# Forge-side auto-merge: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** let the user queue a pull request to merge when its checks pass, and cancel that queue,
on GitHub, GitLab and Azure, with Bitbucket degrading honestly because it has no such capability.

**Architecture:** each forge module computes a small typed descriptor from the payload it already
parses, and that descriptor rides the shared `PullRequest` / `PullRequestDetail` structs that all
four forges already normalise into. The frontend renders from the descriptor and never branches on
provider. Two new commands per supporting forge (arm, disarm), each with its typed wrapper and its
dev-server route in the same task.

**Tech stack:** Rust (Tauri 2), Vue 3 Composition API, TypeScript, Vitest, Node dev-server
(`dev-server.mjs`), `gh` / `glab` CLIs and the Azure DevOps REST API.

**Spec:** `docs/superpowers/specs/2026-09-14-forge-side-auto-merge-design.md`
**Roadmap:** `roadmap.md`, section `### v3.11.0`, bullet "Forge-side auto-merge".

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Package manager: pnpm only.** Never `npm`, never `yarn`.
- **Never hand-edit a version field.** `package.json` / `Cargo.toml` / `tauri.conf.json` belong to
  `./scripts/bump-version.sh`, run at tag time only. **This lot does not bump anything.** v3.11.0
  gets a single tag once all four remaining lots are in `main`.
- **Every new `#[tauri::command]` gets a typed wrapper in `apps/desktop/src/utils/backend*.ts` and a
  real (not stubbed) `dev-server.mjs` route in the same task.**
- **Frontend never calls `invoke()` directly.** Always through the `backend*.ts` layer.
- **No shell string interpolation in commands.** Always `.args([...])`, one argument per entry.
- **Never log secrets.** Forge tokens must not reach stdout, stderr or a spawned process's argv.
- **i18n: 5 locales.** Every user-visible GitWand string needs a key in all of
  `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`. `reason` strings coming from a forge are
  data, not GitWand copy, and are deliberately passed through untranslated.
- **Vitest environment:** `node` by default; a test file touching the DOM adds
  `// @vitest-environment jsdom` on its first line.
- **Component tests use native `createApp` into jsdom.** There is no `@vue/test-utils` in the tree.
- **Rust unit tests go in a named `#[cfg(test)] mod <thing>_tests` next to the function they cover**,
  which is the established convention (`gitlab.rs` carries eight of them).
- **Parity probe covers git commands only.** Forge commands are not added to the probe dispatch; the
  parity assertion for this lot is the refusal-shape test described in Task 5.
- Conventional commits. **No em dash characters** anywhere in generated text.

**Commands used throughout:**

```bash
# Rust
cd apps/desktop/src-tauri && cargo test
cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings

# Frontend unit tests
cd apps/desktop && pnpm test

# Parity harness
cd apps/desktop && pnpm test:parity

# Bundle budget
cd apps/desktop && pnpm build && pnpm bundle-check

# Manual QA against a real forge
cd apps/desktop && pnpm dev:web
```

---

## Phase Map and Dependencies

| Task | Title | Depends on |
|---|---|---|
| 1 | Descriptor types + GitHub pure mapping | none |
| 2 | GitLab, Azure, Bitbucket pure mappings | 1 |
| 3 | Wire the descriptor into the Rust list and detail paths | 1, 2 |
| 4 | TypeScript types and the four mapping sites | 3 |
| 5 | GitHub arm/disarm: command, wrapper, route, refusal parity | 1 |
| 6 | GitLab arm/disarm | 2 |
| 7 | Azure arm/disarm + authenticated identity | 2 |
| 8 | PR detail panel: the action and the rule | 4, 5, 6, 7 |
| 9 | PR list badge | 4 |
| 10 | Today inbox action | 4, 8 |
| 11 | Manual verification and documentation | all |

Tasks 5, 6 and 7 are independent of each other and of 3/4, so they can run in parallel with them.

---

## Task 1: Descriptor types + GitHub pure mapping

**Files:**
- Modify: `apps/desktop/src-tauri/src/types.rs:347` (`PullRequest`), `:520` (`PullRequestDetail`)
- Modify: `apps/desktop/src-tauri/src/commands/gh.rs`
- Test: a new `#[cfg(test)] mod gh_auto_merge_tests` at the end of `gh.rs`

**Interfaces:**
- Produces: `crate::types::AutoMergeState { armed: bool, available: bool, reason: Option<String> }`
  and `crate::types::AutoMergeSupport { supported: bool, reason: Option<String> }`, both
  `#[derive(Serialize, Deserialize, Default, PartialEq, Debug)]` with `#[serde(rename_all =
  "camelCase")]`. Free function `gh_auto_merge_state(pr: &serde_json::Value) -> AutoMergeState`.
  Free function `gh_auto_merge_support(repo_view: &serde_json::Value) -> AutoMergeSupport`.

- [ ] **Step 1: Write the failing tests**

Add at the end of `gh.rs`:

```rust
#[cfg(test)]
mod gh_auto_merge_tests {
    use super::{gh_auto_merge_state, gh_auto_merge_support};

    #[test]
    fn a_pr_with_auto_merge_queued_is_armed() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"number": 7, "autoMergeRequest": {"enabledAt": "2026-09-14T10:00:00Z"}}"#,
        )
        .unwrap();
        let s = gh_auto_merge_state(&v);
        assert!(s.armed);
        assert!(s.available);
        assert_eq!(s.reason, None);
    }

    #[test]
    fn a_pr_without_auto_merge_is_not_armed_but_is_available() {
        let v: serde_json::Value = serde_json::from_str(r#"{"number": 7}"#).unwrap();
        let s = gh_auto_merge_state(&v);
        assert!(!s.armed);
        assert!(s.available, "GitHub has no per-PR precondition beyond the repo setting");
    }

    #[test]
    fn an_explicit_null_auto_merge_request_is_not_armed() {
        // `gh pr list --json autoMergeRequest` emits an explicit null, not an
        // absent key, which is a different JSON shape from the test above.
        let v: serde_json::Value =
            serde_json::from_str(r#"{"number": 7, "autoMergeRequest": null}"#).unwrap();
        assert!(!gh_auto_merge_state(&v).armed);
    }

    #[test]
    fn a_repo_with_auto_merge_disabled_is_unsupported_with_a_reason() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"autoMergeAllowed": false}"#).unwrap();
        let s = gh_auto_merge_support(&v);
        assert!(!s.supported);
        assert_eq!(
            s.reason.as_deref(),
            Some("Auto-merge is disabled in this repository's settings.")
        );
    }

    #[test]
    fn a_repo_with_auto_merge_allowed_is_supported() {
        let v: serde_json::Value = serde_json::from_str(r#"{"autoMergeAllowed": true}"#).unwrap();
        let s = gh_auto_merge_support(&v);
        assert!(s.supported);
        assert_eq!(s.reason, None);
    }

    #[test]
    fn a_missing_field_is_treated_as_unsupported_not_as_allowed() {
        // An older `gh`, or a response shape we did not anticipate, must fail
        // closed: offering a button that cannot work is worse than hiding one
        // that could.
        let v: serde_json::Value = serde_json::from_str(r#"{}"#).unwrap();
        assert!(!gh_auto_merge_support(&v).supported);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test gh_auto_merge_tests`
