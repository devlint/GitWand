// @vitest-environment jsdom
/**
 * README remote-image consent, end to end on the real DashboardView: the
 * "Always show for this project" button must show the images on the click
 * itself (reported as doing nothing until a restart), and the choice must be
 * remembered for that project only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

// A README with an HTML header block (badges), which DashboardView renders
// apart from the markdown body, plus an image in the body.
const README = [
  '<div align="center">',
  '  <h1>App</h1>',
  '  <img alt="badge" src="https://img.shields.io/badge/a-b-green.svg">',
  "</div>",
  "",
  "## Screenshot",
  "",
  "![shot](https://example.com/shot.png)",
  "",
  "Some text.",
].join("\n");

vi.mock("../../utils/backend", async (orig) => {
  const real: Record<string, unknown> = await orig();
  return {
    ...real,
    getGitLog: vi.fn(async () => []),
    getGitShortlog: vi.fn(async () => []),
    getGitAuthorLineStats: vi.fn(async () => []),
    readFile: vi.fn(async (_cwd: string, name: string) => {
      if (name === "README.md") return README;
      throw new Error("not found");
    }),
    openExternalUrl: vi.fn(),
  };
});

async function settle() {
  for (let i = 0; i < 20; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

let app: App | null = null;

async function mountDashboard(cwd: string): Promise<HTMLElement> {
  const { default: DashboardView } = await import("../DashboardView.vue");
  const el = document.createElement("div");
  document.body.appendChild(el);
  app = createApp(DashboardView, {
    cwd,
    branch: "main",
    status: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    ahead: 0,
    behind: 0,
  });
  app.mount(el);
  await settle();
  return el;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("DashboardView — README remote images", () => {
  it("withholds remote images and shows them on the click itself", async () => {
    const el = await mountDashboard("/repos/app");
    expect(el.querySelectorAll(".readme-formatted .md-img-blocked")).toHaveLength(2);
    const button = el.querySelector<HTMLButtonElement>(".rin__btn");
    expect(button).not.toBeNull();

    button!.click();
    await settle();

    expect(el.querySelector(".rin__btn")).toBeNull();
    expect(el.querySelectorAll(".readme-formatted .md-img-blocked")).toHaveLength(0);
    const srcs = [...el.querySelectorAll(".readme-formatted img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual([
      "https://img.shields.io/badge/a-b-green.svg",
      "https://example.com/shot.png",
    ]);
    expect(JSON.parse(localStorage.getItem("gitwand-settings")!).remoteImagesByRepo).toEqual({
      "/repos/app": true,
    });
  });
});
