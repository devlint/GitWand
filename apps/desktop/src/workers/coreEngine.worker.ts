/**
 * Conflict-resolution engine worker (v3.10.0).
 *
 * Hosts `@gitwand/core` off the main thread. The pattern registry, the
 * classifier and tree-sitter all load here, so a large conflict set never
 * blocks paint. Exposed to the main thread with Comlink; see
 * `../utils/coreEngine.ts` for the facade that talks to it.
 *
 * Grammar loading: the worker fetches `/grammars/*.wasm` itself rather than
 * receiving a loader function across the boundary. Functions are not
 * structured-cloneable, and a worker's `fetch` resolves relative URLs against
 * the same origin, so the loader is identical to the main-thread one it
 * replaces.
 *
 * LLM endpoint: Comlink only recognizes a `Comlink.proxy()` marker on a
 * top-level RPC argument — it does not recurse into an argument's nested
 * properties. `options.llmFallback.endpoint` is a live function, so it cannot
 * travel inside `options` (the browser's structured-clone algorithm throws
 * `DataCloneError` on it). Callers must strip `endpoint` out of `options` and
 * pass `Comlink.proxy(endpoint)` as its own top-level `endpointProxy`
 * argument instead; `resolveAsync` below splices it back into the options
 * shape `@gitwand/core` expects before delegating.
 */
import * as Comlink from "comlink";
import { resolve, resolveAsync, parseConflictMarkers, type GitWandOptions, type LlmEndpoint } from "@gitwand/core";

/**
 * Release a Comlink proxy received as an RPC argument, if it is one.
 *
 * A no-op for the in-thread fallback in `../utils/coreEngine.ts`, which hands
 * over the marked function itself rather than a wrapped proxy.
 */
function releaseProxy(value: unknown): void {
  const releasable = value as { [Comlink.releaseProxy]?: () => void } | undefined;
  releasable?.[Comlink.releaseProxy]?.();
}

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

const api = {
  /**
   * Handshake probe. `../utils/coreEngine.ts` races this against a timeout
   * before handing the facade out, so a worker that loads but never answers
   * degrades to the in-thread engine instead of hanging the first caller.
   */
  ping(): true {
    return true;
  },
  resolve(content: string, filePath: string, options?: GitWandOptions) {
    return resolve(content, filePath, options);
  },
  async resolveAsync(
    content: string,
    filePath: string,
    options?: GitWandOptions,
    endpointProxy?: LlmEndpoint,
  ) {
    const opts = endpointProxy
      ? {
          ...options,
          llmFallback: { ...(options?.llmFallback ?? { enabled: false }), endpoint: endpointProxy },
        }
      : options;
    try {
      return await resolveAsync(content, filePath, opts, structuralOpts);
    } finally {
      // Comlink's proxy transfer handler builds a *fresh* `MessageChannel`
      // every time a `Comlink.proxy()`-marked value is serialized, once per
      // call, not once per marked object. The main thread holds the exposing
      // end (`expose(obj, port1)`), so it has nothing to release: without
      // this, one port pair and its message listener leak per conflicted
      // file, per resolution pass, for the life of the page. Releasing from
      // this side makes the exposing end detach its listener and close the
      // port. Safe to do unconditionally after the call: the proxy is
      // per-call, so nothing else can still be holding it.
      releaseProxy(endpointProxy);
    }
  },
  parseConflictMarkers(content: string) {
    return parseConflictMarkers(content);
  },
};

export type CoreEngineWorkerApi = typeof api;

Comlink.expose(api);
