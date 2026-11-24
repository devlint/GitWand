/**
 * The platform the app runs on, for shortcut handling and labels. One test,
 * shared, so a key handler and the label it documents agree.
 */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The OS by name, for reports (GitWand's resolver reports, #301). */
export function platformName(): "macOS" | "Windows" | "Linux" | "unknown" {
  if (IS_MAC) return "macOS";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "unknown";
}

/** The "toggle" click modifier: Cmd on macOS, Ctrl elsewhere (Ctrl-click is a context-menu gesture on mac). */
export function isToggleModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}
