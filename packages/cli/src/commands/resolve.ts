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
import {
  resolve,
  resolveAsync,
  summarizeTiers,
  findEcosystem,
  buildRegenerationPlan,
  type MergeResult,
  type ConflictType,
  type RegenerationContext,
} from "@gitwand/core";

import { c, printBanner, WAND } from "../ui.js";
import { getConflictedFiles, detectMergeContext } from "../git.js";
import { parseConcurrency, runPool } from "../concurrency.js";
import { buildPartialContent } from "../partial-content.js";
import { buildCIReport } from "../reporting.js";
import { buildLlmEndpoint } from "../llm-endpoint.js";
import {
  resolveLlmConfig,
  buildResolveLlmOptions,
  findGitRoot,
  loadGitwandrcResolveGeneratedFiles,
} from "../llm-config.js";
import {
  runRegeneration,
  loadGitwandrcRegenerateFlag,
  type ResolvedSource,
} from "../regenerate-runner.js";
import { loadPersistedConventions } from "./conventions.js";

/** Un marqueur de conflit résiduel dans un contenu régénéré serait un bug de
 * l'installeur (ou un ré-échantillonnage malheureux) — même garde que celle
 * appliquée en pass 1 avant toute écriture. */
const RESIDUAL_MARKER_RE = /^(?:<{7}|={7}|>{7})/m;

