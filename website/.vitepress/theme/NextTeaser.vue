<script setup lang="ts">
import { SKETCH, coverShape, foldLines, hemLine } from './next-sketch'

// The home page announces /next with the same sketch, still, with most of it covered.
defineProps<{ title: string; body: string; cta: string; note?: string }>()

const HEM = 470
const cover = coverShape(HEM)
const hem = hemLine(HEM)
const folds = foldLines(HEM, 22)
</script>

<template>
  <section class="nt" aria-labelledby="nt-title">
    <div class="nt-wrap">
      <div class="nt-text">
        <h2 id="nt-title" class="nt-title">{{ title }}</h2>
        <p class="nt-body">{{ body }}</p>
        <p class="nt-action">
          <a class="nt-cta" href="/next">{{ cta }}</a>
          <span v-if="note" class="nt-note">{{ note }}</span>
        </p>
      </div>
      <a class="nt-art" href="/next" tabindex="-1" aria-hidden="true">
        <svg viewBox="60 40 1130 590" preserveAspectRatio="xMinYMid slice">
          <g class="nt-sketch">
            <template v-for="(s, i) in SKETCH" :key="i">
              <line v-if="s.kind === 'line'" :class="`nt-${s.tone}`" :style="{ strokeWidth: s.w }" :x1="s.a[0]" :y1="s.a[1]" :x2="s.a[2]" :y2="s.a[3]" />
              <rect v-else-if="s.kind === 'rect'" :class="`nt-${s.tone}`" :x="s.a[0]" :y="s.a[1]" :width="s.a[2]" :height="s.a[3]" :rx="s.a[4]" />
              <circle v-else :class="`nt-dot nt-${s.tone}`" :cx="s.a[0]" :cy="s.a[1]" :r="s.a[2]" />
            </template>
          </g>
          <path class="nt-cloth" :d="cover" />
          <path v-for="(d, i) in folds" :key="i" class="nt-fold" :style="{ opacity: 0.22 + 0.2 * ((i * 7) % 5) / 5 }" :d="d" />
          <path class="nt-hem" :d="hem" />
        </svg>
      </a>
    </div>
  </section>
</template>

<style scoped>
.nt {
  margin-top: 56px;
  background: var(--nc-canvas);
  border-top: 1px solid var(--nc-neutral-800);
  border-bottom: 1px solid var(--nc-neutral-800);
}
.nt-wrap {
  max-width: var(--nc-measure);
  margin: 0 auto;
  padding: 0 24px;
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  gap: clamp(24px, 4vw, 56px);
  align-items: center;
}
.nt-text { padding: clamp(32px, 5vw, 56px) 0; }
.nt-title {
  margin: 0;
  padding: 0;
  border: 0;
  font-size: clamp(28px, 3.4vw, 40px);
  line-height: 1.06;
  font-weight: 650;
  letter-spacing: -0.03em;
  color: var(--nc-neutral-100);
}
.nt-body {
  margin: 16px 0 0;
  max-width: 52ch;
  font-size: 17px;
  line-height: 1.55;
  color: var(--nc-neutral-300);
}
.nt-action { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; margin: 20px 0 0; }
.nt-cta {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 20px;
  border: 1px solid var(--nc-accent-600);
  border-radius: 999px;
  font-size: 16px;
  font-weight: 550;
  color: var(--nc-accent-100);
  background: color-mix(in srgb, var(--nc-accent-800) 60%, transparent);
  text-decoration: none;
  transition: background 0.16s ease-out;
}
.nt-cta:hover { background: var(--nc-accent-800); }
.nt-cta:focus-visible { outline: 2px solid var(--nc-accent-400); outline-offset: 3px; }
.nt-note { font-size: 14px; color: var(--nc-neutral-400); }

.nt-art { display: block; align-self: stretch; min-height: 260px; }
.nt-art svg { display: block; width: 100%; height: 100%; }
.nt-sketch line, .nt-sketch rect { fill: none; stroke-width: 1.1; stroke-linecap: round; }
.nt-ink { stroke: var(--nc-neutral-300); }
.nt-faint { stroke: var(--nc-neutral-700); }
.nt-accent { stroke: var(--nc-accent-400); }
.nt-amber { stroke: #fbbf24; }
.nt-green { stroke: #10b981; }
.nt-red { stroke: #f87171; }
.nt-dot.nt-ink { fill: var(--nc-neutral-300); stroke: none; }
.nt-dot.nt-accent { fill: var(--nc-accent-400); stroke: none; }
.nt-dot.nt-amber { fill: #fbbf24; stroke: none; }
.nt-dot.nt-green { fill: #10b981; stroke: none; }
.nt-cloth { fill: var(--nc-canvas); fill-opacity: 0.8; }
.nt-fold { fill: none; stroke: var(--nc-accent-400); stroke-width: 1; }
.nt-hem { fill: none; stroke: var(--nc-accent-300); stroke-width: 1.6; stroke-linecap: round; }

@media (max-width: 820px) {
  .nt-wrap { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .nt-text { padding-bottom: 20px; }
  .nt-art { min-height: 0; aspect-ratio: 1130 / 590; margin-bottom: 28px; }
}
</style>
