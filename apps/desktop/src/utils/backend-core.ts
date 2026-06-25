/**
 * @file backend-core.ts
 *
 * Internal infrastructure shared by all backend sub-modules.
 *
 * Extracted from backend.ts (v2.11) so that per-domain modules
 * (backend-pr, backend-gitlab, backend-bitbucket, backend-ai) can
 * import these helpers without creating circular dependencies with backend.ts.
 *
 * NOT part of the public API surface — consumers should import from backend.ts.
 * Sub-modules (backend-pr.ts etc.) import from here.
 */

export const DEV_SERVER = "http://localhost:3001";

/**
 * Lightweight circuit-breaker for dev-server fetches.
 *
 * After THRESHOLD consecutive "Failed to fetch" (connection refused / server
 * down), all outgoing fetches are blocked for BACKOFF_MS milliseconds so the
 * browser doesn't spray thousands of failed requests into the Network tab.
 */
export const _cb = {
  failures:   0,
  openUntil:  0,
  THRESHOLD:  3,
  BACKOFF_MS: 15_000,
};

/**
 * Thin wrapper around `fetch` that honours the circuit breaker.
 */
export async function devFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  if (Date.now() < _cb.openUntil) {
    throw new Error("dev-server unreachable (circuit breaker open)");
  }
  try {
    const res = await fetch(input, init);
    _cb.failures = 0;
    return res;
  } catch (err: any) {
    if (err?.name === "TypeError" && err?.message?.includes("fetch")) {
      _cb.failures += 1;
      if (_cb.failures >= _cb.THRESHOLD) {
        _cb.openUntil = Date.now() + _cb.BACKOFF_MS;
        console.warn(
          `[backend] dev-server unreachable after ${_cb.failures} attempts — ` +
          `polling paused for ${_cb.BACKOFF_MS / 1000}s`,
        );
        _cb.failures = 0;
      }
    }
    throw err;
  }
}

/** Check if we're inside a Tauri webview. */
export function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__;
}

/**
 * Call a Tauri command via the invoke IPC bridge.
 *
 * `timeoutMs` controls the IPC timeout:
 *   - default 30 000 ms — safe for any read-only command
 *   - pass a higher value (e.g. 300 000) for network operations
 *   - pass `0` to disable the timeout entirely (AI prompts)
 */
export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  const internals = (window as any).__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    throw new Error("Tauri invoke not available");
  }
  const promise = internals.invoke(cmd, args) as Promise<T>;
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.finally(() => { if (timer) clearTimeout(timer); }),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`IPC timeout after ${timeoutMs}ms: ${cmd}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Timeout presets for tauriInvoke.
 */
export const IPC_TIMEOUT = {
  /** Default — short read-only commands. */
  DEFAULT: 30_000,
  /** Network git operations: push, pull, fetch, clone. */
  NETWORK: 300_000,
  /** AI prompts — no timeout, can run arbitrarily long. */
  NONE: 0,
} as const;

/**
 * Dev-mode PTY open over Server-Sent Events. First SSE message is
 * `{"id": <number>}`; subsequent messages are raw output chunks (JSON-encoded
 * strings to preserve control bytes).
 */
export async function devTerminalOpen(
  cwd: string,
  opts: { shell?: string; cols: number; rows: number },
  onOutput: (chunk: string) => void,
): Promise<number> {
  const params = new URLSearchParams({
    cwd,
    cols: String(opts.cols),
    rows: String(opts.rows),
  });
  if (opts.shell) params.set("shell", opts.shell);
  const url = `${DEV_SERVER}/api/terminal-open?${params}`;
  console.log('[pty] opening SSE', url);
  return new Promise((resolve, reject) => {
    const es = new EventSource(url);
    let resolved = false;
    es.onopen = () => console.log('[pty] SSE onopen — connection established');
    es.onmessage = (ev) => {
      const payload = JSON.parse(ev.data);
      console.log('[pty] SSE onmessage', payload);
      if (!resolved && typeof payload?.id === "number") {
        resolved = true;
        resolve(payload.id);
      } else if (typeof payload?.chunk === "string") {
        onOutput(payload.chunk);
      } else if (payload?.eof) {
        // Fix 5 — Explicitly close the EventSource when the shell exits so that
        // the browser's built-in auto-reconnect logic does not fire and spawn an
        // untracked shell process by hitting /api/terminal-open again.
        es.close();
      }
    };
    es.onerror = (e) => {
      console.warn('[pty] SSE onerror', { resolved, readyState: es.readyState, e });
      if (resolved) {
        // Shell exited — close to prevent browser auto-reconnect spawning a new shell
        es.close();
      }
      // !resolved: transient connection error — let EventSource retry naturally
    };
  });
}
