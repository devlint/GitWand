/**
 * The AI endpoint origins the user allowed through the open-endpoint
 * question, for Settings to list and revoke. Loopback and the known
 * providers (Anthropic, OpenAI) never ask, so they are never listed.
 * Revoking an origin makes the next request to it ask again.
 */
import { ref } from "vue";
import { aiAllowedEndpoints, aiRevokeEndpoint } from "../utils/backend";

export function useAllowedAiEndpoints() {
  const origins = ref<string[]>([]);
  const loading = ref(false);
  /** The origin being revoked, or null. */
  const revoking = ref<string | null>(null);
  const error = ref<string | null>(null);

  // Loads can overlap (Settings opened, then a revoke): the list takes the
  // most recent answer that arrived (never an older one over a newer one),
  // only the latest load reports its failure, and `loading` holds until none
  // is in flight.
  let latest = 0;
  let applied = 0;
  let inFlight = 0;
  // The last revoke's failure. It is shown over any read error until a read
  // started after the revoke's own reload has ended succeeds: that read shows
  // what is stored, and the failure is old news by then.
  let revokeFailure: string | null = null;
  let revokeFailureUntil = Infinity;

  async function load(): Promise<void> {
    const mine = ++latest;
    inFlight++;
    loading.value = true;
    // An earlier read failure is not shown over a new read.
    error.value = revokeFailure;
    try {
      const answer = await aiAllowedEndpoints();
      if (mine > applied) {
        applied = mine;
        origins.value = answer;
      }
      if (mine === latest) {
        if (mine > revokeFailureUntil) revokeFailure = null;
        error.value = revokeFailure;
      }
    } catch (e) {
      if (mine === latest) error.value = revokeFailure ?? (e instanceof Error ? e.message : String(e));
    } finally {
      inFlight--;
      loading.value = inFlight > 0;
    }
  }

  async function revoke(origin: string): Promise<void> {
    if (revoking.value) return;
    revoking.value = origin;
    revokeFailure = null;
    revokeFailureUntil = Infinity;
    // An earlier failure is not shown while this revoke runs.
    error.value = null;
    try {
      try {
        await aiRevokeEndpoint(origin);
      } catch (e) {
        revokeFailure = e instanceof Error ? e.message : String(e);
      }
      // What is stored now, whatever happened; a failed revoke keeps its
      // message. No other revoke starts before this reload ends.
      error.value = revokeFailure;
      await load();
      revokeFailureUntil = latest;
    } finally {
      revoking.value = null;
    }
  }

  return { origins, loading, revoking, error, load, revoke };
}
