/**
 * GitWand — Résolveur de FRAGMENTS JSON (v3.11, lot E)
 *
 * `tryResolveJsonConflict` exige que chaque côté du hunk parse comme un
 * document JSON complet. Or les conflits réels de `package.json` /
 * `composer.json` sont presque toujours des fragments — quelques lignes
 * `"clé": valeur,` au milieu d'un objet. Le moteur textuel les traite ligne à
 * ligne (union non_overlapping, value_only…), ce qui est exactement la
 * mauvaise granularité : mesuré sur benchmark/, non_overlapping n'est en
 * accord avec le merge humain que 48–67 % du temps sur ces fichiers.
 *
 * Ici : 3-way par CLÉ.
 *  - ajoutée d'un côté → gardée ; supprimée d'un côté (intacte de l'autre) → supprimée ;
 *  - modifiée d'un côté → prise ; modifiée pareil des deux → prise ;
 *  - modifiée des deux côtés en valeurs DIFFÉRENTES → arbitrage borné :
 *    si les deux valeurs sont des contraintes de version au MÊME opérateur
 *    (`^7.23.0` vs `^7.23.3`), la plus récente gagne — c'est ce que les
 *    équipes livrent, mesuré sur le corpus (elles prennent la dépendance la
 *    plus récente apportée par l'autre branche). Sinon → null, fallback.
 *
 * Conservateur par construction : une ligne qui n'est pas exactement une
 * entrée `"clé": <valeur JSON mono-ligne>` (objet imbriqué multi-lignes,
 * commentaire, ligne vide) → null, on ne devine pas.
 */

// ─── Parsing d'un fragment ────────────────────────────────

export interface FragmentEntry {
  key: string;
  /** Texte source de la valeur (non re-sérialisé — le formatage d'origine est conservé). */
  valueText: string;
  /** Ligne d'origine SANS sa virgule finale (indentation et espaces intacts). */
  rawNoComma: string;
  /** La ligne d'origine portait-elle une virgule finale ? */
  hadComma: boolean;
}

const RE_ENTRY = /^(\s*)"((?:[^"\\]|\\.)+)"(\s*):(\s*)(.+?)(,?)\s*$/;

/** Parse les lignes d'un côté du hunk. `null` dès qu'une ligne n'est pas une entrée simple. */
export function parseFragmentEntries(lines: string[]): FragmentEntry[] | null {
  const entries: FragmentEntry[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.trim() === "") return null; // ligne vide → hors périmètre (conservateur)
    const m = line.match(RE_ENTRY);
    if (!m) return null;
    const [, indent, key, preColon, postColon, valueText, comma] = m;
    // La valeur doit être un JSON mono-ligne valide (scalaire, tableau ou objet inline).
    try {
      JSON.parse(valueText);
    } catch {
      return null;
    }
    if (seen.has(key)) return null; // clé dupliquée dans un même côté → on ne devine pas
    seen.add(key);
    entries.push({
      key,
      valueText,
      rawNoComma: `${indent}"${key}"${preColon}:${postColon}${valueText}`,
      hadComma: comma === ",",
    });
  }
  return entries.length > 0 ? entries : null;
}

// ─── Arbitrage des contraintes de version ─────────────────

const RE_RANGE = /^"([\^~]?)v?(\d+)\.(\d+)(?:\.(\d+))?"$/;

/**
 * Si `a` et `b` sont deux contraintes de version au même opérateur
 * (`"^7.23.0"` vs `"^7.23.3"`), retourne la plus récente. Sinon `null`.
 * Volontairement strict : opérateurs différents, wildcards, prérelease,
 * plages composées → null.
 */
export function pickNewerRange(a: string, b: string): string | null {
  const ma = a.match(RE_RANGE);
  const mb = b.match(RE_RANGE);
  if (!ma || !mb) return null;
  if (ma[1] !== mb[1]) return null; // ^ vs ~ vs pin : intentions différentes → décision humaine
  const va = [Number(ma[2]), Number(ma[3]), Number(ma[4] ?? 0)];
  const vb = [Number(mb[2]), Number(mb[3]), Number(mb[4] ?? 0)];
  for (let i = 0; i < 3; i++) {
    if (va[i] > vb[i]) return a;
    if (va[i] < vb[i]) return b;
  }
  return a; // égales
}

// ─── Merge 3-way par clé ──────────────────────────────────

export interface FragmentMergeResult {
  lines: string[] | null;
  reason: string;
}

