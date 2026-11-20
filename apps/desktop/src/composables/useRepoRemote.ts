/**
 * Each repository folder's `origin` remote, read once and shared (#301): the
 * commit panel's `#` list and the created-issue notice decide on the same
 * push repository.
 *
 * A read can be overtaken (only the latest lands), fail for a moment (the
 * known remote stays) or find the remote gone ("No remote found": it is
 * forgotten). The dev server answers an error with an empty `unknown` remote
 * instead of throwing; that counts as a failure too.
 */
import { ref, type Ref } from "vue";
import { gitRemoteInfo, type RemoteInfo } from "../utils/backend";
import { remoteSlug } from "../utils/issueRefs";

export interface RemoteStoreDeps {
  read: (cwd: string) => Promise<RemoteInfo>;
  now?: () => number;
}

interface Slot {
  info: RemoteInfo | null;
  at: number;
  seq: number;
}

export interface RemoteStore {
  /** The folder's remote, null when it has none or it was never read (reactive). */
  info(cwd: string): RemoteInfo | null;
  /** `owner/repo` (an https remote's whole path) of the folder's remote, or null. */
  slug(cwd: string): string | null;
  /** Read the folder's remote now. */
  load(cwd: string): Promise<RemoteInfo | null>;
  /** Read it again unless the last read is younger than `maxAgeMs`. */
  loadIfOlder(cwd: string, maxAgeMs: number): void;
  version: Ref<number>;
}

function same(a: RemoteInfo, b: RemoteInfo): boolean {
  return a.url === b.url && a.provider === b.provider && a.owner === b.owner && a.repo === b.repo;
}

export function createRemoteStore(deps: RemoteStoreDeps): RemoteStore {
  const now = deps.now ?? (() => Date.now());
  const slots = new Map<string, Slot>();
  const version = ref(0);
  let nextSeq = 0;

  function info(cwd: string): RemoteInfo | null {
    void version.value;
    return slots.get(cwd)?.info ?? null;
  }

  function set(cwd: string, value: RemoteInfo | null) {
    const slot = slots.get(cwd);
    if (slot && (slot.info === value || (slot.info && value && same(slot.info, value)))) return;
    slots.set(cwd, { info: value, at: slot?.at ?? now(), seq: slot?.seq ?? 0 });
    version.value++;
  }

  async function load(cwd: string): Promise<RemoteInfo | null> {
    const seq = ++nextSeq;
    const slot = slots.get(cwd);
    slots.set(cwd, { info: slot?.info ?? null, at: now(), seq });
    let value: RemoteInfo | null;
    try {
      value = await deps.read(cwd);
      if (!value.url && value.provider === "unknown") throw new Error("empty remote answer");
    } catch (e) {
      if (slots.get(cwd)?.seq !== seq) return info(cwd);
      if (/no remote/i.test(String(e))) set(cwd, null);
      return info(cwd);
    }
    if (slots.get(cwd)?.seq !== seq) return info(cwd);
    set(cwd, value);
    return info(cwd);
  }

  function loadIfOlder(cwd: string, maxAgeMs: number) {
    const slot = slots.get(cwd);
    if (!slot || now() - slot.at > maxAgeMs) void load(cwd);
  }

  return { info, slug: (cwd) => remoteSlug(info(cwd)), load, loadIfOlder, version };
}

/** The app's store. */
export const repoRemotes = createRemoteStore({ read: gitRemoteInfo });
