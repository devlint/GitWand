/**
 * The platform the app runs on, for shortcut handling and labels. One test,
 * shared, so a key handler and the label it documents agree.
 */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
