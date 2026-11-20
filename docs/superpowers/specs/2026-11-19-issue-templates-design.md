# Issue templates in the issue form (#301, part 5)

## Intent

Issue #301 asks to "support issue templates in `.github/ISSUE_TEMPLATE/`".
A repository's templates say what an issue should contain (steps to
reproduce, version, expected result...). Filing from GitWand should start
from them, as filing on GitHub does, so the issue fits the project's
conventions.

## Decided with the user

- **Both formats:**
  - **Markdown templates** (`*.md` with a front matter) fill the form as is.
  - **Issue forms** (`*.yml`) are **flattened into Markdown** (option 1).
    Each field becomes a `### Label` section the user fills in. This is the
    shape of the body GitHub itself produces from a form.
- **Rejected:**
  - a real form renderer (dropdowns, checkboxes, required fields): far
    more code for the same issue on GitHub;
  - Markdown templates only: many projects have only `.yml` forms.

## Behaviour

**Where the templates come from: the target repository of the form**

Read from GitHub, because the target can be a fork's parent:

1. `.github/ISSUE_TEMPLATE/*.md`, `*.yml` and `*.yaml`, plus `config.yml`;
2. if there are none, the single-template files: `.github/ISSUE_TEMPLATE.md`,
   `ISSUE_TEMPLATE.md`, `docs/ISSUE_TEMPLATE.md`;
3. if there are still none, the same paths in the owner's `.github`
   repository (GitHub's default community health files).

The templates are read again when the target changes. Limits: 20 templates,
64 KB each; beyond that a file is skipped.

**Picker**
- In the blank form only (toolbar, ⌘K, ⌘⇧I without a selection), a "Template"
  row lists each template's `name`, with its `about` as hint, plus "Blank
  issue".
- The commit, line-selection and resolution-report forms keep their own
  prefill and show no picker.
- Templates are listed in file name order, as GitHub does.

**Choosing a template**
- It fills the title (the template's `title`, possibly empty) and the
  description.
- It selects its `labels` that exist in the target's label list, and its
  `assignees` that the assignee picker offers; the others are ignored.
- If the title or description was edited, it first asks before replacing
  them, the same confirmation as the GitWand switch of part 3.
- "Blank issue" empties the title and description (asking the same way).

**`config.yml`**
- `blank_issues_enabled: false` shows a hint ("This repository expects a
  template") next to "Blank issue". It does not block sending, since the API
  allows a blank issue.
- `contact_links` are listed as links under the picker (name and about).

**Flattening an issue form (`.yml`)**

| Item | Becomes |
|---|---|
| `markdown` | An HTML comment (`<!-- … -->`): instructions the writer sees but the issue does not show, as on GitHub. |
| `textarea` | `### label`, then its `value`. When it has none, the `placeholder` as a comment. With `render: lang`, an empty fenced block in that language. |
| `input` | `### label`, then its `value`, or the `placeholder` as a comment. |
| `dropdown` | `### label`, then the `default` option if there is one; otherwise the options as a comment (`<!-- one of: a, b, c -->`). |
| `checkboxes` | `### label`, then `- [ ] option` for each option. |

- A required field (`validations.required: true`) gets ` *` after its
  label; nothing more is enforced.
- `title`, `labels` and `assignees` at the top of the form apply as for
  Markdown templates.

## Constraints

- **Backend command:** the template read is a new Tauri command (Settings
  token REST first, then `gh`, like the other `gh_issues` reads). It needs
  its `backend.ts` wrapper, its `commandRegistry` entry and a dev-server
  route.
- **Where the logic lives:**
  - parsing and flattening are pure TypeScript, tested on their own;
  - YAML goes through the `yaml` package, loaded on demand (the main chunk
    stays within budget).
- **Content handling:** the template's text is data. It is never run, and
  the preview is sanitised as today.
- **i18n:** all 5 locales.

## Non-goals

- Enforcing required fields, and real dropdowns or checkboxes.
- GitLab and Gitea templates (the issue form is GitHub-only).
- The picker on prefilled forms.
- Organisation-wide templates beyond the owner's `.github` repository.

## Left to the builder

- The exact layout of the "Template" row in the modal; it follows the
  existing target and labels rows.
