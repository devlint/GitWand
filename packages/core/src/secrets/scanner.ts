import { matchGlob } from "../config.js";
import { BUILT_IN_PATTERNS } from "./patterns.js";
import type { ScanFileInput, SecretFinding, SecretPattern, SecretsScanConfig } from "./types.js";

/**
 * v3.5.0 — Scanner de secrets pur (aucune dépendance Node/git).
 *
 * Mirroir Rust : `apps/desktop/src-tauri/src/commands/secrets.rs` (`scan_lines`). Toute
 * modification de comportement ici doit être répercutée côté Rust — voir le test de parité
 * (Task 7).
 */

/** Nombre maximal de findings retournés (défensif — voir apps/desktop/CLAUDE.md P6.4). */
const MAX_FINDINGS = 500;

/** Longueur minimale d'un token pour être soumis à la détection par entropie. */
const MIN_ENTROPY_TOKEN_LENGTH = 20;

/** Caractères considérés comme faisant partie d'un token candidat à l'entropie. */
const ENTROPY_TOKEN_RE = /[A-Za-z0-9+/=_-]+/g;

export function scanSecrets(files: ScanFileInput[], config: SecretsScanConfig): SecretFinding[] {
  if (!config.enabled) return [];

  const allPatterns: SecretPattern[] = [...BUILT_IN_PATTERNS, ...config.extraPatterns];
  const compiled = allPatterns.flatMap((pattern) => {
    try {
      return [{ pattern, re: new RegExp(pattern.regex, "g") }];
    } catch {
      // Regex utilisateur malformée — on l'ignore silencieusement, jamais fatal.
      return [];
    }
  });

  const findings: SecretFinding[] = [];

  for (const file of files) {
    for (const { line, text } of file.addedLines) {
      const matchedRanges: Array<[number, number]> = [];

      for (const { pattern, re } of compiled) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const matchValue = m[0];
          if (matchValue.length === 0) {
            re.lastIndex++;
            continue;
          }
          matchedRanges.push([m.index, m.index + matchValue.length]);
          if (!isIgnored(file.path, matchValue, config.ignore)) {
            findings.push({
              file: file.path,
              line,
              patternId: pattern.id,
              severity: pattern.severity,
              redactedExcerpt: redact(matchValue),
            });
          }
        }
      }

      if (config.entropyThreshold > 0) {
        ENTROPY_TOKEN_RE.lastIndex = 0;
        let tokenMatch: RegExpExecArray | null;
        while ((tokenMatch = ENTROPY_TOKEN_RE.exec(text)) !== null) {
          const token = tokenMatch[0];
          const start = tokenMatch.index;
          const end = start + token.length;
          if (token.length < MIN_ENTROPY_TOKEN_LENGTH) continue;

          const overlapsRegexHit = matchedRanges.some(
            ([rStart, rEnd]) => start < rEnd && end > rStart,
          );
          if (overlapsRegexHit) continue;

          if (shannonEntropy(token) >= config.entropyThreshold) {
            if (!isIgnored(file.path, token, config.ignore)) {
              findings.push({
                file: file.path,
                line,
                patternId: "high_entropy",
                severity: "low",
                redactedExcerpt: redact(token),
              });
            }
          }
        }
      }
    }
  }

  return findings.slice(0, MAX_FINDINGS);
}

/** Entropie de Shannon en bits/char. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Masque une valeur secrète : ≤3 caractères de tête + `…` + ≤3 caractères de queue.
 * Pour les correspondances courtes, où révéler 3+3 caractères exposerait (quasi) toute la
 * valeur, on masque intégralement à la place. Le brut n'est JAMAIS retourné.
 */
export function redact(match: string): string {
  const VISIBLE_EDGE = 3;
  const MIN_LENGTH_FOR_PARTIAL_REVEAL = 12;
  if (match.length < MIN_LENGTH_FOR_PARTIAL_REVEAL) {
    return "*".repeat(match.length);
  }
  const lead = match.slice(0, VISIBLE_EDGE);
  const trail = match.slice(-VISIBLE_EDGE);
  return `${lead}…${trail}`;
}

/**
 * `true` si la valeur matchée ou le fichier doit être ignoré, d'après `.gitwandrc` `secrets.ignore[]`.
 * Une entrée `/.../ ` est un littéral regex testé contre la valeur matchée ; toute autre entrée
 * est un glob de chemin testé contre `path` (via `matchGlob`, le même moteur que les overrides de
 * politique de merge).
 */
export function isIgnored(path: string, value: string, ignore: string[]): boolean {
  for (const entry of ignore) {
    if (entry.length >= 2 && entry.startsWith("/") && entry.endsWith("/")) {
      const body = entry.slice(1, -1);
      try {
        if (new RegExp(body).test(value)) return true;
      } catch {
        // Regex d'ignore malformée — on l'ignore silencieusement.
        continue;
      }
    } else if (matchGlob(entry, path)) {
      return true;
    }
  }
  return false;
}
