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

  // Loads can overlap (Settings opened, then a revoke): only the latest one
  // writes its answer, and `loading` holds until none is in flight.
  let latest = 0;
  let inFlight = 0;

  async function load(): Promise<void> {
    const mine = ++latest;
    inFlight++;
    loading.value = true;
    try {
      const answer = await aiAllowedEndpoints();
      if (mine === latest) {
        origins.value = answer;
        error.value = null;
      }
    } catch (e) {
      if (mine === latest) error.value = e instanceof Error ? e.message : String(e);
    } finally {
      inFlight--;
      loading.value = inFlight > 0;
    }
  }

  async function revoke(origin: string): Promise<void> {
    if (revoking.value) return;
    revoking.value = origin;
    let failure: string | null = null;
    try {
      await aiRevokeEndpoint(origin);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    } finally {
      revoking.value = null;
    }
    // What is stored now, whatever happened; a failed revoke keeps its message.
    await load();
    if (failure) error.value = failure;
  }

  return { origins, loading, revoking, error, load, revoke };
}
