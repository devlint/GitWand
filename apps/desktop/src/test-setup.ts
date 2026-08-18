/**
 * Vitest global setup — installs an in-memory Web Storage shim when
 * `localStorage`/`sessionStorage` are missing or non-functional.
 *
 * Two distinct gaps this covers, both of which land on the same fix:
 * 1. Node.js v25 ships a `localStorage` global that only works when
 *    `--localstorage-file` is supplied. Without the flag the object exists
 *    but has no Storage methods (setItem/getItem/removeItem/clear/key/length).
 * 2. Under Vitest's plain "node" environment (the default since the
 *    jsdom -> node switch, see vite.config.ts), there is no jsdom-provided
 *    Storage implementation to fall back on at all.
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

installStorageShimIfNeeded("localStorage");
installStorageShimIfNeeded("sessionStorage");
