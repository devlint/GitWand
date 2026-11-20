# Issue references in the commit message (#301, part 4)

## Intent

Issue #301 (Pannboo) asks that, after an issue is filed from GitWand, its `#123`
can go into the commit message being written, and, later, that an existing
issue can be linked to a commit (`Fixes #N`). The goal is to cite an issue
without leaving the commit panel, the way one does on GitHub or in an IDE.

## Decided with the user

- **Approach A:** typing `#` in the commit summary or description opens a
  list of the repository's open issues, filtered as you type. It works the
  same way `/` opens commit templates.
- The "issue created" toast gets an **"Add to commit"** action.
- Rejected:
  - **B, a "Link an issue" button and picker:** an extra click, and an issue
    cannot be cited mid-sentence. It can come later if needed.
  - **The issue's dedicated list panel:** too far from where the message is
    written.

## Behaviour

**Trigger**
- A `#` opens the list when it is at the very start of the field, or right
  after a space, a line break or `(`.
- `C#` and `abc#` never open it.
- The list follows what is typed after the `#`. It closes on a space,
  on Escape, when the field loses focus, or when the `#` is deleted.

**Content**
- Open issues of the repository, from the active forge's `listIssues`. Today
  that covers GitHub, GitLab, Gitea and Bitbucket.
- A forge without `listIssues` (Azure, Cursor) gets no list; `#` stays a plain
  character.

**Filter**
- Digits match the issue number by prefix.
- Anything else matches the title, case-insensitively.
- At most 8 rows, the most recently updated first.

**Keys**

| Key | Effect |
|---|---|
| ↑ / ↓ | Move through the rows |
| Enter or Tab | Replace `#query` with `#N ` |
| Shift+Enter | Replace `#query` with `Fixes #N ` |
| Escape | Close the list only |
| Click | Same as Enter |

- When the list is closed, every key behaves as today.
- The list's last row reminds the user of the two forms: `↵ #N · ⇧↵ Fixes #N`.

**Loading and errors**
- The issues are fetched the first time the list opens for a repository.
- They are kept per repository and fetched again when more than 60 s old.
- While they load, the list shows a "Loading…" row.
- If loading fails (no account, network down), the list shows a muted
  "Issues unavailable" row and the `#` is left as typed.

**Toast after creating an issue**
- The toast keeps its "Open" link and gains an "Add to commit" button.
- The button appends ` #N` to the end of the current commit description. With
  an empty description, the description becomes `#N`.
- Nothing is added if that reference is already in the message.

**Which repository `#N` points to**
- A bare `#N` points to the repository the commit is pushed to.
- An issue filed on the parent of a fork (the PR #304 path) is written
  `owner/repo#N`, both from the toast and from the list.

## Constraints

- **Strings:** every UI string goes in all 5 locales. The keyword `Fixes` and
  the `#N` format are git text, so they are not translated.
- **Escape:** the list's Escape must not reach the app's Escape ladder, which
  closes panels.
- **Logic location:** the logic lives in a composable (the trigger, the
  filter, the cache). RepoSidebar wires it to the two fields.
- **No new Tauri command:** `listIssues` and its dev-server routes already
  exist.
- **Performance:** nothing is fetched until a `#` opens the list. There is no
  polling.

## Non-goals

- A choice of closing keyword other than `Fixes` (Closes, Resolves…).
- Azure's `AB#N`.
- An issue browsing panel.
- Linking closed issues.

## Left to the builder

- **Which repository `listIssues` reads:** on GitHub, `gh` may resolve
  `upstream` (#298). Check it, and qualify the reference whenever that
  repository is not the push remote.
- **The list's exact position under the caret:** in the textarea, under the
  line is enough.
