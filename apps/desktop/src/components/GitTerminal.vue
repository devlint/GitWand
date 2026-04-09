<script setup lang="ts">
import { ref, nextTick, onMounted } from "vue";
import { gitExec, gitAutocomplete, type TerminalResult } from "../utils/backend";

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "close"): void;
}>();

interface HistoryEntry {
  command: string;
  result: TerminalResult;
  timestamp: number;
}

const input = ref("");
const history = ref<HistoryEntry[]>([]);
const commandHistory = ref<string[]>([]);
const historyIndex = ref(-1);
const isRunning = ref(false);
const suggestions = ref<string[]>([]);
const selectedSuggestion = ref(-1);
const showSuggestions = ref(false);
const inputEl = ref<HTMLInputElement>();
const outputEl = ref<HTMLElement>();

async function runCommand() {
  const cmd = input.value.trim();
  if (!cmd || isRunning.value) return;

  // Parse the command — strip leading "git " if present
  const normalized = cmd.startsWith("git ") ? cmd.slice(4) : cmd;
  const args = normalized.split(/\s+/).filter(Boolean);

  isRunning.value = true;
  showSuggestions.value = false;
  input.value = "";

  try {
    const result = await gitExec(props.cwd, args);
    history.value.push({
      command: `git ${normalized}`,
      result,
      timestamp: Date.now(),
    });

    // State-changing commands trigger a refresh
    const mutating = ["add", "commit", "push", "pull", "merge", "rebase", "checkout", "switch", "stash", "cherry-pick", "reset", "restore", "revert", "branch"];
    if (mutating.some((m) => args[0] === m)) {
      emit("refresh");
    }
  } catch (err: any) {
    history.value.push({
      command: `git ${normalized}`,
      result: { stdout: "", stderr: err.message, exitCode: -1 },
      timestamp: Date.now(),
    });
  } finally {
    isRunning.value = false;
    commandHistory.value.push(cmd);
    historyIndex.value = -1;
  }

  await nextTick();
  if (outputEl.value) {
    outputEl.value.scrollTop = outputEl.value.scrollHeight;
  }
}

async function updateSuggestions() {
  const val = input.value.trim();
  if (!val) {
    showSuggestions.value = false;
    return;
  }

  // Strip "git " prefix for autocomplete
  const partial = val.startsWith("git ") ? val.slice(4) : val;

  try {
    suggestions.value = await gitAutocomplete(props.cwd, partial);
    showSuggestions.value = suggestions.value.length > 0;
    selectedSuggestion.value = -1;
  } catch {
    showSuggestions.value = false;
  }
}

function applySuggestion(suggestion: string) {
  const parts = input.value.trim().split(/\s+/);
  if (parts.length <= 1 || (parts.length === 1 && !input.value.startsWith("git "))) {
    // Completing the subcommand
    input.value = input.value.startsWith("git ") ? `git ${suggestion} ` : `${suggestion} `;
  } else {
    // Completing an argument — replace the last word
    parts[parts.length - 1] = suggestion;
    input.value = parts.join(" ") + " ";
  }
  showSuggestions.value = false;
  inputEl.value?.focus();
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    if (showSuggestions.value && selectedSuggestion.value >= 0) {
      applySuggestion(suggestions.value[selectedSuggestion.value]);
      e.preventDefault();
    } else {
      runCommand();
    }
  } else if (e.key === "Tab") {
    e.preventDefault();
    if (suggestions.value.length === 1) {
      applySuggestion(suggestions.value[0]);
    } else if (showSuggestions.value && selectedSuggestion.value >= 0) {
      applySuggestion(suggestions.value[selectedSuggestion.value]);
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (showSuggestions.value) {
      selectedSuggestion.value = Math.max(0, selectedSuggestion.value - 1);
    } else if (commandHistory.value.length > 0) {
      if (historyIndex.value < 0) historyIndex.value = commandHistory.value.length;
      historyIndex.value = Math.max(0, historyIndex.value - 1);
      input.value = commandHistory.value[historyIndex.value];
    }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (showSuggestions.value) {
      selectedSuggestion.value = Math.min(suggestions.value.length - 1, selectedSuggestion.value + 1);
    } else if (historyIndex.value >= 0) {
      historyIndex.value++;
      if (historyIndex.value >= commandHistory.value.length) {
        historyIndex.value = -1;
        input.value = "";
      } else {
        input.value = commandHistory.value[historyIndex.value];
      }
    }
  } else if (e.key === "Escape") {
    showSuggestions.value = false;
  }
}

onMounted(() => {
  inputEl.value?.focus();
});
</script>

