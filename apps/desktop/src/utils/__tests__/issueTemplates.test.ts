/**
 * Issue templates (#301, part 5): Markdown templates and issue forms,
 * flattened into the Markdown body GitHub itself would produce.
 */
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { parseTemplateSet, flattenForm, loadTemplateSet } from "../issueTemplates";

const dir = (name: string) => `.github/ISSUE_TEMPLATE/${name}`;

describe("parseTemplateSet — Markdown templates", () => {
  it("reads the front matter and keeps the body without it", () => {
    const md = "---\nname: Bug report\nabout: Something broke\ntitle: '[Bug] '\nlabels: bug, ui\nassignees: [alice]\n---\n## Steps\n\n1. \n";
    const set = parseTemplateSet([{ path: dir("bug.md"), content: md }], parse);
    expect(set.templates).toEqual([
      { id: dir("bug.md"), name: "Bug report", about: "Something broke", title: "[Bug] ", labels: ["bug", "ui"], assignees: ["alice"], body: "## Steps\n\n1. \n" },
    ]);
  });

  it("a leading BOM or an empty front matter is still a front matter", () => {
    const set = parseTemplateSet([
      { path: dir("a.md"), content: "\uFEFF---\nname: A\n---\nbody A" },
      { path: "docs/ISSUE_TEMPLATE.md", content: "---\n---\nbody B" },
    ], parse);
    expect(set.templates.map((t) => [t.name, t.body])).toEqual([["A", "body A"], ["ISSUE_TEMPLATE", "body B"]]);
  });

  it("in the template folder, a template without a name is not offered (as on GitHub)", () => {
    const set = parseTemplateSet([
      { path: dir("notes.md"), content: "---\nlabels: x\n---\nbody" },
      { path: dir("form.yml"), content: "body:\n  - type: input\n    attributes:\n      label: A\n" },
      { path: "docs/ISSUE_TEMPLATE.md", content: "---\nlabels: y\n---\nlegacy" },
    ], parse);
    expect(set.templates.map((t) => t.name)).toEqual(["ISSUE_TEMPLATE"]);
  });

  it("a Markdown file in the template folder without front matter (a README) is not a template", () => {
    const set = parseTemplateSet([{ path: dir("README.md"), content: "# How to file\n" }], parse);
    expect(set.templates).toEqual([]);
  });

  it("a template without front matter is named after its file", () => {
    const set = parseTemplateSet([{ path: "docs/ISSUE_TEMPLATE.md", content: "Describe it.\n" }], parse);
    expect(set.templates[0]).toMatchObject({ name: "ISSUE_TEMPLATE", about: "", title: "", labels: [], assignees: [], body: "Describe it.\n" });
  });

  it("a template whose front matter does not parse is skipped, the others kept", () => {
    const set = parseTemplateSet([
      { path: dir("a.md"), content: "---\nname: [unclosed\n---\nx" },
      { path: dir("b.md"), content: "---\nname: B\n---\ny" },
    ], parse);
    expect(set.templates.map((t) => t.name)).toEqual(["B"]);
  });
});

describe("flattenForm", () => {
  it("markdown items become comments, text fields headings with their value or placeholder", () => {
    expect(flattenForm([
      { type: "markdown", attributes: { value: "Thanks for the report!\n" } },
      { type: "textarea", attributes: { label: "What happened?", placeholder: "Tell us" }, validations: { required: true } },
      { type: "input", attributes: { label: "Version", value: "3.13" } },
      { type: "textarea", attributes: { label: "Logs", render: "shell" } },
    ])).toBe(
      "<!-- Thanks for the report! -->\n\n" +
      "### What happened?\n\n<!-- Tell us -->\n\n" +
      "### Version\n\n3.13\n\n" +
      "### Logs\n\n```shell\n\n```\n",
    );
  });

  it("never closes a comment early, fences a rendered value, and skips an empty label's heading", () => {
    expect(flattenForm([
      { type: "markdown", attributes: { value: "a --> b --!> c" } },
      { type: "textarea", attributes: { label: "Logs", render: "shell", value: "ls -la" } },
      { type: "input", attributes: { label: "", value: "x" } },
    ])).toBe("<!-- a -- > b -- > c -->\n\n### Logs\n\n```shell\nls -la\n```\n\nx\n");
  });

  it("a dropdown's default counts the options as written", () => {
    expect(flattenForm([{ type: "dropdown", attributes: { label: "OS", options: [true, "Linux", "macOS"], default: 1 } }])).toBe("### OS\n\nLinux\n");
  });

  it("dropdowns give their default or the choices; checkboxes a task list", () => {
    expect(flattenForm([
      { type: "dropdown", attributes: { label: "OS", options: ["macOS", "Linux"], default: 1 } },
      { type: "dropdown", attributes: { label: "Browser", options: ["Chrome", "Firefox"] } },
      { type: "checkboxes", attributes: { label: "Checks", options: [{ label: "I searched" }, { label: "I read the docs" }] } },
    ])).toBe(
      "### OS\n\nLinux\n\n" +
      "### Browser\n\n<!-- Chrome | Firefox -->\n\n" +
      "### Checks\n\n- [ ] I searched\n- [ ] I read the docs\n",
    );
  });
});

describe("parseTemplateSet — issue forms and config", () => {
  it("an issue form gives its name, title, labels and the flattened body", () => {
    const yml = "name: Bug\ndescription: File a bug\ntitle: '[Bug]: '\nlabels: [bug, triage]\nbody:\n  - type: input\n    attributes:\n      label: Version\n";
    const set = parseTemplateSet([{ path: dir("bug.yml"), content: yml }], parse);
    expect(set.templates[0]).toMatchObject({ name: "Bug", about: "File a bug", title: "[Bug]: ", labels: ["bug", "triage"], body: "### Version\n" });
  });

  it("config.yml: blank issues and contact links", () => {
    const cfg = "blank_issues_enabled: false\ncontact_links:\n  - name: Discussions\n    url: https://github.com/o/r/discussions\n    about: Ask here\n";
    const set = parseTemplateSet([{ path: dir("config.yml"), content: cfg }], parse);
    expect(set.templates).toEqual([]);
    expect(set.blankAllowed).toBe(false);
    expect(set.contactLinks).toEqual([{ name: "Discussions", url: "https://github.com/o/r/discussions", about: "Ask here" }]);
  });

  it("without config, blank issues are allowed and there are no links", () => {
    const set = parseTemplateSet([], parse);
    expect(set).toEqual({ templates: [], blankAllowed: true, contactLinks: [] });
  });

  it("a contact link without an https URL is dropped", () => {
    const cfg = "contact_links:\n  - name: X\n    url: javascript:alert(1)\n    about: x\n";
    expect(parseTemplateSet([{ path: dir("config.yml"), content: cfg }], parse).contactLinks).toEqual([]);
  });

  it("loadTemplateSet loads the YAML parser itself", async () => {
    const set = await loadTemplateSet([{ path: dir("q.yml"), content: "name: Q\nbody:\n  - type: input\n    attributes:\n      label: A\n" }]);
    expect(set.templates[0].body).toBe("### A\n");
  });
});
