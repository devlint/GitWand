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

export function findDevServerRoutes(source: string): string[] {
  const routes = new Set<string>();
  for (const m of source.matchAll(/url\.pathname === "(\/api\/[a-z0-9-]+)"/g)) {
    routes.add(m[1]!);
  }
  return [...routes].sort();
}