Expected: FAIL, `cannot find function gh_auto_merge_state in this scope`.

- [ ] **Step 3: Add the two structs to `types.rs`**

Insert just above `pub struct PullRequest` (currently line 347):

```rust
// ─── Forge-side auto-merge (v3.11.0) ───────────────────────────────
//
// Two scopes, deliberately separate. `supported` is an administrative
// setting of the repository and does not vary per PR, so resolving it per
// PR would ask N times for one answer. `armed` / `available` are per PR and
// come from payloads each forge module already parses.

#[derive(Serialize, Deserialize, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutoMergeSupport {
    /// This forge, on this repository, can queue a merge at all.
    pub supported: bool,
    /// When it cannot, why, in the forge's own words. Not translated: this
    /// is forge data, not GitWand copy.
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutoMergeState {
    /// An auto-merge is queued on this PR right now.
    pub armed: bool,
    /// This PR meets the forge's preconditions for queueing one.
    pub available: bool,
    /// When it does not, why. Forge text, untranslated.
    pub reason: Option<String>,
}
```

Then add the field to both structs. In `PullRequest`, next to `merge_state_status`:

```rust
    #[serde(rename = "autoMerge", default)]
    pub auto_merge: AutoMergeState,
```

and the identical field in `PullRequestDetail`.

- [ ] **Step 4: Write the two GitHub mapping functions**

In `gh.rs`, above the test module:

```rust
/// Per-PR auto-merge state from a `gh pr list` / `gh pr view` JSON object.
///
/// `autoMergeRequest` is a flat node: present and non-null when a merge is
/// queued, explicitly `null` otherwise. GitHub has no per-PR precondition
/// beyond the repository setting, so `available` is unconditionally true
/// here; whether the repository allows it at all is `gh_auto_merge_support`.
pub(crate) fn gh_auto_merge_state(pr: &serde_json::Value) -> crate::types::AutoMergeState {
    crate::types::AutoMergeState {
        armed: pr.get("autoMergeRequest").is_some_and(|v| !v.is_null()),
        available: true,
        reason: None,
    }
}

/// Repository-level capability from `gh repo view --json autoMergeAllowed`.
///
/// Fails closed: a missing or non-boolean field reads as unsupported. An
/// older `gh`, or a shape we did not anticipate, must hide the button rather
/// than offer one that cannot work.
pub(crate) fn gh_auto_merge_support(
    repo_view: &serde_json::Value,
) -> crate::types::AutoMergeSupport {
    if repo_view
        .get("autoMergeAllowed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        crate::types::AutoMergeSupport { supported: true, reason: None }
    } else {
        crate::types::AutoMergeSupport {
            supported: false,
            reason: Some(
                "Auto-merge is disabled in this repository's settings.".to_string(),
            ),
        }
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test gh_auto_merge_tests`
Expected: PASS, 6 tests.

- [ ] **Step 6: Check nothing else broke**

Run: `cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS. The new `PullRequest` field has a `Default`, so every existing construction site
still compiles.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/types.rs apps/desktop/src-tauri/src/commands/gh.rs
git commit -m "feat(desktop): auto-merge descriptor types and the GitHub mapping"
```

---

## Task 2: GitLab, Azure and Bitbucket pure mappings

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gitlab.rs`, `azure.rs`, `bitbucket.rs`
- Test: a new named `#[cfg(test)]` module in each of the three

**Interfaces:**
- Consumes: `crate::types::{AutoMergeState, AutoMergeSupport}` from Task 1.
- Produces: `gl_auto_merge_state(mr: &serde_json::Value) -> AutoMergeState`,
  `az_auto_merge_state(pr: &serde_json::Value) -> AutoMergeState`,
  `bb_auto_merge_support() -> AutoMergeSupport`. GitLab and Azure need no `*_support` function:
  both are constant `supported: true`, expressed at the call site in Task 3.

- [ ] **Step 1: Write the failing GitLab tests**

At the end of `gitlab.rs`:

```rust
#[cfg(test)]
mod gl_auto_merge_tests {
    use super::gl_auto_merge_state;

    #[test]
    fn an_mr_with_merge_when_pipeline_succeeds_is_armed() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"iid": 3, "merge_when_pipeline_succeeds": true,
                "pipeline": {"id": 9, "status": "running"}}"#,
        )
        .unwrap();
        let s = gl_auto_merge_state(&v);
        assert!(s.armed);
        assert!(s.available);
    }

    #[test]
    fn an_mr_with_a_running_pipeline_is_available_but_not_armed() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"iid": 3, "merge_when_pipeline_succeeds": false,
                "pipeline": {"id": 9, "status": "running"}}"#,
        )
        .unwrap();
        let s = gl_auto_merge_state(&v);
        assert!(!s.armed);
        assert!(s.available);
    }

    #[test]
    fn an_mr_with_no_pipeline_is_unavailable_with_a_reason() {
        // GitLab's merge-when-pipeline-succeeds needs a pipeline to succeed.
        let v: serde_json::Value =
            serde_json::from_str(r#"{"iid": 3, "merge_when_pipeline_succeeds": false}"#).unwrap();
        let s = gl_auto_merge_state(&v);
        assert!(!s.available);
        assert_eq!(
            s.reason.as_deref(),
            Some("No pipeline is running for this merge request.")
        );
    }

    #[test]
    fn a_null_pipeline_reads_the_same_as_an_absent_one() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"iid": 3, "merge_when_pipeline_succeeds": false, "pipeline": null}"#,
        )
        .unwrap();
        assert!(!gl_auto_merge_state(&v).available);
    }

    #[test]
    fn the_newer_auto_merge_enabled_field_is_honoured_when_present() {
        // GitLab 17.x renamed the flag. Both spellings must arm.
        let v: serde_json::Value = serde_json::from_str(
            r#"{"iid": 3, "auto_merge_enabled": true, "pipeline": {"status": "running"}}"#,
        )
        .unwrap();
        assert!(gl_auto_merge_state(&v).armed);
    }
}
```

