// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createApp, h } from "vue";
import AgentIcon from "../AgentIcon.vue";
import antigravitySvg from "../../assets/agents/antigravity.svg?raw";

describe("AgentIcon", () => {
  it("gives each instance its own gradient/mask/filter ids", () => {
    const host = document.createElement("div");
    const app = createApp({
      render: () => [
        h(AgentIcon, { agent: "codex" }),
        h(AgentIcon, { agent: "codex" }),
        h(AgentIcon, { agent: "claude" }),
      ],
    });
    app.mount(host);

    const ids = [...host.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);

    // Every url(#…) reference inside an icon points to an id of that same icon.
    for (const svg of host.querySelectorAll("svg")) {
      const own = new Set([...svg.querySelectorAll("[id]")].map((e) => e.id));
      const refs = [...svg.querySelectorAll("[fill^='url('], [filter], [mask]")]
        .flatMap((e) => ["fill", "filter", "mask"].map((a) => e.getAttribute(a)))
        .filter((v): v is string => !!v && v.startsWith("url(#"))
        .map((v) => v.slice(5, -1));
      for (const r of refs) expect(own.has(r)).toBe(true);
    }
    app.unmount();
  });

  it("renders the filter-heavy Antigravity mark as a cached image, at the given size", () => {
    const host = document.createElement("div");
    const app = createApp({
      render: () => [h(AgentIcon, { agent: "antigravity" }), h(AgentIcon, { agent: "antigravity", size: 16 })],
    });
    app.mount(host);
    const imgs = [...host.querySelectorAll("img")];
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute("src")).toMatch(/antigravity\.svg/);
    expect(imgs.map((i) => i.getAttribute("width"))).toEqual(["14", "16"]);
    expect(imgs[0].getAttribute("alt")).toBe("");
    app.unmount();
  });

  it("keeps every url(#…) reference of the Antigravity file pointing at one of its own ids", () => {
    const svg = antigravitySvg;
    const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(ids.has(r)).toBe(true);
  });

  it("follows currentColor for the single-colour OpenCode mark", () => {
    const host = document.createElement("div");
    const app = createApp({ render: () => h(AgentIcon, { agent: "opencode", size: 16 }) });
    app.mount(host);
    const svg = host.querySelector("svg")!;
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("width")).toBe("16");
    app.unmount();
  });
});
