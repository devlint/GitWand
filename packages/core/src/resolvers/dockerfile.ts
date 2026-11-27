/**
 * GitWand — Resolver Dockerfile (v1.4)
 *
 * Merge sémantique de Dockerfiles, avec support multi-stage.
 * Zéro dépendance externe.
 *
 * Stratégies par instruction :
 * - FROM   : prefer theirs (image de base plus récente)
 * - ENV/ARG : merge par clé (union, prefer theirs)
 * - COPY/ADD : merge si destinations distinctes ; conflit si même dest
 * - RUN    : conservatif — fallback si conflit
 * - WORKDIR, EXPOSE, USER : prefer theirs si conflit
 * - COMMENT, BLANK : fusionnés par emplacement (l'instruction qu'ils précèdent)
 * - la base (diff3) départage changements, suppressions et réordonnancements
 */

// ─── Types ─────────────────────────────────────────────────────

type InstructionKind =
  | "FROM"
  | "ENV"
  | "ARG"
  | "COPY"
  | "ADD"
  | "RUN"
  | "CMD"
  | "ENTRYPOINT"
  | "WORKDIR"
  | "EXPOSE"
  | "USER"
  | "LABEL"
  | "COMMENT"
  | "BLANK"
  | "OTHER";

interface Instruction {
  kind: InstructionKind;
  raw: string[]; // lignes originales (pour les multi-lignes avec \)
  key?: string; // pour FROM: alias; pour COPY/ADD: dest; pour ENV/ARG: key
  value?: string;
}

type FormatResult = { lines: string[] | null; reason: string };

// ─── Parser ──────────────────────────────────────────────────

const DOCKERFILE_INSTRUCTIONS = new Set([
  "FROM", "RUN", "CMD", "LABEL", "EXPOSE", "ENV", "ADD", "COPY",
  "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD",
  "STOPSIGNAL", "HEALTHCHECK", "SHELL", "MAINTAINER",
]);

function parseDockerfileInstructions(lines: string[]): Instruction[] {
  const instructions: Instruction[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Ligne vide
    if (!trimmed) {
      instructions.push({ kind: "BLANK", raw: [line] });
      i++;
      continue;
    }

    // Commentaire
    if (trimmed.startsWith("#")) {
      instructions.push({ kind: "COMMENT", raw: [line] });
      i++;
      continue;
    }

    // Instruction Dockerfile
    const firstWord = trimmed.split(/\s+/)[0].toUpperCase();

    if (DOCKERFILE_INSTRUCTIONS.has(firstWord)) {
      // Collecter les lignes de continuation (\)
      const rawLines = [line];
      // `\` suivi d'espaces ou d'un `\r` (CRLF) continue aussi la ligne.
      while (/\\\s*$/.test(lines[i] ?? "") && i + 1 < lines.length) {
        i++;
        rawLines.push(lines[i]);
      }
      i++;

      const fullLine = rawLines.map((l) => l.replace(/\\\s*$/, "").trim()).join(" ");
      const rest = fullLine.slice(firstWord.length).trim();

      let instr: Instruction = { kind: firstWord as InstructionKind, raw: rawLines };

      if (firstWord === "FROM") {
        const asPart = rest.match(/\bAS\s+(\S+)/i);
        instr.key = asPart?.[1]; // alias
        instr.value = rest.replace(/\s+AS\s+\S+/i, "").trim();
      } else if (firstWord === "ENV" || firstWord === "ARG") {
        const eqIdx = rest.indexOf("=");
        if (eqIdx > 0) {
          instr.key = rest.slice(0, eqIdx).trim();
          instr.value = rest.slice(eqIdx + 1).trim();
        } else {
          instr.key = rest.split(/\s+/)[0];
          instr.value = rest.slice(instr.key.length).trim();
        }
      } else if (firstWord === "COPY" || firstWord === "ADD") {
        // Dernier token est la destination
        const parts = rest.split(/\s+/);
        instr.key = parts[parts.length - 1]; // dest
      } else if (firstWord === "WORKDIR") {
        instr.key = rest;
      }

      instructions.push(instr);
    } else {
      instructions.push({ kind: "OTHER", raw: [line] });
      i++;
    }
  }

  return instructions;
}