- [ ] **Step 2: Run them and verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test gl_auto_merge_tests`
Expected: FAIL, `cannot find function gl_auto_merge_state`.

- [ ] **Step 3: Implement the GitLab mapping**

```rust
/// Per-MR auto-merge state from a GitLab merge-request JSON object.
///
/// Two spellings of the same flag: `merge_when_pipeline_succeeds` is the
/// historical name, `auto_merge_enabled` the 17.x one. Either arms.
///
/// The precondition is a pipeline: merge-when-pipeline-succeeds has nothing
/// to wait for without one, and GitLab refuses the call.
fn gl_auto_merge_state(mr: &serde_json::Value) -> crate::types::AutoMergeState {
    let armed = mr
        .get("merge_when_pipeline_succeeds")
        .and_then(|v| v.as_bool())
        .or_else(|| mr.get("auto_merge_enabled").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    let has_pipeline = mr.get("pipeline").is_some_and(|v| !v.is_null())
        || mr.get("head_pipeline").is_some_and(|v| !v.is_null());
    crate::types::AutoMergeState {
        armed,
        available: has_pipeline,
        reason: if has_pipeline {
            None
        } else {
            Some("No pipeline is running for this merge request.".to_string())
        },
    }
}
```

- [ ] **Step 4: Verify the GitLab tests pass**

Run: `cd apps/desktop/src-tauri && cargo test gl_auto_merge_tests`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing Azure tests**

At the end of `azure.rs`:

```rust
#[cfg(test)]
mod az_auto_merge_tests {
    use super::az_auto_merge_state;

    #[test]
    fn a_pr_with_auto_complete_set_is_armed() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"pullRequestId": 4, "isDraft": false,
                "autoCompleteSetBy": {"id": "11111111-2222-3333-4444-555555555555"}}"#,
        )
        .unwrap();
        let s = az_auto_merge_state(&v);
        assert!(s.armed);
        assert!(s.available);
    }

    #[test]
    fn a_draft_pr_is_unavailable_with_a_reason() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"pullRequestId": 4, "isDraft": true}"#).unwrap();
        let s = az_auto_merge_state(&v);
        assert!(!s.available);
        assert_eq!(
            s.reason.as_deref(),
            Some("A draft pull request cannot be set to auto-complete.")
        );
    }

    #[test]
    fn a_non_draft_pr_without_auto_complete_is_available_but_not_armed() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"pullRequestId": 4, "isDraft": false}"#).unwrap();
        let s = az_auto_merge_state(&v);
        assert!(!s.armed);
        assert!(s.available);
    }

    #[test]
    fn a_missing_is_draft_field_reads_as_not_draft() {
        // Azure omits `isDraft` on some API versions rather than sending false.
        let v: serde_json::Value = serde_json::from_str(r#"{"pullRequestId": 4}"#).unwrap();
        assert!(az_auto_merge_state(&v).available);
    }
}
```

- [ ] **Step 6: Implement the Azure mapping and verify**

```rust
/// Per-PR auto-complete state from an Azure DevOps pull-request object.
///
/// `autoCompleteSetBy` carries the identity that armed it, so its presence
/// is the armed flag. Azure refuses auto-complete on a draft.
fn az_auto_merge_state(pr: &serde_json::Value) -> crate::types::AutoMergeState {
    let is_draft = pr.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false);
    crate::types::AutoMergeState {
        armed: pr.get("autoCompleteSetBy").is_some_and(|v| !v.is_null()),
        available: !is_draft,
        reason: if is_draft {
            Some("A draft pull request cannot be set to auto-complete.".to_string())
        } else {
            None
        },
    }
}
```

Run: `cd apps/desktop/src-tauri && cargo test az_auto_merge_tests`
Expected: PASS, 4 tests.

- [ ] **Step 7: Write the Bitbucket support function and its test**

At the end of `bitbucket.rs`:

```rust
/// Bitbucket has no forge-side auto-merge. Static, and stated rather than
/// inferred from an absent field, so the UI can explain instead of hiding.
pub(crate) fn bb_auto_merge_support() -> crate::types::AutoMergeSupport {
    crate::types::AutoMergeSupport {
        supported: false,
        reason: Some(
            "Bitbucket has no merge-when-checks-pass equivalent. Merging immediately still works."
                .to_string(),
        ),
    }
}

#[cfg(test)]
mod bb_auto_merge_tests {
    use super::bb_auto_merge_support;

    #[test]
    fn bitbucket_is_unsupported_and_says_what_still_works() {
        let s = bb_auto_merge_support();
        assert!(!s.supported);
        let reason = s.reason.expect("a reason, not a silent false");
        assert!(
            reason.contains("Merging immediately still works"),
            "the message must say what DOES work, per the forgeUnsupported precedent"
        );
    }
}
```

- [ ] **Step 8: Run the full Rust suite and commit**

Run: `cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS.

```bash
git add apps/desktop/src-tauri/src/commands/gitlab.rs \
        apps/desktop/src-tauri/src/commands/azure.rs \
        apps/desktop/src-tauri/src/commands/bitbucket.rs
git commit -m "feat(desktop): auto-merge mappings for GitLab, Azure and Bitbucket"
```

---

## Task 3: Wire the descriptor into the Rust list and detail paths

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gh.rs` (the `--json` field lists at `:105`, `:463`,
  `:900`, and the `gh repo view` call at `:204`)
- Modify: `apps/desktop/src-tauri/src/commands/gitlab.rs`, `azure.rs`, `bitbucket.rs` at their
  `PullRequest` / `PullRequestDetail` construction sites

**Interfaces:**
- Consumes: the five mapping functions from Tasks 1 and 2.
- Produces: every `PullRequest` and `PullRequestDetail` crossing IPC now carries a populated
  `autoMerge` object rather than the `Default`.

- [ ] **Step 1: Measure the cost of the added GitHub field before adding it**

This is a required measurement, not a formality. `gh.rs:155` carries an explicit warning about the
cost of fields added to `gh pr list --json`.

On a repository with a large open-PR count, time the current call and the call with the field added:

```bash
cd <a repo with many open PRs>
time gh pr list --limit 100 --json number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,labels,assignees,mergeStateStatus,statusCheckRollup
time gh pr list --limit 100 --json number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,labels,assignees,mergeStateStatus,statusCheckRollup,autoMergeRequest
```

Record both numbers in the commit message. **If the second is more than 20% slower, stop and do not
add the field to the list call.** Fall back to detail-only: `armed` then reaches the PR detail alone,
Task 9's badge is dropped from the plan, and Task 10's Today action offers auto-merge only after the
PR has been opened once. Write which branch was taken into the commit message either way.

- [ ] **Step 2: Add the field to the GitHub calls**

Assuming the measurement passed, append `,autoMergeRequest` to the `--json` list at `gh.rs:105` and
`:463`, and to the detail list at `:900`. Append `,autoMergeAllowed` to the `gh repo view --json`
call at `:204`.

- [ ] **Step 3: Populate the struct at each construction site**

Wherever `gh.rs` builds a `PullRequest` or `PullRequestDetail` from the parsed JSON object `v`, set:

```rust
        auto_merge: gh_auto_merge_state(&v),
