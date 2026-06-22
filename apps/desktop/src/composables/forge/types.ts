/**
 * @file forge/types.ts
 *
 * ForgeProvider — contrat commun pour GitHub, GitLab, Bitbucket (v2.10+).
 *
 * Design:
 * - Toutes les méthodes prennent `cwd: string` comme premier argument (repo
 *   local) pour rester cohérent avec les wrappers `gh*` existants.
 * - Les types de données (PullRequest, PullRequestDetail…) sont réutilisés
 *   depuis `utils/backend.ts` — ils sont déjà forge-agnostiques.
 * - `detectFromRemote(url)` permet au `ForgeRegistry` (useForge.ts) de router
 *   automatiquement sans configuration manuelle.
 */

import type {
  PullRequest,
  PullRequestDetail,
  CICheck,
  CIAnnotation,
  PrReviewComment,
  CreatePrCommentParams,
  PrReview,
  PendingReviewComment,
  PrConflictPreview,
  PrHotspot,
  PrFileHistory,
  ReviewerCandidate,
  Issue,
} from "../../utils/backend";
import type { Account } from "../useAccounts";

// ─── Re-exports pour les consommateurs du module forge ──────────────────────
export type {
  PullRequest,
  PullRequestDetail,
  CICheck,
  CIAnnotation,
  PrReviewComment,
  CreatePrCommentParams,
  PrReview,
  PendingReviewComment,
  PrConflictPreview,
  PrHotspot,
  PrFileHistory,
  ReviewerCandidate,
  Issue,
  Account,
};

// ─── Options / Inputs ───────────────────────────────────────────────────────

export interface ListPRsOptions {
  state?: "open" | "closed" | "all";
  limit?: number;
  offset?: number;
}

export interface ListIssuesOptions {
  filter?: "" | "assigned" | "mentioned" | "created";
  limit?: number;
}

export interface CreatePRInput {
  title: string;
  body: string;
  base?: string;
  /**
   * Cross-fork target as "owner/repo". When set (and different from origin),
   * the PR opens against this repo with the current branch as the head fork.
   * GitHub only — ignored by GitLab/Bitbucket.
   */
  baseRepo?: string;
  draft?: boolean;
  reviewers?: string[];
}

export interface SubmitReviewOptions {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body?: string;
  comments?: PendingReviewComment[];
}

// ─── Forge name discriminant ────────────────────────────────────────────────

export type ForgeName = "github" | "gitlab" | "bitbucket" | "azure" | "unknown";

// ─── ForgeProvider interface ─────────────────────────────────────────────────

/**
 * Contrat commun implémenté par GitHubProvider, GitLabProvider, BitbucketProvider.
 *
 * Chaque méthode correspond 1-pour-1 à une opération PR/MR existante. Les stubs
 * (GitLab, Bitbucket) peuvent lancer `NotImplementedError` jusqu'à ce que leur
 * provider soit complet.
 */
export interface ForgeProvider {
  /** Identifiant du forge — utilisé pour les labels i18n conditionnels. */
  readonly name: ForgeName;

  /** Retourne true si l'URL remote appartient à ce forge. */
  detectFromRemote(remoteUrl: string): boolean;

  /**
   * Bind a specific Account to this provider instance.
   * When set, the provider uses the associated credential (tokenKey / username)
   * instead of the default environment / keychain lookup.
   * Pass `null` to revert to the default credential resolution.
   *
   * v2.14: stored in-memory on each provider. Deeper wiring into backend
   * commands (e.g. passing workspace from account.tokenKey to Bitbucket calls)
   * is a follow-up for each individual forge.
   */
  setAccount(account: Account | null): void;

  // ── Discovery ─────────────────────────────────────────────────────────────

  /** Login de l'utilisateur courant (pour filtrage Assigned to me). */
  getCurrentUser(cwd: string): Promise<string>;

