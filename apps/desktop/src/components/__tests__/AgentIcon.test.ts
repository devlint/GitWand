// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createApp, h } from "vue";
import AgentIcon from "../AgentIcon.vue";

describe("AgentIcon", () => {
  it("gives each instance its own gradient/mask/filter ids", () => {
    const host = document.createElement("div");
    const app = createApp({
      render: () => [
        h(AgentIcon, { agent: "antigravity" }),
        h(AgentIcon, { agent: "antigravity" }),
        h(AgentIcon, { agent: "codex" }),
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
