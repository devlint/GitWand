<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { CALLOUTS, HEM, SKETCH, VIEW, coverShape, foldLines, hemLine } from './next-sketch'

// Where the hem of the cover hangs, in viewBox x. `shown` eases towards `wanted`.
const wanted = ref(HEM.start)
const shown = ref(HEM.start)
let frame = 0
let still = false

const cover = computed(() => coverShape(shown.value))
const hem = computed(() => hemLine(shown.value))
const folds = computed(() => foldLines(shown.value))
const percent = computed(() => Math.round(((wanted.value - HEM.min) / (HEM.max - HEM.min)) * 100))

function settle() {
  const gap = wanted.value - shown.value
  if (still || Math.abs(gap) < 0.5) {
    shown.value = wanted.value
    frame = 0
    return
  }
  shown.value += gap * 0.16
  frame = requestAnimationFrame(settle)
}
function pull(x: number) {
  wanted.value = Math.min(HEM.max, Math.max(HEM.min, x))
  if (!frame) frame = requestAnimationFrame(settle)
}
function onRange(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  pull(HEM.min + (v / 100) * (HEM.max - HEM.min))
}
function onPointer(e: PointerEvent) {
  if (e.pointerType !== 'mouse') return
  const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
  pull(((e.clientX - box.left) / box.width) * VIEW.w)
}

onMounted(() => {
  still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
})
onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>

<template>
  <section class="nx">
    <div class="nx-inner">
      <h1 class="nx-h1">This is the future of GitWand.</h1>
      <h2 class="nx-h2">GitWand v4, before it is finished.</h2>
      <p class="nx-sub">
        One working environment where coding agents are supervised and controlled, and where their work is
        integrated with proof. This is a sketch of it. Part of it is still under the cover, because that part
        is not designed yet.
      </p>
      <p class="nx-links">
        <a href="#why">Read where this is going</a>
        <a href="https://github.com/devlint/GitWand/blob/main/ROADMAP.md">The roadmap on GitHub</a>
        <a href="#take-part">Take part, or sponsor the work</a>
      </p>

      <figure class="nx-figure">
        <svg
          class="nx-svg"
          :viewBox="`0 0 ${VIEW.w} ${VIEW.h}`"
          role="img"
          aria-label="Line sketch of the GitWand v4 workspace: a list of tasks on the left, the agent's session in the middle, and a right-hand column still hidden under a cover."
          @pointermove="onPointer"
        >
          <g class="nx-sketch">
            <template v-for="(s, i) in SKETCH" :key="i">
              <line
                v-if="s.kind === 'line'"
                :class="`nx-${s.tone}`" :style="{ '--s': s.step, strokeWidth: s.w }"
                :x1="s.a[0]" :y1="s.a[1]" :x2="s.a[2]" :y2="s.a[3]" pathLength="1"
              />
              <rect
                v-else-if="s.kind === 'rect'"
                :class="`nx-${s.tone}`" :style="{ '--s': s.step }"
                :x="s.a[0]" :y="s.a[1]" :width="s.a[2]" :height="s.a[3]" :rx="s.a[4]" pathLength="1"
              />
              <circle
                v-else
                :class="`nx-dot nx-${s.tone}`" :style="{ '--s': s.step }"
                :cx="s.a[0]" :cy="s.a[1]" :r="s.a[2]"
              />
            </template>
          </g>

          <g class="nx-callouts">
            <template v-for="c in CALLOUTS" :key="c.text">
              <line class="nx-lead" :x1="c.lead[0]" :y1="c.lead[1]" :x2="c.lead[2]" :y2="c.lead[3]" />
              <text :x="c.x" :y="c.y">{{ c.text }}</text>
            </template>
          </g>

          <g class="nx-cover">
            <path class="nx-cloth" :d="cover" />
            <path v-for="(d, i) in folds" :key="i" class="nx-fold" :style="{ opacity: 0.22 + 0.2 * ((i * 7) % 5) / 5 }" :d="d" />
            <path class="nx-hem" :d="hem" />
            <text class="nx-covered" x="1104" y="34" text-anchor="end">Still under the cover: not designed yet</text>
          </g>
        </svg>

        <figcaption class="nx-caption">
          <label class="nx-range">
            <span>Pull the cover back</span>
            <input type="range" min="0" max="100" :value="percent" @input="onRange" />
          </label>
          <ul class="nx-legend">
            <li>Left: your tasks, across every repository.</li>
            <li>Middle: the agent's session, and what waits for you.</li>
            <li>Right: the instruments, not designed yet.</li>
          </ul>
        </figcaption>
      </figure>
    </div>
  </section>
</template>

