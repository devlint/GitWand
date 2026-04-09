/**
 * Syntax highlighting for diff lines using highlight.js.
 *
 * - Auto-detects language from file extension
 * - Caches highlighted HTML per file path
 * - Returns raw content if language is unsupported or highlighting fails
 */
import hljs from "highlight.js/lib/core";

// Register commonly used languages (keep bundle small)
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml"; // HTML, XML, Vue templates
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import csharp from "highlight.js/lib/languages/csharp";
import cpp from "highlight.js/lib/languages/cpp";
import c from "highlight.js/lib/languages/c";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import ini from "highlight.js/lib/languages/ini";
import diff from "highlight.js/lib/languages/diff";
import plaintext from "highlight.js/lib/languages/plaintext";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("php", php);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c", c);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("plaintext", plaintext);

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

/**
 * Highlight a single line of code.
 * Returns HTML string with <span> elements for syntax tokens.
 * Falls back to HTML-escaped plain text if language is unknown.
 */
export function highlightLine(content: string, language: string | null): string {
  if (!content || !language) return escapeHtml(content);
  try {
    const result = hljs.highlight(content, { language, ignoreIllegals: true });
    return result.value;
  } catch {
    return escapeHtml(content);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
