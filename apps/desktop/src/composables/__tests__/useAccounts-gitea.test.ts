/**
 * Detection layer 2: a self-hosted Gitea on a neutral hostname is recognised
 * because the user configured an account for that host, not because the URL
 * says so.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAccounts } from "../useAccounts";
import { giteaProviderHostMatches } from "../../utils/backend";

describe("Gitea account hosts", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("exposes the hosts of configured Gitea accounts", () => {
    const { addAccount, giteaHosts } = useAccounts();
    addAccount({
      forge: "gitea",
      label: "work",
      username: "alice",
      tokenKey: "gitwand:gitea/git.acme.io:alice",
    });
    expect(giteaHosts()).toEqual(["git.acme.io"]);
  });

  it("matches a remote host against the configured hosts", () => {
    expect(giteaProviderHostMatches("https://git.acme.io/acme/app.git", ["git.acme.io"])).toBe(true);
    expect(giteaProviderHostMatches("git@git.acme.io:acme/app.git", ["git.acme.io"])).toBe(true);
    expect(giteaProviderHostMatches("https://git.other.io/acme/app.git", ["git.acme.io"])).toBe(false);
    expect(giteaProviderHostMatches("https://git.acme.io/acme/app.git", [])).toBe(false);
  });
});
