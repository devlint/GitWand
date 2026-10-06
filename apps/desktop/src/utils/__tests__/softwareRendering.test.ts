import { describe, it, expect, vi, afterEach } from "vitest";
import { isSoftwareRendering, __resetSoftwareRenderingForTests } from "../softwareRendering";

const UNMASKED_RENDERER_WEBGL = 0x9246;

/** Stub `document.createElement("canvas")` with a fake GL stack. */
function stubGl(opts: { strict: boolean; any: boolean; renderer?: string }) {
  const gl = {
    RENDERER: 0x1f01,
    getExtension: (name: string) =>
      name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL } : null,
    getParameter: () => opts.renderer ?? "",
  };
  const canvas = {
    getContext: (_kind: string, attrs?: { failIfMajorPerformanceCaveat?: boolean }) => {
      if (attrs?.failIfMajorPerformanceCaveat) return opts.strict ? gl : null;
      return opts.any ? gl : null;
    },
  };
  vi.stubGlobal("document", { createElement: () => canvas });
}

describe("isSoftwareRendering", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSoftwareRenderingForTests();
  });

  it("is false on a hardware GPU", () => {
    stubGl({ strict: true, any: true, renderer: "AMD Radeon RX 7900 XTX (radeonsi)" });
    expect(isSoftwareRendering()).toBe(false);
  });

  it("is true when the renderer is llvmpipe even if the strict context is granted", () => {
    stubGl({ strict: true, any: true, renderer: "llvmpipe (LLVM 19.1.7, 256 bits)" });
    expect(isSoftwareRendering()).toBe(true);
  });

  it("is true when a context without a performance caveat is refused", () => {
    stubGl({ strict: false, any: true, renderer: "Mesa Intel(R) Graphics" });
    expect(isSoftwareRendering()).toBe(true);
  });

  it("is true when WebGL is unavailable", () => {
    stubGl({ strict: false, any: false });
    expect(isSoftwareRendering()).toBe(true);
  });

  it("is false outside a DOM", () => {
    expect(isSoftwareRendering()).toBe(false);
  });

  it("caches the probe", () => {
    stubGl({ strict: true, any: true, renderer: "llvmpipe" });
    expect(isSoftwareRendering()).toBe(true);
    stubGl({ strict: true, any: true, renderer: "AMD Radeon" });
    expect(isSoftwareRendering()).toBe(true);
  });
});
