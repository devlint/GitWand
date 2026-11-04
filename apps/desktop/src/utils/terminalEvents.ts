/** What `terminal_open` streams on its one channel (`TerminalEvent` in Rust). */
export type TerminalEvent = { type: "chunk"; data: string } | { type: "exit"; code: number | null };

/** Routes one channel event: chunks to `onOutput`, the final exit to `onExit`. */
export function dispatchTerminalEvent(
  event: TerminalEvent,
  onOutput: (chunk: string) => void,
  onExit: ((code: number | null) => void) | undefined,
): void {
  if (event.type === "chunk") onOutput(event.data);
  else onExit?.(event.code ?? null);
}
