/**
 * A bisect error for the user: GitWand's own refusals come from the backend
 * as `bisect:<code>: <English text>` (`commands/bisect.rs`,
 * `dev-bisect.mjs`) and are shown in the user's language; git's own errors
 * pass through as git wrote them.
 */
import { t } from "./useI18n";

const KEYS = {
  notHashes: "bisect.errors.notHashes",
  busy: "bisect.errors.busy",
  dirty: "bisect.errors.dirty",
  unrelated: "bisect.errors.unrelated",
  verdict: "bisect.errors.verdict",
  notBisecting: "bisect.errors.notBisecting",
  resetFailed: "bisect.errors.resetFailed",
  notInHead: "bisect.notInHead",
  headMoved: "bisect.errors.headMoved",
} as const;

export function bisectErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const code = /^bisect:(\w+):/.exec(raw)?.[1];
  return code && code in KEYS ? t(KEYS[code as keyof typeof KEYS]) : raw;
}
