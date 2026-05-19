<script setup lang="ts">
/**
 * @file SettingsMcpTab.vue — Settings > MCP tab (v2.10 §6.2, fixed §6.8)
 *
 * Features:
 *  1. @gitwand/mcp pinned feature card (installed per config file with --cwd)
 *  2. Smart search input: plain text → filter list | URL → install direct |
 *     npm package (@scope/name) → install direct
 *  3. Server list from registry with correct install commands per registryType
 *  4. isInstalled checks serverKeys from all detected configs
 *  5. Install modal: pick config files, preview fragment JSON
 */

import { ref, computed, onMounted } from "vue";
import BaseModal from "./BaseModal.vue";
import { useI18n } from "../composables/useI18n";
import {
  useMcpRegistry,
  buildInstallFragment,
  serverInstallKey,
  classifyInput,
  extractRegistryServerId,
  type McpServer,
  type InputMode,
} from "../composables/useMcpRegistry";
import {
  mcpDetectConfigs,
  mcpInstallServer,
  mcpUninstallServer,
  isTauri,
  type McpConfigFile,
} from "../utils/backend";

const props = defineProps<{ cwd?: string }>();

const { t } = useI18n();

const { loading, error: registryError, loaded, load, refresh, filteredServers, findById } =
  useMcpRegistry();

// ─── Load ────────────────────────────────────────────────────────────────────

onMounted(() => { load(); detectConfigs(); });

// ─── Config detection ─────────────────────────────────────────────────────────

const configs = ref<McpConfigFile[]>([]);
const configsDetected = ref(false);

/** Standard paths shown as manual-copy fallback in browser/dev mode. */
const FALLBACK_PATHS: Array<{ label: string; path: string }> = [
  { label: "Claude Desktop (macOS)", path: "~/Library/Application Support/Claude/claude_desktop_config.json" },
  { label: "Claude Code (global)", path: "~/.claude.json" },
  { label: "Cursor (global)", path: "~/.cursor/mcp.json" },
  { label: "Windsurf (global)", path: "~/.windsurf/mcp.json" },
];

async function detectConfigs() {
  try { configs.value = await mcpDetectConfigs(); } catch { /* browser mode */ }
  configsDetected.value = true;
}

/** True when we're in browser mode (or Tauri failed) and have no detected configs. */
const showManualFallback = computed(() => configsDetected.value && configs.value.length === 0);

// ─── Clipboard ────────────────────────────────────────────────────────────────

const copiedPath = ref<string | null>(null);
const copiedFragment = ref(false);

async function copyToClipboard(text: string, marker: "fragment" | string) {
  try {
    await navigator.clipboard.writeText(text);
    if (marker === "fragment") {
      copiedFragment.value = true;
      setTimeout(() => { copiedFragment.value = false; }, 1800);
    } else {
      copiedPath.value = marker;
      setTimeout(() => { copiedPath.value = null; }, 1800);
    }
  } catch { /* ignore */ }
}

// ─── @gitwand/mcp pinned card ─────────────────────────────────────────────────

const GITWAND_KEY = "gitwand";

const gitwandInstalledConfigs = computed(() =>
  configs.value.filter((c) => c.serverKeys.includes(GITWAND_KEY)),
);

function gitwandFragment(): string {
  const args = ["-y", "@gitwand/mcp"];
  if (props.cwd) args.push("--cwd", props.cwd);
  return JSON.stringify({ command: "npx", args });
}

async function uninstallGitwand() {
  const paths = gitwandInstalledConfigs.value.map((c) => c.path);
  if (!paths.length) return;
  try { await mcpUninstallServer(GITWAND_KEY, paths); await detectConfigs(); } catch { /* ignore */ }
}

// ─── Search / input mode ──────────────────────────────────────────────────────

const rawInput = ref("");
const inputMode = computed<InputMode>(() => classifyInput(rawInput.value));

// When mode is "search" use the composable filter; no category filter (field doesn't exist)
const searchResults = computed(() =>
  inputMode.value === "search" ? filteredServers(rawInput.value) : [],
);

