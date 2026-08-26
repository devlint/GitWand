/**
 * `gitwand conventions` — mesurer les conventions de merge du dépôt courant
 * sur son propre historique (accuracy lot F).
 *
 * Rejoue les merges passés (git merge-tree, sans toucher au working tree),
 * compare les sorties de règles candidates à ce que l'équipe a réellement
 * commité, et n'émet un verdict qu'au-dessus des planchers de preuve. Résultat
 * écrit dans `.git/gitwand/conventions.json` — par clone, jamais commité, et
 * toujours battu par un `.gitwandrc` explicite.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  deriveConventions,
  isChangelogFile,
  isGeneratedFile,
  parseConflictMarkers,
  resolve as gwResolve,
  type ConventionObservation,
  type RepoConventions,
} from "@gitwand/core";

import { c, printBanner } from "../ui.js";

const MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_MERGES = 200;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Remplace chaque bloc de conflit par un seul côté — le candidat « tel quel ». */
function takeSide(content: string, side: "ours" | "theirs"): string {
  const { segments } = parseConflictMarkers(content);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.type === "text") out.push(...seg.lines);
    else out.push(...(side === "ours" ? seg.conflict.oursLines : seg.conflict.theirsLines));
  }
  return out.join("\n");
}

/** Famille de chemins pour pathPolicy : l'extension. */
function bucketOf(path: string): string | null {
  const m = path.match(/\.([A-Za-z0-9]+)$/);
  return m ? `**/*.${m[1].toLowerCase()}` : null;
}

export interface DeriveRunResult {
  conventions: RepoConventions;
  skipped: { unreadable: number; tooLarge: number };
  /** Matière première du verdict — exposée pour l'audit et la validation split-half. */
  observations: ConventionObservation[];
}

/**
 * Le replay lui-même. Borné (maxMerges), en lecture seule sur l'objet-store
 * (`merge-tree --write-tree` n'écrit que des objets non référencés, ramassés
 * par gc), jamais le working tree.
 */
/** `merge-tree --write-tree` (le cœur du replay) exige git >= 2.38. */
export function supportsMergeTreeWriteTree(): boolean {
  try {
    const out = execFileSync("git", ["--version"], { encoding: "utf-8" });
    const m = out.match(/(\d+)\.(\d+)/);
    if (!m) return false;
    const [maj, min] = [Number(m[1]), Number(m[2])];
    return maj > 2 || (maj === 2 && min >= 38);
  } catch {
    return false;
  }
}

export function deriveFromHistory(cwd: string, maxMerges: number): DeriveRunResult {
  if (!supportsMergeTreeWriteTree()) {
    throw new Error("gitwand conventions requires git >= 2.38 (merge-tree --write-tree). Update git and retry.");
  }
  const merges = git(cwd, ["rev-list", "--merges", `--max-count=${String(maxMerges)}`, "HEAD"])
    .split("\n")
    .filter(Boolean);

  const observations: ConventionObservation[] = [];
  const skipped = { unreadable: 0, tooLarge: 0 };

  for (const merge of merges) {
    const parents = git(cwd, ["rev-list", "--parents", "-n", "1", merge]).trim().split(" ").slice(1);
    if (parents.length !== 2) continue; // octopus hors périmètre

    let treeOid = "";
    let files: string[] = [];
    try {
      git(cwd, ["-c", "merge.conflictstyle=diff3", "merge-tree", "--write-tree", "--name-only", parents[0], parents[1]]);
      continue; // merge propre → aucune observation
    } catch (err: any) {
      if (err.status !== 1 || typeof err.stdout !== "string") continue;
      const head = err.stdout.split("\n\n")[0].split("\n").filter(Boolean);
      treeOid = head[0];
      files = head.slice(1);
    }

    for (const path of new Set(files)) {
      let conflicted: string;
      let human: string;
      try {
        conflicted = git(cwd, ["show", `${treeOid}:${path}`]);
        human = git(cwd, ["show", `${merge}:${path}`]);
      } catch {
        skipped.unreadable++;
        continue;
      }
      if (conflicted.length > MAX_FILE_BYTES || conflicted.includes("\0") || !conflicted.includes("<<<<<<<")) {
        skipped.tooLarge++;
        continue;
      }

      // Le premier parent d'un commit de merge EST la branche cible.
      const mergeContext = { operation: "merge" as const, targetSide: "ours" as const };

      if (isGeneratedFile(path).generated) {
        // Candidat « merge » : la fusion sémantique (opt-in forcé) reproduit-elle
        // le commit ? Une fusion impossible compte comme un non — si le moteur ne
        // peut même pas produire de fusion, elle ne reproduit certainement pas ce
        // que l'équipe livre, et c'est une preuve de plus pour « regenerate ».
        try {
          const r = gwResolve(conflicted, path, { resolveGeneratedFiles: true, mergeContext });
          observations.push({
            question: "generatedFiles",
            path,
            candidates: { merge: r.mergedContent !== null && r.mergedContent === human },
          });
        } catch { skipped.unreadable++; }
        continue;
      }

      if (isChangelogFile(path)) {
        let union = false;
        try {
          const r = gwResolve(conflicted, path, { mergeContext });
          union = r.mergedContent !== null && r.mergedContent === human;
        } catch { /* union reste false */ }
        const target = takeSide(conflicted, "ours") === human;
        observations.push({ question: "changelog", path, candidates: { union, "target-structure": target } });
        continue;
      }

      // pathPolicy : le fichier livré est-il un côté tel quel ?
      const bucket = bucketOf(path);
      if (bucket) {
        const ours = takeSide(conflicted, "ours") === human;
        const theirs = takeSide(conflicted, "theirs") === human;
        observations.push({ question: "pathPolicy", path, bucket, candidates: { "prefer-ours": ours, "prefer-theirs": theirs } });
      }
    }
  }

  const enginePkg = JSON.parse(
    readFileSync(new URL("../../node_modules/@gitwand/core/package.json", import.meta.url), "utf-8"),
  ) as { version: string };

  const conventions = deriveConventions(observations, {
    mergesReplayed: merges.length,
    derivedAt: new Date().toISOString(),
    engineVersion: enginePkg.version,
  });
  return { conventions, skipped, observations };
}

