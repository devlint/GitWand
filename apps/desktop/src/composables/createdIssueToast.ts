/**
 * The notice shown once an issue is created (#301): "Open", and "Add to
 * commit" for an issue on the user's own repository.
 *
 * A resolver report on GitWand's public repository gets no "Add to commit":
 * citing it in the user's commit would show that commit, and its repository,
 * on the public issue.
 */
import type { CreatedIssue } from "../utils/backend";
import { addCreatedIssueToCommit } from "../utils/issueRefs";

type ToastKey =
  | "createIssue.created"
  | "createIssue.open"
  | "createIssue.addToCommit"
  | "createIssue.addToCommitOtherRepo"
  | "createIssue.addToCommitAlready";

export interface CreatedIssueToastDeps {
  t: (key: ToastKey, ...args: (string | number)[]) => string;
  /** The repository folder active now (the user may have switched tabs). */
  activeCwd: () => string;
  message: () => { summary: string; description: string };
  setDescription: (description: string) => void;
  /** `owner/repo` of the folder's push remote; read only if the button is used. */
  readPushRepo: (cwd: string) => Promise<string | null>;
  /** Forget the cached `#` issues of this folder and of this repository. */
  invalidate: (target: { cwd: string; repo: string }) => void;
  /** A short follow-up notice (why nothing was added). */
  notify: (title: string) => void;
}

export interface CreatedIssueToast {
  title: string;
  link?: { label: string; url: string };
  action?: { label: string; run: () => Promise<void> };
}

export function createdIssueToast(
  issue: CreatedIssue,
  ctx: { toGitwand: boolean; repo: string; cwd: string },
  deps: CreatedIssueToastDeps,
): CreatedIssueToast {
  const title = deps.t("createIssue.created", issue.number);
  const link = issue.url ? { label: deps.t("createIssue.open"), url: issue.url } : undefined;
  if (ctx.toGitwand) return { title, link };
  const createdIn = ctx.cwd;
  // The new issue belongs in the `#` list at once, not after the cache's minute.
  if (createdIn) deps.invalidate({ cwd: createdIn, repo: ctx.repo });
  return {
    title,
    link,
    action: {
      label: deps.t("createIssue.addToCommit"),
      run: async () => {
        const pushRepo = createdIn ? await deps.readPushRepo(createdIn).catch(() => null) : null;
        const { summary, description } = deps.message();
        const out = addCreatedIssueToCommit(
          { url: issue.url, number: issue.number, repo: ctx.repo },
          { createdIn, activeCwd: deps.activeCwd(), pushRepo, summary, description },
        );
        // Never a silent click: say why nothing was added.
        if (out.status === "added") deps.setDescription(out.description);
        else deps.notify(deps.t(out.status === "otherRepo" ? "createIssue.addToCommitOtherRepo" : "createIssue.addToCommitAlready"));
      },
    },
  };
}
