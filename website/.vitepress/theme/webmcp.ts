/**
 * WebMCP registration, shared by every page that exposes tools to agents.
 *
 * The spec (W3C Draft Community Group Report, 26 August 2026) puts the entry
 * point on `document.modelContext`. Tools belong to a document, which is the
 * stated reason the getter moved off Navigator on 27 May 2026.
 *
 * Chrome 150 deprecated `navigator.modelContext` but kept it as an ALIAS to
 * the same object. Registering on both locations would therefore register
 * every tool twice on the versions that matter today. Detect, pick one,
 * register once.
 *
 * Spec:   https://webmachinelearning.github.io/webmcp/
 * Chrome: https://developer.chrome.com/docs/ai/webmcp/imperative-api
 */

/**
 * MCP-style tool result. The spec serialises whatever `execute` resolves to
 * into JSON and imposes no shape, but content blocks are what MCP clients
 * already parse, so they cost nothing and travel further than a bare object.
 */
export interface ToolResult {
  content: { type: 'text'; text: string }[]
}

export interface WebMcpTool {
  /** 1-128 chars, alphanumeric plus underscore, hyphen and period. */
  name: string
  /** Written for an agent deciding whether to call it, not for a human. */
  description: string
  /** JSON Schema for the input object. */
  inputSchema: Record<string, unknown>
  execute: (input: any, options: { signal: AbortSignal }) => Promise<ToolResult>
}

interface ModelContextLike {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): Promise<void> | void
}

export type Surface = 'document' | 'navigator' | null

/** Which surface this browser exposes, if any. Null during the SSR pass. */
export function detectSurface(): Surface {
  if (typeof document === 'undefined') return null
  if ((document as any).modelContext) return 'document'
  if (typeof navigator !== 'undefined' && (navigator as any).modelContext) return 'navigator'
  return null
}

function getModelContext(surface: Surface): ModelContextLike | null {
  if (surface === 'document') return (document as any).modelContext
  if (surface === 'navigator') return (navigator as any).modelContext
  return null
}

/** Wrap a string into the content-block shape. */
export function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] }
}

export interface RegisterOutcome {
  /** Null when the browser has no WebMCP support at all. */
  surface: Surface
  registered: string[]
  failed: { name: string; reason: string }[]
}

/**
 * Register every tool on whichever surface exists, counting calls through
 * `onCall`. Returns what actually landed rather than throwing: a page that
 * cannot register its tools should still render for the humans reading it.
 */
export async function registerTools(
  tools: WebMcpTool[],
  options: { signal: AbortSignal; onCall?: (name: string) => void },
): Promise<RegisterOutcome> {
  const surface = detectSurface()
  const mc = getModelContext(surface)
  if (!mc) return { surface: null, registered: [], failed: [] }

  const registered: string[] = []
  const failed: { name: string; reason: string }[] = []

  for (const tool of tools) {
    const instrumented: WebMcpTool = {
      ...tool,
      execute: (input, execOptions) => {
        options.onCall?.(tool.name)
        return tool.execute(input, execOptions)
      },
    }
    try {
      // `signal` goes in the options argument, NOT in the tool dictionary.
      // ModelContextTool declares no `signal` member, so one set on the tool
      // itself is dropped on the floor and the tool can never be unregistered.
      await mc.registerTool(instrumented, { signal: options.signal })
      registered.push(tool.name)
    } catch (err) {
      failed.push({ name: tool.name, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return { surface, registered, failed }
}
