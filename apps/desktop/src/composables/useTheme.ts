import { ref, watchEffect } from "vue";

export type Theme = "dark" | "light";

const STORAGE_KEY = "gitwand-theme";

/** Detect user's OS preference. */
function getSystemTheme(): Theme {
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

/** Read persisted theme or fall back to OS preference. */
function getInitialTheme(): Theme {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  }
  return getSystemTheme();
}

const theme = ref<Theme>(getInitialTheme());

/**
 * Composable for dark/light theme toggle.
 * Applies `data-theme` attribute to <html> and persists choice.
 */
export function useTheme() {
  // Keep <html data-theme="..."> in sync
  watchEffect(() => {
    document.documentElement.setAttribute("data-theme", theme.value);
    try {
      localStorage.setItem(STORAGE_KEY, theme.value);
    } catch {
      // localStorage might not be available
    }
  });

  function toggle() {
    theme.value = theme.value === "dark" ? "light" : "dark";
  }

  function setTheme(t: Theme) {
    theme.value = t;
  }

  return { theme, toggle, setTheme };
}
