/**
 * useTierStats — agrégat cumulatif LOCAL de la métrique « recoverable-before-model ».
 *
 * Accumule les `stats.byType` des fichiers conflictuels rencontrés (câblé dans
 * `useGitWand.loadRealFiles`) et expose le résumé par tier via
 * `summarizeTiers()` de @gitwand/core. 100 % local : localStorage, aucun
 * réseau — la télémétrie distante (Aptabase) est bloquée par un crash tokio
 * upstream, et ce cumul a d'abord une valeur d'affichage pour l'utilisateur
 * (« sur vos conflits réels, X % du résidu est récupéré avant l'IA »).
 *
 * Déduplication : `loadRealFiles` est rappelé sur le même jeu de conflits
 * (refresh, re-open) — chaque fichier est empreinté (chemin + signature
 * byType) et une empreinte déjà vue n'est pas recomptée. Les empreintes sont
 * persistées (cap FIFO) pour survivre aux redémarrages en cours de résolution.
 */
import { ref, computed, readonly } from "vue";
import { summarizeTiers, type ConflictType, type MergeStats, type TierSummary } from "@gitwand/core";

const STORAGE_KEY = "gitwand-tier-stats";
const MAX_FINGERPRINTS = 200;

interface TierStatsData {
  byType: Partial<Record<ConflictType, number>>;
  filesRecorded: number;
  since: string | null;
  /** Empreintes des fichiers déjà comptés (FIFO, cap MAX_FINGERPRINTS). */
  seen: string[];
}

function emptyData(): TierStatsData {
  return { byType: {}, filesRecorded: 0, since: null, seen: [] };
}

function load(): TierStatsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyData();
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || typeof parsed.byType !== "object") {
      return emptyData();
    }
    return {
      byType: parsed.byType ?? {},
      filesRecorded: parsed.filesRecorded ?? 0,
      since: parsed.since ?? null,
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
    };
  } catch {
    return emptyData();
  }
}

function save(data: TierStatsData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage indisponible/plein — l'agrégat reste en mémoire pour la session.
  }
}

// ─── État module (singleton, pattern stores du projet) ─────────────
let data = ref<TierStatsData>(load());

function fingerprint(cwd: string, path: string, stats: MergeStats): string {
  const sig = Object.entries(stats.byType)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, n]) => `${t}:${n}`)
    .join(",");
  return `${cwd}|${path}|${sig}`;
}

export interface TierStatsView {
  totalHunks: number;
  filesRecorded: number;
  since: string | null;
  tiers: TierSummary;
}

const tierStats = computed<TierStatsView>(() => {
  const byType = data.value.byType as Record<ConflictType, number>;
  const totalHunks = Object.values(data.value.byType).reduce((a, b) => a + (b ?? 0), 0);
  return {
    totalHunks,
    filesRecorded: data.value.filesRecorded,
    since: data.value.since,
    tiers: summarizeTiers(byType),
  };
});

function recordFile(cwd: string, path: string, stats: MergeStats): void {
  if (stats.totalConflicts === 0) return;
  const fp = fingerprint(cwd, path, stats);
  if (data.value.seen.includes(fp)) return;

  const next: TierStatsData = {
    byType: { ...data.value.byType },
    filesRecorded: data.value.filesRecorded + 1,
    since: data.value.since ?? new Date().toISOString(),
    seen: [...data.value.seen, fp].slice(-MAX_FINGERPRINTS),
  };
  for (const [type, count] of Object.entries(stats.byType)) {
    if (count > 0) {
      const t = type as ConflictType;
      next.byType[t] = (next.byType[t] ?? 0) + count;
    }
  }
  data.value = next;
  save(next);
}

function reset(): void {
  data.value = emptyData();
  save(data.value);
}

export function useTierStats() {
  return {
    tierStats: readonly(tierStats),
    recordFile,
    reset,
  };
}

/** Test-only : réinitialise l'état module (simule un redémarrage d'app). */
export function __resetTierStatsForTests(opts: { keepStorage?: boolean } = {}): void {
  if (!opts.keepStorage) {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
  data.value = load();
}
