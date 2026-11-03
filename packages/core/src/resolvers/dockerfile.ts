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
 * - COMMENT, BLANK : préserver depuis theirs
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
  "STOPSIGNAL", "HEALTHCHECK", "SHELL",
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
      while (lines[i]?.endsWith("\\") && i + 1 < lines.length) {
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
 * Fusionne deux listes d'instructions d'un même stage Dockerfile.
 * Retourne les lignes fusionnées ou null si un conflit irréductible est détecté.
 *
 * `baseInstructions` (stage de base apparié, absent en diff2) : quand une
 * instruction diffère entre les deux côtés et qu'un côté est resté égal à la
 * base, c'est l'autre côté qui l'a changée — on garde son changement au lieu
 * d'appliquer « prefer theirs », qui effaçait en silence une modification
 * faite seulement côté ours. Seules les clés uniques dans le stage de base
 * servent (plusieurs `RUN` partagent la clé `RUN` : ambigu).
 */
function mergeStage(
  oursInstructions: Instruction[],
  theirsInstructions: Instruction[],
  baseInstructions?: Instruction[],
): string[] | null {
  // Indexer theirs par (kind, key)
  // Une clé répétée côté theirs (plusieurs `RUN`, deux `COPY` vers la même
  // destination) ne garderait que la dernière instruction dans la map, et les
  // précédentes seraient perdues : on laisse le moteur textuel. Les lignes
  // vides et commentaires partagent aussi une clé mais ne portent pas de sens.
  const theirsMap = new Map<string, Instruction>();
  for (const instr of theirsInstructions) {
    const mapKey = instr.key ? `${instr.kind}:${instr.key}` : instr.kind;
    if (theirsMap.has(mapKey) && instr.kind !== "BLANK" && instr.kind !== "COMMENT") return null;
    theirsMap.set(mapKey, instr);
  }

  const baseRawByKey = new Map<string, string | null>();
  for (const instr of baseInstructions ?? []) {
    const mapKey = instr.key ? `${instr.kind}:${instr.key}` : instr.kind;
    baseRawByKey.set(mapKey, baseRawByKey.has(mapKey) ? null : instr.raw.join("\n"));
  }

  const result: string[] = [];
  const seen = new Set<string>();

  for (const oursInstr of oursInstructions) {
    const mapKey = oursInstr.key ? `${oursInstr.kind}:${oursInstr.key}` : oursInstr.kind;
    const theirsInstr = theirsMap.get(mapKey);

    if (!theirsInstr) {
      // Instruction seulement dans ours → inclure
      result.push(...oursInstr.raw);
      seen.add(mapKey);
      continue;
    }

    seen.add(mapKey);
    const oursRaw = oursInstr.raw.join("\n");
    const theirsRaw = theirsInstr.raw.join("\n");

    if (oursRaw === theirsRaw) {
      // Identiques → inclure une fois
      result.push(...oursInstr.raw);
      continue;
    }

    // Changement d'un seul côté → le garder.
    const baseRaw = baseRawByKey.get(mapKey);
    if (typeof baseRaw === "string") {
      if (baseRaw === theirsRaw) {
        result.push(...oursInstr.raw);
        continue;
      }
      if (baseRaw === oursRaw) {
        result.push(...theirsInstr.raw);
        continue;
      }
    }

    // Conflit : stratégie par instruction
    switch (oursInstr.kind) {
      case "FROM":
        // prefer theirs (image de base plus récente)
        result.push(...theirsInstr.raw);
        break;

      case "ENV":
      case "ARG":
        // prefer theirs (valeur entrante)
        result.push(...theirsInstr.raw);
        break;

      case "WORKDIR":
      case "EXPOSE":
      case "USER":
        // prefer theirs
        result.push(...theirsInstr.raw);
        break;

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
        // prefer theirs
        result.push(...theirsInstr.raw);
    }
  }

  // Instructions seulement dans theirs
  for (const [mapKey, instr] of theirsMap) {
    if (!seen.has(mapKey)) {
      result.push(...instr.raw);
    }
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