```

Do the same in `gitlab.rs` with `gl_auto_merge_state(&v)` and in `azure.rs` with
`az_auto_merge_state(&v)`. In `bitbucket.rs` leave the `Default` (`armed: false, available: false`),
because Bitbucket's answer is carried by `bb_auto_merge_support()` at the support level, not per PR.

- [ ] **Step 4: Verify the per-forge precondition fields are actually on the list payload**

The design flags this as an open verification, one capture per forge. For GitLab and Azure, log one
real list response and confirm that `pipeline` (GitLab) and `isDraft` (Azure) are present on the
**list** payload and not only on the detail:

```bash
glab api "projects/:id/merge_requests?per_page=1" | head -60
az repos pr list --output json | head -60
```

If a field is absent from a list response, that forge's `available` reads false in lists, which
would wrongly hide the Today action. In that case set `available: true` with `reason: None` on the
list path for that forge and let the detail path carry the real answer, and record the decision in
a comment at the construction site.

- [ ] **Step 5: Run the Rust suite**

Run: `cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/
git commit -m "feat(desktop): carry the auto-merge descriptor on every PR the forges return"
```

---

## Task 4: TypeScript types and the four mapping sites

**Files:**
- Modify: `apps/desktop/src/utils/backend-pr.ts:69` (`PullRequest`), and its `PullRequestDetail`
- Modify: `apps/desktop/src/utils/backend-gitlab.ts:50` (`mapGlPullRequest`)
- Modify: `apps/desktop/src/utils/backend-bitbucket.ts` (its equivalent mapping function)
- Test: `apps/desktop/src/utils/__tests__/backend-gitlab-automerge.test.ts` (new)

**Interfaces:**
- Consumes: the serialized `autoMerge` object from Task 3.
- Produces: `export interface AutoMergeState { armed: boolean; available: boolean; reason: string | null }`
  and `export interface AutoMergeSupport { supported: boolean; reason: string | null }` in
  `backend-pr.ts`, plus `autoMerge: AutoMergeState` on `PullRequest` and `PullRequestDetail`.

- [ ] **Step 1: Write the failing mapping test**

Create `apps/desktop/src/utils/__tests__/backend-gitlab-automerge.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mapGlPullRequest } from "../backend-gitlab";

