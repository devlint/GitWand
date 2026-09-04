/**
 * Facade over the `@gitwand/core` conflict-resolution engine.
 *
 * v3.10.0: the engine runs in a Web Worker (`../workers/coreEngine.worker.ts`)
 * so the pattern registry, the classifier and tree-sitter never execute on the
 * main thread. Every method is async, including `resolve`, which used to be
 * synchronous once the module was loaded.
 *
 * Callers keep the same entry point they had when this file was a lazy module
 * loader: the dynamic-import boundary that keeps ~244 KB out of the boot chunk
 * is preserved, it just moved into the worker.
 *
 * Fallback: environments without `Worker` (Vitest's `node` environment, SSR)
 * transparently get an in-thread implementation with identical signatures, so
 * unit tests and any non-browser consumer keep working.
 *
 * LLM endpoint: `resolveAsync`'s optional `endpointProxy` argument exists
 * because Comlink only recognizes a `Comlink.proxy()` marker on a top-level
 * RPC argument, not on a property nested inside `options` — see
 * `../workers/coreEngine.worker.ts` for the full rationale. Callers must
 * build `options` without a live `llmFallback.endpoint` and pass
 * `Comlink.proxy(endpoint)` here instead.
 */
import * as Comlink from "comlink";
import type { GitWandOptions, LlmEndpoint, MergeResult } from "@gitwand/core";
import type { CoreEngineWorkerApi } from "../workers/coreEngine.worker";

export interface CoreEngineFacade {
  resolve(content: string, filePath: string, options?: GitWandOptions): Promise<MergeResult>;
  resolveAsync(
    content: string,
    filePath: string,
    options?: GitWandOptions,
    endpointProxy?: LlmEndpoint,
  ): Promise<MergeResult>;
  parseConflictMarkers(
    content: string,
  ): Promise<Awaited<ReturnType<CoreEngineWorkerApi["parseConflictMarkers"]>>>;
}

let _facade: Promise<CoreEngineFacade> | null = null;

/** Same grammar loader the worker uses, for the in-thread fallback. */
const structuralOpts = {
  wasmPath: "/grammars/web-tree-sitter.wasm",
  customLoader: async (grammarName: string): Promise<Uint8Array> => {
    const response = await fetch(`/grammars/${grammarName}.wasm`);
    if (!response.ok) {
      throw new Error(`[gitwand] Failed to fetch grammar ${grammarName} (HTTP ${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
};

async function inThreadFacade(): Promise<CoreEngineFacade> {
  const core = await import("@gitwand/core");
  return {
    async resolve(content, filePath, options) {
      return core.resolve(content, filePath, options as never);
    },
    async resolveAsync(content, filePath, options, endpointProxy) {
      const opts = endpointProxy
        ? { ...options, llmFallback: { ...(options?.llmFallback ?? { enabled: false }), endpoint: endpointProxy } }
        : options;
      return core.resolveAsync(content, filePath, opts as never, structuralOpts);
    },
    async parseConflictMarkers(content) {
      return core.parseConflictMarkers(content) as never;
    },
  };
}

/**
 * How long the worker gets to answer its handshake before we give up on it and
 * run in-thread. Generous: this only has to cover chunk fetch + module eval on
 * a cold cache, and the common failure modes (404, no module-worker support)
 * report themselves through the `error` event long before it elapses.
 */
const HANDSHAKE_TIMEOUT_MS = 5_000;

async function workerFacade(): Promise<CoreEngineFacade> {
  const worker = new Worker(new URL("../workers/coreEngine.worker.ts", import.meta.url), {
    type: "module",
  });
  // Constructing a Worker never throws for a chunk that fails to load (e.g. a
  // 404, or a WebView without module-worker support) — the failure surfaces
  // later as an async `error` event, well after this function has already
  // returned a Comlink-wrapped facade. This listener keeps a worker that dies
  // *later* from being handed to every subsequent `engine()` caller: it
  // demotes `_facade` to the in-thread implementation so the conflict UI
  // degrades instead of freezing.
  worker.addEventListener("error", (event) => {
    console.warn("[gitwand] core engine worker failed to load, falling back to in-thread", event);
    worker.terminate();
    _facade = inThreadFacade();
  });

  const remote = Comlink.wrap<CoreEngineWorkerApi>(worker);
  // Handshake before handing the facade out. Comlink's RPC has no timeout, so
  // a worker that loads but never answers (or one whose `error` event the
  // WebView does not deliver) would leave the *first* caller
  // (`useGitWand.loadRealFiles`, awaiting `Promise.all` over `resolveAsync`)
  // hanging forever, with the merge editor stuck on its loading state and no
  // error anywhere. The listener above cannot rescue that call; proving the
  // worker answers one cheap RPC first can.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      remote.ping(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`core engine worker did not answer in ${HANDSHAKE_TIMEOUT_MS}ms`)),
          HANDSHAKE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    worker.terminate();
    throw err; // engine() below turns this into the in-thread fallback
  } finally {
    clearTimeout(timer);
  }

  return remote as unknown as CoreEngineFacade;
}

export function engine(): Promise<CoreEngineFacade> {
  return (_facade ??= (async () => {
    if (typeof Worker === "undefined") return inThreadFacade();
    try {
      return await workerFacade();
    } catch (err) {
      console.warn("[gitwand] core engine worker unavailable, running in-thread", err);
      return inThreadFacade();
    }
  })());
}
