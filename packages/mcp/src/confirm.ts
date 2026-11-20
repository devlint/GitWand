/**
 * Asking the user to confirm through the MCP client (elicitation), so a
 * create is approved by the user, not only by the agent.
 */

import type { ClientCapabilities, ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

/** What `elicitConfirm` needs of the MCP `Server`. */
export interface ElicitingServer {
  getClientCapabilities(): ClientCapabilities | undefined;
  elicitInput(params: ElicitRequestFormParams, options?: RequestOptions): Promise<ElicitResult>;
}

/**
 * How long the user may take. Bounded, and tied to the tool call's own
 * signal: when the client gives up on the call (cancels it), the question is
 * withdrawn and nothing is created.
 */
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

/**
 * A `confirm(message)` for one tool call: true/false for the user's answer,
 * undefined when the client cannot ask with a form (no elicitation, or URL
 * mode only). A failure to ask throws.
 */
export function elicitConfirm(server: ElicitingServer, signal?: AbortSignal) {
  return async (message: string): Promise<boolean | undefined> => {
    const el = server.getClientCapabilities()?.elicitation as { form?: object; url?: object } | undefined;
    // An empty `elicitation: {}` is form mode (the spec before modes existed).
    if (!el || (!el.form && el.url)) return undefined;
    const r = await server.elicitInput(
      { message, requestedSchema: { type: "object", properties: {} } },
      { signal, timeout: CONFIRM_TIMEOUT_MS },
    );
    return r.action === "accept";
  };
}