<style scoped>
.nx {
  background: var(--nc-canvas);
  color: var(--nc-text);
  border-bottom: 1px solid var(--nc-neutral-800);
}
.nx-inner {
  max-width: 1240px;
  margin: 0 auto;
  padding: clamp(32px, 4vw, 56px) clamp(20px, 4vw, 48px) clamp(28px, 4vw, 48px);
}
.nx-h1 {
  margin: 0;
  max-width: 26ch;
  text-wrap: balance;
  font-size: clamp(2.25rem, 4.6vw, 3.75rem);
  line-height: 1;
  font-weight: 650;
  letter-spacing: -0.035em;
  color: var(--nc-neutral-100);
}
.nx-h2 {
  margin: 14px 0 0;
  padding: 0;
  border: 0;
  font-size: clamp(1.25rem, 2.1vw, 1.75rem);
  line-height: 1.25;
  font-weight: 500;
  letter-spacing: -0.015em;
  color: var(--nc-accent-300);
}
.nx-sub {
  margin: 16px 0 0;
  max-width: 62ch;
  font-size: clamp(1rem, 1.4vw, 1.2rem);
  line-height: 1.55;
  color: var(--nc-neutral-300);
}
.nx-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  margin: 20px 0 0;
  font-size: 1rem;
}
.nx-links a {
  color: var(--nc-accent-300);
  text-decoration: underline;
  text-decoration-color: var(--nc-accent-700);
  text-underline-offset: 5px;
}
.nx-links a:hover { color: var(--nc-accent-100); text-decoration-color: currentColor; }
.nx-links a:focus-visible,
.nx-range input:focus-visible { outline: 2px solid var(--nc-accent-400); outline-offset: 4px; border-radius: 4px; }

.nx-figure { margin: clamp(20px, 2.5vw, 32px) 0 0; }
.nx-svg { display: block; width: 100%; height: auto; cursor: ew-resize; touch-action: pan-y; }

.nx-sketch line,
.nx-sketch rect {
  fill: none;
  stroke-width: 1.1;
  stroke-linecap: round;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: nx-draw 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
  animation-delay: calc(var(--s) * 130ms);
}
.nx-dot { opacity: 0; animation: nx-show 0.3s ease-out forwards; animation-delay: calc(var(--s) * 130ms + 300ms); }
.nx-ink { stroke: var(--nc-neutral-300); }
.nx-faint { stroke: var(--nc-neutral-700); }
.nx-accent { stroke: var(--nc-accent-400); }
.nx-amber { stroke: #fbbf24; }
.nx-green { stroke: #10b981; }
.nx-red { stroke: #f87171; }
.nx-dot.nx-ink { fill: var(--nc-neutral-300); stroke: none; }
.nx-dot.nx-accent { fill: var(--nc-accent-400); stroke: none; }
.nx-dot.nx-amber { fill: #fbbf24; stroke: none; }
.nx-dot.nx-green { fill: #10b981; stroke: none; }

.nx-callouts text,
.nx-covered { font-family: Inter, system-ui, sans-serif; font-size: 14px; fill: var(--nc-neutral-400); }
.nx-covered { fill: var(--nc-accent-300); }
.nx-lead { stroke: var(--nc-neutral-600); stroke-width: 0.8; }
.nx-callouts { opacity: 0; animation: nx-show 0.5s ease-out 0.9s forwards; }

.nx-cover { opacity: 0; animation: nx-show 0.8s ease-out 0.75s forwards; }
.nx-cloth { fill: var(--nc-canvas); fill-opacity: 0.8; }
.nx-fold { fill: none; stroke: var(--nc-accent-400); stroke-width: 1; }
.nx-hem { fill: none; stroke: var(--nc-accent-300); stroke-width: 1.6; stroke-linecap: round; }

.nx-caption {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px 40px;
  margin-top: 16px;
  color: var(--nc-neutral-400);
  font-size: 0.95rem;
}
.nx-range { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; color: var(--nc-neutral-200); }
.nx-range input { width: min(280px, 60vw); height: 44px; accent-color: var(--nc-accent-400); }
.nx-legend { display: none; margin: 0; padding: 0; list-style: none; }

@keyframes nx-draw { to { stroke-dashoffset: 0; } }
@keyframes nx-show { to { opacity: 1; } }

/* The callouts are unreadable once the drawing is this small: say the same thing as a list. */
@media (max-width: 720px) {
  .nx-callouts, .nx-covered { display: none; }
  .nx-legend { display: grid; gap: 4px; }
}
@media (prefers-reduced-motion: reduce) {
  .nx-sketch line, .nx-sketch rect { animation: none; stroke-dashoffset: 0; }
  .nx-dot, .nx-callouts, .nx-cover { animation: none; opacity: 1; }
}
</style>