  /** Utilisateurs pouvant être reviewers sur ce repo. */
  listReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]>;

  // ── PR / MR listing ───────────────────────────────────────────────────────

  listPRs(cwd: string, opts?: ListPRsOptions): Promise<PullRequest[]>;

  /**
   * Open issues for the repo. Optional: forges without an issue concept
   * (Azure → Work Items) omit it; callers treat absence as "unsupported".
   */
  listIssues?(cwd: string, opts?: ListIssuesOptions): Promise<Issue[]>;

  getPRCount(cwd: string, state?: string): Promise<number>;

  /** Fichiers touchés par la PR (pour l'overlap detection du Launchpad). */
  getPRFiles(cwd: string, prNumber: number): Promise<string[]>;

  // ── PR / MR detail ────────────────────────────────────────────────────────

  getPR(cwd: string, number: number): Promise<PullRequestDetail>;

  getPRDiff(cwd: string, number: number): Promise<string>;

  getCIChecks(cwd: string, number: number): Promise<CICheck[]>;

  /**
   * Annotations de check-runs ancrées sur des lignes de fichiers (v2.18).
   * GitHub: check-runs annotations · GitLab: codequality report ·
   * Bitbucket: Reports API. Retourne `[]` si la forge n'a rien à offrir.
   */
  getCheckAnnotations(cwd: string, number: number): Promise<CIAnnotation[]>;

  // ── PR / MR actions ───────────────────────────────────────────────────────

  createPR(cwd: string, input: CreatePRInput): Promise<PullRequest>;

  mergePR(cwd: string, number: number, method?: "merge" | "squash" | "rebase"): Promise<void>;

  checkoutPR(cwd: string, number: number): Promise<void>;

  /** Convert a draft PR/MR to "ready for review". */
  convertDraftToReady(cwd: string, number: number): Promise<void>;

  // ── Comments ──────────────────────────────────────────────────────────────

  listComments(cwd: string, prNumber: number): Promise<PrReviewComment[]>;

  /**
   * Issue-level (conversation) comments — not anchored to a diff line.
   * Optional: providers that don't expose them simply omit it.
   */
  listIssueComments?(cwd: string, prNumber: number): Promise<PrReviewComment[]>;

  createComment(cwd: string, prNumber: number, params: CreatePrCommentParams): Promise<PrReviewComment>;

  /**
   * `prNumber` est requis par GitLab (MR iid nécessaire en plus du note_id)
   * et Bitbucket (PR id nécessaire en plus du comment_id). Ignoré sur GitHub.
   */
  updateComment(cwd: string, commentId: number, body: string, prNumber?: number): Promise<void>;

  deleteComment(cwd: string, commentId: number, prNumber?: number): Promise<void>;

  // ── Reviews ───────────────────────────────────────────────────────────────

  listReviews(cwd: string, prNumber: number): Promise<PrReview[]>;

  submitReview(cwd: string, prNumber: number, opts: SubmitReviewOptions): Promise<PrReview>;

  // ── Intelligence (forge-agnostique depuis v2.14) ───────────────────────────
  //
  // getConflictPreview et getHotspots s'appuient sur des données git locales
  // (git merge-tree, git log --merges) — implémentables sur tous les forges.
  // getFileHistory requiert une API forge (review comments) et est implémentée
  // spécifiquement par chaque provider.

  getConflictPreview(cwd: string, prNumber: number): Promise<PrConflictPreview>;

  getHotspots(cwd: string, paths: string[]): Promise<PrHotspot[]>;

  getFileHistory(cwd: string, paths: string[]): Promise<Record<string, PrFileHistory>>;
}

// ─── NotImplementedError ─────────────────────────────────────────────────────

/**
 * Lancé par les providers incomplets (GitLab stub, Bitbucket stub) quand une
 * méthode n'est pas encore implémentée. Permet de cibler précisément les gaps.
 */
export class ForgeNotImplementedError extends Error {
  constructor(provider: ForgeName, method: string) {
    super(`[ForgeProvider:${provider}] ${method}() not yet implemented`);
    this.name = "ForgeNotImplementedError";
  }
}