<template>
  <div class="git-terminal">
    <div class="terminal-header">
      <span class="terminal-title">⌨️ Git Terminal</span>
      <button class="btn btn-sm btn-ghost" @click="$emit('close')">✕</button>
    </div>

    <div ref="outputEl" class="terminal-output">
      <div v-for="(entry, i) in history" :key="i" class="terminal-entry">
        <div class="terminal-cmd">
          <span class="terminal-prompt">$</span>
          <span>{{ entry.command }}</span>
        </div>
        <pre
          v-if="entry.result.stdout"
          class="terminal-stdout"
        >{{ entry.result.stdout }}</pre>
        <pre
          v-if="entry.result.stderr"
          class="terminal-stderr"
        >{{ entry.result.stderr }}</pre>
        <div v-if="entry.result.exitCode !== 0" class="terminal-exit">
          exit code: {{ entry.result.exitCode }}
        </div>
      </div>

      <div v-if="history.length === 0" class="terminal-welcome">
        Type a git command (e.g. <code>status</code>, <code>log --oneline -5</code>).
        The <code>git</code> prefix is optional.
      </div>
    </div>

    <div class="terminal-input-area">
      <div v-if="showSuggestions" class="terminal-suggestions">
        <div
          v-for="(s, i) in suggestions.slice(0, 8)"
          :key="s"
          class="terminal-suggestion"
          :class="{ active: i === selectedSuggestion }"
          @click="applySuggestion(s)"
        >
          {{ s }}
        </div>
      </div>
      <div class="terminal-input-row">
        <span class="terminal-prompt">$</span>
        <span class="terminal-git-prefix">git</span>
        <input
          ref="inputEl"
          v-model="input"
          class="terminal-input"
          type="text"
          placeholder="status"
          :disabled="isRunning"
          @keydown="handleKeydown"
          @input="updateSuggestions"
          spellcheck="false"
          autocomplete="off"
        />
        <span v-if="isRunning" class="terminal-spinner">⏳</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.git-terminal {
  display: flex;
  flex-direction: column;
  background: var(--bg-terminal, #11111b);
  border-radius: 8px;
  border: 1px solid var(--border-color, #313244);
  font-family: "JetBrains Mono", "Fira Code", "Consolas", monospace;
  font-size: 12px;
  height: 300px;
  overflow: hidden;
}

.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--bg-secondary, #1e1e2e);
  border-bottom: 1px solid var(--border-color, #313244);
}

.terminal-title {
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
}

.terminal-output {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.terminal-welcome {
  color: var(--text-muted, #6c7086);
  font-size: 12px;
  padding: 12px 0;
}

.terminal-welcome code {
  background: var(--bg-secondary, #1e1e2e);
  padding: 1px 4px;
  border-radius: 3px;
}

.terminal-entry {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.terminal-cmd {
  display: flex;
  gap: 6px;
  color: var(--text-primary, #cdd6f4);
  font-weight: 600;
}

.terminal-prompt {
  color: var(--color-success, #a6e3a1);
  font-weight: 700;
  user-select: none;
}

.terminal-stdout {
  margin: 0;
  color: var(--text-secondary, #a6adc8);
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 11px;
  line-height: 1.5;
}

.terminal-stderr {
  margin: 0;
  color: var(--color-error, #f38ba8);
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 11px;
  line-height: 1.5;
}

.terminal-exit {
  font-size: 10px;
  color: var(--color-error, #f38ba8);
  opacity: 0.7;
}

.terminal-input-area {
  position: relative;
  border-top: 1px solid var(--border-color, #313244);
}

.terminal-suggestions {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  background: var(--bg-secondary, #1e1e2e);
  border: 1px solid var(--border-color, #313244);
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  max-height: 160px;
  overflow-y: auto;
}

.terminal-suggestion {
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.1s;
}

.terminal-suggestion:hover,
.terminal-suggestion.active {
  background: var(--bg-hover, rgba(255, 255, 255, 0.08));
}

.terminal-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
}

.terminal-git-prefix {
  color: var(--color-accent, #cba6f7);
  user-select: none;
  font-weight: 600;
}

.terminal-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
}

.terminal-input::placeholder {
  color: var(--text-muted, #45475a);
}

.terminal-spinner {
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* Button styles */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-color, #313244);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  padding: 3px 8px;
  transition: all 0.15s;
}

.btn:hover { background: var(--bg-hover, rgba(255, 255, 255, 0.08)); }
.btn-sm { font-size: 12px; }
.btn-ghost { border-color: transparent; }
</style>