export async function cmdResolve(
  files: string[],
  flags: Record<string, boolean | string>,
): Promise<void> {
  const isCIMode = flags.ci || flags.json;
  const verbose = !isCIMode && (flags.verbose === true || typeof flags.verbose === "string");
  const resolveWhitespace = !(flags["no-whitespace"] === true);
  // accuracy lot 1 — les fichiers générés déclinent par défaut ; ce flag rétablit
  // l'auto-résolution (équivalent CLI de resolveGeneratedFiles: true).
  //
  // Fix (task 3 brief, Bug A) — précédence, de la plus à la moins spécifique :
  //   --resolve-generated (true explicite) > .gitwandrc resolveGeneratedFiles
  //   (true/false explicite) > undefined (laisse la convention mesurée décider)
  //   > défaut du moteur (false). L'ancien code passait TOUJOURS un booléen
  //   concret (`=== true`, donc `false` même quand le flag n'était jamais
  //   fourni) — cela bloquait silencieusement pour toujours la précédence lot F
  //   de core (`resolver/index.ts` : un verdict "merge" ne s'applique que si
  //   `userOptions.resolveGeneratedFiles === undefined`).
  const resolveGeneratedFiles: boolean | undefined =
    flags["resolve-generated"] === true ? true : loadGitwandrcResolveGeneratedFiles();
  // accuracy lot F (Bug B fix, task 3) — conventions mesurées sur l'historique du
  // dépôt (`gitwand conventions`), si elles ont été dérivées. Jusqu'ici jamais
  // chargées ici : `options.conventions` restait toujours `undefined`, et la
  // précédence lot F de core ne pouvait donc jamais s'exercer depuis le CLI.
  const conventions = loadPersistedConventions(process.cwd());
  // accuracy lot C — contexte de merge : détecté depuis l'état .git ; null hors opération.
  // Rend déterministes les décisions qui en dépendent (versions modifiées des
  // deux côtés → la branche cible garde sa valeur).
  const mergeContext = detectMergeContext();
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
    if (verbose && mergeContext) {
      const refs = mergeContext.oursRef && mergeContext.theirsRef
        ? ` — ${mergeContext.theirsRef} → ${mergeContext.oursRef}`
        : "";
      console.log(`${c.dim}  context: ${mergeContext.operation} in progress${refs} (target: ${mergeContext.targetSide})${c.reset}`);
    }
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

  // Extrait pour être réutilisé par la pass 2 (accuracy lot D — regenerate
  // tier) : après une régénération réussie/échouée, les stats/résolutions du
  // fichier changent et la ligne affichée doit refléter le nouvel état plutôt
  // que le résultat figé de la pass 1.
  function buildFileLines(
    file: string,
    result: MergeResult,
    validationWarning: string | null,
    skipWrite: boolean,
  ): string[] {
    const printLines: string[] = [];
    if (isCIMode) return printLines;
    if (result.stats.totalConflicts === 0) {
      printLines.push(`${c.dim}  ○ ${file} — no conflicts${c.reset}`);
      return printLines;
    }

    const icon = result.stats.remaining === 0 ? "✓" : "◐";
    const color = result.stats.remaining === 0 ? c.green : c.yellow;

    printLines.push(
      `${color}  ${icon} ${file} — ${result.stats.autoResolved}/${result.stats.totalConflicts} resolved${c.reset}`,
    );

    if (validationWarning) {
      const warnColor = skipWrite ? c.red : c.yellow;
      printLines.push(`${warnColor}    ⚠ validation: ${validationWarning}${c.reset}`);
    }

    if (verbose) {
      for (const res of result.resolutions) {
        const status = res.autoResolved
          ? `${c.green}auto${c.reset}`
          : `${c.red}manual${c.reset}`;
        printLines.push(
          `${c.dim}    L${res.hunk.startLine} [${res.hunk.type}] ${status} — ${res.hunk.explanation}${c.reset}`,
        );
        printLines.push(`${c.dim}      trace: ${res.hunk.trace.summary}${c.reset}`);
        if (res.regenerationPlan) {
          printLines.push(`${c.dim}      regenerate: ${res.resolutionReason}${c.reset}`);
        }
      }
    }

    return printLines;
  }

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
          resolveGeneratedFiles,
          mergeContext,
          conventions,
          llmFallback: {
            ...buildResolveLlmOptions(llmCliConfig, llmFileConfig),
            endpoint: buildLlmEndpoint(llmCliConfig),
          },
        })
      : resolve(content, file, {
          verbose: false,
          resolveWhitespace,
          resolveGeneratedFiles,
          mergeContext,
          conventions,
        });

    // Écriture sur disque (sauf dry-run). Bloquée si des marqueurs résiduels
    // sont détectés dans mergedContent (résolution complète) — écrire un tel
    // fichier laisserait le repo dans un état conflictuel apparent. Les erreurs
    // de syntaxe n'empêchent pas l'écriture mais génèrent un avertissement.
    // buildPartialContent conserve intentionnellement les marqueurs des conflits
    // non résolus — ceux-là ne déclenchent pas le blocage.
    let skipWrite = false;
    let validationWarning: string | null = null;
    if (!flags["dry-run"] && result.stats.autoResolved > 0) {
      if (result.mergedContent !== null && result.validation.hasResidualMarkers) {
        skipWrite = true;
        validationWarning = "residual conflict markers detected — file NOT written";
      } else if (result.mergedContent !== null && !result.validation.isValid) {
        const reasons: string[] = [];
        if (result.validation.syntaxError) reasons.push(result.validation.syntaxError);
        else if ((result.validation.parseTreeErrors ?? 0) > 0)
          reasons.push(`${result.validation.parseTreeErrors} parse-tree error(s)`);
        if (reasons.length) validationWarning = reasons.join("; ");
      }
      if (!skipWrite) {
        const newContent =
          result.mergedContent ?? buildPartialContent(content, result.resolutions);
        await writeFile(filePath, newContent, "utf-8");
      }
    }

    const printLines = buildFileLines(file, result, validationWarning, skipWrite);

    return { file, result, printLines };
  });

  // ─── accuracy lot D — Pass 2 : tier de régénération (opt-in) ───
  //
  // Ne tourne QUE si `--regenerate` ou `.gitwandrc` `regenerate: true` est
  // actif, et seulement après que la pass 1 ci-dessus a produit `outcomes`
  // en entier — c'est ce qui permet de connaître l'état des AUTRES fichiers
  // du merge (sources de vérité) avant de décider qu'un plan est sûr à
  // exécuter. Voir `regenerate-runner.ts` pour l'exécution elle-même.
  const regenerateEnabled =
    !resolveGeneratedFiles && (flags.regenerate === true || loadGitwandrcRegenerateFlag());
  if (regenerateEnabled) {
    const repoRoot = findGitRoot();
    if (repoRoot !== null) {
      // Fix round 1 (Important #1) — `outcomes` ne couvre QUE les fichiers
      // que git a signalés en conflit (`getConflictedFiles()` /
      // `git diff --diff-filter=U`). Une source de vérité qui a fusionné
      // proprement (ex: `package.json` intact pendant que `package-lock.json`
      // diverge) n'apparaît JAMAIS dans `outcomes` — et `RegenerationContext.
      // siblingFiles` documente pourtant la clé comme « chaque AUTRE fichier
      // de ce merge », pas « chaque autre fichier CONFLICTÉ ». Ne pas la
      // couvrir revient à la traiter comme "conflicted" par défaut dans
      // `buildRegenerationPlan` (absente de la map ⇒ conflicted) — ce qui
      // rend `runnable` inatteignable pour le cas le plus courant (lockfile
      // seul en conflit) et rend yarn-berry totalement injoignable (son
      // marqueur `.yarnrc.yml` n'est quasiment jamais lui-même conflicté).
      const conflictedFileSet = new Set(outcomes.map((o) => o.file));
      const siblingFiles: RegenerationContext["siblingFiles"] = {};
      for (const outcome of outcomes) {
        if (outcome.result === null) continue;
        const { stats } = outcome.result;
        siblingFiles[outcome.file] = {
          state:
            stats.totalConflicts === 0
              ? "clean"
              : stats.remaining === 0
                ? "resolved"
                : "conflicted",
        };
      }
      // Pré-seed chaque source de vérité des écosystèmes candidats qui n'a
      // JAMAIS été signalée en conflit par git : par construction, "jamais
      // vue en conflit" = "clean", exactement le signal attendu par le type.
      for (const outcome of outcomes) {
        if (outcome.result === null) continue;
        const hasRegenCandidate = outcome.result.resolutions.some((res) => res.regenerationPlan !== undefined);
        if (!hasRegenCandidate) continue;
        const ecosystem = findEcosystem(outcome.file);
        if (!ecosystem) continue;
        for (const sourcePath of ecosystem.sourcesOfTruth) {
          if (!conflictedFileSet.has(sourcePath) && !(sourcePath in siblingFiles)) {
            siblingFiles[sourcePath] = { state: "clean" };
          }
        }
      }

      for (const outcome of outcomes) {
        if (outcome.result === null) continue;
        const hasRegenCandidate = outcome.result.resolutions.some((res) => res.regenerationPlan !== undefined);
        if (!hasRegenCandidate) continue;

        const ecosystem = findEcosystem(outcome.file);
        if (!ecosystem) continue; // ne devrait jamais arriver — le plan pass-1 impliquait déjà un match

        // Ruling P-1b (brief) — on IGNORE le `runnable` attaché en pass 1 (il
        // vaut toujours `false`, `regenerationContext` n'existait pas encore)
        // et on re-dérive le plan avec la carte de siblings réelle.
        const plan = buildRegenerationPlan(outcome.file, ecosystem, { siblingFiles });
        if (!plan.runnable) continue;

        const resolvedSources: ResolvedSource[] = [];
        let sourcesReady = true;
        for (const source of plan.sources) {
          const siblingOutcome = outcomes.find((o) => o.file === source.path);
          if (siblingOutcome?.result?.mergedContent != null) {
            resolvedSources.push({ path: source.path, content: siblingOutcome.result.mergedContent });
            continue;
          }
          if (!siblingOutcome) {
            // Jamais vu par la pass 1 ⇒ jamais conflicté ⇒ son contenu actuel
            // sur disque EST déjà le contenu final (rien à fusionner) : on le
            // lit directement plutôt que de le rechercher dans `outcomes`.
            try {
              const diskContent = await readFile(resolvePath(source.path), "utf-8");
              resolvedSources.push({ path: source.path, content: diskContent });
              continue;
            } catch {
              // Fichier introuvable — défensif, ne devrait pas arriver si
              // `state === "clean"` a été dérivé de "jamais en conflit".
            }
          }
          sourcesReady = false;
          break;
        }
        if (!sourcesReady) continue; // défensif : `plan.runnable` aurait dû le garantir

        const regenOutcome = await runRegeneration({
          repoRoot,
          file: outcome.file,
          ecosystem,
          resolvedSources,
        });

        const hasResidualMarkers =
          regenOutcome.kind === "success" &&
          regenOutcome.content !== null &&
          RESIDUAL_MARKER_RE.test(regenOutcome.content);

        let validationWarning: string | null = null;
        let skipWrite = false;

        if (regenOutcome.kind === "success" && regenOutcome.content !== null && !hasResidualMarkers) {
          if (!flags["dry-run"]) {
            await writeFile(resolvePath(outcome.file), regenOutcome.content, "utf-8");
          }
          const updatedResolutions = outcome.result.resolutions.map((res) =>
            res.regenerationPlan !== undefined
              ? {
                  ...res,
                  autoResolved: true,
                  resolutionReason: `${res.resolutionReason} ${regenOutcome.reason}`,
                }
              : res,
          );
          const newAutoResolved = updatedResolutions.filter((r) => r.autoResolved).length;
          outcome.result = {
            ...outcome.result,
            mergedContent: regenOutcome.content,
            resolutions: updatedResolutions,
            stats: {
              ...outcome.result.stats,
              autoResolved: newAutoResolved,
              remaining: outcome.result.stats.totalConflicts - newAutoResolved,
            },
          };
          siblingFiles[outcome.file] = {
            state: outcome.result.stats.remaining === 0 ? "resolved" : "conflicted",
          };
        } else {
          // Échec (toute nature confondue) OU succès mais contenu régénéré
          // truffé de marqueurs résiduels : le fichier reste EXACTEMENT tel
          // que la pass 1 l'a laissé sur disque — seule la raison affichée
          // gagne le détail de l'échec.
          if (hasResidualMarkers) {
            validationWarning = "regenerated content still contains conflict markers — file NOT touched";
            skipWrite = true;
          }
          const detail = hasResidualMarkers
            ? `${regenOutcome.reason} (marqueurs résiduels détectés — écriture annulée)`
            : regenOutcome.reason;
          const updatedResolutions = outcome.result.resolutions.map((res) =>
            res.regenerationPlan !== undefined
              ? { ...res, resolutionReason: `${res.resolutionReason} ${detail}` }
              : res,
          );
          outcome.result = { ...outcome.result, resolutions: updatedResolutions };
        }

        outcome.printLines = buildFileLines(outcome.file, outcome.result, validationWarning, skipWrite);
        if (verbose && !isCIMode) {
          outcome.printLines.push(
            `${c.dim}      regenerate: ${regenOutcome.trace.ecosystem} · ${regenOutcome.trace.command} · ${(regenOutcome.trace.durationMs / 1000).toFixed(1)}s · ${regenOutcome.kind}${c.reset}`,
          );
        }
      }
    }
  }

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
  const aggregateByType: Partial<Record<ConflictType, number>> = {};
  for (const outcome of outcomes) {
    if (outcome.result === null) continue;
    results.push({ file: outcome.file, result: outcome.result });
    totalConflicts += outcome.result.stats.totalConflicts;
    totalResolved += outcome.result.stats.autoResolved;
    totalRemaining += outcome.result.stats.remaining;
    for (const [type, count] of Object.entries(outcome.result.stats.byType)) {
      const t = type as ConflictType;
      aggregateByType[t] = (aggregateByType[t] ?? 0) + count;
    }
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

  // accuracy lot D (task 3, checklist item 1) — offer the regenerate tier by
  // default (not just under --verbose) whenever it's a live option: at least
  // one declined resolution carries a `regenerationPlan` (an ecosystem
  // matched), regardless of whether a measured convention exists — the
  // per-file reason text (visible via --verbose) already carries the
  // convention provenance when there is one. Suppressed when this very run
  // already used --regenerate/.gitwandrc `regenerate: true`: re-offering a
  // flag that was already applied (and, on failure, already tried) is not
  // useful. `regenerationPlan` is still attached after a failed pass-2
  // attempt, so this check must also account for that by keying off
  // `regenerateEnabled` from this same invocation.
  const hasRegenerationOffer =
    !regenerateEnabled &&
    outcomes.some((o) =>
      o.result?.resolutions.some((r) => r.regenerationPlan !== undefined && !r.autoResolved),
    );
  if (hasRegenerationOffer) {
    console.log(
      `${c.dim}Some declined file(s) could be auto-resolved by regenerating their lockfile — re-run with --regenerate.${c.reset}`,
    );
  }

  // v2.7 — "recoverable-before-model" : de ce qui dépasse les passes triviales,
  // combien reste récupérable de façon déterministe avant d'atteindre le LLM.
  // N'affiche rien si tout était trivial (résidu vide — rien à mesurer).
  const tiers = summarizeTiers(aggregateByType as Record<ConflictType, number>);
  if (tiers.residual > 0) {
    const pct = Math.round(tiers.recoverableBeforeModel * 100);
    console.log(
      `${c.dim}residual ${tiers.residual} → ${tiers.byTier.advancedDeterministic} deterministic · ${tiers.aiReachable} to model · recoverable-before-model ${pct}%${c.reset}`,
    );
  }

  if (flags["dry-run"]) {
    console.log(`\n${c.dim}(dry-run — no files modified)${c.reset}`);
  }

  console.log();
}
