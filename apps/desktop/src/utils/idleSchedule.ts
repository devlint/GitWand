/**
 * Resolve on the next idle slice so background paging never blocks input.
 * Falls back to a short timeout when `requestIdleCallback` isn't available
 * (older browsers, some webview engines).
 */
export function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void;
    }).requestIdleCallback;
    if (typeof ric === "function") ric(() => resolve(), { timeout: 300 });
    else setTimeout(resolve, 32);
  });
}
