// Local one-off: renders the Git Advent Calendar social previews with headless
// Chrome into public/advent/og/. Never run from CI or `build`.
//   pnpm --filter gitwand-website advent:og   (CHROME_PATH overrides the binary)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DOORS } from "../../packages/cli/src/advent/doors.ts";
import { plainText } from "../../packages/cli/src/advent/inline.ts";

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "advent", "og");
const WORK_DIR = mkdtempSync(join(tmpdir(), "advent-og-"));
mkdirSync(OUT_DIR, { recursive: true });

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CSS = `
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;overflow:hidden}
body{background:#0d0f1a;color:#e8e8f0;font-family:Inter,-apple-system,"Segoe UI",sans-serif;
  padding:64px 72px;display:flex;flex-direction:column;position:relative;
  background-image:radial-gradient(ellipse at 85% 0%,rgba(210,206,253,.16),transparent 55%)}
.brand{font-size:28px;font-weight:600;color:#d2cefd;letter-spacing:.01em}
.day{font-size:150px;font-weight:800;line-height:1;margin-top:40px;color:#fff;letter-spacing:-.03em}
.cmd{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:44px;font-weight:600;
  color:#d2cefd;background:#232532;border:1px solid #3a3d52;border-radius:14px;
  padding:16px 26px;margin-top:34px;align-self:flex-start;max-width:1056px;
  white-space:pre-wrap;overflow-wrap:anywhere}
.cmd.long{font-size:32px}
.problem{font-size:32px;line-height:1.35;color:#b8b9c9;margin-top:30px;max-width:1056px;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.title{font-size:62px;font-weight:800;line-height:1.08;color:#fff;margin-top:44px;letter-spacing:-.02em;max-width:600px}
.sub{font-size:28px;color:#b8b9c9;margin-top:26px;max-width:600px;line-height:1.35}
.grid{position:absolute;right:72px;top:150px;display:grid;grid-template-columns:repeat(6,60px);gap:10px}
.door{width:60px;height:60px;border-radius:10px;background:#232532;border:1px solid #3a3d52;
  display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#d2cefd}
.door.on{background:#d2cefd;color:#0d0f1a}
`;

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@600&display=swap">
<style>${CSS}</style></head><body>${body}</body></html>`;
}

function render(name: string, html: string): void {
  const src = join(WORK_DIR, `${name}.html`);
  writeFileSync(src, html);
  const out = join(OUT_DIR, `${name}.png`);
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--virtual-time-budget=4000",
      "--window-size=1200,630",
      `--screenshot=${out}`,
      pathToFileURL(src).href,
    ],
    { stdio: "pipe" },
  );
  console.log("wrote", out);
}

const doorsGrid = DOORS.map(
  (d, i) => `<div class="door${i % 5 === 0 ? " on" : ""}">${d.day}</div>`,
).join("");
render(
  "index",
  page(`<div class="brand">GitWand · Git Advent Calendar</div>
<div class="title">24 little-known git commands</div>
<div class="sub">One a day until Christmas, each with a GitWand tip.</div>
<div class="grid">${doorsGrid}</div>`),
);

for (const d of DOORS) {
  render(
    `day-${String(d.day).padStart(2, "0")}`,
    page(`<div class="brand">GitWand · Git Advent Calendar</div>
<div class="day">Day ${d.day}</div>
<div class="cmd${plainText(d.command).length > 30 ? " long" : ""}">${esc(plainText(d.command))}</div>
<div class="problem">${esc(plainText(d.problem))}</div>`),
  );
}
