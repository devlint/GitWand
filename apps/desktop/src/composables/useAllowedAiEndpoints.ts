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

  async function load(): Promise<void> {
    loading.value = true;
    try {
      origins.value = await aiAllowedEndpoints();
      error.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
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
