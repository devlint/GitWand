/**
 * v3.13 — The trust prompt is mounted once in App.vue and driven by the
 * shared composable state; creation (PR 3) and removal (PR 4) call
 * `ensureTrusted` and rely on this mount to show the question.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appVue = readFileSync(resolve(__dirname, "../App.vue"), "utf-8");
const modal = appVue.match(/<WorktreeHookTrustModal\b[\s\S]*?\/>/)?.[0] ?? "";

describe("App.vue — worktree hook trust wiring", () => {
  it("lazy-loads the modal and uses the composable", () => {
    expect(appVue).toMatch(
      /const WorktreeHookTrustModal = defineAsyncComponent\(\(\) => import\("\.\/components\/WorktreeHookTrustModal\.vue"\)\)/,
    );
    expect(appVue).toMatch(/import \{ useWorktreeHookTrust \} from "\.\/composables\/useWorktreeHookTrust"/);
  });

  it("renders only while a question is pending and forwards the answer", () => {
    expect(modal).toMatch(/v-if="hookTrust\.pending\.value"/);
    expect(modal).toMatch(/:status="hookTrust\.pending\.value"/);
    expect(modal).toMatch(/:error="hookTrust\.error\.value"/);
    expect(modal).toMatch(/@answer="hookTrust\.answer"/);
  });
});
