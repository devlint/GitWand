/**
 * KeyboardEvent → bytes for the PTY, xterm-compatible.
 *
 * Returns `null` when the key should not be sent (bare modifiers, Cmd shortcuts
 * on macOS, keys the browser must handle such as IME composition).
 */

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export interface KeyContext {
  appCursor: boolean;
  isMac: boolean;
  /**
   * Shift+Enter sends ESC CR — the "insert newline" binding of claude, codex
   * and gemini. Off for plain shells, where ESC CR means something else (zsh:
   * accept-and-hold) and xterm sends a bare CR.
   */
  shiftEnterNewline?: boolean;
}

const FN_TILDE: Record<string, number> = {
  Insert: 2, Delete: 3, PageUp: 5, PageDown: 6,
  F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
};

const CURSOR: Record<string, string> = {
  ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F",
};

const SS3_FN: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };

/** xterm modifier parameter: 1 + shift + 2·alt + 4·ctrl. */
function modParam(e: KeyEventLike): number {
  return 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
}

export function keyToSequence(e: KeyEventLike, ctx: KeyContext): string | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const { key } = e;
  // Cmd is the application's modifier on macOS; Super is the OS's elsewhere.
  if (e.metaKey) return null;

  const mod = modParam(e);

  const cursor = CURSOR[key];
  if (cursor) {
    if (mod > 1) return `\x1b[1;${mod}${cursor}`;
    return ctx.appCursor ? `\x1bO${cursor}` : `\x1b[${cursor}`;
  }
  const tilde = FN_TILDE[key];
  if (tilde !== undefined) return mod > 1 ? `\x1b[${tilde};${mod}~` : `\x1b[${tilde}~`;
  const ss3 = SS3_FN[key];
  if (ss3) return mod > 1 ? `\x1b[1;${mod}${ss3}` : `\x1bO${ss3}`;

  const esc = e.altKey && !ctx.isMac ? "\x1b" : "";

  switch (key) {
    case "Enter":
      if (e.altKey || (e.shiftKey && ctx.shiftEnterNewline)) return "\x1b\r";
      return "\r";
    case "Backspace":
      if (e.ctrlKey) return esc + "\x08";
      return (e.altKey ? "\x1b" : "") + "\x7f";
    case "Tab":
      return e.shiftKey ? "\x1b[Z" : esc + "\t";
    case "Escape":
      return esc + "\x1b";
  }

  // Bare modifier / dead / unidentified keys.
  if ([...key].length !== 1) return null;

  if (e.ctrlKey && !e.altKey) {
    const c = ctrlChar(e);
    if (c !== null) return c;
  }
  if (e.ctrlKey && e.altKey) {
    // AltGr on Windows/Linux layouts reports ctrl+alt: send the composed char.
    const c = ctrlChar(e);
    if (c !== null && /^[a-z]$/i.test(key)) return "\x1b" + c;
    return key;
  }
  // macOS Option composes characters (é, ∂…) — send what it produced.
  if (e.altKey && ctx.isMac) return key;
  return esc + key;
}

function ctrlChar(e: KeyEventLike): string | null {
  const k = e.key;
  if (k.length === 1) {
    const lower = k.toLowerCase();
    if (lower >= "a" && lower <= "z") return String.fromCharCode(lower.charCodeAt(0) - 96);
    switch (k) {
      case " ": case "@": case "2": return "\x00";
      case "[": case "3": return "\x1b";
      case "\\": case "4": return "\x1c";
      case "]": case "5": return "\x1d";
      case "^": case "6": return "\x1e";
      case "_": case "-": case "/": case "7": return "\x1f";
      case "8": case "?": return "\x7f";
    }
  }
  // Non-Latin layouts: fall back to the physical key.
  const code = e.code ?? "";
  const m = /^Key([A-Z])$/.exec(code);
  if (m) return String.fromCharCode(m[1].charCodeAt(0) - 64);
  return null;
}
