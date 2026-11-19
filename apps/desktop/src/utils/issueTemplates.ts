/**
 * A repository's issue templates (#301, part 5), from the raw files
 * `gh_issue_templates` reads.
 *
 * - Markdown templates (`*.md`, with an optional front matter) are used as is.
 * - Issue forms (`*.yml`) are flattened into the Markdown body GitHub itself
 *   produces from a form: a `### Label` section per field. Their dropdowns,
 *   checkboxes and required fields are not enforced here.
 * - `config.yml` says whether blank issues are welcome, and lists contact links.
 *
 * A template that does not parse is skipped; the others are kept.
 */

export interface IssueTemplate {
  /** The file path: stable, unique. */
  id: string;
  name: string;
  about: string;
  title: string;
  labels: string[];
  assignees: string[];
  body: string;
}

export interface ContactLink {
  name: string;
  url: string;
  about: string;
}

export interface IssueTemplateSet {
  templates: IssueTemplate[];
  blankAllowed: boolean;
  contactLinks: ContactLink[];
}

type ParseYaml = (source: string) => unknown;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** A front matter list: an array, or a comma-separated string (`labels: bug, ui`). */
function list(v: unknown): string[] {
  const items = Array.isArray(v) ? v.map(str) : typeof v === "string" ? v.split(",") : [];
  return items.map((s) => s.trim()).filter(Boolean);
}

/** The file name without its directory and extension. */
function baseName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.(md|ya?ml)$/i, "");
}

/** Text inside an HTML comment, which must never close it early. */
function comment(text: string): string {
  return `<!-- ${text.trim().replace(/--!?>/g, "-- >")} -->`;
}

/** An issue form's `body`, as the Markdown GitHub would file from it. */
export function flattenForm(body: unknown[]): string {
  const sections: string[] = [];
  for (const item of body) {
    if (!isObj(item)) continue;
    const a = isObj(item.attributes) ? item.attributes : {};
    const label = str(a.label).trim();
    // A field with no label gets no heading (never a bare `### `). Required
    // fields are not marked: GitHub's issue carries the label as is, and
    // tools find sections by it.
    const heading = label ? `### ${label}` : "";
    const section = (content: string) => [heading, content].filter(Boolean).join("\n\n");
    switch (item.type) {
      case "markdown": {
        const value = str(a.value).trim();
        if (value) sections.push(comment(value));
        break;
      }
      case "textarea":
      case "input": {
        const value = str(a.value);
        const render = item.type === "textarea" ? str(a.render).trim() : "";
        const placeholder = str(a.placeholder).trim();
        const text = value.replace(/\s+$/, "");
        // A rendered field is fenced, its value included, as GitHub files it.
        const content = render ? `\`\`\`${render}\n${text ? `${text}\n` : "\n"}\`\`\`` : text.trim() ? text : placeholder ? comment(placeholder) : "";
        if (heading || content) sections.push(section(content));
        break;
      }
      case "dropdown": {
        const raw = Array.isArray(a.options) ? a.options.map(str) : [];
        const options = raw.filter(Boolean);
        // `default` indexes the options as written (before any is dropped).
        const chosen = typeof a.default === "number" ? raw[a.default] || undefined : undefined;
        // The choices alone (no words to translate in a body filed as is).
        const content = chosen ?? (options.length ? comment(options.join(" | ")) : "");
        if (heading || content) sections.push(section(content));
        break;
      }
      case "checkboxes": {
        const options = Array.isArray(a.options) ? a.options.map((o) => (isObj(o) ? str(o.label) : str(o))).filter(Boolean) : [];
        const content = options.map((o) => `- [ ] ${o}`).join("\n");
        if (heading || content) sections.push(section(content));
        break;
      }
    }
  }
  return sections.length ? `${sections.join("\n\n")}\n` : "";
}

/** A front matter, possibly empty (`---\n---`). */
const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** In a template folder: `.github/ISSUE_TEMPLATE/`, or an owner `.github` repository's root or `docs` one. */
const inTemplateFolder = (path: string) => /(^|\/)ISSUE_TEMPLATE\//i.test(path);

/** GitHub's single-template file (`ISSUE_TEMPLATE.md`): it prefills the form rather than being chosen. */
export const isSingleTemplateFile = (path: string) => /^(\.github\/|docs\/)?issue_template\.md$/i.test(path);

function markdownTemplate(path: string, raw: string, parseYaml: ParseYaml): IssueTemplate | null {
  const content = raw.replace(/^\uFEFF/, ""); // a BOM before the front matter
  const m = FRONT_MATTER.exec(content);
  // In the template folder, a Markdown file without front matter (a README)
  // is not a template: GitHub's chooser does not offer it either.
  if (!m && inTemplateFolder(path)) return null;
  let meta: Obj = {};
  if (m) {
    const parsed = m[1] === undefined ? null : parseYaml(m[1]);
    if (parsed !== null && parsed !== undefined && !isObj(parsed)) return null;
    meta = parsed ?? {};
  }
  // In the template folder a template needs a name, as GitHub's chooser does;
  // a single-template file elsewhere is named after its file.
  const name = str(meta.name).trim();
  if (!name && inTemplateFolder(path)) return null;
  return {
    id: path,
    name: name || baseName(path),
    about: str(meta.about).trim(),
    title: str(meta.title),
    labels: list(meta.labels),
    assignees: list(meta.assignees),
    body: m ? content.slice(m[0].length) : content,
  };
}

function formTemplate(path: string, content: string, parseYaml: ParseYaml): IssueTemplate | null {
  const form = parseYaml(content);
  if (!isObj(form) || !Array.isArray(form.body)) return null;
  const name = str(form.name).trim();
  if (!name) return null; // GitHub offers no form without a name
  return {
    id: path,
    name,
    about: str(form.description).trim(),
    title: str(form.title),
    labels: list(form.labels),
    assignees: list(form.assignees),
    body: flattenForm(form.body),
  };
}

const isConfig = (path: string) => /(^|\/)config\.ya?ml$/i.test(path);

/** The templates, and `config.yml`'s settings, from a target's raw files. */
export function parseTemplateSet(files: { path: string; content: string }[], parseYaml: ParseYaml): IssueTemplateSet {
  const set: IssueTemplateSet = { templates: [], blankAllowed: true, contactLinks: [] };
  for (const { path, content } of files) {
    try {
      if (isConfig(path)) {
        const cfg = parseYaml(content);
        if (!isObj(cfg)) continue;
        if (cfg.blank_issues_enabled === false) set.blankAllowed = false;
        if (Array.isArray(cfg.contact_links)) {
          for (const l of cfg.contact_links) {
            if (!isObj(l)) continue;
            const url = str(l.url).trim();
            // Only a web link is offered (never `javascript:` or the like).
            if (!/^https:\/\//i.test(url)) continue;
            set.contactLinks.push({ name: str(l.name).trim() || url, url, about: str(l.about).trim() });
          }
        }
        continue;
      }
      const t = /\.ya?ml$/i.test(path) ? formTemplate(path, content, parseYaml) : markdownTemplate(path, content, parseYaml);
      if (t) set.templates.push(t);
    } catch {
      // A template that does not parse is skipped; the others are kept.
    }
  }
  return set;
}

/** `parseTemplateSet` with the YAML parser loaded on demand (kept out of the main chunk). */
export async function loadTemplateSet(files: { path: string; content: string }[]): Promise<IssueTemplateSet> {
  const { parse } = await import("yaml");
  return parseTemplateSet(files, parse);
}
