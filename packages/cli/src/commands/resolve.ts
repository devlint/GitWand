/**
 * Commande `gitwand resolve` — boucle de résolution principale.
 *
 * Flux (P1.3 — parallèle) :
 * 1. découverte des fichiers (args positionnels, sinon `git diff`),
 * 2. pool concurrent borné par `--concurrency=N` (défaut 8),
 * 3. chaque worker : lit le fichier, appelle `resolve()`, écrit le résultat
 *    (partiel ou complet) sauf en `--dry-run`,
 * 4. flush ordonné des lignes d'affichage et du rapport JSON CI.
 *
 * Notes importantes :
 * - `verbose: false` est toujours passé à `resolve()` pour éviter que des
 *   `console.log` internes s'interleavent entre workers. On ré-imprime
 *   nous-mêmes un résumé plus riche (incluant `trace.summary`) en verbose.
 * - L'ordre des résultats (affichage + JSON) est garanti par `runPool` —
 *   les workers écrivent dans un tableau indexé par position d'entrée.
 * - Pas de write-race possible : chaque fichier n'a qu'un seul writer.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { resolve, resolveAsync, type MergeResult } from "@gitwand/core";

import { c, printBanner, WAND } from "../ui.js";
import { getConflictedFiles } from "../git.js";
import { parseConcurrency, runPool } from "../concurrency.js";
import { buildPartialContent } from "../partial-content.js";
import { buildCIReport } from "../reporting.js";
import { buildLlmEndpoint } from "../llm-endpoint.js";
import { resolveLlmConfig, buildResolveLlmOptions } from "../llm-config.js";

export async function cmdResolve(
  files: string[],
  flags: Record<string, boolean | string>,
): Promise<void> {
  const isCIMode = flags.ci || flags.json;
  const verbose = !isCIMode && (flags.verbose === true || typeof flags.verbose === "string");
  const resolveWhitespace = !(flags["no-whitespace"] === true);
  const concurrency = parseConcurrency(flags.concurrency);
  const llmFallbackEnabled = flags["llm-fallback"] === true;

  // v2.5 — LLM fallback opt-in. Bascule de `resolve()` vers `resolveAsync()`
  // et injecte un endpoint Node (fetch natif) qui wrap Claude / OpenAI / Ollama.
  // Le fichier `.gitwandrc.llmFallback` est mergé avec les flags CLI (flags
  // prioritaires). Aucune dep npm ajoutée : tout passe par `fetch` natif Node 20+.
  let llmCliConfig: ReturnType<typeof resolveLlmConfig>["config"] | null = null;
  let llmFileConfig: ReturnType<typeof resolveLlmConfig>["fileConfig"] | null = null;
  if (llmFallbackEnabled) {
    try {
      const resolved = resolveLlmConfig(flags);
      llmCliConfig = resolved.config;
      llmFileConfig = resolved.fileConfig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${c.red}${msg}${c.reset}`);
      process.exit(2);
    }
    // TS ne sait pas que `process.exit` ne revient pas — garde explicite.
    if (llmCliConfig === null) process.exit(2);
    // Avertissement stderr (toujours visible, même en --json) — l'utilisateur
    // doit savoir que du code va sortir de sa machine. Aucune télémétrie,
    // mais l'opt-in mérite un disclaimer clair à chaque invocation.
    console.error(
      `${c.yellow}[GitWand] LLM fallback enabled — your code will be sent to "${llmCliConfig.provider}" (model: ${llmCliConfig.model}). Review before commit.${c.reset}`,
    );
  }

  if (!isCIMode) {
    printBanner();
  }

  // If no files specified, discover from git
  if (files.length === 0) {
    files = getConflictedFiles();
    if (files.length === 0) {
      if (isCIMode) {
        console.log(JSON.stringify({ version: "0.0.1", summary: { files: 0, totalConflicts: 0, autoResolved: 0, remaining: 0, allResolved: true }, files: [] }, null, 2));
        process.exit(0);
      }
      console.log(`${c.green}No conflicted files detected.${c.reset}`);
      return;
    }
    if (!isCIMode) {
      console.log(
        `${c.cyan}${files.length} conflicted file(s) detected${c.reset}\n`,
      );
    }
  }

  // Chaque fichier est traité concurremment par le pool, mais chaque worker
  // produit (a) son MergeResult et (b) les lignes non-CI à afficher. Les
  // résultats sont indexés par position dans `files`, donc l'ordre du rapport
  // JSON et de l'affichage utilisateur reste déterministe — indépendant de
  // l'ordre de complétion des workers.
  type FileOutcome = {
    file: string;
    result: MergeResult | null; // null = fichier introuvable
    printLines: string[];
  };

  const outcomes = await runPool<string, FileOutcome>(files, concurrency, async (file) => {
    const filePath = resolvePath(file);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return {
        file,
        result: null,
        printLines: isCIMode ? [] : [`${c.red}  \u2717 ${file} — file not found${c.reset}`],
      };
    }

    // Rétro-compat : sans `--llm-fallback`, on garde le `resolve()` synchrone
    // — comportement v2.4 intact. Avec le flag, on passe par `resolveAsync()`
    // qui supporte le pattern `llm_proposed` (priorité 998 dans le core).
    const result: MergeResult = llmFallbackEnabled && llmCliConfig !== null
      ? await resolveAsync(content, file, {
          verbose: false,
          resolveWhitespace,
          llmFallback: {
            ...buildResolveLlmOptions(llmCliConfig, llmFileConfig),
            endpoint: buildLlmEndpoint(llmCliConfig),
          },
        })
      : resolve(content, file, {
          verbose: false,
          resolveWhitespace,
        });

    // Écriture sur disque (sauf dry-run). L'écriture est concurrente entre
    // fichiers distincts, mais chaque fichier n'a qu'un seul writer — il n'y
    // a donc pas de write-race possible tant que les chemins sont distincts.
    if (!flags["dry-run"] && result.stats.autoResolved > 0) {
      const newContent =
        result.mergedContent ?? buildPartialContent(content, result.resolutions);
      await writeFile(filePath, newContent, "utf-8");
    }

    const printLines: string[] = [];
    if (!isCIMode) {
      if (result.stats.totalConflicts === 0) {
        printLines.push(`${c.dim}  \u25CB ${file} — no conflicts${c.reset}`);
      } else {
        const icon = result.stats.remaining === 0 ? "\u2713" : "\u25D0";
        const color = result.stats.remaining === 0 ? c.green : c.yellow;

        printLines.push(
          `${color}  ${icon} ${file} — ${result.stats.autoResolved}/${result.stats.totalConflicts} resolved${c.reset}`,
        );

        if (verbose) {
          for (const res of result.resolutions) {
            const status = res.autoResolved
              ? `${c.green}auto${c.reset}`
              : `${c.red}manual${c.reset}`;
            printLines.push(
              `${c.dim}    L${res.hunk.startLine} [${res.hunk.type}] ${status} — ${res.hunk.explanation}${c.reset}`,
            );
            printLines.push(`${c.dim}      trace: ${res.hunk.trace.summary}${c.reset}`);
          }
        }
      }
    }

    return { file, result, printLines };
  });

  // Flush ordonné (ordre de `files`, pas ordre de complétion).
  if (!isCIMode) {
    for (const outcome of outcomes) {
      for (const line of outcome.printLines) {
        console.log(line);
      }
    }
  }

  const results: Array<{ file: string; result: MergeResult }> = [];
  let totalResolved = 0;
  let totalRemaining = 0;
  let totalConflicts = 0;
  for (const outcome of outcomes) {
    if (outcome.result === null) continue;
    results.push({ file: outcome.file, result: outcome.result });
    totalConflicts += outcome.result.stats.totalConflicts;
    totalResolved += outcome.result.stats.autoResolved;
    totalRemaining += outcome.result.stats.remaining;
  }

  // CI mode: JSON output
  if (isCIMode) {
    const report = buildCIReport(results);
    console.log(JSON.stringify(report, null, 2));

    if (report.summary.remaining > 0) {
      process.exit(1);
    }
    process.exit(0);
  }

  // Human-readable summary
  console.log(`\n${c.bold}\u2500\u2500\u2500 Summary \u2500\u2500\u2500${c.reset}`);
  console.log(
    `${c.bold}${WAND} ${totalResolved}${c.reset} conflict(s) auto-resolved out of ${c.bold}${totalConflicts}${c.reset}`,
  );

  if (totalRemaining > 0) {
    console.log(
      `${c.yellow}${totalRemaining} conflict(s) remaining — manual resolution needed${c.reset}`,
    );
  } else if (totalConflicts > 0) {
    console.log(
      `${c.green}${c.bold}All conflicts resolved! ${WAND}${c.reset}`,
    );
  }

  if (flags["dry-run"]) {
    console.log(`\n${c.dim}(dry-run — no files modified)${c.reset}`);
  }

  console.log();
}
