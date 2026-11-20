#!/usr/bin/env node

/**
 * @gitwand/mcp — MCP server for smart Git conflict resolution
 *
 * Exposes GitWand's conflict resolution engine as MCP tools and resources
 * for use with Claude Code, Claude Desktop, Cursor, Windsurf, etc.
 *
 * Usage:
 *   npx @gitwand/mcp                    # stdio transport (default)
 *   npx @gitwand/mcp --cwd /path/repo   # specify repo directory
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { registerTools, handleToolCall } from "./tools/index.js";
import { registerResources, handleResourceRead } from "./resources/index.js";

// ─── Parse CLI args ────────────────────────────────────────
const args = process.argv.slice(2);
let cwd = process.cwd();

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cwd" && args[i + 1]) {
    cwd = args[i + 1];
    i++;
  }
}

// ─── Server setup ──────────────────────────────────────────
const server = new Server(
  {
    name: "gitwand",
    version: "3.13.2",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

// ─── Tools ─────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: registerTools(),
}));

/**
 * Asks the user directly (MCP elicitation) when the client supports it: a
 * create is then confirmed by the user, not only by the agent. Undefined when
 * the client cannot ask.
 */
async function confirm(message: string): Promise<boolean | undefined> {
  if (!server.getClientCapabilities()?.elicitation) return undefined;
  // The user reads the whole issue first: give them time. A failure (or no
  // answer in time) throws, and the tool reports it as such, not as a no.
  const r = await server.elicitInput(
    { message, requestedSchema: { type: "object", properties: {} } },
    { timeout: 10 * 60_000 },
  );
  return r.action === "accept";
}

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  return handleToolCall(request.params.name, request.params.arguments ?? {}, cwd, { confirm });
});

// ─── Resources ─────────────────────────────────────────────
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: registerResources(),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request: any) => {
  return handleResourceRead(request.params.uri, cwd);
});

// ─── Start ─────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[gitwand-mcp] Server started on stdio");
}

main().catch((err) => {
  console.error("[gitwand-mcp] Fatal error:", err);
  process.exit(1);
});