// ─── Merge d'un stage ─────────────────────────────────────────

/**
 * Clé d'appariement d'une instruction : `kind:key` (alias, destination, nom
 * de variable), le texte pour un commentaire (sinon tous les commentaires
 * partagent une clé et l'un remplace l'autre), `kind` seul sinon.
 */
function instructionKey(instr: Instruction): string {
  if (instr.kind === "COMMENT") return `COMMENT:${instr.raw.join("\n").trim()}`;
  return instr.key ? `${instr.kind}:${instr.key}` : instr.kind;
}

/** `ENV A=1 B=2`, `LABEL a=1 b=1` : plus d'une affectation sur la ligne. */
function assignsSeveral(instr: Instruction): boolean {
  const rest = instr.raw.map((l) => l.replace(/\\\s*$/, "").trim()).join(" ").replace(/^\S+\s+/, "");
  return (rest.match(/(?:^|\s)[A-Za-z_][\w.-]*=/g) ?? []).length > 1;
}

/** Instructions dont la clé est la valeur (chemin, destination). */
const VALUE_KEYED = new Set<InstructionKind>(["WORKDIR", "COPY", "ADD"]);

/** Une clé qui peut se répéter sans ambiguïté de sens (lignes vides, commentaires identiques). */
const repeatable = (instr: Instruction) => instr.kind === "BLANK" || instr.kind === "COMMENT";

/**
 * Sépare un stage en instructions et en groupes de commentaires/lignes vides,
 * chaque groupe rattaché à l'instruction qu'il précède (sa clé, unique d'un
 * même côté), `END` en fin de stage.
 */
function splitRepeatables(instructions: Instruction[]): {
  body: Instruction[];
  groups: Map<string, string[][]>;
  text: string;
  textOnly: string;
} {
  const body: Instruction[] = [];
  const groups = new Map<string, string[][]>();
  let pending: string[][] = [];
  for (const instr of instructions) {
    if (repeatable(instr)) {
      pending.push(instr.raw);
      continue;
    }
    body.push(instr);
    if (pending.length > 0) groups.set(instructionKey(instr), pending);
    pending = [];
  }
  if (pending.length > 0) groups.set("END", pending);
  // Signature : chaque commentaire ou ligne vide avec l'instruction qu'il
  // précède. Le texte seul ne suffit pas (le même séparateur ajouté de chaque
  // côté à un endroit différent) ; une instruction insérée sous un
  // commentaire compte donc aussi comme un changement de ce côté.
  return {
    body,
    groups,
    text: JSON.stringify([...groups.entries()]),
    // Le texte seul, dans l'ordre : identique des trois côtés, personne n'a
    // touché aux commentaires (seules des instructions ont bougé autour).
    textOnly: JSON.stringify([...groups.values()]),
  };
}