describe("mapGlPullRequest, auto-merge passthrough", () => {
  it("carries the descriptor through the GitLab normalisation", () => {
    const raw = {
      number: 3,
      title: "t",
      auto_merge: { armed: true, available: true, reason: null },
    } as any;
    expect(mapGlPullRequest(raw).autoMerge).toEqual({
      armed: true,
      available: true,
      reason: null,
    });
  });

  it("defaults to a closed descriptor when the backend sent none", () => {
    // An older backend, or a path that has not been wired yet, must not make
    // the UI offer a button. Absent reads as unavailable, never as available.
    const raw = { number: 3, title: "t" } as any;
    expect(mapGlPullRequest(raw).autoMerge).toEqual({
      armed: false,
      available: false,
      reason: null,
    });
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/utils/__tests__/backend-gitlab-automerge.test.ts`
Expected: FAIL, `autoMerge` is undefined.

- [ ] **Step 3: Add the types and the passthrough**

In `backend-pr.ts`, above `export interface PullRequest`:

```typescript
/**
 * Forge-side auto-merge, v3.11.0. Two scopes: `AutoMergeSupport` is a
 * property of the repository, `AutoMergeState` of one PR.
 *
 * `reason` is the forge's own text and is deliberately NOT translated: the
 * i18n rule covers GitWand's copy, not messages a forge produces.
 */
export interface AutoMergeSupport {
  supported: boolean;
  reason: string | null;
}

export interface AutoMergeState {
  armed: boolean;
  available: boolean;
  reason: string | null;
}

/** Fails closed: an absent descriptor never offers the action. */
export const CLOSED_AUTO_MERGE: AutoMergeState = {
  armed: false,
  available: false,
  reason: null,
};
```

Add `autoMerge: AutoMergeState;` to `PullRequest` and to `PullRequestDetail`. In
`mapGlPullRequest` and the Bitbucket equivalent, add:

```typescript
    autoMerge: pr.auto_merge ?? CLOSED_AUTO_MERGE,
```

- [ ] **Step 4: Verify the test passes and the suite is green**

Run: `cd apps/desktop && pnpm test`
Expected: PASS. Fix any TypeScript error where a test fixture builds a `PullRequest` literal and now
misses the field; add `autoMerge: CLOSED_AUTO_MERGE` to those fixtures.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils/
git commit -m "feat(desktop): type the auto-merge descriptor across the four forges"
```

---

## Task 5: GitHub arm and disarm

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gh.rs` (next to `gh_merge_pr` at `:782`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (the `invoke_handler` registration list)
- Modify: `apps/desktop/src/utils/backend-pr.ts` (next to `ghMergePr` at `:466`)
- Modify: `apps/desktop/dev-server.mjs` (next to the `/api/gh-merge-pr` route)
- Test: `apps/desktop/tests/parity/auto-merge-refusal.test.mjs` (new)

**Interfaces:**
- Produces: `gh_enable_auto_merge(cwd: String, number: i64, method: String) -> Result<(), String>`
  and `gh_disable_auto_merge(cwd: String, number: i64) -> Result<(), String>`; TS wrappers
  `ghEnableAutoMerge(cwd, number, method)` and `ghDisableAutoMerge(cwd, number)`; routes
  `POST /api/gh-enable-auto-merge` and `POST /api/gh-disable-auto-merge`.

- [ ] **Step 1: Write the failing refusal-parity test**

Create `apps/desktop/tests/parity/auto-merge-refusal.test.mjs`:

```javascript
/**
 * Parity: the Rust command and the dev-server route must REFUSE identically.
 *
 * Following the read_file precedent from #189. No test arms an auto-merge on
 * a live PR; what is checkable, and what has historically drifted, is whether
 * the two backends agree on failure. A repository with no forge remote is the
 * cheapest way to make both refuse for the same reason.
 */
import { describe, it, expect } from "vitest";
import { makeRepo } from "./fixtures.mjs";
import { withDevServer, probe } from "./harness.mjs";

describe("parity: auto-merge refusal", () => {
  it("both backends refuse on a repo with no forge remote", async () => {
    const repo = await makeRepo();
    const viaProbe = await probe("gh-enable-auto-merge", {
      cwd: repo,
      number: 1,
      method: "squash",
    });
    const viaRoute = await withDevServer(async (base) => {
      const r = await fetch(`${base}/api/gh-enable-auto-merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: repo, number: 1, method: "squash" }),
      });
      return r.json();
    });
    expect(viaProbe.error).toBeTruthy();
    expect(viaRoute.error).toBeTruthy();
    expect(normalizeForgeError(viaRoute.error)).toBe(normalizeForgeError(viaProbe.error));
  });
});

/** Collapse the parts that legitimately differ: absolute paths, gh's own
 *  wording across versions. What must match is the class of failure. */
function normalizeForgeError(msg) {
  return String(msg)
    .replace(/\/[^\s]*\/gw-[^\s]*/g, "<repo>")
    .toLowerCase()
    .includes("no git remote") ? "no-remote" : "other";
}
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd apps/desktop && pnpm test:parity -- auto-merge-refusal`
Expected: FAIL, the route does not exist.

Note: the parity harness binds a local port and the CLI paths reach the network, so this suite needs
to run outside a restrictive sandbox.

- [ ] **Step 3: Implement the two Rust commands, both paths**

`gh_merge_pr_inner` (`gh.rs:750`) has **two** implementations, and this was missed in the design:
when a GitHub token is configured in Settings it calls `github_api::rest_merge_pr` and never touches
the `gh` CLI. A command that only shells out to `gh` would break for token users, who may not have
`gh` installed at all. Mirror that structure exactly.

Note also that both existing merge paths pass `--delete-branch`. Auto-merge does too, or it behaves
differently from the button sitting next to it.

In `gh.rs`, next to `gh_merge_pr`:

```rust
fn gh_enable_auto_merge_inner(cwd: String, number: i64, method: String) -> Result<(), String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_enable_auto_merge(&cwd, number, &method, &tok);
    }
    let merge_flag = match method.as_str() {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };
    let output = hidden_cmd("gh")
        .args([
            "pr",
            "merge",
            &number.to_string(),
            "--auto",
            merge_flag,
            "--delete-branch",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to enable auto-merge: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh pr merge --auto failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Queue this PR to merge once its required checks pass.
///
/// A separate command from `gh_merge_pr` rather than a flag on it: arming
/// takes a merge method, disarming takes none, and the two fail for
/// unrelated reasons. `git_rebase_action`'s mode argument works because its
/// three modes share every argument; these do not.
#[tauri::command]
pub(crate) async fn gh_enable_auto_merge(
    cwd: String,
    number: i64,
    method: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_enable_auto_merge_inner(cwd, number, method))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_disable_auto_merge_inner(cwd: String, number: i64) -> Result<(), String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_disable_auto_merge(&cwd, number, &tok);
    }
    let output = hidden_cmd("gh")
        .args(["pr", "merge", &number.to_string(), "--disable-auto"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to disable auto-merge: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh pr merge --disable-auto failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Cancel a queued auto-merge. Takes no method: there is nothing to choose.
#[tauri::command]
pub(crate) async fn gh_disable_auto_merge(cwd: String, number: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_disable_auto_merge_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}
```

Register both in `lib.rs`'s `invoke_handler` list, among the other `gh_*` entries.

- [ ] **Step 4: Implement the token path in `github_api.rs`**

`github_api.rs` already has a `graphql(token, query, variables)` helper at `:1582` and already
resolves PR node ids for other mutations (see `:1448`, `:1624`). Auto-merge is two GraphQL
mutations taking the same node id, so this follows an established path rather than opening a new one.

```rust
/// GraphQL equivalent of `gh pr merge --auto`, for the configured-token path.
///
/// `enablePullRequestAutoMerge` takes the PR's node id, which this module
/// already resolves for its other mutations.
pub(crate) fn rest_enable_auto_merge(
    cwd: &str,
    number: i64,
    method: &str,
    token: &str,
) -> Result<(), String> {
    let node = pr_node_id(cwd, number, token)?;
    let merge_method = match method {
        "squash" => "SQUASH",
        "rebase" => "REBASE",
        _ => "MERGE",
    };
    let query = r#"
        mutation($id: ID!, $method: PullRequestMergeMethod!) {
          enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) {
            clientMutationId
          }
        }"#;
    graphql(
        token,
        query,
        serde_json::json!({ "id": node, "method": merge_method }),
    )?;
    Ok(())
}

/// GraphQL equivalent of `gh pr merge --disable-auto`.
pub(crate) fn rest_disable_auto_merge(
    cwd: &str,
    number: i64,
    token: &str,
) -> Result<(), String> {
    let node = pr_node_id(cwd, number, token)?;
    let query = r#"
        mutation($id: ID!) {
          disablePullRequestAutoMerge(input: {pullRequestId: $id}) {
            clientMutationId
          }
        }"#;
    graphql(token, query, serde_json::json!({ "id": node }))?;
    Ok(())
}
```

`pr_node_id` is the existing node-id resolution used by the neighbouring mutations; read its real
name at `:1448` and `:1624` and use that rather than the name written here.

- [ ] **Step 5: Add the typed wrappers and the dev-server routes**

In `backend-pr.ts`, next to `ghMergePr` at `:466`, following its exact shape:

```typescript
export async function ghEnableAutoMerge(
  cwd: string,
  number: number,
  method: string = "merge",
): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("gh_enable_auto_merge", { cwd, number, method });
    return;
  }
  const resp = await devFetch(`${DEV_SERVER}/api/gh-enable-auto-merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, number, method }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
}

export async function ghDisableAutoMerge(cwd: string, number: number): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("gh_disable_auto_merge", { cwd, number });
    return;
  }
  const resp = await devFetch(`${DEV_SERVER}/api/gh-disable-auto-merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, number }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
}
```

In `dev-server.mjs`, immediately after the `/api/gh-merge-pr` route at `:5067`, using that route's
own helpers (`readBody`, `jsonResponse`, `spawnSync`, `GH`, `resolve`) rather than any new ones:

```javascript
    // POST /api/gh-enable-auto-merge  { cwd, number, method }
    if (url.pathname === "/api/gh-enable-auto-merge" && req.method === "POST") {
      try {
        const { cwd, number, method } = await readBody(req);
        if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
        const mergeFlag = method === "squash" ? "--squash"
          : method === "rebase" ? "--rebase"
          : "--merge";
        const r = spawnSync(
          GH,
          ["pr", "merge", String(number), "--auto", mergeFlag, "--delete-branch"],
          { cwd: resolve(cwd), encoding: "utf-8" },
        );
        if (r.status !== 0) {
          const detail = (r.stderr || r.stdout || "").trim() || "gh pr merge --auto failed";
          return jsonResponse(req, res, { error: detail }, 500);
        }
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }

    // POST /api/gh-disable-auto-merge  { cwd, number }
    if (url.pathname === "/api/gh-disable-auto-merge" && req.method === "POST") {
      try {
        const { cwd, number } = await readBody(req);
        if (!cwd || !number) return jsonResponse(req, res, { error: "Missing cwd or number" }, 400);
        const r = spawnSync(GH, ["pr", "merge", String(number), "--disable-auto"], {
          cwd: resolve(cwd),
          encoding: "utf-8",
        });
        if (r.status !== 0) {
          const detail = (r.stderr || r.stdout || "").trim() || "gh pr merge --disable-auto failed";
          return jsonResponse(req, res, { error: detail }, 500);
        }
        return jsonResponse(req, res, { ok: true });
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }
```

Note for the parity test: the Rust side prefixes its error with `"gh pr merge --auto failed: "`
while the dev-server returns the bare stderr, exactly as the two existing merge paths already
differ. That is why the parity assertion normalises to a **class** of failure rather than comparing
strings. Do not "fix" the prefix to make a string comparison pass; the two implementations are
allowed to phrase an error differently, and are not allowed to disagree about whether it is one.

- [ ] **Step 6: Run the parity test and the Rust suite**

Run: `cd apps/desktop && pnpm test:parity -- auto-merge-refusal`
Run: `cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/ apps/desktop/src/utils/backend-pr.ts \
        apps/desktop/dev-server.mjs apps/desktop/tests/parity/auto-merge-refusal.test.mjs
git commit -m "feat(desktop): arm and disarm auto-merge on GitHub, CLI and token paths"
```

---

## Task 6: GitLab arm and disarm

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gitlab.rs` (next to `gl_merge_mr` at `:1125`)
- Modify: `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/utils/backend-gitlab.ts`,
  `apps/desktop/dev-server.mjs`
- Test: extend `apps/desktop/tests/parity/auto-merge-refusal.test.mjs`

**Interfaces:**
- Produces: `gl_enable_auto_merge(cwd, iid, method)`, `gl_disable_auto_merge(cwd, iid)`, wrappers
  `glEnableAutoMerge` / `glDisableAutoMerge`, routes `/api/gl-enable-auto-merge` and
  `/api/gl-disable-auto-merge`.

- [ ] **Step 1: Extend the parity test with the GitLab pair**

Add a second `it()` to `auto-merge-refusal.test.mjs`, identical in shape to the GitHub one but
POSTing to `/api/gl-enable-auto-merge` with `{ cwd, iid: 1, method: "merge" }`, and asserting the
same normalised class of refusal.

- [ ] **Step 2: Run it and verify it fails**

Run: `cd apps/desktop && pnpm test:parity -- auto-merge-refusal`
Expected: FAIL on the new case only.

- [ ] **Step 3: Implement the two commands**

```rust
/// Queue this MR to merge when its pipeline succeeds.
///
/// `glab mr merge --when-pipeline-succeeds` is the CLI spelling of GitLab's
/// merge-when-pipeline-succeeds. It requires a running pipeline, which is
/// why `gl_auto_merge_state` reports `available: false` without one: the
/// button is hidden rather than offered and refused.
#[tauri::command]
pub(crate) async fn gl_enable_auto_merge(
    cwd: String,
    iid: i64,
    method: String,
) -> Result<(), String> {
    let mut args = vec![
        "mr".to_string(),
        "merge".to_string(),
        iid.to_string(),
        "--when-pipeline-succeeds".to_string(),
        "--yes".to_string(),
    ];
    match method.as_str() {
        "squash" => args.push("--squash".to_string()),
        "rebase" => args.push("--rebase".to_string()),
        "merge" => {}
        other => return Err(format!("Unknown merge method '{}'", other)),
    }
    let out = hidden_cmd("glab")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab mr merge --when-pipeline-succeeds: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Cancel a queued merge-when-pipeline-succeeds.
#[tauri::command]
pub(crate) async fn gl_disable_auto_merge(cwd: String, iid: i64) -> Result<(), String> {
    let out = hidden_cmd("glab")
        .args(["mr", "update", &iid.to_string(), "--unset-auto-merge"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab mr update --unset-auto-merge: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}
```

Note two things about the GitLab side. `gl_merge_mr_inner` (`gitlab.rs:1098`) has **no** token
path, unlike GitHub: it is `glab`-only, so there is a single implementation to mirror here. And it
passes `--delete-source-branch`, so the armed variant passes it too, or arming behaves differently
from the merge button beside it.

**Verify the `glab` flag names against the installed `glab --help` before trusting them.** They have
changed across `glab` versions, and an invented flag would surface as an opaque refusal. If
`--unset-auto-merge` does not exist in the installed version, use the REST fallback the module
already has for other operations: `PUT /projects/:id/merge_requests/:iid` with
`{"merge_when_pipeline_succeeds": false}`.

- [ ] **Step 4: Add the wrapper, the routes, run and commit**

Mirror Task 5 steps 4 to 7 exactly, in `backend-gitlab.ts` and `dev-server.mjs`.

Run: `cd apps/desktop && pnpm test:parity -- auto-merge-refusal`
Run: `cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`

```bash
git add apps/desktop/src-tauri/src/ apps/desktop/src/utils/backend-gitlab.ts \
        apps/desktop/dev-server.mjs apps/desktop/tests/parity/auto-merge-refusal.test.mjs
git commit -m "feat(desktop): arm and disarm auto-merge on GitLab"
```

---

## Task 7: Azure arm and disarm, plus the authenticated identity

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/azure.rs` (next to `az_merge_pr` at `:1745` and
  `rest_merge_pr` at `:1095`)
- Modify: `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/utils/backend-pr.ts`,
  `apps/desktop/dev-server.mjs`
- Test: a new `#[cfg(test)] mod az_auto_complete_body_tests` in `azure.rs`, plus a third case in the
  parity refusal suite

**Interfaces:**
- Consumes: the identity-resolution machinery already present for the PR-create API.
- Produces: `az_current_identity_id(cwd: &str) -> Result<String, String>`,
  `az_enable_auto_merge(cwd, number, method)`, `az_disable_auto_merge(cwd, number)`, wrappers
  `azEnableAutoMerge` / `azDisableAutoMerge`, routes `/api/az-enable-auto-merge` and
  `/api/az-disable-auto-merge`.

- [ ] **Step 1: Write the failing body-shape test**

Azure arms auto-complete by PATCHing the PR with the identity that armed it. The body construction
is pure and is the part worth testing without the network:

```rust
#[cfg(test)]
mod az_auto_complete_body_tests {
    use super::az_auto_complete_body;

    #[test]
    fn arming_sets_the_identity_and_the_merge_strategy() {
        let b = az_auto_complete_body(Some("11111111-2222-3333-4444-555555555555"), "squash");
        assert_eq!(
            b["autoCompleteSetBy"]["id"],
            "11111111-2222-3333-4444-555555555555"
        );
        assert_eq!(b["completionOptions"]["mergeStrategy"], "squash");
    }

    #[test]
    fn disarming_sends_an_explicit_null_identity() {
        // Azure clears auto-complete by nulling the identity. Omitting the
        // key would leave it armed, which is the silent failure to avoid.
        let b = az_auto_complete_body(None, "merge");
        assert!(b["autoCompleteSetBy"].is_null());
    }

    #[test]
    fn an_unknown_method_falls_back_to_no_fast_forward() {
        let b = az_auto_complete_body(Some("id"), "nonsense");
        assert_eq!(b["completionOptions"]["mergeStrategy"], "noFastForward");
    }
}
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test az_auto_complete_body_tests`
Expected: FAIL, `cannot find function az_auto_complete_body`.

- [ ] **Step 3: Implement the pure body builder**

```rust
/// Body for the PATCH that arms or clears Azure auto-complete.
///
/// `Some(id)` arms with that identity, `None` clears it. The null is
/// explicit rather than an omitted key: Azure treats an absent field as "do
/// not change", so omitting it would leave auto-complete armed while the
/// call reported success.
fn az_auto_complete_body(identity_id: Option<&str>, method: &str) -> serde_json::Value {
    let strategy = match method {
        "squash" => "squash",
        "rebase" => "rebase",
        "merge" => "noFastForward",
        _ => "noFastForward",
    };
    serde_json::json!({
        "autoCompleteSetBy": identity_id.map(|id| serde_json::json!({ "id": id })),
        "completionOptions": { "mergeStrategy": strategy },
    })
}
```

- [ ] **Step 4: Verify the tests pass**

Run: `cd apps/desktop/src-tauri && cargo test az_auto_complete_body_tests`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the identity lookup and the two commands**

`az_current_identity_id` calls the Azure DevOps `connectionData` endpoint and reads
`authenticatedUser.id`, reusing whatever HTTP helper `rest_merge_pr` at `:1095` uses. Cache the
result per session in the same way other per-account lookups in this module are cached; the identity
does not change within a session.

The two commands PATCH the PR with `az_auto_complete_body(Some(&id), &method)` and
`az_auto_complete_body(None, "merge")` respectively.

- [ ] **Step 6: Add the wrapper, the routes, extend the parity suite, run and commit**

Mirror Task 5 steps 4 to 7.

Run: `cd apps/desktop && pnpm test:parity -- auto-merge-refusal`
Run: `cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`

```bash
git add apps/desktop/src-tauri/src/ apps/desktop/src/utils/backend-pr.ts \
        apps/desktop/dev-server.mjs apps/desktop/tests/parity/auto-merge-refusal.test.mjs
git commit -m "feat(desktop): arm and disarm auto-complete on Azure"
```

---

## Task 8: PR detail panel, the action and the rule

**Files:**
- Modify: `apps/desktop/src/composables/usePrPanel.ts` (next to `mergeReadiness` at `:350`)
- Modify: `apps/desktop/src/components/PrDetailView.vue` (the merge prompt around `:342`)
- Modify: `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`
- Test: `apps/desktop/src/composables/__tests__/usePrPanel-automerge.test.ts` (new)

**Interfaces:**
- Consumes: `PullRequestDetail.autoMerge`, `AutoMergeSupport`, and the six wrappers from Tasks 5 to 7.
- Produces: `autoMergeOffer` computed, `armAutoMerge(method)` and `disarmAutoMerge()` actions on the
  `usePrPanel` return object.

- [ ] **Step 1: Write the failing tests for the offer rule**

```typescript
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { computeAutoMergeOffer } from "../usePrPanel";

const armed = { armed: true, available: true, reason: null };
const open = { armed: false, available: true, reason: null };
const blocked = { armed: false, available: false, reason: "No pipeline is running." };
const supported = { supported: true, reason: null };

describe("computeAutoMergeOffer", () => {
  it("offers arming on a PR that is not yet mergeable", () => {
    expect(computeAutoMergeOffer(supported, open, { ready: false, reason: "" }))
      .toEqual({ kind: "arm" });
  });

  it("does NOT offer arming when the PR is already mergeable", () => {
    // The rule that removes the entire "I asked for later and it merged now"
    // class of failure: when the PR can merge, the immediate merge next to
    // this button is what the user wants, and gh pr merge --auto against an
    // already-mergeable PR may merge immediately.
    expect(computeAutoMergeOffer(supported, open, { ready: true, reason: "" }))
      .toEqual({ kind: "none" });
  });

  it("offers cancelling whenever one is armed, mergeable or not", () => {
    expect(computeAutoMergeOffer(supported, armed, { ready: true, reason: "" }))
      .toEqual({ kind: "disarm" });
  });

  it("explains instead of offering when the forge cannot do it", () => {
    expect(
      computeAutoMergeOffer(
        { supported: false, reason: "Bitbucket has no equivalent." },
        open,
        { ready: false, reason: "" },
      ),
    ).toEqual({ kind: "explain", reason: "Bitbucket has no equivalent." });
  });

  it("explains instead of offering when the PR fails a precondition", () => {
    expect(computeAutoMergeOffer(supported, blocked, { ready: false, reason: "" }))
      .toEqual({ kind: "explain", reason: "No pipeline is running." });
  });

  it("offers nothing when readiness is still unknown", () => {
    expect(computeAutoMergeOffer(supported, open, null)).toEqual({ kind: "none" });
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/usePrPanel-automerge.test.ts`
Expected: FAIL, `computeAutoMergeOffer` is not exported.

- [ ] **Step 3: Implement the pure decision function and the computed**

Export from `usePrPanel.ts`, outside the composable so it is testable directly, following the
precedent of the other free helpers in that file:

```typescript
export type AutoMergeOffer =
  | { kind: "arm" }
  | { kind: "disarm" }
  | { kind: "explain"; reason: string }
  | { kind: "none" };

/**
 * What the panel should offer for forge-side auto-merge.
 *
 * The load-bearing rule is the second branch: auto-merge is never offered on
 * a PR that is already mergeable. An auto-merge that cannot be armed must
 * never become a merge, and `gh pr merge --auto` against an already-clean PR
 * may merge immediately. Hiding the button there deletes the whole class of
 * problem, and costs nothing, since the immediate merge sits next to it.
 */
export function computeAutoMergeOffer(
  support: AutoMergeSupport,
  state: AutoMergeState,
  readiness: { ready: boolean; reason: string } | null,
): AutoMergeOffer {
  if (state.armed) return { kind: "disarm" };
  if (!support.supported) return { kind: "explain", reason: support.reason ?? "" };
  if (!state.available) return { kind: "explain", reason: state.reason ?? "" };
  if (readiness === null) return { kind: "none" };
  if (readiness.ready) return { kind: "none" };
  return { kind: "arm" };
}
```

Wire a `autoMergeOffer` computed that feeds it `prDetail.value.autoMerge` and `mergeReadiness.value`,
plus `armAutoMerge(method)` / `disarmAutoMerge()` which call the right pair of wrappers for the
current provider and, on failure, set `error.value` to the forge's message **and re-fetch the PR**,
so the descriptor corrects itself rather than the app remembering a stale refusal.

- [ ] **Step 4: Add the five locale keys**

In each of the five locale files, under the existing `pr.detail` group:

```typescript
      autoMergeArm: "Merge when checks pass",
      autoMergeDisarm: "Cancel scheduled merge",
      autoMergeArmed: "Will merge when checks pass",
      autoMergeUnavailable: "Scheduled merge unavailable",
```

Translate the four into `fr`, `es`, `pt-BR` and `zh-CN`. The forge's `reason` is rendered as-is next
to `autoMergeUnavailable` and is not a key.

- [ ] **Step 5: Render it in `PrDetailView.vue`**

Next to the existing merge prompt, a button whose label and handler come from `autoMergeOffer.kind`,
and for `explain` a disabled row showing `autoMergeUnavailable` plus the raw `reason`.

- [ ] **Step 6: Run the suite, the bundle check and commit**

Run: `cd apps/desktop && pnpm test && pnpm build && pnpm bundle-check`
Expected: PASS, and the bundle within budget.

```bash
git add apps/desktop/src/
git commit -m "feat(desktop): schedule a merge from the PR panel, never on an already-mergeable PR"
```

---

## Task 9: PR list badge

**Files:**
- Modify: `apps/desktop/src/components/PullRequestPanel.vue`
- Modify: the five locale files
- Test: `apps/desktop/src/components/__tests__/PullRequestPanel-automerge.test.ts` (new)

**Interfaces:**
- Consumes: `PullRequest.autoMerge.armed` from Task 4.

**Skip this task entirely if Task 3 Step 1's measurement forced `armed` off the list payload.** In
that case record the skip in `roadmap.md` rather than leaving the task silently undone.

- [ ] **Step 1: Write the failing component test**

```typescript
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
// Mount PullRequestPanel with two PRs, one armed and one not, following the
// native createApp pattern used by the neighbouring component tests.

describe("PullRequestPanel, auto-merge badge", () => {
  it("badges only the PR whose auto-merge is armed", async () => {
    const { container } = await mountPanel([
      { number: 1, title: "armed", autoMerge: { armed: true, available: true, reason: null } },
      { number: 2, title: "plain", autoMerge: { armed: false, available: true, reason: null } },
    ]);
    const badges = container.querySelectorAll("[data-testid='auto-merge-badge']");
    expect(badges.length).toBe(1);
    expect(badges[0].closest("[data-pr-number]")?.getAttribute("data-pr-number")).toBe("1");
  });
});
```

Write `mountPanel` in the test file itself, copying the mount helper from
`apps/desktop/src/components/__tests__/LaunchpadView.test.ts`, which mounts a PR-listing component
with native `createApp` into jsdom and already stubs `utils/backend`. Do not invent a new mount
shape, and do not add `@vue/test-utils`.

- [ ] **Step 2: Run it and verify it fails, then implement the badge, then verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/PullRequestPanel-automerge.test.ts`

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/
git commit -m "feat(desktop): badge a PR whose merge is already scheduled"
```

---

## Task 10: Today inbox action

**Files:**
- Modify: `apps/desktop/src/composables/useLaunchpadInbox.ts:38` (the `InboxAction` union) and the
  classification at `:121-155`
- Modify: the five locale files
- Test: `apps/desktop/src/composables/__tests__/useLaunchpadInbox-automerge.test.ts` (new)

**Interfaces:**
- Consumes: `PullRequest.autoMerge` from Task 4 and `computeAutoMergeOffer` from Task 8.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { classifyPr } from "../useLaunchpadInbox";

describe("Today inbox, auto-merge action", () => {
  it("offers auto-merge on a PR that cannot merge yet but could be scheduled", () => {
    const r = classifyPr(prFixture({
      mergeStateStatus: "BLOCKED",
      autoMerge: { armed: false, available: true, reason: null },
    }));
    expect(r?.action).toBe("auto-merge");
  });

  it("keeps the immediate merge when the PR is ready now", () => {
    const r = classifyPr(prFixture({
      mergeStateStatus: "CLEAN",
      autoMerge: { armed: false, available: true, reason: null },
    }));
    expect(r?.action).toBe("merge");
  });

  it("keeps the immediate merge when the forge cannot schedule", () => {
    // Bitbucket. The v3.10 comment at useLaunchpadInbox.ts:121 says this
    // action is a merge and not an auto-merge because no forge auto-merge
    // existed; it now exists for three forges out of four, and the fourth
    // must keep the honest immediate merge rather than losing the action.
    const r = classifyPr(prFixture({
      mergeStateStatus: "BLOCKED",
      autoMerge: { armed: false, available: false, reason: "no equivalent" },
    }));
    expect(r?.action).toBe("merge");
  });

  it("offers nothing new when one is already armed", () => {
    const r = classifyPr(prFixture({
      mergeStateStatus: "BLOCKED",
      autoMerge: { armed: true, available: true, reason: null },
    }));
    expect(r?.action).not.toBe("auto-merge");
  });
});
```

- [ ] **Step 2: Run, implement, verify**

Add `"auto-merge"` to the `InboxAction` union, extend the classification, and update the stale
comment at `:121` so it describes what is now true rather than the v3.10 state.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/
git commit -m "feat(desktop): Today can schedule a merge, and still merges now where it cannot"
```

---

## Task 11: Manual verification and documentation

**Files:**
- Modify: `CHANGELOG.md` (the `[Unreleased]` section, **not** a new version heading)
- Modify: `roadmap.md` (the v3.11.0 "Remaining before the tag" list)

- [ ] **Step 1: Verify the GitHub already-mergeable behaviour, by hand, once**

This is the behaviour the design neutralised rather than relied on, and it is the only way to know
what it actually does. On a scratch repository with a real PR whose checks already pass:

```bash
gh pr merge <n> --auto --squash
gh pr view <n> --json state,autoMergeRequest
```

Record in the commit message whether it merged immediately, refused, or queued. **Whatever the
answer, the Task 8 rule stays**: the button is not offered on an already-mergeable PR either way.
The point of the check is to know what a user hitting that path from another client will see.

- [ ] **Step 2: Drive all three forges once through `pnpm dev:web`**

With a real forge configured per provider: arm, confirm the badge, cancel, confirm it clears.
Confirm Bitbucket shows the explanation and still offers the immediate merge. This is the only
coverage these paths will ever get, so it is a step and not a suggestion.

- [ ] **Step 3: Write the CHANGELOG entry under `[Unreleased]`**

Do **not** open a `## [3.11.0]` heading and do **not** run `bump-version.sh`. v3.11.0 gets one tag,
after the last of the four remaining lots lands.

- [ ] **Step 4: Remove the lot from the roadmap's remaining list**

Delete the "Forge-side auto-merge" bullet from the v3.11.0 section and change "Four lots" to "Three
lots". Do not move anything into Shipped: nothing is shipped until the tag.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md roadmap.md
git commit -m "docs: forge-side auto-merge, and what its manual verification found"
```
