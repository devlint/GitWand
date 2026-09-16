/**
 * Detection layer 2: a self-hosted Gitea on a neutral hostname is recognised
 * because the user configured an account for that host, not because the URL
 * says so.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAccounts, giteaHostHasAccount, giteaPointerShouldBeDeleted } from "../useAccounts";
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

  it("matches a mixed-case host against the (always lowercase) configured hosts", () => {
    // The account form always stores a lowercase host (giteaHostFromUrl runs
    // URL.hostname), so a remote typed or cloned with different casing must
    // still be recognised rather than silently missing.
    expect(giteaProviderHostMatches("https://Git.ACME.io/acme/app.git", ["git.acme.io"])).toBe(true);
    expect(giteaProviderHostMatches("git@Git.ACME.io:acme/app.git", ["git.acme.io"])).toBe(true);
  });
});

// The pointer keychain entry (see useCredentials.saveGiteaCredential) is keyed
// by bare host alone, while the account model is multi-account per forge, and a
// second Gitea account on a host that already has one would silently
// overwrite the first account's pointer. These two predicates are what the
// add form and the remove handler in SettingsAccountsTab.vue call to avoid
// that, covered here rather than only through the component.
describe("Gitea account collisions per host", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("giteaHostHasAccount: single-account case", () => {
    const { addAccount } = useAccounts();
    const acc = addAccount({
      forge: "gitea",
      label: "work",
      username: "alice",
      tokenKey: "gitwand:gitea/git.acme.io:alice",
    });
    expect(giteaHostHasAccount([acc], "git.acme.io")).toBe(true);
    expect(giteaHostHasAccount([acc], "git.other.io")).toBe(false);
    expect(giteaHostHasAccount([], "git.acme.io")).toBe(false);
  });

  it("giteaHostHasAccount: two accounts, same host", () => {
    const { addAccount } = useAccounts();
    const a = addAccount({ forge: "gitea", label: "work", username: "alice", tokenKey: "gitwand:gitea/git.acme.io:alice" });
    const b = addAccount({ forge: "gitea", label: "personal", username: "bob", tokenKey: "gitwand:gitea/git.acme.io:bob" });
    expect(giteaHostHasAccount([a, b], "git.acme.io")).toBe(true);
  });

  it("giteaHostHasAccount: two accounts, different hosts", () => {
    const { addAccount } = useAccounts();
    const a = addAccount({ forge: "gitea", label: "work", username: "alice", tokenKey: "gitwand:gitea/git.acme.io:alice" });
    const b = addAccount({ forge: "gitea", label: "personal", username: "bob", tokenKey: "gitwand:gitea/git.other.io:bob" });
    expect(giteaHostHasAccount([a, b], "git.acme.io")).toBe(true);
    expect(giteaHostHasAccount([a, b], "git.other.io")).toBe(true);
    expect(giteaHostHasAccount([a, b], "git.third.io")).toBe(false);
  });

  it("giteaPointerShouldBeDeleted: single-account case, the last account on the host, pointer goes with it", () => {
    const { addAccount } = useAccounts();
    const acc = addAccount({ forge: "gitea", label: "work", username: "alice", tokenKey: "gitwand:gitea/git.acme.io:alice" });
    expect(giteaPointerShouldBeDeleted([acc], acc)).toBe(true);
  });

  it("giteaPointerShouldBeDeleted: two accounts, same host, removing one keeps the pointer for the sibling", () => {
    const { addAccount } = useAccounts();
    const a = addAccount({ forge: "gitea", label: "work", username: "alice", tokenKey: "gitwand:gitea/git.acme.io:alice" });
    const b = addAccount({ forge: "gitea", label: "personal", username: "bob", tokenKey: "gitwand:gitea/git.acme.io:bob" });
    expect(giteaPointerShouldBeDeleted([a, b], a)).toBe(false);
    // Once only `b` remains, removing it does delete the pointer.
    expect(giteaPointerShouldBeDeleted([b], b)).toBe(true);
  });

  it("giteaPointerShouldBeDeleted: two accounts, different hosts, each is its own last account", () => {
    const { addAccount } = useAccounts();
    const a = addAccount({ forge: "gitea", label: "work", username: "alice", tokenKey: "gitwand:gitea/git.acme.io:alice" });
    const b = addAccount({ forge: "gitea", label: "personal", username: "bob", tokenKey: "gitwand:gitea/git.other.io:bob" });
    expect(giteaPointerShouldBeDeleted([a, b], a)).toBe(true);
    expect(giteaPointerShouldBeDeleted([a, b], b)).toBe(true);
  });

  it("giteaPointerShouldBeDeleted: never true for a non-Gitea account", () => {
    const { addAccount } = useAccounts();
    const gh = addAccount({ forge: "github", label: "work", username: "alice", tokenKey: "gitwand:github/alice" });
    expect(giteaPointerShouldBeDeleted([gh], gh)).toBe(false);
  });
});