/**
 * Fusionne deux listes d'instructions d'un même stage Dockerfile.
 * Retourne les lignes fusionnées ou null si un conflit irréductible est détecté.
 *
 * Commentaires et lignes vides : un côté dont les commentaires et lignes vides
 * sont restés ceux de la base, chacun devant la même instruction, ne les a
 * pas touchés ; ceux de l'autre côté
 * sont pris en entier, chacun remis devant l'instruction qu'il précède. Si
 * les deux côtés les ont changés autrement : moteur textuel (qui fusionne
 * souvent ces lignes distinctes sans aide). Sans base, union des deux côtés,
 * sauf deux groupes différents devant la même instruction.
 *
 * `baseInstructions` (stage de base apparié, absent en diff2) départage les
 * instructions :
 * - une instruction qui diffère et dont un côté est resté égal à la base :
 *   c'est l'autre côté qui l'a changée, on garde son changement ; changée des
 *   deux côtés autrement : stratégie par instruction (« prefer theirs » pour
 *   FROM, ENV/ARG, WORKDIR, EXPOSE, USER… ; RUN, CMD, COPY/ADD : moteur
 *   textuel) ;
 * - une instruction présente d'un seul côté et dans la base : l'autre côté
 *   l'a supprimée. Restée égale à la base, elle disparaît ; modifiée, c'est
 *   un conflit modification/suppression (moteur textuel). Sans base, elle est
 *   gardée ;
 * - une instruction dont la clé est sa valeur (WORKDIR, destination d'un
 *   COPY/ADD) absente des deux côtés, avec une nouvelle de même sorte des deux
 *   côtés (changée des deux côtés), ou d'un seul côté au même endroit
 *   (changée d'un côté, supprimée de l'autre) — moteur textuel ;
 * - l'ordre : si seul theirs a réordonné les instructions communes, son ordre
 *   est gardé ; si les deux côtés les ont réordonnées autrement, moteur
 *   textuel. Une instruction présente d'un seul côté s'insère juste après
 *   celle qui la précède de son côté.
 */
function mergeStage(
  oursInstructions: Instruction[],
  theirsInstructions: Instruction[],
  baseInstructions?: Instruction[],
): string[] | null {
  const oursSplit = splitRepeatables(oursInstructions);
  const theirsSplit = splitRepeatables(theirsInstructions);
  const baseSplit = splitRepeatables(baseInstructions ?? []);
  const hasBase = (baseInstructions?.length ?? 0) > 0;

  // ── Quel côté fournit les commentaires et lignes vides.
  let source: { groups: Map<string, string[][]> } = oursSplit;
  const untouched =
    oursSplit.textOnly === theirsSplit.textOnly && (!hasBase || oursSplit.textOnly === baseSplit.textOnly);
  if (!untouched && oursSplit.text !== theirsSplit.text) {
    if (!hasBase) {
      // diff2 : rien ne dit qui a changé quoi. Union des groupes tant que les
      // deux côtés n'en placent pas un, différent, devant la même instruction.
      const union = new Map(oursSplit.groups);
      for (const [key, group] of theirsSplit.groups) {
        const text = JSON.stringify(group);
        const mine = union.get(key);
        if (mine && JSON.stringify(mine) !== text) return null;
        // Le même groupe devant une autre instruction de l'autre côté : le
        // garder aux deux endroits le dédoublerait.
        const elsewhere = [...oursSplit.groups].some(([k, g]) => k !== key && JSON.stringify(g) === text);
        if (!mine && elsewhere) return null;
        union.set(key, group);
      }
      source = { groups: union };
    } else {
      const oursChanged = oursSplit.text !== baseSplit.text;
      const theirsChanged = theirsSplit.text !== baseSplit.text;
      if (oursChanged && theirsChanged) return null;
      if (theirsChanged) source = theirsSplit;
    }
  }

  const merged = mergeBody(oursSplit.body, theirsSplit.body, hasBase ? baseSplit.body : undefined);
  if (!merged) return null;

  // ── Remettre chaque groupe juste avant son instruction.
  const out: string[] = [];
  const placed = new Set<string>();
  for (const entry of merged) {
    const group = source.groups.get(entry.key);
    if (group && !placed.has(entry.key)) {
      for (const raw of group) out.push(...raw);
      placed.add(entry.key);
    }
    out.push(...entry.lines);
  }
  for (const raw of source.groups.get("END") ?? []) out.push(...raw);
  placed.add("END");
  // Un groupe dont l'instruction n'est plus dans la sortie (supprimée, ou
  // changée par l'autre côté) : on ne sait plus où il va, moteur textuel.
  for (const key of source.groups.keys()) if (!placed.has(key)) return null;
  return out;
}

