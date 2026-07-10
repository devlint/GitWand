/**
 * v3.5.0 — Types partagés du scanner de secrets.
 *
 * Mirroir Rust : `apps/desktop/src-tauri/src/types.rs` (SecretFinding, SecretPatternInput,
 * SecretsScanConfig). Toute modification de forme ici doit être répercutée côté Rust — voir le
 * test de parité (Task 7).
 */

export type SecretSeverity = "high" | "medium" | "low";

/** Un détecteur built-in ou fourni par l'utilisateur via `.gitwandrc`. */
export interface SecretPattern {
  /** Identifiant stable, ex: "aws_access_key_id", "github_pat_classic". */
  id: string;
  /** Sous-ensemble commun Rust+JS — PAS de lookaround / backreferences. */
  regex: string;
  severity: SecretSeverity;
  /** Description par défaut en anglais ; l'UI affiche une clé i18n par id quand elle existe. */
  description: string;
}

/** Entrée du scanner pur (l'appelant extrait ceci depuis `git diff --cached`). */
export interface ScanFileInput {
  path: string;
  addedLines: Array<{ line: number; text: string }>;
}

/** Config effective : built-ins + extensions utilisateur, résolue par l'appelant. */
export interface SecretsScanConfig {
  /** Interrupteur maître (app setting ET .gitwandrc secrets.enabled). */
  enabled: boolean;
  /** Depuis .gitwandrc secrets.patterns[]. */
  extraPatterns: SecretPattern[];
  /** Chemins glob OU littéraux /regex/ à ignorer, depuis .gitwandrc. */
  ignore: string[];
  /** Bits/char Shannon sur tokens longs ; 0 désactive la détection par entropie. */
  entropyThreshold: number;
}

export interface SecretFinding {
  file: string;
  line: number;
  /** id built-in, id utilisateur, ou "high_entropy". */
  patternId: string;
  severity: SecretSeverity;
  /** Excerpt masqué au centre — JAMAIS le secret brut. */
  redactedExcerpt: string;
}
