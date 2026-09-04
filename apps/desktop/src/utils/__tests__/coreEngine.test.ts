import { describe, it, expect, vi, afterEach } from "vitest";
import { engine } from "../coreEngine";

const CONFLICT = [
  "<<<<<<< HEAD",
  "ours",
  "=======",
  "theirs",
  ">>>>>>> branch",
  "",
].join("\n");

describe("coreEngine facade", () => {
  it("falls back in-thread when Worker is unavailable and still resolves", async () => {
    // The vitest `node` environment has no Worker, which is exactly the
    // fallback path this asserts.
    const e = await engine();
    const result = await e.resolve(CONFLICT, "a.txt");
    expect(result.filePath).toBe("a.txt");
    expect(result.stats.totalConflicts).toBe(1);
  });

  it("exposes parseConflictMarkers as a promise", async () => {
    const e = await engine();
    const parsed = await e.parseConflictMarkers(CONFLICT);
    expect(parsed.segments.some((s: any) => s.type === "conflict")).toBe(true);
  });

  it("memoizes the facade", async () => {
    expect(await engine()).toBe(await engine());
  });

  it("splices the LLM endpoint back into options without ever putting a live function inside the options object", async () => {
    // Regression guard for the Comlink DataCloneError this facade works
    // around: Comlink only recognizes a `Comlink.proxy()` marker on a
    // top-level RPC argument, not on a value nested inside `options`, so the
    // endpoint MUST travel as resolveAsync's separate 4th argument. This
    // asserts the two halves of that contract: (1) `options` itself stays
    // plain, structured-clone-safe data, and (2) the facade still splices the
    // endpoint back in so the LLM fallback actually fires.
    const COMPLEX_CONFLICT = [
      "<<<<<<< HEAD",
      "function total(items) { return items.reduce((a,b) => a + b.price, 0); }",
      "||||||| base",
      "function total(items) { let s = 0; for (const i of items) s += i.price; return s; }",
      "=======",
      "const total = (items) => items.map(i => i.price * i.qty).reduce((a,b) => a+b, 0);",
      ">>>>>>> branch",
      "",
    ].join("\n");

    const options = { llmFallback: { enabled: true } };
    expect(() => JSON.stringify(options)).not.toThrow();

    let callCount = 0;
    const endpointProxy = {
      call: async (_prompt: string) => {
        callCount++;
        return "function total(items) { return items.reduce((a,b) => a + b.price * b.qty, 0); }";
      },
    };

    const e = await engine();
    const result = await e.resolveAsync(COMPLEX_CONFLICT, "cart.js", options, endpointProxy);

    expect(callCount).toBe(1);
    expect(result.hunks.map((h) => h.type)).toContain("llm_proposed");
    expect(result.stats.remaining).toBe(0);
  });
});

describe("coreEngine worker handshake", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /**
   * A worker chunk that fails to load (404, a WebView without module-worker
   * support) does not make `new Worker` throw, and Comlink's RPC has no
   * timeout, so the first caller, `useGitWand.loadRealFiles` awaiting
   * `Promise.all` over `resolveAsync`, used to hang forever with the merge
   * editor stuck on its loading state and no error surfaced anywhere. The
   * handshake must give up and degrade to the in-thread engine instead.
   */
  it("gives up on a worker that never answers and resolves in-thread", async () => {
    vi.useFakeTimers();
    let terminated = false;
    class DeafWorker {
      addEventListener() {}
      removeEventListener() {}
      postMessage() {} // swallows the handshake: no reply, ever
      terminate() {
        terminated = true;
      }
    }
    vi.stubGlobal("Worker", DeafWorker);
    vi.resetModules();
    const { engine: freshEngine } = await import("../coreEngine");

    const pending = freshEngine();
    await vi.advanceTimersByTimeAsync(5_001);
    const e = await pending;

    expect(terminated).toBe(true);
    // The facade still works, it is the in-thread implementation now.
    vi.useRealTimers();
    const result = await e.resolve(CONFLICT, "a.txt");
    expect(result.stats.totalConflicts).toBe(1);
  });

  it("hands out the worker facade as soon as it answers the handshake", async () => {
    // Fake timers that are never advanced: if the handshake needed the
    // timeout to settle, this test would hang instead of passing.
    vi.useFakeTimers();
    let posted = 0;
    class TalkingWorker {
      private listeners: Array<(ev: MessageEvent) => void> = [];
      addEventListener(type: string, fn: (ev: MessageEvent) => void) {
        if (type === "message") this.listeners.push(fn);
      }
      removeEventListener(type: string, fn: (ev: MessageEvent) => void) {
        this.listeners = this.listeners.filter((l) => l !== fn);
      }
      postMessage(msg: { id?: string; type?: string; path?: string[] }) {
        posted++;
        // Minimal Comlink reply: echo the message id with a plain value.
        const reply = { data: { id: msg.id, type: "RAW", value: true } } as MessageEvent;
        for (const l of [...this.listeners]) l(reply);
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", TalkingWorker);
    vi.resetModules();
    const { engine: freshEngine } = await import("../coreEngine");

    await freshEngine();
    expect(posted).toBeGreaterThan(0); // the handshake actually went out
  });
});
