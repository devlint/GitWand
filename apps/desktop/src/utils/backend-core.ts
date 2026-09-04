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
  opts: { shell?: string; agent?: string; cols: number; rows: number },
  onOutput: (chunk: string) => void,
): Promise<number> {
  const params = new URLSearchParams({
    cwd,
    cols: String(opts.cols),
    rows: String(opts.rows),
  });
  if (opts.shell) params.set("shell", opts.shell);
  if (opts.agent) params.set("agent", opts.agent);
  return new Promise((resolve, reject) => {
    const es = new EventSource(`${DEV_SERVER}/api/terminal-open?${params}`);
    let resolved = false;
    es.onmessage = (ev) => {
      const payload = JSON.parse(ev.data);
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
    es.onerror = () => {
      if (resolved) {
        // The dev server ties PTY lifetime to this SSE connection: req.on("close")
        // kills the PTY the moment the connection drops (see dev-server.mjs). So
        // once the shell is up, ANY onerror means the server-side PTY is already
        // gone — close here rather than let EventSource auto-reconnect, which
        // would re-hit /api/terminal-open and spawn an untracked orphan shell
        // with a new id the frontend can't address. (Surviving a transient blip
        // would require server-side reconnect-by-id; this is dev-mode only.)
        es.close();
      } else {
        // Initial connection failure before the id arrived (dev server down,
        // not yet started, etc.). Reject the Promise so the caller surfaces the
        // error instead of hanging forever with a ghost tab at sessionId=-1.
        es.close();
        reject(new Error("dev server unreachable: terminal-open SSE connection failed"));
      }
    };
  });
}

/** Open dev-mode watch streams, keyed by subscription id. */
const _devWatchStreams = new Map<number, EventSource>();

/**
 * Dev-mode (`pnpm dev:web`) equivalent of the Tauri `watch_repo_start` Channel:
 * an SSE stream. The server sends `{ id }` first, then one message per
 * coalesced batch. Resolves with the subscription id.
 *
 * `onClose`, if given, fires once if the stream dies *after* the subscription
 * started (dev server killed/restarted mid-session) — distinct from the
 * initial-connection failure, which rejects the returned Promise instead.
 */
export async function devWatchRepoOpen(
  cwd: string,
  onChange: (ev: { kinds: string[]; paths: string[]; truncated: boolean }) => void,
  onClose?: () => void,
): Promise<number> {
  const params = new URLSearchParams({ cwd });
  return new Promise((resolve, reject) => {
    const es = new EventSource(`${DEV_SERVER}/api/watch-repo?${params}`);
    let resolved = false;
    let subscriptionId = -1;
    _devWatchStreams.set(-1, es); // placeholder replaced once the id arrives
    es.onmessage = (ev) => {
      const payload = JSON.parse(ev.data);
      if (!resolved && typeof payload?.id === "number") {
        resolved = true;
        subscriptionId = payload.id;
        _devWatchStreams.delete(-1);
        _devWatchStreams.set(payload.id, es);
        resolve(payload.id);
      } else if (payload && Array.isArray(payload.kinds)) {
        onChange(payload);
      }
    };
    es.onerror = () => {
      es.close();
      if (!resolved) {
        reject(new Error("dev server unreachable: watch-repo SSE failed"));
        return;
      }
      // The stream died mid-session: the subscription is dead even though
      // nothing ever called devWatchRepoClose for it.
      _devWatchStreams.delete(subscriptionId);
      onClose?.();
    };
  });
}

export function devWatchRepoClose(id: number): void {
  const es = _devWatchStreams.get(id);
  if (es) {
    es.close();
    _devWatchStreams.delete(id);
  }
}

/** One progress update from `git clone --progress` / `git fetch --progress`. */
interface DevCloneProgress {
  stage: string;
  percent: number;
  message: string;
}

/**
 * Dev-mode (`pnpm dev:web`) equivalent of the Tauri `git_clone` Channel: an
 * SSE stream that forwards `{stage,percent,message}` progress messages,
 * then resolves on `{done: dest}` or rejects on `{error}`.
 */
export async function devGitClone(
  url: string,
  dest: string,
  onProgress?: (p: DevCloneProgress) => void,
): Promise<string> {
  const params = new URLSearchParams({ url, dest });
  return new Promise((resolve, reject) => {
    const es = new EventSource(`${DEV_SERVER}/api/git-clone-stream?${params}`);
    es.onmessage = (ev) => {
      const payload = JSON.parse(ev.data);
      if (typeof payload?.done === "string") {
        es.close();
        resolve(payload.done);
      } else if (typeof payload?.error === "string") {
        es.close();
        reject(new Error(payload.error));
      } else if (typeof payload?.stage === "string") {
        onProgress?.(payload as DevCloneProgress);
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error("dev server unreachable: git-clone-stream SSE failed"));
    };
  });
}

/**
 * Dev-mode (`pnpm dev:web`) equivalent of the Tauri `git_fetch` Channel: an
 * SSE stream that forwards `{stage,percent,message}` progress messages,
 * then resolves with the final `{result}` (a `GitPushPullResult`-shaped
 * object). Mirrors the Rust command: a failed fetch resolves with
 * `result.success === false` rather than rejecting the promise.
 */
export async function devGitFetch(
  cwd: string,
  onProgress?: (p: DevCloneProgress) => void,
): Promise<{ success: boolean; message: string; conflicts?: boolean }> {
  const params = new URLSearchParams({ cwd });
  return new Promise((resolve, reject) => {
    const es = new EventSource(`${DEV_SERVER}/api/git-fetch-stream?${params}`);
    es.onmessage = (ev) => {
      const payload = JSON.parse(ev.data);
      if (payload?.result) {
        es.close();
        resolve(payload.result);
      } else if (typeof payload?.error === "string") {
        es.close();
        reject(new Error(payload.error));
      } else if (typeof payload?.stage === "string") {
        onProgress?.(payload as DevCloneProgress);
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error("dev server unreachable: git-fetch-stream SSE failed"));
    };
  });
}
