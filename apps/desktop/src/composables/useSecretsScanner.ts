import { computed, ref, type ComputedRef, type Ref } from "vue";
import { parseGitwandrc, type SecretPattern } from "@gitwand/core";
import {
  readGitwandrc,
  scanSecrets,
  writeGitwandrc,
  type SecretFinding,
  type SecretsScanConfig,
} from "../utils/backend";
import type { AppSettings } from "./useSettings";

/** The app-setting subset needed to resolve an effective `SecretsScanConfig`. */
export type SecretsScannerAppSettings = Pick<AppSettings, "secretsScannerEnabled" | "secretsEntropyThreshold">;

export interface UseSecretsScannerOptions {
  /** Debounce (ms) applied to `scan()` — coalesces rapid staged-set changes. Default 400. */
  debounceMs?: number;
}

export interface UseSecretsScannerResult {
  /** Raw findings from the last completed scan. */
  findings: Ref<SecretFinding[]>;
  /** True while a scan is in flight. */
  scanning: Ref<boolean>;
  /** `findings` minus session-dismissed entries — what the UI should render. */
  activeFindings: ComputedRef<SecretFinding[]>;
  /**
   * Debounced scan trigger. Wire this to the existing staged-set refresh flow
   * (never a `setInterval` — see apps/desktop/CLAUDE.md P6.4).
   */
  scan: (cwd: string, settings: SecretsScannerAppSettings) => void;
  /**
   * Suppresses `patternId` for every file it currently appears in, by appending each affected
   * file path as a glob entry to `.gitwandrc` `secrets.ignore[]`. The underlying ignore config
   * only supports path-globs and value-regexes (no patternId-based ignore) — and `SecretFinding`
   * intentionally never carries the raw matched value (Task 3's redaction contract), so a
   * value-regex can't be reconstructed here for `high_entropy` findings either. Suppressing by
   * file is the safe, structurally-supported option for both cases.
   */
  ignorePattern: (cwd: string, patternId: string) => Promise<void>;
  /** Session-only hide — does not touch `.gitwandrc` or `findings`. */
  dismiss: (key: string) => void;
  /** Stable per-finding identity used by `dismiss`. */
  findingKey: (finding: SecretFinding) => string;
}

function findingKey(f: SecretFinding): string {
  return `${f.file}:${f.line}:${f.patternId}`;
}

interface ResolvedGitwandrcSecrets {
  enabled?: boolean;
  extraPatterns: SecretPattern[];
  ignore: string[];
  entropyThreshold?: number;
}

/**
 * v3.5.0 — Local, non-blocking secrets scanner over the staged diff. Business logic for the
 * commit-area badge + findings modal (App.vue / SecretsFindingsModal.vue); components stay thin.
 */
export function useSecretsScanner(opts: UseSecretsScannerOptions = {}): UseSecretsScannerResult {
  const { debounceMs = 400 } = opts;

  const findings = ref<SecretFinding[]>([]);
  const scanning = ref(false);
  const dismissedKeys = ref<Set<string>>(new Set());

  const activeFindings = computed(() =>
    findings.value.filter((f) => !dismissedKeys.value.has(findingKey(f))),
  );

  let timer: ReturnType<typeof setTimeout> | null = null;

  // Per-repo cache of the resolved `.gitwandrc` `secrets` block, scoped to this composable
  // instance — avoids re-reading + re-parsing `.gitwandrc` on every staged-set change.
  // Invalidated whenever `ignorePattern` writes to it.
  const gitwandrcSecretsCache = new Map<string, ResolvedGitwandrcSecrets>();

  async function resolveGitwandrcSecrets(cwd: string): Promise<ResolvedGitwandrcSecrets> {
    const cached = gitwandrcSecretsCache.get(cwd);
    if (cached) return cached;

    let resolved: ResolvedGitwandrcSecrets = { extraPatterns: [], ignore: [] };
    try {
      const rcRaw = await readGitwandrc(cwd);
      if (rcRaw.trim()) {
        const parsed = parseGitwandrc(rcRaw);
        resolved = {
          enabled: parsed?.secrets?.enabled,
          extraPatterns: parsed?.secrets?.patterns ?? [],
          ignore: parsed?.secrets?.ignore ?? [],
          entropyThreshold: parsed?.secrets?.entropyThreshold,
        };
      }
    } catch {
      // No .gitwandrc, or unreadable — fall back to built-ins + app settings only.
    }

    gitwandrcSecretsCache.set(cwd, resolved);
    return resolved;
  }

  async function resolveConfig(cwd: string, settings: SecretsScannerAppSettings): Promise<SecretsScanConfig> {
    const secrets = await resolveGitwandrcSecrets(cwd);
    return {
      enabled: secrets.enabled ?? settings.secretsScannerEnabled,
      extraPatterns: secrets.extraPatterns,
      ignore: secrets.ignore,
      entropyThreshold: secrets.entropyThreshold ?? settings.secretsEntropyThreshold,
    };
  }

  async function runScan(cwd: string, settings: SecretsScannerAppSettings): Promise<void> {
    const config = await resolveConfig(cwd, settings);
    if (!config.enabled) {
      findings.value = [];
      return;
    }
    scanning.value = true;
    try {
      findings.value = await scanSecrets(cwd, config);
    } catch {
      // Non-blocking by design — a scan failure must never disrupt the commit flow.
      findings.value = [];
    } finally {
      scanning.value = false;
    }
  }

  function scan(cwd: string, settings: SecretsScannerAppSettings): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void runScan(cwd, settings);
    }, debounceMs);
  }

  async function ignorePattern(cwd: string, patternId: string): Promise<void> {
    const affectedFiles = Array.from(
      new Set(findings.value.filter((f) => f.patternId === patternId).map((f) => f.file)),
    );
    if (affectedFiles.length === 0) return;

    let existingRc: Record<string, unknown> = {};
    let existingIgnore: string[] = [];
    try {
      const rcRaw = await readGitwandrc(cwd);
      if (rcRaw.trim()) {
        existingRc = JSON.parse(rcRaw);
        const parsed = parseGitwandrc(rcRaw);
        existingIgnore = parsed?.secrets?.ignore ?? [];
      }
    } catch {
      // Malformed or absent .gitwandrc — write a fresh one below.
    }

    const nextIgnore = Array.from(new Set([...existingIgnore, ...affectedFiles]));
    const existingSecrets =
      typeof existingRc.secrets === "object" && existingRc.secrets !== null
        ? (existingRc.secrets as Record<string, unknown>)
        : {};

    await writeGitwandrc(cwd, {
      ...existingRc,
      secrets: { ...existingSecrets, ignore: nextIgnore },
    });

    gitwandrcSecretsCache.delete(cwd);
    // Optimistic local update — the caller may also trigger a fresh scan() separately.
    findings.value = findings.value.filter((f) => f.patternId !== patternId);
  }

  function dismiss(key: string): void {
    const next = new Set(dismissedKeys.value);
    next.add(key);
    dismissedKeys.value = next;
  }

  return { findings, scanning, activeFindings, scan, ignorePattern, dismiss, findingKey };
}
