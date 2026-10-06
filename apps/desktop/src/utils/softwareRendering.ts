/**
 * Detect whether the webview renders through a CPU rasterizer (Mesa llvmpipe /
 * softpipe, SwiftShader…) instead of a real GPU.
 *
 * On Linux the backend forces `LIBGL_ALWAYS_SOFTWARE=1` and disables WebKitGTK
 * compositing to dodge EGL crashes (#135, #139). In that mode "GPU" features
 * become CPU work: the xterm WebGL renderer and `backdrop-filter` blurs are far
 * slower than their plain fallbacks, so callers use this to skip them.
 *
 * The probe runs once and is cached — it allocates a throwaway GL context.
 */
const SOFTWARE_RENDERER = /llvmpipe|softpipe|swiftshader|software|lavapipe/i;

let cached: boolean | null = null;

export function isSoftwareRendering(): boolean {
  if (cached !== null) return cached;
  cached = probe();
  return cached;
}

function probe(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    // A software-only GL stack refuses a context that must not carry a major
    // performance caveat — the cheapest, most direct signal when honoured.
    const strict = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true })
      ?? canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true });
    const gl = (strict ?? canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as
      | WebGLRenderingContext
      | null;
    if (!gl) return true; // no WebGL at all → nothing GPU-backed to rely on
    // Not every engine honours failIfMajorPerformanceCaveat (WebKitGTK may hand
    // back an llvmpipe context anyway) — confirm against the renderer string.
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(
      info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return !strict || SOFTWARE_RENDERER.test(renderer);
  } catch {
    return false;
  }
}

/** Reset the cached probe result. Used in tests only. */
export function __resetSoftwareRenderingForTests(): void {
  cached = null;
}