export function tryResolveJsonFragment(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): FragmentMergeResult {
  const ours = parseFragmentEntries(oursLines);
  const theirs = parseFragmentEntries(theirsLines);
  if (!ours || !theirs) {
    return { lines: null, reason: "Fragment JSON : lignes non reconnues comme entrées « \"clé\": valeur » simples." };
  }
  // Base absente (diff2) → traitée comme vide : tout est « ajouté ».
  const base = baseLines.length > 0 ? parseFragmentEntries(baseLines) : [];
  if (base === null) {
    return { lines: null, reason: "Fragment JSON : base non reconnue comme liste d'entrées simples." };
  }

  const bMap = new Map(base.map((e) => [e.key, e]));
  const oMap = new Map(ours.map((e) => [e.key, e]));
  const tMap = new Map(theirs.map((e) => [e.key, e]));

  let merged = 0;
  let arbitrated = 0;

  /** Décide l'entrée survivante pour une clé, ou "drop", ou null (conflit réel). */
  function decide(key: string): FragmentEntry | "drop" | null {
    const b = bMap.get(key);
    const o = oMap.get(key);
    const t = tMap.get(key);
    const eq = (x?: FragmentEntry, y?: FragmentEntry) =>
      !!x && !!y && JSON.stringify(JSON.parse(x.valueText)) === JSON.stringify(JSON.parse(y.valueText));

    if (o && t) {
      if (eq(o, t)) return o;                       // identiques (même modif ou intacts)
      if (b && eq(b, o)) { merged++; return t; }     // seul theirs a changé
      if (b && eq(b, t)) { merged++; return o; }     // seul ours a changé
      // Modifiée/ajoutée des deux côtés avec des valeurs différentes.
      const winner = pickNewerRange(o.valueText, t.valueText);
      if (winner !== null) {
        arbitrated++;
        return winner === o.valueText ? o : t;
      }
      return null;
    }
    if (o && !t) {
      if (!b) return o;                              // ajoutée par ours
      if (eq(b, o)) return "drop";                   // supprimée par theirs, intacte chez ours
      return null;                                   // modifiée par ours ET supprimée par theirs
    }
    if (!o && t) {
      if (!b) return t;
      if (eq(b, t)) return "drop";
      return null;
    }
    return "drop"; // supprimée des deux côtés
  }

  // Ordre de sortie : la séquence de ours, puis insertion des clés propres à
  // theirs juste après leur prédécesseur dans theirs (ou en tête / à la fin).
  const outKeys: string[] = [];
  const decided = new Map<string, FragmentEntry>();
  const allKeys = new Set([...oMap.keys(), ...tMap.keys()]);

  for (const key of allKeys) {
    const d = decide(key);
    if (d === null) {
      return { lines: null, reason: `Fragment JSON : la clé « ${key} » est modifiée des deux côtés avec des valeurs non arbitrables — décision humaine.` };
    }
    if (d !== "drop") decided.set(key, d);
  }

  for (const e of ours) if (decided.has(e.key)) outKeys.push(e.key);
  const theirsKeys = theirs.map((e) => e.key);
  for (let i = 0; i < theirsKeys.length; i++) {
    const key = theirsKeys[i];
    if (!decided.has(key) || outKeys.includes(key)) continue;
    // Prédécesseur (dans theirs) déjà placé → insérer juste après lui.
    let anchor = -1;
    for (let j = i - 1; j >= 0; j--) {
      const at = outKeys.indexOf(theirsKeys[j]);
      if (at !== -1) { anchor = at; break; }
    }
    outKeys.splice(anchor + 1, 0, key);
  }

  // Les maps de dépendances sont triées alphabétiquement par convention (npm
  // l'impose à l'install). Si les DEUX côtés étaient déjà triés, on trie la
  // sortie — c'est ce que l'outillage de l'équipe aurait produit. Sinon on
  // respecte l'ordre reconstruit ci-dessus.
  const isSorted = (keys: string[]) => keys.every((k, i) => i === 0 || keys[i - 1].localeCompare(k) <= 0);
  if (isSorted(ours.map((e) => e.key)) && isSorted(theirsKeys)) {
    outKeys.sort((a, b) => a.localeCompare(b));
  }

  // Virgules : chaque ligne sauf la dernière en porte une ; la dernière suit la
  // convention du fragment d'origine (dernière ligne de ours et theirs d'accord,
  // sinon on décline plutôt que de risquer un JSON invalide).
  const oursLast = ours[ours.length - 1].hadComma;
  const theirsLast = theirs[theirs.length - 1].hadComma;
  if (oursLast !== theirsLast) {
    return { lines: null, reason: "Fragment JSON : convention de virgule finale incohérente entre les deux côtés." };
  }

  const lines = outKeys.map((key, idx) => {
    const e = decided.get(key)!;
    const isLast = idx === outKeys.length - 1;
    return e.rawNoComma + (isLast ? (oursLast ? "," : "") : ",");
  });

  return {
    lines,
    reason: `Fragment JSON fusionné par clé : ${outKeys.length} entrée(s), ${merged} modification(s) unilatérale(s) prise(s)${arbitrated ? `, ${arbitrated} contrainte(s) de version arbitrée(s) vers la plus récente` : ""}.`,
  };
}