// When mode is "url" → try to resolve from registry first
const urlServerId = computed(() =>
  inputMode.value === "url" ? extractRegistryServerId(rawInput.value) : null,
);
const urlResolvedServer = computed<McpServer | null>(() =>
  urlServerId.value ? (findById(urlServerId.value) ?? null) : null,
);
const isHttpServer = computed(() => {
  if (inputMode.value !== "url") return false;
  const id = urlServerId.value;
  // A URL that doesn't resolve to a known registry server is treated as HTTP/SSE
  return !id || !urlResolvedServer.value;
});

// ─── isInstalled ─────────────────────────────────────────────────────────────

function isInstalled(key: string): boolean {
  return configs.value.some((c) => c.serverKeys.includes(key));
}

// ─── Install modal ────────────────────────────────────────────────────────────

type InstallTarget =
  | { type: "registry"; server: McpServer }
  | { type: "gitwand" }
  | { type: "package"; identifier: string }
  | { type: "http"; url: string };

const installTarget = ref<InstallTarget | null>(null);
const selectedPaths = ref<string[]>([]);
const installing = ref(false);
const installError = ref<string | null>(null);
const installSuccess = ref(false);

function openInstall(target: InstallTarget) {
  installTarget.value = target;
  selectedPaths.value = configs.value.filter((c) => c.exists).map((c) => c.path);
  if (!selectedPaths.value.length && configs.value.length) {
    // Default: select first config even if it doesn't exist yet
    selectedPaths.value = [configs.value[0].path];
  }
  installError.value = null;
  installSuccess.value = false;
}

function closeInstall() { installTarget.value = null; }

function togglePath(path: string) {
  const i = selectedPaths.value.indexOf(path);
  if (i === -1) selectedPaths.value.push(path);
  else selectedPaths.value.splice(i, 1);
}

const installFragmentPreview = computed<string>(() => {
  const target = installTarget.value;
  if (!target) return "";
  if (target.type === "gitwand") return gitwandFragment();
  if (target.type === "registry") return buildInstallFragment(target.server);
  if (target.type === "package") return JSON.stringify({ command: "npx", args: ["-y", target.identifier] });
  if (target.type === "http") return JSON.stringify({ url: target.url });
  return "";
});

