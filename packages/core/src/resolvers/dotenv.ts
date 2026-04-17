/**
 * GitWand — Resolver .env (v1.4)
 *
 * Merge de fichiers .env, .env.*, *.env par clé.
 * Zéro dépendance externe.
 *
 * Grammaire supportée :
 *   LINE = COMMENT | BLANK | EXPORT? KEY '=' VALUE
 *   COMMENT = '#' ...
 *   EXPORT  = 'export '
 *   KEY     = [A-Z_][A-Z0-9_]*  (insensible à la casse pour la détection)
 *   VALUE   = QUOTED | UNQUOTED
 *
 * Limitations :
 * - Valeurs multilignes (backslash continuation) → fallback textuel
 * - Nested quotes complexes → fallback textuel
 */

// ─── Types ─────────────────────────────────────────────────────

interface EnvEntry {
  key: string;
  value: string;
  raw: string; // ligne originale
  comment: string; // commentaire inline (si présent)
  export: boolean;
}

type ParsedEnv = Map<string, EnvEntry>;

type FormatResult = { lines: string[] | null; reason: string };

// ─── Parser ──────────────────────────────────────────────────

const KEY_PATTERN = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const COMMENT_PATTERN = /^\s*#/;

/**
 * Parse un tableau de lignes .env en Map<key, EnvEntry>.
 * Les commentaires et lignes vides sont préservés dans leur entrée "précédente".
 * Retourne null si une ligne multiline (backslash) est détectée.
 */
function parseEnvLines(lines: string[]): ParsedEnv | null {
  const result: ParsedEnv = new Map();

  for (const line of lines) {
    // Backslash continuation → non supporté
    if (line.endsWith("\\")) return null;

    const trimmed = line.trim();
    if (!trimmed || COMMENT_PATTERN.test(trimmed)) {
      // Commentaire ou ligne vide : on les associe à une clé spéciale __COMMENT__N
      result.set(`__BLANK__${result.size}`, {
        key: "__BLANK__",
        value: "",
        raw: line,
        comment: "",
        export: false,
      });
      continue;
    }

    const m = trimmed.match(KEY_PATTERN);
    if (!m) continue; // ligne non reconnue → skip

    const isExport = !!m[1];
    const key = m[2];
    const rawValue = m[3].trim();

    // Séparer valeur et commentaire inline (hors guillemets)
    let value = rawValue;
    let comment = "";

    if (!rawValue.startsWith('"') && !rawValue.startsWith("'")) {
      const commentIdx = rawValue.indexOf(" #");
      if (commentIdx >= 0) {
        value = rawValue.slice(0, commentIdx).trim();
        comment = rawValue.slice(commentIdx).trim();
      }
    }

    result.set(key, { key, value, raw: line, comment, export: isExport });
  }

  return result;
}

// ─── Résolution ──────────────────────────────────────────────

/**
 * Tente de résoudre un conflit dans un fichier .env.
 */
export function tryResolveDotenvConflict(
  _baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): FormatResult {
  const oursParsed = parseEnvLines(oursLines);
  const theirsParsed = parseEnvLines(theirsLines);

  if (!oursParsed || !theirsParsed) {
    return {
      lines: null,
      reason: "[dotenv] Valeurs multilignes détectées — fallback textuel.",
    };
  }

  const result: string[] = [];
  const seen = new Set<string>();

  // Parcourir ours en premier
  for (const [mapKey, entry] of oursParsed) {
    if (mapKey.startsWith("__BLANK__")) {
      // Ligne vide ou commentaire — inclure si pas déjà dans theirs
      result.push(entry.raw);
      continue;
    }

    seen.add(entry.key);
    const theirsEntry = theirsParsed.get(entry.key);

    if (!theirsEntry) {
      // Clé seulement dans ours → inclure
      result.push(entry.raw);
    } else if (entry.value === theirsEntry.value) {
      // Même valeur → inclure une fois (ours)
      result.push(entry.raw);
    } else {
      // Valeur différente → prefer theirs (version plus récente / entrante)
      result.push(theirsEntry.raw);
    }
  }

  // Clés seulement dans theirs → les ajouter à la fin
  for (const [mapKey, entry] of theirsParsed) {
    if (mapKey.startsWith("__BLANK__")) continue; // commentaires déjà gérés
    if (!seen.has(entry.key)) {
      result.push(entry.raw);
    }
  }

  return {
    lines: result,
    reason: "Format key=value — merge par clé (.env). Nouvelles clés ajoutées des deux côtés ; conflits de valeur résolus en faveur de theirs.",
  };
}
