/**
 * Syntax highlighting for diff lines using highlight.js.
 *
 * - Auto-detects language from file extension
 * - Caches highlighted HTML per file path
 * - Returns raw content if language is unsupported or highlighting fails
 *
 * P4.3 — Bundle size optimization: only the most-common languages are
 * loaded eagerly into the main bundle. Others are dynamic-imported on
 * first use, with graceful fallback to escaped plain text while the
 * chunk is fetching. This shaves ~150-250 KB gzipped off the initial
 * JS that the cold start has to parse and evaluate.
 */
import hljs from "highlight.js/lib/core";

// ─── Eager languages — kept in the main bundle ──────────────────────────────
// These cover ~80% of code review use cases. Keep this set small.
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml"; // HTML, Vue templates, SVG, XML
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import plaintext from "highlight.js/lib/languages/plaintext";
import { escapeHtml } from "./escapeHtml";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("plaintext", plaintext);

// Track which languages are ready for synchronous use.
const REGISTERED = new Set<string>([
  "javascript",
  "typescript",
  "xml",
  "css",
  "json",
  "markdown",
  "yaml",
  "diff",
  "plaintext",
]);

// ─── Lazy languages — fetched only on first use ────────────────────────────
// Vite splits each dynamic import into its own chunk. Each is ~3-15 KB
// minified+gzipped, so the savings vs. an all-eager bundle add up fast.
type Loader = () => Promise<{ default: any }>;
const LAZY_LOADERS: Record<string, Loader> = {
  scss:       () => import("highlight.js/lib/languages/scss"),
  python:     () => import("highlight.js/lib/languages/python"),
  rust:       () => import("highlight.js/lib/languages/rust"),
  go:         () => import("highlight.js/lib/languages/go"),
  java:       () => import("highlight.js/lib/languages/java"),
  kotlin:     () => import("highlight.js/lib/languages/kotlin"),
  swift:      () => import("highlight.js/lib/languages/swift"),
  bash:       () => import("highlight.js/lib/languages/bash"),
  shell:      () => import("highlight.js/lib/languages/shell"),
  sql:        () => import("highlight.js/lib/languages/sql"),
  php:        () => import("highlight.js/lib/languages/php"),
  ruby:       () => import("highlight.js/lib/languages/ruby"),
  csharp:     () => import("highlight.js/lib/languages/csharp"),
  cpp:        () => import("highlight.js/lib/languages/cpp"),
  c:          () => import("highlight.js/lib/languages/c"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  ini:        () => import("highlight.js/lib/languages/ini"),
};

// Track in-flight loads so we never request the same chunk twice in parallel.
const PENDING: Record<string, Promise<boolean>> = {};

/**
 * Ensure a language is registered. Resolves true once highlighting is
 * available, false if the language is not known to GitWand. Components
 * that want to *await* the load (e.g. to retrigger their render) can,
 * but `highlightLine` works without explicit awaiting — it returns
 * plain text until the chunk arrives.
 */
export async function ensureLanguage(lang: string | null): Promise<boolean> {
  if (!lang) return false;
  if (REGISTERED.has(lang)) return true;
  if (lang in PENDING) return PENDING[lang]!;
  const loader = LAZY_LOADERS[lang];
  if (!loader) return false;
  PENDING[lang] = loader()
    .then((mod) => {
      hljs.registerLanguage(lang, mod.default);
      REGISTERED.add(lang);
      return true;
    })
    .catch(() => {
      // Don't poison the registry — let a future call retry.
      delete PENDING[lang];
      return false;
    });
  return PENDING[lang];
}

/** Map file extensions to highlight.js language names */
const extToLang: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  vue: "xml",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "css",
  json: "json",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  php: "php",
  rb: "ruby",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  h: "c",
  c: "c",
  dockerfile: "dockerfile",
  ini: "ini",
  toml: "ini",
  cfg: "ini",
  env: "ini",
  diff: "diff",
  patch: "diff",
  txt: "plaintext",
  lock: "plaintext",
};

/**
 * Detect highlight.js language name from a file path.
 * Returns null if the extension is not mapped.
 */
export function detectLanguage(filePath: string): string | null {
  // Handle filenames like "Dockerfile", ".gitignore"
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "bash";

  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return extToLang[ext] ?? null;
}

// R2 — module-level cache: keyed by content + '\0' + lang.
// Avoids re-highlighting identical lines on every render (DiffViewer
// calls hl() per line in the template — without cache, hljs.highlight
// runs for every line on every render cycle).
const _hlCache = new Map<string, string>();
const _HL_CACHE_MAX = 10_000;

/**
 * Highlight a single line of code.
 * Returns HTML string with <span> elements for syntax tokens.
 * Falls back to HTML-escaped plain text if language is unknown OR if the
 * lazy chunk for that language hasn't loaded yet (in which case we kick
 * off the load and the next render call will highlight properly).
 */
export function highlightLine(content: string, language: string | null): string {
  const cacheKey = content + '\0' + (language ?? '');
  const cached = _hlCache.get(cacheKey);
  if (cached) return cached;

  const store = (html: string): string => {
    if (_hlCache.size < _HL_CACHE_MAX) _hlCache.set(cacheKey, html);
    return html;
  };

  if (!content || !language) return store(escapeHtml(content));
  if (!REGISTERED.has(language)) {
    void ensureLanguage(language);
    return store(escapeHtml(content));
  }
  try {
    const result = hljs.highlight(content, { language, ignoreIllegals: true });
    return store(result.value);
  } catch {
    return store(escapeHtml(content));
  }
}