const installKey = computed<string>(() => {
  const target = installTarget.value;
  if (!target) return "";
  if (target.type === "gitwand") return GITWAND_KEY;
  if (target.type === "registry") return serverInstallKey(target.server);
  if (target.type === "package") return target.identifier.replace(/^@[^/]+\//, "");
  if (target.type === "http") return new URL(target.url).hostname.replace(/\./g, "-");
  return "server";
});

const installTitle = computed<string>(() => {
  const target = installTarget.value;
  if (!target) return "";
  if (target.type === "gitwand") return "@gitwand/mcp";
  if (target.type === "registry") return target.server.name || target.server.id;
  if (target.type === "package") return target.identifier;
  if (target.type === "http") return target.url;
  return "";
});

async function confirmInstall() {
  if (!selectedPaths.value.length || !installTarget.value) return;
  installing.value = true;
  installError.value = null;
  try {
    await mcpInstallServer(installKey.value, installFragmentPreview.value, selectedPaths.value);
    installSuccess.value = true;
    await detectConfigs();
    setTimeout(() => { closeInstall(); installSuccess.value = false; }, 1200);
  } catch (err: unknown) {
    installError.value = err instanceof Error ? err.message : String(err);
  } finally {
    installing.value = false;
  }
}

// ─── Direct install from URL/package input ────────────────────────────────────

function handleDirectInstall() {
  const v = rawInput.value.trim();
  if (inputMode.value === "url") {
    if (urlResolvedServer.value) {
      openInstall({ type: "registry", server: urlResolvedServer.value });
    } else {
      openInstall({ type: "http", url: v });
    }
  } else if (inputMode.value === "package") {
    openInstall({ type: "package", identifier: v });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function registryTypeLabel(type: string): string {
  return ({ npm: "npm", pypi: "PyPI", docker: "Docker" } as Record<string, string>)[type] ?? type;
}

function pluralConfig(n: number): string {
  return n === 1 ? "1 config" : `${n} configs`;
}

function shortId(id: string): string {
  // "io.github.devlint/gitwand" → "devlint/gitwand"
  return id.replace(/^[^/]+\.github\./, "").replace(/^[^/]+\./, "");
}
</script>

<template>
  <div class="sm">

    <!-- ── @gitwand/mcp feature card ── -->
    <div class="sm-feature-card">
      <div class="sm-feature-left">
        <svg class="sm-feature-logo" viewBox="0 0 32 32" width="28" height="28" fill="none">
          <rect width="32" height="32" rx="7" fill="var(--color-accent,#0a84ff)" opacity="0.15"/>
          <path d="M8 24 L16 8 L24 24" stroke="var(--color-accent,#0a84ff)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M11 19h10" stroke="var(--color-accent,#0a84ff)" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        <div class="sm-feature-meta">
          <span class="sm-feature-name">@gitwand/mcp</span>
          <span class="sm-feature-publisher">{{ t('settings.mcp.featurePublisher') }}</span>
          <span class="sm-feature-desc">
            {{ t('settings.mcp.featureDesc') }}
            <template v-if="props.cwd"> {{ t('settings.mcp.featureCwdHint', props.cwd) }}</template>
          </span>
        </div>
      </div>
      <div class="sm-feature-right">
        <span v-if="gitwandInstalledConfigs.length" class="sm-installed-chip">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6l3 3 5-5"/></svg>
          {{ pluralConfig(gitwandInstalledConfigs.length) }}
        </span>
        <button v-if="gitwandInstalledConfigs.length" class="sm-uninstall-btn" @click="uninstallGitwand">{{ t('settings.mcp.featureRemove') }}</button>
        <button v-else class="sm-install-btn sm-install-btn--accent" @click="openInstall({ type: 'gitwand' })">{{ t('settings.mcp.featureInstall') }}</button>
      </div>
    </div>

    <!-- ── Smart search / input bar ── -->
    <div class="sm-searchbar">
      <div class="sm-searchbar-inner" :class="`sm-searchbar--${inputMode}`">
        <svg class="sm-searchbar-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <circle v-if="inputMode === 'search'" cx="6.5" cy="6.5" r="4.5"/>
          <path v-if="inputMode === 'search'" d="M11 11l3 3"/>
          <!-- URL icon -->
          <template v-if="inputMode === 'url'">
            <path d="M6.5 9.5a3.5 3.5 0 0 0 3 0M9.5 6.5a3.5 3.5 0 0 0 0 3M3 8h10M8 3v10"/>
          </template>
          <!-- Package icon -->
          <template v-if="inputMode === 'package'">
            <rect x="2" y="6" width="12" height="8" rx="1.5"/>
            <path d="M5 6V4a3 3 0 0 1 6 0v2"/>
          </template>
        </svg>
        <input
          v-model="rawInput"
          class="sm-search"
          type="text"
          :placeholder="t('settings.mcp.searchPlaceholder')"
          @keydown.enter="inputMode !== 'search' && handleDirectInstall()"
        />
        <button
          v-if="inputMode !== 'search'"
          class="sm-install-btn sm-input-action-btn"
          @click="handleDirectInstall"
        >
          <template v-if="inputMode === 'url' && !urlResolvedServer">{{ t('settings.mcp.searchAddHttp') }}</template>
          <template v-else-if="inputMode === 'url' && urlResolvedServer">{{ t('settings.mcp.searchInstallServer', urlResolvedServer.name) }}</template>
          <template v-else-if="inputMode === 'package'">{{ t('settings.mcp.searchInstallPackage') }}</template>
        </button>
        <button v-if="rawInput" class="sm-clear-btn" @click="rawInput = ''" title="Clear">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M3 3l6 6M9 3l-6 6"/>
          </svg>
        </button>
      </div>

      <!-- Hint for URL mode -->
      <p v-if="inputMode === 'url' && !urlResolvedServer && !isHttpServer" class="sm-input-hint">
        {{ t('settings.mcp.searchUrlUnknown') }}
      </p>
      <p v-if="inputMode === 'url' && urlResolvedServer" class="sm-input-hint sm-input-hint--ok">
        {{ t('settings.mcp.searchUrlFound', urlResolvedServer?.name ?? '') }}
      </p>

      <div v-if="inputMode === 'search'" class="sm-searchbar-controls">
        <span class="sm-section-title">{{ t('settings.mcp.searchRegistryTitle') }}</span>
        <button class="sm-refresh-btn" :disabled="loading" @click="refresh" title="Refresh registry">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" :class="{ 'sm-spin': loading }">
            <path d="M13.5 2.5A7 7 0 1 1 4 2.7"/>
            <path d="M13.5 2.5V6.5H9.5"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- ── Loading ── -->
    <div v-if="loading && !loaded" class="sm-loading">
      <div class="sm-spinner"></div>
      <span>{{ t('settings.mcp.listLoading') }}</span>
    </div>

    <!-- ── Registry error ── -->
    <div v-else-if="registryError && !loaded" class="sm-error">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <circle cx="8" cy="8" r="6.5"/>
        <path d="M8 5v4M8 11v.5"/>
      </svg>
      <span>{{ registryError }}</span>
      <button class="sm-refresh-btn" @click="refresh">Retry</button>
    </div>

    <!-- ── Search results (text mode) ── -->
    <div v-else-if="inputMode === 'search' && loaded" class="sm-list">
      <div v-if="!searchResults.length" class="sm-empty">{{ t('settings.mcp.listNoMatch', rawInput) }}</div>
      <div v-for="server in searchResults" :key="server.id" class="sm-card">
        <div class="sm-card-body">
          <div class="sm-card-top">
            <span class="sm-card-name">{{ server.name || shortId(server.id) }}</span>
            <span v-if="server.packages?.[0]" class="sm-badge sm-badge--type">
              {{ registryTypeLabel(server.packages[0].registryType) }}
            </span>
          </div>
          <p class="sm-card-desc">{{ server.description }}</p>
          <div class="sm-card-meta">
            <span class="sm-card-id">{{ shortId(server.id) }}</span>
            <span v-if="server.packages?.[0]?.identifier" class="sm-card-pkg">{{ server.packages[0].identifier }}</span>
            <span v-if="server.version_detail?.name" class="sm-card-ver">v{{ server.version_detail.name }}</span>
          </div>
        </div>
        <div class="sm-card-action">
          <span v-if="isInstalled(serverInstallKey(server))" class="sm-installed-chip">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6l3 3 5-5"/></svg>
            {{ t('settings.mcp.listInstalled') }}
          </span>
          <button v-else class="sm-install-btn" @click="openInstall({ type: 'registry', server })">
            {{ t('settings.mcp.featureInstall') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Placeholder when no input yet and not loading -->
    <div v-else-if="inputMode === 'search' && !loaded && !loading" class="sm-empty">
      {{ t('settings.mcp.listHint') }}
    </div>

  </div>

  <!-- ── Install modal ── -->
  <BaseModal
    v-if="installTarget"
    :title="t('settings.mcp.modalTitle', installTitle)"
    size="md"
    @close="closeInstall"
  >
    <template #title-icon>
      <span class="bm-title-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 3v10M6 10l4 4 4-4"/><path d="M4 17h12"/>
        </svg>
      </span>
    </template>
    <!-- Fragment preview -->
    <div class="sm-modal-section">
      <span class="sm-modal-label">{{ t('settings.mcp.modalFragmentLabel') }}</span>
      <pre class="sm-modal-code">{{ JSON.stringify({ [installKey]: JSON.parse(installFragmentPreview) }, null, 2) }}</pre>
    </div>

    <p class="sm-modal-desc">{{ t('settings.mcp.modalConfigsLabel') }}</p>

    <div class="sm-modal-configs">
      <div v-for="cfg in configs" :key="cfg.path" class="sm-modal-cfg">
        <label class="sm-modal-cfg-label">
          <input type="checkbox" :checked="selectedPaths.includes(cfg.path)" @change="togglePath(cfg.path)" />
          <span class="sm-modal-cfg-name">{{ cfg.label }}</span>
          <span class="sm-badge" :class="cfg.exists ? 'sm-badge--type' : 'sm-badge--new'">
            {{ cfg.exists ? t('settings.mcp.modalCfgExists') : t('settings.mcp.modalCfgWillCreate') }}
          </span>
        </label>
        <span class="sm-modal-cfg-path">{{ cfg.path }}</span>
      </div>

      <!-- Fallback: browser/dev mode — manual copy -->
      <template v-if="showManualFallback">
        <div class="sm-manual-note">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="8" cy="8" r="6.5"/>
            <path d="M8 7v4M8 5v.5"/>
          </svg>
          <span>
            <template v-if="!isTauri()">{{ t('settings.mcp.modalDevMode') }}</template>
            <template v-else>{{ t('settings.mcp.modalNoConfigs') }}</template>
          </span>
        </div>

        <div class="sm-manual-fragment">
          <div class="sm-manual-fragment-header">
            <span class="sm-modal-label">{{ t('settings.mcp.modalJsonLabel') }}</span>
            <button class="sm-copy-btn" @click="copyToClipboard(installFragmentPreview, 'fragment')">
              <template v-if="copiedFragment">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6l3 3 5-5"/></svg>
                {{ t('settings.mcp.modalCopied') }}
              </template>
              <template v-else>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="4" y="4" width="6" height="7" rx="1"/>
                  <path d="M2 8V3a1 1 0 0 1 1-1h5"/>
                </svg>
                {{ t('settings.mcp.modalCopyJson') }}
              </template>
            </button>
          </div>
          <pre class="sm-modal-code">{{ JSON.stringify({ [installKey]: JSON.parse(installFragmentPreview) }, null, 2) }}</pre>
        </div>

        <div class="sm-manual-paths">
          <p class="sm-manual-paths-label">{{ t('settings.mcp.modalPathsLabel') }}</p>
          <div v-for="fp in FALLBACK_PATHS" :key="fp.path" class="sm-manual-path-row">
            <span class="sm-manual-path-label">{{ fp.label }}</span>
            <code class="sm-manual-path-code">{{ fp.path }}</code>
            <button class="sm-copy-btn" @click="copyToClipboard(fp.path, fp.path)">
              <template v-if="copiedPath === fp.path">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6l3 3 5-5"/></svg>
                {{ t('settings.mcp.modalCopiedShort') }}
              </template>
              <template v-else>
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="4" y="4" width="6" height="7" rx="1"/>
                  <path d="M2 8V3a1 1 0 0 1 1-1h5"/>
                </svg>
              </template>
            </button>
          </div>
        </div>
      </template>
    </div>

    <p v-if="installError" class="sm-msg sm-msg--error">{{ installError }}</p>
    <p v-if="installSuccess" class="sm-msg sm-msg--ok">{{ t('settings.mcp.modalSuccess') }}</p>

    <template #footer>
      <button class="bm-btn bm-btn--ghost" :disabled="installing" @click="closeInstall">{{ t('common.cancel') }}</button>
      <button
        class="bm-btn bm-btn--primary"
        :disabled="installing || !selectedPaths.length"
        @click="confirmInstall"
      >{{ installing ? t('settings.mcp.modalInstalling') : t('settings.mcp.modalConfirm') }}</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.sm { display: flex; flex-direction: column; gap: 20px; }

/* .sm-title-icon removed — use global .bm-title-icon from BaseModal instead */

/* ── Feature card ── */
.sm-feature-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-radius: var(--radius-md, 8px);
  background: var(--color-bg, #1e1e1e);
  border: 1px solid var(--color-accent, #0a84ff);
  box-shadow: 0 0 0 1px rgba(10, 132, 255, 0.12);
}
.sm-feature-left { display: flex; align-items: flex-start; gap: 12px; flex: 1; min-width: 0; }
.sm-feature-logo { flex-shrink: 0; margin-top: 2px; }
.sm-feature-meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.sm-feature-name { font-size: 13px; font-weight: 600; color: var(--color-text, #eee); }
.sm-feature-publisher { font-size: 11px; color: var(--color-accent, #0a84ff); }
.sm-feature-desc { font-size: 12px; color: var(--color-text-muted, #888); line-height: 1.45; }
.sm-feature-desc code {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  background: rgba(255,255,255,0.07);
  padding: 1px 4px;
  border-radius: 3px;
}
.sm-feature-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* ── Search bar ── */
.sm-searchbar { display: flex; flex-direction: column; gap: 6px; }

.sm-searchbar-inner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: var(--color-bg-subtle, rgba(255,255,255,0.04));
  border: 1px solid var(--color-border, rgba(255,255,255,0.1));
  border-radius: var(--radius-sm, 5px);
  transition: border-color 0.12s;
}
.sm-searchbar-inner:focus-within { border-color: var(--color-accent, #0a84ff); }
.sm-searchbar--url { border-color: rgba(255,165,0,0.4); }
.sm-searchbar--url:focus-within { border-color: rgba(255,165,0,0.8); }
.sm-searchbar--package { border-color: rgba(80,200,120,0.4); }
.sm-searchbar--package:focus-within { border-color: rgba(80,200,120,0.8); }

.sm-searchbar-icon { flex-shrink: 0; color: var(--color-text-muted, #888); }

.sm-search {
  flex: 1;
  padding: 8px 0;
  font-size: 13px;
  background: transparent;
  color: var(--color-text, #eee);
  border: none;
  outline: none;
}
.sm-search::placeholder { color: var(--color-text-muted, #555); font-size: 12px; }

.sm-input-action-btn {
  flex-shrink: 0;
  white-space: nowrap;
  padding: 4px 10px;
  font-size: 11px;
}

.sm-clear-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--color-text-muted, #888);
  cursor: pointer;
  border-radius: 4px;
}
.sm-clear-btn:hover { background: var(--color-bg-tertiary, rgba(255,255,255,0.07)); color: var(--color-text, #eee); }

.sm-input-hint {
  font-size: 11px;
  color: var(--color-text-muted, #888);
  margin: 0;
  padding: 0 2px;
}
.sm-input-hint--ok { color: var(--color-success, #3fb950); }

.sm-searchbar-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}
.sm-section-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--color-text-muted, #888);
}

/* ── Refresh button ── */
.sm-refresh-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  background: transparent;
  border: 1px solid var(--color-border, rgba(255,255,255,0.1));
  border-radius: var(--radius-sm, 5px);
  color: var(--color-text-muted, #888);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}
.sm-refresh-btn:hover { border-color: var(--color-text-muted, #888); color: var(--color-text, #eee); }
.sm-refresh-btn:disabled { opacity: 0.4; cursor: default; }

@keyframes sm-spin { to { transform: rotate(360deg); } }
.sm-spin { animation: sm-spin 0.8s linear infinite; transform-origin: center; }

/* ── Loading ── */
.sm-loading { display: flex; align-items: center; gap: 10px; padding: 24px 0; font-size: 12px; color: var(--color-text-muted, #888); }
.sm-spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--color-accent, #0a84ff); border-radius: 50%; animation: sm-spin 0.7s linear infinite; }

/* ── Error ── */
.sm-error { display: flex; align-items: center; gap: 8px; padding: 12px; font-size: 12px; color: var(--color-danger, #e55); background: rgba(238,85,85,0.08); border: 1px solid rgba(238,85,85,0.2); border-radius: var(--radius-sm, 5px); }

/* ── Empty ── */
.sm-empty { padding: 24px 0; font-size: 12px; color: var(--color-text-muted, #888); text-align: center; }

/* ── Server list ── */
.sm-list { display: flex; flex-direction: column; gap: 6px; }

.sm-card {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; padding: 12px 14px;
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg, #1e1e1e);
  border: 1px solid var(--color-border, rgba(255,255,255,0.07));
  transition: border-color 0.1s;
}
.sm-card:hover { border-color: var(--color-border-strong, rgba(255,255,255,0.14)); }

.sm-card-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.sm-card-top { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.sm-card-name { font-size: 13px; font-weight: 600; color: var(--color-text, #eee); }
.sm-card-desc {
  font-size: 12px; color: var(--color-text-muted, #888); line-height: 1.45; margin: 0;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.sm-card-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sm-card-id { font-size: 11px; color: var(--color-text-muted, #666); font-family: var(--font-mono, monospace); }
.sm-card-pkg { font-size: 11px; color: var(--color-text-muted, #888); }
.sm-card-ver { font-size: 11px; color: var(--color-text-muted, #666); }
.sm-card-action { flex-shrink: 0; display: flex; align-items: center; padding-top: 2px; }

/* ── Badges ── */
.sm-badge {
  display: inline-block; padding: 1px 6px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.03em;
  border-radius: 3px; text-transform: uppercase;
}
.sm-badge--type { background: rgba(10,132,255,0.12); color: var(--color-accent, #0a84ff); }
.sm-badge--new { background: rgba(255,255,255,0.06); color: var(--color-text-muted, #888); }

/* ── Installed chip ── */
.sm-installed-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 9px; font-size: 11px; font-weight: 600;
  border-radius: 4px;
  background: rgba(34,134,58,0.14);
  color: var(--color-success, #3fb950);
}

/* ── Buttons ── */
.sm-install-btn {
  padding: 4px 12px; font-size: 12px; font-weight: 600;
  border-radius: var(--radius-sm, 5px);
  background: var(--color-bg-tertiary, rgba(255,255,255,0.07));
  border: 1px solid var(--color-border, rgba(255,255,255,0.1));
  color: var(--color-text, #eee);
  cursor: pointer; white-space: nowrap;
  transition: background 0.1s, border-color 0.1s;
}
.sm-install-btn:hover { background: var(--color-bg, rgba(255,255,255,0.1)); border-color: var(--color-border-strong, rgba(255,255,255,0.18)); }
.sm-install-btn--accent { background: var(--color-accent, #0a84ff); border-color: var(--color-accent, #0a84ff); color: #fff; }
.sm-install-btn--accent:hover { background: var(--color-accent-hover, #0073e6); border-color: var(--color-accent-hover, #0073e6); }

.sm-uninstall-btn {
  padding: 4px 10px; font-size: 11px;
  background: none; border: none;
  color: var(--color-danger, #e55); cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
.sm-uninstall-btn:hover { color: var(--color-danger-light, #f77); }

/* ── Modal body content ── */
.sm-modal-section { display: flex; flex-direction: column; gap: 4px; }
.sm-modal-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-muted, #888); }
.sm-modal-code {
  margin: 0;
  padding: 10px 12px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.6;
  background: rgba(0,0,0,0.25);
  border: 1px solid var(--color-border, rgba(255,255,255,0.07));
  border-radius: var(--radius-sm, 5px);
  color: var(--color-text-muted, #aaa);
  overflow-x: auto;
  white-space: pre;
}

.sm-modal-desc { font-size: 12px; color: var(--color-text-muted, #888); margin: 0; }
.sm-modal-configs { display: flex; flex-direction: column; gap: 8px; }
.sm-modal-cfg {
  display: flex; flex-direction: column; gap: 2px;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 5px);
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--color-border, rgba(255,255,255,0.07));
}
.sm-modal-cfg-label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.sm-modal-cfg-name { font-size: 12px; font-weight: 600; color: var(--color-text, #eee); flex: 1; }
.sm-modal-cfg-path { font-size: 10px; color: var(--color-text-muted, #666); font-family: var(--font-mono, monospace); word-break: break-all; }
.sm-modal-empty { font-size: 12px; color: var(--color-text-muted, #888); margin: 0; }

.sm-msg { font-size: 12px; margin: 0; }
.sm-msg--error { color: var(--color-danger, #e55); }
.sm-msg--ok { color: var(--color-success, #3fb950); }

/* ── Manual fallback (browser mode) ── */
.sm-manual-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--color-text-muted, #aaa);
  background: rgba(255, 165, 0, 0.07);
  border: 1px solid rgba(255, 165, 0, 0.2);
  border-radius: var(--radius-sm, 5px);
  line-height: 1.5;
}
.sm-manual-note svg { flex-shrink: 0; margin-top: 1px; color: rgba(255, 165, 0, 0.8); }

.sm-manual-fragment { display: flex; flex-direction: column; gap: 6px; }

.sm-manual-fragment-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sm-manual-fragment-header .sm-modal-label { flex: 1; }
.sm-manual-fragment-header code {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  background: rgba(255,255,255,0.07);
  padding: 1px 4px;
  border-radius: 3px;
}

.sm-manual-paths { display: flex; flex-direction: column; gap: 4px; }

.sm-manual-paths-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted, #888);
  margin: 0 0 2px;
}

.sm-manual-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--color-border, rgba(255,255,255,0.06));
  border-radius: var(--radius-sm, 5px);
}

.sm-manual-path-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-muted, #aaa);
  white-space: nowrap;
  flex-shrink: 0;
  min-width: 160px;
}

.sm-manual-path-code {
  flex: 1;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--color-text-muted, #888);
  word-break: break-all;
}

/* ── Copy button ── */
.sm-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11px;
  white-space: nowrap;
  background: var(--color-bg-tertiary, rgba(255,255,255,0.06));
  border: 1px solid var(--color-border, rgba(255,255,255,0.1));
  border-radius: var(--radius-sm, 4px);
  color: var(--color-text-muted, #aaa);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.1s, color 0.1s;
}
.sm-copy-btn:hover { background: var(--color-bg, rgba(255,255,255,0.1)); color: var(--color-text, #eee); }
</style>
