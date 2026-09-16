/**
 * `forgeCommitUrl` — the "View on forge" target for a commit.
 *
 * Extracted from `useCommitActions.handleViewOnForge`, where it was an inline
 * ternary chain, so the per-forge shapes are actually pinned by tests.
 *
 * Takes the whole remote rather than just owner/repo: Azure DevOps commit URLs
 * need the org/project pair, which only the remote URL carries.
 */
import { describe, it, expect } from "vitest";
import { forgeCommitUrl, giteaHostFromUrl, giteaBaseFromUrl } from "../forgeUrls";

const SHA = "abc1234def5678";

/** Shorthand for the common `{provider, owner, repo, url}` shape. */
const remote = (provider: string, owner: string, repo: string, url = "") => ({
  provider,
  owner,
  repo,
  url,
});

describe("forgeCommitUrl — GitHub, GitLab, Bitbucket", () => {
  it("points at the commit", () => {
    expect(forgeCommitUrl(remote("github", "acme", "checkout"), SHA)).toBe(
      `https://github.com/acme/checkout/commit/${SHA}`
    );
    expect(forgeCommitUrl(remote("gitlab", "acme", "checkout"), SHA)).toBe(
      `https://gitlab.com/acme/checkout/-/commit/${SHA}`
    );
    expect(forgeCommitUrl(remote("bitbucket", "acme", "checkout"), SHA)).toBe(
      `https://bitbucket.org/acme/checkout/commits/${SHA}`
    );
  });
});

describe("forgeCommitUrl — Cursor Origin", () => {
  it("degrades to the repo page", () => {
    // Origin's commit-permalink path shape is not documented, and guessing
    // `/commit/{sha}` risks a 404. The repo page always resolves.
    expect(
      forgeCommitUrl(
        remote("cursor", "acme", "checkout", "https://origin.cursor.com/acme/checkout.git"),
        SHA
      )
    ).toBe("https://cursor.com/codebase/acme/checkout");
  });
});

describe("forgeCommitUrl — Azure DevOps", () => {
  // Previously fell through to the GitHub shape, producing a github.com URL
  // where the commit does not exist. The org/project pair is parsed out of the
  // remote, mirroring `parse_azure_remote()` in src-tauri/src/commands/azure.rs.
  const EXPECTED = `https://dev.azure.com/myorg/myproj/_git/myrepo/commit/${SHA}`;

  it("handles the dev.azure.com shape", () => {
    expect(
      forgeCommitUrl(
        remote("azure", "", "", "https://dev.azure.com/myorg/myproj/_git/myrepo"),
        SHA
      )
    ).toBe(EXPECTED);
  });

  it("handles a userinfo prefix in the remote", () => {
    expect(
      forgeCommitUrl(
        remote("azure", "", "", "https://myorg@dev.azure.com/myorg/myproj/_git/myrepo"),
        SHA
      )
    ).toBe(EXPECTED);
  });

  it("handles the legacy visualstudio.com shape", () => {
    expect(
      forgeCommitUrl(
        remote("azure", "", "", "https://myorg.visualstudio.com/myproj/_git/myrepo"),
        SHA
      )
    ).toBe(EXPECTED);
  });

  it("drops the DefaultCollection segment", () => {
    expect(
      forgeCommitUrl(
        remote("azure", "", "", "https://myorg.visualstudio.com/DefaultCollection/myproj/_git/myrepo"),
        SHA
      )
    ).toBe(EXPECTED);
  });

  it("handles the SSH shape", () => {
    expect(
      forgeCommitUrl(
        remote("azure", "", "", "git@ssh.dev.azure.com:v3/myorg/myproj/myrepo"),
        SHA
      )
    ).toBe(EXPECTED);
  });

  it("tolerates a trailing .git", () => {
    expect(
      forgeCommitUrl(
        remote("azure", "", "", "https://dev.azure.com/myorg/myproj/_git/myrepo.git"),
        SHA
      )
    ).toBe(EXPECTED);
  });

  it("returns null rather than a wrong URL when the remote is unparseable", () => {
    // Never silently fall back to the GitHub shape again.
    expect(
      forgeCommitUrl(remote("azure", "acme", "checkout", "https://dev.azure.com/nope"), SHA)
    ).toBeNull();
  });
});

describe("forgeCommitUrl — missing data", () => {
  it("returns null when owner or repo is missing on a path-based forge", () => {
    expect(forgeCommitUrl(remote("github", "", "checkout"), SHA)).toBeNull();
    expect(forgeCommitUrl(remote("github", "acme", ""), SHA)).toBeNull();
  });
});

describe("giteaHostFromUrl / giteaBaseFromUrl: the account-form join", () => {
  // A regression bug once had giteaHostFromUrl keep the port, which broke the
  // keychain lookup (Rust's extract_remote_host always strips it), and had
  // the base URL default to https unconditionally, which broke a plain-http
  // self-hosted instance. Both are pinned here with exact strings.

  it("drops the port from the bare host, keeps it in the base", () => {
    expect(giteaHostFromUrl("http://git.acme.io:3000")).toBe("git.acme.io");
    expect(giteaBaseFromUrl("http://git.acme.io:3000")).toBe("http://git.acme.io:3000");
  });

  it("keeps the scheme the user typed in the base, not a guessed default", () => {
    expect(giteaHostFromUrl("http://git.acme.io")).toBe("git.acme.io");
    expect(giteaBaseFromUrl("http://git.acme.io")).toBe("http://git.acme.io");
  });

  it("the default-port https case is unchanged: bare host, base with no port", () => {
    expect(giteaHostFromUrl("https://git.acme.io")).toBe("git.acme.io");
    expect(giteaBaseFromUrl("https://git.acme.io")).toBe("https://git.acme.io");
  });

  it("adds https when no scheme is typed at all", () => {
    expect(giteaHostFromUrl("git.acme.io")).toBe("git.acme.io");
    expect(giteaBaseFromUrl("git.acme.io")).toBe("https://git.acme.io");
  });

  it("strips a trailing slash and an /api/v1 suffix from the base", () => {
    expect(giteaBaseFromUrl("https://git.acme.io/")).toBe("https://git.acme.io");
    expect(giteaBaseFromUrl("https://git.acme.io/api/v1")).toBe("https://git.acme.io");
    expect(giteaBaseFromUrl("https://git.acme.io/api/v1/")).toBe("https://git.acme.io");
  });

  it("keeps a subpath install in the base", () => {
    expect(giteaBaseFromUrl("https://acme.io/gitea/")).toBe("https://acme.io/gitea");
    expect(giteaHostFromUrl("https://acme.io/gitea/")).toBe("acme.io");
  });

  it("returns empty strings for input that can't become a valid URL", () => {
    expect(giteaHostFromUrl("")).toBe("");
    expect(giteaBaseFromUrl("")).toBe("");
  });
});
