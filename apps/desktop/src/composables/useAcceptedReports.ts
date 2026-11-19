/**
 * Accepted proposals kept reportable for the session (#301, part 3).
 *
 * Accepting an engine or token-level proposal writes the file, and the hunk
 * (with its panel) is gone after the reparse. The merge editor tells this
 * store about every resolution it sends (`resolving`: the report for an
 * accepted proposal, `null` for anything else) and about every reparse
 * (`landed`: the index of the one hunk that went, or `null`). A copy is
 * listed only when its own write is the one that landed: a refused write
 * followed by another resolution of the same hunk lists nothing. In memory
 * only; `clear` when the file or the repository changes.
 */
import { ref, type Ref } from "vue";
import type { ResolutionReport } from "../utils/resolutionReport";

export interface AcceptedReports {
  list: Ref<ResolutionReport[]>;
  resolving(idx: number, accepted: ResolutionReport | null): void;
  landed(idx: number | null): void;
  clear(): void;
}

/**
 * How long a write may take to come back as a reparse. Past it, a refused
 * write's copy must not be credited to an unrelated change (an external
 * edit) that happens to remove a hunk at the same index.
 */
const PENDING_TTL_MS = 10_000;

export function useAcceptedReports(now: () => number = Date.now): AcceptedReports {
  const list = ref<ResolutionReport[]>([]);
  let pending: { idx: number; report: ResolutionReport | null; at: number } | null = null;

  function resolving(idx: number, accepted: ResolutionReport | null) {
    pending = { idx, report: accepted, at: now() };
  }

  function landed(idx: number | null) {
    const p = pending;
    pending = null;
    if (!p?.report || idx === null || p.idx !== idx || now() - p.at > PENDING_TTL_MS) return;
    list.value = [...list.value, p.report];
  }

  function clear() {
    list.value = [];
    pending = null;
  }

  return { list, resolving, landed, clear };
}
