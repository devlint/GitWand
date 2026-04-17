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
 */
function mergeStage(oursInstructions: Instruction[], theirsInstructions: Instruction[]): string[] | null {
  // Indexer theirs par (kind, key)
  const theirsMap = new Map<string, Instruction>();
  for (const instr of theirsInstructions) {
    const mapKey = instr.key ? `${instr.kind}:${instr.key}` : instr.kind;
    theirsMap.set(mapKey, instr);
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
  _baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): FormatResult {
  const oursInstructions = parseDockerfileInstructions(oursLines);
  const theirsInstructions = parseDockerfileInstructions(theirsLines);

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

  // Indexer les stages theirs par alias FROM
  const getStageKey = (stage: Instruction[]): string => {
    const from = stage.find((i) => i.kind === "FROM");
    return from?.key ?? from?.value ?? `__stage_${Math.random()}`;
  };

  const theirsStageMap = new Map<string, Instruction[]>();
  for (const stage of theirsStages) {
    theirsStageMap.set(getStageKey(stage), stage);
  }

  const resultLines: string[] = [];
  const seenStages = new Set<string>();

  for (const oursStage of oursStages) {
    const key = getStageKey(oursStage);
    const theirsStage = theirsStageMap.get(key);
    seenStages.add(key);

    if (!theirsStage) {
      // Stage seulement dans ours → inclure
      for (const instr of oursStage) resultLines.push(...instr.raw);
      continue;
    }

    const merged = mergeStage(oursStage, theirsStage);
    if (!merged) {
      return {
        lines: null,
        reason: "[dockerfile] Conflit irréductible dans un stage — fallback textuel.",
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
    reason: "Dockerfile — merge par stage et instruction (FROM prefer-theirs, ENV/ARG par clé, RUN conservatif).",
  };
}
