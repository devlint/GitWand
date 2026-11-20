/**
 * The environment a spawned program gets (AGENTS.md: only what it needs, no
 * secret it does not use): one base list every child needs to run — on
 * POSIX and on Windows — plus each child's own extras.
 */

/** Finding programs, the home and temp directories, locale; Windows' equivalents. */
const BASE = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ALLUSERSPROFILE",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
];

/**
 * `process.env` reduced to the base list and `extra` names — matched in any
 * case, as Windows spells `PATH` `Path` — and, with `more`, every name
 * starting with its prefix that `refuse` does not match.
 */
export function childEnv(extra: string[], more?: { prefix: string; refuse: RegExp }): NodeJS.ProcessEnv {
  const allowed = new Set([...BASE, ...extra].map((k) => k.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const byPrefix = more && k.toUpperCase().startsWith(more.prefix) && !more.refuse.test(k);
    if (allowed.has(k.toUpperCase()) || byPrefix) env[k] = v;
  }
  return env;
}
