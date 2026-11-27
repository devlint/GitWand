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
 * - COMMENT : appariés par leur texte ; BLANK : préservées
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

/** Une clé qui peut se répéter sans ambiguïté de sens (lignes vides, commentaires identiques). */
const repeatable = (instr: Instruction) => instr.kind === "BLANK" || instr.kind === "COMMENT";

/**
 * Fusionne deux listes d'instructions d'un même stage Dockerfile.
 * Retourne les lignes fusionnées ou null si un conflit irréductible est détecté.
 *
 * `baseInstructions` (stage de base apparié, absent en diff2) départage :
 * - une instruction qui diffère et dont un côté est resté égal à la base :
 *   c'est l'autre côté qui l'a changée, on garde son changement (au lieu de
 *   « prefer theirs », qui effaçait en silence une modification de ours) ;
 * - une instruction présente d'un seul côté et dans la base : l'autre côté
 *   l'a supprimée. Restée égale à la base, elle disparaît ; modifiée, c'est
 *   un conflit modification/suppression (moteur textuel). Sans base, elle est
 *   gardée (rien ne dit si elle a été ajoutée ou supprimée) ;
 * - l'ordre : si seul theirs a réordonné les instructions communes, son ordre
 *   est gardé ; si les deux côtés les ont réordonnées autrement, moteur
 *   textuel.
 * Seules les clés uniques dans le stage de base servent (plusieurs `RUN`
 * partagent la clé `RUN` : ambigu).
 */
function mergeStage(
  oursInstructions: Instruction[],
  theirsInstructions: Instruction[],
  baseInstructions?: Instruction[],
): string[] | null {
  // Une clé répétée d'un côté (plusieurs `RUN`, deux `COPY` vers la même
  // destination) ne garderait que la dernière instruction dans la map, et les
  // précédentes seraient perdues ou appariées plusieurs fois : moteur textuel.
  const indexSide = (instructions: Instruction[]): Map<string, Instruction> | null => {
    const map = new Map<string, Instruction>();
    for (const instr of instructions) {
      const key = instructionKey(instr);
      if (map.has(key) && !repeatable(instr)) return null;
      map.set(key, instr);
    }
    return map;
  };
  const oursMap = indexSide(oursInstructions);
  const theirsMap = indexSide(theirsInstructions);
  if (!oursMap || !theirsMap) return null;

  const baseRawByKey = new Map<string, string | null>();
  for (const instr of baseInstructions ?? []) {
    const key = instructionKey(instr);
    baseRawByKey.set(key, baseRawByKey.has(key) ? null : instr.raw.join("\n"));
  }
  const hasBase = (baseInstructions?.length ?? 0) > 0;

  // ── Ordre : comparer l'ordre relatif des instructions présentes partout
  // (clés uniques, lignes vides exclues), pour savoir qui a réordonné.
  let driveByTheirs = false;
  if (hasBase) {
    const common = (key: string) =>
      typeof baseRawByKey.get(key) === "string" && oursMap.has(key) && theirsMap.has(key) && !key.startsWith("BLANK");
    const order = (instructions: Instruction[]) => {
      const keys = instructions.map(instructionKey).filter(common);
      return keys.filter((k, i) => keys.indexOf(k) === i).join("\u0000");
    };
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
    const baseRaw = baseRawByKey.get(instructionKey(instr));
    if (typeof baseRaw !== "string") return instr.raw; // ajoutée, ou base ambiguë
    return baseRaw === instr.raw.join("\n") ? "drop" : null;
  };

  /** Lignes d'une instruction présente des deux côtés. */
  const twoSided = (oursInstr: Instruction, theirsInstr: Instruction): string[] | null => {
    const oursRaw = oursInstr.raw.join("\n");
    const theirsRaw = theirsInstr.raw.join("\n");
    if (oursRaw === theirsRaw) return oursInstr.raw;

    // Changement d'un seul côté → le garder.
    const baseRaw = baseRawByKey.get(instructionKey(oursInstr));
    if (typeof baseRaw === "string") {
      if (baseRaw === theirsRaw) return oursInstr.raw;
      if (baseRaw === oursRaw) return theirsInstr.raw;
    }

    // Conflit : stratégie par instruction
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
      default:
        // FROM (image de base plus récente), ENV/ARG (valeur entrante),
        // WORKDIR, EXPOSE, USER… : prefer theirs
        return theirsInstr.raw;
    }
  };

  // Le côté dont on suit l'ordre ; les instructions présentes seulement de
  // l'autre côté viennent ensuite.
  const [lead, leadIsOurs] = driveByTheirs ? [theirsInstructions, false] : [oursInstructions, true];
  const otherMap = leadIsOurs ? theirsMap : oursMap;
  const otherList = leadIsOurs ? theirsInstructions : oursInstructions;

  const result: string[] = [];
  const seen = new Set<string>();

  for (const instr of lead) {
    const key = instructionKey(instr);
    const counterpart = otherMap.get(key);
    seen.add(key);
    if (!counterpart) {
      const lines = oneSided(instr);
      if (lines === null) return null;
      if (lines !== "drop") result.push(...lines);
      continue;
    }
    const lines = leadIsOurs ? twoSided(instr, counterpart) : twoSided(counterpart, instr);
    if (!lines) return null;
    result.push(...lines);
  }

  for (const instr of otherList) {
    const key = instructionKey(instr);
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = oneSided(instr);
    if (lines === null) return null;
    if (lines !== "drop") result.push(...lines);
  }

  return result;
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

  // Stages de base, appariés avec les mêmes clés — seulement si la base a le
  // même nombre de stages sans alias (sinon la position ne dit rien) et n'est
  // pas vide (diff2). Sans base, mergeStage garde « prefer theirs ».
  const baseStageMap = new Map<string, Instruction[]>();
  if (baseLines.length > 0) {
    const baseStages = splitByStage(parseDockerfileInstructions(baseLines));
    const baseKeys = stageKeys(baseStages);
    if (countUnaliased(baseKeys) === countUnaliased(oursKeys)) {
      baseStages.forEach((stage, idx) => baseStageMap.set(baseKeys[idx], stage));
    }
  }

  const resultLines: string[] = [];
  const seenStages = new Set<string>();

  for (const [idx, oursStage] of oursStages.entries()) {
    const key = oursKeys[idx];
    const theirsStage = theirsStageMap.get(key);
    seenStages.add(key);

    if (!theirsStage) {
      // Stage seulement dans ours → inclure
      for (const instr of oursStage) resultLines.push(...instr.raw);
      continue;
    }

    const merged = mergeStage(oursStage, theirsStage, baseStageMap.get(key));
    if (!merged) {
      return {
        lines: null,
        reason: "[dockerfile] Irreducible conflict inside a stage, falling back to the textual engine.",
      };
    }
    resultLines.push(...merged);
  }

  // Stages seulement dans theirs → les ajouter
  for (const [key, stage] of theirsStageMap) {
    if (!seenStages.has(key)) {
      for (const instr of stage) resultLines.push(...instr.raw);
    }
  }

  return {
    lines: resultLines,
    reason: "Dockerfile merged by stage and instruction (FROM prefer-theirs, ENV/ARG by key, RUN conservatively).",
  };
}