/** Fusionne les instructions (sans commentaires ni lignes vides) d'un stage. */
function mergeBody(
  oursInstructions: Instruction[],
  theirsInstructions: Instruction[],
  baseInstructions?: Instruction[],
): { key: string; lines: string[] }[] | null {
  // Une clé répétée d'un côté (plusieurs `RUN`, deux `COPY` vers la même
  // destination) ne garderait que la dernière instruction dans la map, et les
  // précédentes seraient perdues ou appariées plusieurs fois : moteur textuel.
  const indexSide = (instructions: Instruction[]): Map<string, Instruction> | null => {
    const map = new Map<string, Instruction>();
    for (const instr of instructions) {
      const key = instructionKey(instr);
      if (map.has(key)) return null;
      map.set(key, instr);
    }
    return map;
  };
  const oursMap = indexSide(oursInstructions);
  const theirsMap = indexSide(theirsInstructions);
  if (!oursMap || !theirsMap) return null;

  const hasBase = baseInstructions !== undefined;
  const baseRawByKey = new Map<string, string | null>();
  const baseRawsByKey = new Map<string, string[]>();
  for (const instr of baseInstructions ?? []) {
    const key = instructionKey(instr);
    baseRawByKey.set(key, baseRawByKey.has(key) ? null : instr.raw.join("\n"));
    baseRawsByKey.set(key, [...(baseRawsByKey.get(key) ?? []), instr.raw.join("\n")]);
  }

  if (hasBase) {
    // Clé = valeur (WORKDIR, COPY/ADD) absente des deux côtés, remplacée au
    // même endroit (même instruction avant elle) par une nouvelle de même
    // sorte d'un côté au moins : un changement, des deux côtés ou face à une
    // suppression. Une instruction de même sorte ajoutée ailleurs n'en est
    // pas un.
    const base = baseInstructions ?? [];
    const prevKey = (list: Instruction[], idx: number) => (idx > 0 ? instructionKey(list[idx - 1]) : "START");
    for (const [bIdx, baseInstr] of base.entries()) {
      const key = instructionKey(baseInstr);
      if (!VALUE_KEYED.has(baseInstr.kind) || oursMap.has(key) || theirsMap.has(key)) continue;
      const before = prevKey(base, bIdx);
      const newOfKind = (mine: Instruction[], other: Map<string, Instruction>) =>
        mine
          .map((instr, idx) => ({ instr, idx }))
          .filter(({ instr }) => {
            const k = instructionKey(instr);
            return instr.kind === baseInstr.kind && !baseRawByKey.has(k) && !other.has(k);
          });
      const oursNew = newOfKind(oursInstructions, theirsMap);
      const theirsNew = newOfKind(theirsInstructions, oursMap);
      // Une nouvelle de chaque côté, où qu'elle soit : changée des deux côtés
      // (deux valeurs gardées, la dernière gagnant en silence).
      if (oursNew.length > 0 && theirsNew.length > 0) return null;
      // D'un seul côté, au même endroit : changée face à une suppression.
      const replacedHere = (found: { instr: Instruction; idx: number }[], mine: Instruction[]) =>
        found.some(({ idx }) => prevKey(mine, idx) === before);
      if (replacedHere(oursNew, oursInstructions) || replacedHere(theirsNew, theirsInstructions)) return null;
    }
  }

  // ── Ordre : comparer l'ordre relatif des instructions présentes partout
  // (clés uniques), pour savoir qui a réordonné.
  let driveByTheirs = false;
  if (hasBase) {
    const common = (key: string) =>
      typeof baseRawByKey.get(key) === "string" && oursMap.has(key) && theirsMap.has(key);
    const order = (instructions: Instruction[]) =>
      instructions.map(instructionKey).filter(common).join("\u0000");
    const baseOrder = order(baseInstructions ?? []);
    const oursOrder = order(oursInstructions);
    const theirsOrder = order(theirsInstructions);
    const oursMoved = oursOrder !== baseOrder;
    const theirsMoved = theirsOrder !== baseOrder;
    if (oursMoved && theirsMoved && oursOrder !== theirsOrder) return null;
    driveByTheirs = theirsMoved && !oursMoved;
  }

  /**
   * Lignes d'une instruction présente d'un seul côté : gardée, supprimée
   * (l'autre côté l'a retirée sans que celui-ci la change), ou conflit.
   */
  const oneSided = (instr: Instruction): string[] | "drop" | null => {
    if (!hasBase) return instr.raw;
    const baseRaws = baseRawsByKey.get(instructionKey(instr));
    if (!baseRaws) return instr.raw; // absente de la base : ajoutée
    // Présente dans la base (une ou plusieurs copies, plusieurs `RUN`) : une
    // copie restée telle quelle a été supprimée par l'autre côté ; sinon
    // c'est une suppression face à un changement, ou une base ambiguë.
    return baseRaws.includes(instr.raw.join("\n")) ? "drop" : null;
  };

  /** Lignes d'une instruction présente des deux côtés. */
  const twoSided = (oursInstr: Instruction, theirsInstr: Instruction): string[] | null => {
    const oursRaw = oursInstr.raw.join("\n");
    const theirsRaw = theirsInstr.raw.join("\n");
    if (oursRaw === theirsRaw) return oursInstr.raw;

    const baseRaw = baseRawByKey.get(instructionKey(oursInstr));
    if (typeof baseRaw === "string") {
      // Changement d'un seul côté → le garder.
      if (baseRaw === theirsRaw) return oursInstr.raw;
      if (baseRaw === oursRaw) return theirsInstr.raw;
    }

    // Changée des deux côtés autrement (ou sans base) : stratégie par instruction.
    switch (oursInstr.kind) {
      case "COPY":
      case "ADD":
        // Même destination → conflit irréductible
        return null;
      case "RUN":
      case "CMD":
      case "ENTRYPOINT":
        // Conservatif → fallback
        return null;
      case "ENV":
      case "ARG":
      case "LABEL":
        // Plusieurs affectations sur une ligne (`ENV A=1 B=2`, `LABEL a=1 b=1`) :
        // « prefer theirs » perdrait le changement de ours sur une autre clé.
        // Moteur textuel.
        if (assignsSeveral(oursInstr) || assignsSeveral(theirsInstr)) return null;
        return theirsInstr.raw;
      case "EXPOSE":
      case "VOLUME":
        // Additives (clé = la sorte seule) : ajoutées des deux côtés sans base,
        // les deux restent ; changées des deux côtés depuis la base, moteur
        // textuel.
        return typeof baseRaw === "string" ? null : [...oursInstr.raw, ...theirsInstr.raw];
      default:
        // FROM (image de base plus récente), ENV/ARG (valeur entrante),
        // WORKDIR, EXPOSE, USER… : prefer theirs
        return theirsInstr.raw;
    }
  };

  // Le côté dont on suit l'ordre ; une instruction présente seulement de
  // l'autre côté s'insère juste après celle qui la précède de son côté (pas à
  // la fin : un `RUN` ajouté avant `USER node` doit rester avant).
  const [lead, leadIsOurs] = driveByTheirs ? [theirsInstructions, false] : [oursInstructions, true];
  const otherMap = leadIsOurs ? theirsMap : oursMap;
  const otherList = leadIsOurs ? theirsInstructions : oursInstructions;

  type Entry = { key: string; lines: string[]; otherIdx?: number };
  const out: Entry[] = [];

  for (const instr of lead) {
    const key = instructionKey(instr);
    const counterpart = otherMap.get(key);
    if (!counterpart) {
      const lines = oneSided(instr);
      if (lines === null) return null;
      if (lines !== "drop") out.push({ key, lines });
      continue;
    }
    const lines = leadIsOurs ? twoSided(instr, counterpart) : twoSided(counterpart, instr);
    if (!lines) return null;
    out.push({ key, lines });
  }

  const leadKeys = new Set(lead.map(instructionKey));
  for (const [i, instr] of otherList.entries()) {
    const key = instructionKey(instr);
    if (leadKeys.has(key)) continue; // déjà traitée avec le côté qui mène
    const lines = oneSided(instr);
    if (lines === null) return null;
    if (lines === "drop") continue;

    // Ancre : l'instruction qui la précède de son côté, déjà dans la sortie.
    let pos = 0;
    for (let j = i - 1; j >= 0; j--) {
      const found = out.findIndex((e) => e.key === instructionKey(otherList[j]));
      if (found >= 0) { pos = found + 1; break; }
    }
    // Après les insertions précédentes du même côté au même endroit.
    while (pos < out.length && out[pos].otherIdx !== undefined && out[pos].otherIdx! < i) pos++;
    out.splice(pos, 0, { key, lines, otherIdx: i });
  }

  return out.map(({ key, lines }) => ({ key, lines }));
}