// ─── Stockage ─────────────────────────────────────────────

export function conventionsPath(cwd: string): string {
  const gitDir = git(cwd, ["rev-parse", "--absolute-git-dir"]).trim();
  return join(gitDir, "gitwand", "conventions.json");
}

function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, path);
}

// ─── Commande ─────────────────────────────────────────────

function printVerdicts(conv: RepoConventions): void {
  const pct = (n: number) => `${Math.round(n * 100)} %`;
  console.log(`${c.dim}  measured on ${conv.evidence.mergesReplayed} merges / ${conv.evidence.conflictedFiles} conflicted files (engine ${conv.evidence.engineVersion}, ${conv.evidence.derivedAt})${c.reset}\n`);
  const row = (q: string, v: string, s: number, a: number) =>
    console.log(`  ${q.padEnd(16)} ${c.bold}${v}${c.reset}  ${c.dim}(${s} samples, ${pct(a)})${c.reset}`);
  if (conv.generatedFiles) row("generated files", conv.generatedFiles.verdict, conv.generatedFiles.samples, conv.generatedFiles.agreement);
  if (conv.changelog) row("changelog", conv.changelog.verdict, conv.changelog.samples, conv.changelog.agreement);
  if (conv.versionIdentity) row("version identity", conv.versionIdentity.verdict, conv.versionIdentity.samples, conv.versionIdentity.agreement);
  if (!conv.generatedFiles && !conv.changelog && !conv.versionIdentity) {
    console.log(`  ${c.dim}no verdict cleared the evidence floor (≥5 samples, ≥80 % agreement) — engine defaults apply${c.reset}`);
  }
  if (conv.pathPolicies?.length) {
    console.log(`\n  ${c.bold}suggested .gitwandrc patternOverrides${c.reset} ${c.dim}(reported, never auto-applied)${c.reset}:`);
    const patterns = Object.fromEntries(conv.pathPolicies.map((p) => [p.glob, p.policy]));
    console.log(
      JSON.stringify({ patterns }, null, 2)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }
}

export async function cmdConventions(flags: Record<string, boolean | string>): Promise<void> {
  const cwd = process.cwd();
  const asJson = flags.json === true;
  const path = conventionsPath(cwd);

  if (flags.clear === true) {
    rmSync(path, { force: true });
    if (!asJson) console.log(`${c.green}✓ derived conventions cleared${c.reset}`);
    return;
  }

  if (flags.show === true) {
    if (!existsSync(path)) {
      console.log(asJson ? "null" : `${c.dim}no derived conventions — run \`gitwand conventions\` to measure them${c.reset}`);
      return;
    }
    const conv = JSON.parse(readFileSync(path, "utf-8")) as RepoConventions;
    if (asJson) console.log(JSON.stringify(conv, null, 2));
    else { printBanner(); printVerdicts(conv); }
    return;
  }

  const maxMerges = typeof flags["max-merges"] === "string" ? Math.max(1, Number(flags["max-merges"]) || DEFAULT_MAX_MERGES) : DEFAULT_MAX_MERGES;
  if (!asJson) {
    printBanner();
    console.log(`${c.dim}  replaying up to ${maxMerges} historical merges (read-only)…${c.reset}\n`);
  }

  const { conventions, skipped } = deriveFromHistory(cwd, maxMerges);
  writeAtomic(path, JSON.stringify(conventions, null, 2) + "\n");

  if (asJson) {
    console.log(JSON.stringify({ conventions, skipped }, null, 2));
  } else {
    printVerdicts(conventions);
    if (skipped.unreadable + skipped.tooLarge > 0) {
      console.log(`\n${c.dim}  skipped: ${skipped.unreadable} unreadable, ${skipped.tooLarge} too large/binary${c.reset}`);
    }
    console.log(`\n${c.green}✓ written to .git/gitwand/conventions.json${c.reset} ${c.dim}(per-clone, never committed; an explicit .gitwandrc always wins)${c.reset}`);
  }
}
