/**
 * Text parsing for the command-route guard.
 *
 * Deliberately not a regex over the whole call: a type parameter can contain
 * a nested generic (`tauriInvoke<Array<{ a: string }>>("git_log", …)`), and
 * `[^>]*` stops at the first `>`. That mistake cost 18 undetected commands in
 * the first measurement (design §1), so the scan walks from the identifier to
 * its opening parenthesis instead of trying to match the whole call.
 */

/**
 * Is this `tauriInvoke` occurrence something other than a call we can read?
 *
 * Judged on the current line only. An earlier attempt looked at the preceding
 * 200 characters, which made the `export async function …` enclosing a call
 * match the import/export test and rejected 119 of 139 real invocations — the
 * floor assertion in the test file is what caught it.
 */
function isNonCall(linePrefix: string): boolean {
  const trimmed = linePrefix.trimStart();
  return (
    // Its own declaration: `export async function tauriInvoke<T>(…)`.
    /\bfunction\s+$/.test(linePrefix) ||
    // A named import or re-export list that happens to contain the identifier.
    /^\s*(import|export)\b/.test(linePrefix) ||
    // Prose in a comment: ` * Timeout presets for tauriInvoke.`
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

export function findInvokedCommands(source: string): {
  commands: string[];
  dynamic: string[];
} {
  const commands = new Set<string>();
  const dynamic: string[] = [];
  let i = -1;
  while ((i = source.indexOf("tauriInvoke", i + 1)) !== -1) {
    const lineStart = source.lastIndexOf("\n", i) + 1;
    if (isNonCall(source.slice(lineStart, i))) continue;
    const paren = source.indexOf("(", i);
    if (paren === -1) continue;
    const after = source.slice(paren + 1).replace(/^\s+/, "");
    const literal = after.match(/^"([a-z0-9_]+)"/);
    if (literal) {
      commands.add(literal[1]!);
    } else {
      dynamic.push(source.slice(i, i + 80).split("\n")[0]!);
    }
  }
  return { commands: [...commands].sort(), dynamic };
}

/**
 * Two declaration styles exist in dev-server.mjs: the usual
 * `url.pathname === "/api/…"` test, and `case "/api/…":` labels inside a
 * prefix dispatcher (`url.pathname.startsWith("/api/gitea-")` switches on the
 * full path). Missing the second made every Gitea read route look absent.
 *
 * A `case` label counts only when it sits inside the block of a dispatcher
 * whose prefix it starts with: a label the guard can never let through is
 * unreachable, and counting it would let an entry name a dead route.
 */
export function findDevServerRoutes(source: string): string[] {
  const routes = new Set<string>();
  for (const m of source.matchAll(/url\.pathname === "(\/api\/[a-z0-9-]+)"/g)) {
    routes.add(m[1]!);
  }
  for (const d of source.matchAll(
    /url\.pathname\.startsWith\("(\/api\/[a-z0-9-]+)"\)/g,
  )) {
    const prefix = d[1]!;
    const block = blockAfter(source, d.index! + d[0].length);
    for (const c of block.matchAll(/case "(\/api\/[a-z0-9-]+)"/g)) {
      if (c[1]!.startsWith(prefix)) routes.add(c[1]!);
    }
  }
  return [...routes].sort();
}

/**
 * The command names registered in `tauri::generate_handler![…]` (src-tauri's
 * lib.rs), last path segment only: `commands::read::git_log` → `git_log`,
 * which is the name `invoke()` resolves.
 *
 * The source is lexed first (`stripRustCommentsAndStrings`), so a
 * commented-out entry does not count as registered, and neither a `/*` inside
 * a string nor the macro's name in a comment can derail the scan. An attribute
 * (`#[cfg(…)] commands::x::y,`) is skipped by bracket matching and its command
 * still counted: it is registered in the builds the attribute allows, and the
 * guard is about names, not features. Returns `[]` when no macro is found;
 * the caller's floor assertion is what notices that.
 */
export function findRegisteredCommands(libRs: string): string[] {
  const code = stripRustCommentsAndStrings(libRs);
  const marker = "generate_handler![";
  const start = code.indexOf(marker);
  if (start === -1) return [];
  const open = start + marker.length - 1;
  const body = withoutAttributes(code.slice(open + 1, matchingBracket(code, open)));
  const names = new Set<string>();
  for (const entry of body.split(",")) {
    const path = entry.trim();
    if (!path) continue;
    const name = path.split("::").pop()!.trim();
    if (/^[a-z_][a-z0-9_]*$/.test(name)) names.add(name);
  }
  return [...names].sort();
}

/** Index of the `]` closing the `[` at `open` (or the end of `s`). */
function matchingBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) return i;
  }
  return s.length;
}

/** `s` with every `#[…]` / `#![…]` attribute removed, brackets balanced. */
function withoutAttributes(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const open = s.startsWith("#[", i) ? i + 1 : s.startsWith("#![", i) ? i + 2 : -1;
    if (open === -1) {
      out += s[i];
      continue;
    }
    i = matchingBracket(s, open);
  }
  return out;
}

/**
 * Rust source with comments removed and string / char literals emptied
 * (`"…"` → `""`), so what is left is code. Handles nested block comments,
 * escapes, raw strings (`r#"…"#`, `br"…"`) and tells a char literal (`'['`)
 * from a lifetime (`'a`). Not a full lexer: enough for the handler list.
 */
export function stripRustCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 0;
      while (i < n) {
        if (src.startsWith("/*", i)) { depth++; i += 2; }
        else if (src.startsWith("*/", i)) { depth--; i += 2; if (depth === 0) break; }
        else i++;
      }
      out += " ";
      continue;
    }
    // Raw string: r"…", r#"…"#, br#"…"#. Only when `r` starts a token.
    const raw = /^b?r(#*)"/.exec(src.slice(i, i + 260));
    if (raw && !/[A-Za-z0-9_]/.test(src[i - 1] ?? "")) {
      const close = `"${raw[1]}`;
      const end = src.indexOf(close, i + raw[0].length);
      i = end === -1 ? n : end + close.length;
      out += '""';
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
      continue;
    }
    if (c === "'") {
      // A char literal closes within a few characters ('x', '\n', '\u{1F600}');
      // a lifetime ('a, 'static) never closes before an identifier ends.
      const lit = /^'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|.)|[^\\'])'/.exec(src.slice(i, i + 12));
      if (lit) {
        i += lit[0].length;
        out += "' '";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The `{ … }` block opened by the first brace at or after `from`, by brace
 * counting. Not a JS parser: a brace inside a string or comment would throw
 * the count off. dev-server.mjs's dispatcher bodies have balanced braces in
 * their strings (template `${…}` only). An unbalanced one either ends the
 * block early, so a real route goes missing and the registry test names it,
 * or runs it to EOF, so later labels sharing the prefix count — the prefix
 * check still applies.
 */
function blockAfter(source: string, from: number): string {
  const open = source.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}
