/**
 * Vitest global setup — installs an in-memory Web Storage shim when
 * `localStorage`/`sessionStorage` are missing or non-functional.
 *
 * Three distinct gaps this covers, all landing on the same fix:
 * 1. Node.js v25 ships a `localStorage` global that only works when
 *    `--localstorage-file` is supplied. Without the flag the object exists
 *    but has no Storage methods (setItem/getItem/removeItem/clear/key/length).
 * 2. Under Vitest's plain "node" environment (the default since the
 *    jsdom -> node switch, see vite.config.ts), there is no jsdom-provided
 *    Storage implementation to fall back on at all.
 * 3. Some Node versions (observed: v25 locally) define a global `Storage`
 *    class alongside their `localStorage` stub, so `Storage.prototype` exists
 *    for `vi.spyOn` to hook even before this file runs. Node 22 (CI's
 *    matrix) has neither — `Storage` is undefined as a bare identifier,
 *    which throws a ReferenceError the moment a test does
 *    `vi.spyOn(Storage.prototype, "setItem")` (see usePrCache.test.ts). Expose
 *    `InMemoryStorage` as the global `Storage` so that spy target exists
 *    consistently across Node versions, and so it's the exact same
 *    prototype our localStorage/sessionStorage instances are built from.
 *
 * This file is intentionally self-contained (pure JS, no jsdom dependency)
 * so it works identically whether a given test file runs in "node" or
 * opts into "jsdom" via a `// @vitest-environment jsdom` docblock.
 */

class InMemoryStorage implements Storage {
  private store: Map<string, string> = new Map();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

// Only install the shim when the existing global is absent or non-functional
// (no `setItem`) — e.g. jsdom's own Storage implementation, when a test file
// opts into `// @vitest-environment jsdom`, is left untouched.
function installStorageShimIfNeeded(key: "localStorage" | "sessionStorage") {
  const existing = (globalThis as Record<string, unknown>)[key] as
    | Storage
    | undefined;
  if (existing && typeof existing.setItem === "function") {
    return;
  }
  Object.defineProperty(globalThis, key, {
    value: new InMemoryStorage(),
    writable: true,
    configurable: true,
  });
}

// Expose the constructor globally (as `Storage`) whenever it's missing, so
// `vi.spyOn(Storage.prototype, "setItem")`-style tests work regardless of
// Node version — see gap 3 above. Our localStorage/sessionStorage instances
// below are always `InMemoryStorage`, so this is the exact prototype they
// share; spying on it affects them too.
if (typeof (globalThis as Record<string, unknown>).Storage !== "function") {
  (globalThis as Record<string, unknown>).Storage = InMemoryStorage;
}

installStorageShimIfNeeded("localStorage");
installStorageShimIfNeeded("sessionStorage");