// ─── Résolution ──────────────────────────────────────────────

/**
 * Tente de résoudre un conflit dans un Dockerfile.
 */
export function tryResolveDockerfileConflict(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): FormatResult {
  const oursInstructions = parseDockerfileInstructions(oursLines);
  const theirsInstructions = parseDockerfileInstructions(theirsLines);

  // Une ligne qui n'est pas une instruction (suite d'un `\` commencé avant le
  // hunk, corps de heredoc) n'a pas de clé fiable : moteur textuel.
  if ([...oursInstructions, ...theirsInstructions].some((i) => i.kind === "OTHER")) {
    return {
      lines: null,
      reason: "[dockerfile] The hunk contains lines that are not instructions (continuation or heredoc), falling back to the textual engine.",
    };
  }

  // Détecter les stages FROM…AS
  const splitByStage = (instructions: Instruction[]): Instruction[][] => {
    const stages: Instruction[][] = [];
    let current: Instruction[] = [];
    for (const instr of instructions) {
      if (instr.kind === "FROM" && current.length > 0) {
        stages.push(current);
        current = [];
      }
      current.push(instr);
    }
    if (current.length > 0) stages.push(current);
    return stages;
  };

  const oursStages = splitByStage(oursInstructions);
  const theirsStages = splitByStage(theirsInstructions);

  // Clé d'appariement des stages : l'alias `AS x` s'il existe, sinon la
  // position parmi les stages sans alias. Un stage sans FROM (hunk qui ne
  // contient que des instructions du milieu d'un stage) compte comme un stage
  // sans alias. Ne JAMAIS apparier par l'image : un FROM modifié des deux côtés
  // (node:20 vs node:22) ne s'apparierait pas et les deux stages seraient gardés.
  const stageKeys = (stages: Instruction[][]): string[] => {
    let unaliased = 0;
    return stages.map((stage) => {
      const alias = stage.find((i) => i.kind === "FROM")?.key;
      return alias !== undefined ? `alias:${alias}` : `#${unaliased++}`;
    });
  };
  const oursKeys = stageKeys(oursStages);
  const theirsKeys = stageKeys(theirsStages);

  // L'appariement par position n'a de sens que si les deux côtés ont le même
  // nombre de stages sans alias. Sinon (stage ajouté d'un côté, alias ajouté ou
  // retiré d'un côté) on ne sait pas qui correspond à qui : moteur textuel.
  const countUnaliased = (keys: string[]) => keys.filter((k) => k.startsWith("#")).length;
  if (countUnaliased(oursKeys) !== countUnaliased(theirsKeys)) {
    return {
      lines: null,
      reason: "[dockerfile] The two sides do not have the same unaliased stages, so they cannot be paired; falling back to the textual engine.",
    };
  }

  const theirsStageMap = new Map<string, Instruction[]>();
  theirsStages.forEach((stage, idx) => theirsStageMap.set(theirsKeys[idx], stage));

  // Stages de base, appariés avec les mêmes clés (base vide : diff2, sans
  // base ; mergeStage garde alors « prefer theirs »).
  const baseStageMap = new Map<string, Instruction[]>();
  if (baseLines.length > 0) {
    const baseStages = splitByStage(parseDockerfileInstructions(baseLines));
    const baseKeys = stageKeys(baseStages);
    // Une base qui n'a pas les mêmes stages sans alias ne s'apparie pas ; la
    // fusion sans base (diff2) perdrait un changement d'un seul côté au profit
    // de « prefer theirs » : moteur textuel.
    if (countUnaliased(baseKeys) !== countUnaliased(oursKeys)) {
      return {
        lines: null,
        reason: "[dockerfile] The base does not have the same unaliased stages as the two sides, falling back to the textual engine.",
      };
    }
    baseStages.forEach((stage, idx) => baseStageMap.set(baseKeys[idx], stage));
  }

  // Un stage présent d'un seul côté : gardé s'il n'est pas dans la base
  // (ajouté) ; s'il y est, l'autre côté l'a supprimé — retiré s'il est resté
  // tel quel, conflit (null) s'il a été modifié.
  const oneSidedStage = (stage: Instruction[], baseStage: Instruction[] | undefined): boolean | null => {
    if (!baseStage) return true;
    const raw = (instructions: Instruction[]) => instructions.map((i) => i.raw.join("\n")).join("\n");
    return raw(stage) === raw(baseStage) ? false : null;
  };
  const stageConflict: FormatResult = {
    lines: null,
    reason: "[dockerfile] A stage deleted on one side was changed on the other, falling back to the textual engine.",
  };

  // Les stages suivent l'ordre de ours ; un stage présent seulement dans
  // theirs se place juste après celui qui le précède dans theirs (pas à la
  // fin : un stage utilisé par `COPY --from=` doit venir avant).
  const stageOut: { key: string; lines: string[]; theirsIdx?: number }[] = [];
  const seenStages = new Set<string>();

  for (const [idx, oursStage] of oursStages.entries()) {
    const key = oursKeys[idx];
    const theirsStage = theirsStageMap.get(key);
    seenStages.add(key);

    if (!theirsStage) {
      // Stage seulement dans ours : ajouté, ou supprimé par theirs.
      const kept = oneSidedStage(oursStage, baseStageMap.get(key));
      if (kept === null) return stageConflict;
      if (kept) stageOut.push({ key, lines: oursStage.flatMap((i) => i.raw) });
      continue;
    }

    const merged = mergeStage(oursStage, theirsStage, baseStageMap.get(key));
    if (!merged) {
      return {
        lines: null,
        reason: "[dockerfile] Irreducible conflict inside a stage, falling back to the textual engine.",
      };
    }
    stageOut.push({ key, lines: merged });
  }

  // Stages seulement dans theirs : ajoutés, ou supprimés par ours.
  for (const [tIdx, stage] of theirsStages.entries()) {
    const key = theirsKeys[tIdx];
    if (seenStages.has(key)) continue;
    const kept = oneSidedStage(stage, baseStageMap.get(key));
    if (kept === null) return stageConflict;
    if (!kept) continue;
    let pos = 0;
    for (let j = tIdx - 1; j >= 0; j--) {
      const found = stageOut.findIndex((e) => e.key === theirsKeys[j]);
      if (found >= 0) { pos = found + 1; break; }
    }
    while (pos < stageOut.length && stageOut[pos].theirsIdx !== undefined && stageOut[pos].theirsIdx! < tIdx) pos++;
    stageOut.splice(pos, 0, { key, lines: stage.flatMap((i) => i.raw), theirsIdx: tIdx });
  }
  const resultLines = stageOut.flatMap((e) => e.lines);

  return {
    lines: resultLines,
    reason: "Dockerfile merged by stage and instruction (FROM prefer-theirs, ENV/ARG by key, RUN conservatively).",
  };
}
