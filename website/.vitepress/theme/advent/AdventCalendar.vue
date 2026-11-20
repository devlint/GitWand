<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  DOORS,
  DOOR_COUNT,
  calendarState,
  isUnlocked,
  type AdventDoor,
  type CalendarState,
} from '@gitwand/advent'
import {
  DOWNLOAD_URL,
  closeTargetPath,
  initialDoorAction,
  lockedMessage,
  markOpened,
  openedUnlockedCount,
  readOpened,
  resolveNow,
  shouldAutoOpen,
  showDoorArticle,
} from './advent-state'
import AdventDoorContent from './AdventDoorContent.vue'
import AdventDoorDialog from './AdventDoorDialog.vue'

/**
 * `initialDay`: the door of a `/advent/<day>` page. `builtOver`: whether the
 * calendar was over when that page was built (frontmatter `adventOver`),
 * which decides the server render of the door article.
 */
const props = defineProps<{ initialDay?: number; builtOver?: boolean }>()

const ARTICLE_TITLE_ID = 'advent-article-title'

const FLIP_MS = 400
const SHAKE_MS = 450

type DoorState = 'pending' | 'opened' | 'today' | 'available' | 'locked'

// Everything below stays neutral until onMounted: the server has no clock
// override, no storage and no idea of the visitor's time zone.
const now = ref<Date | null>(null)
const opened = ref<Set<number>>(new Set())
const activeDay = ref<number | null>(null)
const flippingDay = ref<number | null>(null)
const shakingDay = ref<number | null>(null)
const liveMessage = ref('')

// The day-page article (the door's content, once the season is over). Its first
// value comes from the build, so the client's first render matches the static
// HTML; onMounted re-decides with the visitor's clock (and ?date=).
const articleShown = ref(props.builtOver === true)

const doorButtons = new Map<number, HTMLButtonElement>()
let returnFocusTo: HTMLButtonElement | null = null
const timers = new Set<ReturnType<typeof setTimeout>>()
let shakeTimer: ReturnType<typeof setTimeout> | undefined
let shakeGeneration = 0

const days = Array.from({ length: DOOR_COUNT }, (_, i) => i + 1)
const doorsByDay = new Map(DOORS.map((d) => [d.day, d]))

const state = computed<CalendarState | null>(() => (now.value ? calendarState(now.value) : null))
const openedCount = computed(() =>
  now.value ? openedUnlockedCount(opened.value, now.value) : 0,
)
const articleDoor = computed<AdventDoor | null>(() =>
  articleShown.value && props.initialDay !== undefined ? (doorsByDay.get(props.initialDay) ?? null) : null,
)
const activeDoor = computed<AdventDoor | null>(() =>
  activeDay.value === null ? null : (doorsByDay.get(activeDay.value) ?? null),
)

function unlocked(day: number): boolean {
  return now.value !== null && isUnlocked(day, now.value)
}

function doorState(day: number): DoorState {
  if (!now.value) return 'pending'
  if (!unlocked(day)) return 'locked'
  if (opened.value.has(day)) return 'opened'
  return isToday(day) ? 'today' : 'available'
}

/** Today's door during the run, whether or not it is already opened. */
function isToday(day: number): boolean {
  const s = state.value
  return s?.phase === 'running' && s.today === day
}

function doorLabel(day: number): string {
  if (!now.value) return `Day ${day}`
  if (!unlocked(day)) return `Day ${day}, locked`
  const today = isToday(day) ? ', today' : ''
  return `Day ${day}${today}, ${doorsByDay.get(day)?.command ?? ''}`
}

/** The command sits behind the leaf once the door is opened, and while it swings open. */
function showsCommand(day: number): boolean {
  return flippingDay.value === day || doorState(day) === 'opened'
}

function setDoorRef(day: number, el: unknown): void {
  if (el instanceof HTMLButtonElement) doorButtons.set(day, el)
  else doorButtons.delete(day)
}

function later(fn: () => void, ms: number): void {
  const t = setTimeout(() => {
    timers.delete(t)
    fn()
  }, ms)
  timers.add(t)
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function replaceUrl(path: string): void {
  try {
    history.replaceState(history.state, '', path + location.search)
  } catch {
    // A refused replaceState only costs the shareable URL.
  }
}

async function announce(message: string): Promise<void> {
  // Clear first so a repeated message is announced again.
  liveMessage.value = ''
  await nextTick()
  liveMessage.value = message
}

async function refuse(day: number): Promise<void> {
  void announce(lockedMessage(day))
  // Restart the shake on every click: drop the class, let Vue patch the DOM,
  // force a reflow, then add it back. Only the latest click owns the timer.
  const generation = ++shakeGeneration
  clearTimeout(shakeTimer)
  shakingDay.value = null
  await nextTick()
  if (generation !== shakeGeneration) return
  void doorButtons.get(day)?.offsetWidth
  shakingDay.value = day
  shakeTimer = setTimeout(() => {
    if (generation === shakeGeneration) shakingDay.value = null
  }, SHAKE_MS)
}

function showDoor(day: number): void {
  const next = markOpened(storage(), day)
  for (const d of opened.value) next.add(d)
  opened.value = next
  liveMessage.value = ''
  replaceUrl(`/advent/${day}`)
  activeDay.value = day
}

function onDoorClick(day: number, event: MouseEvent): void {
  if (!now.value || flippingDay.value !== null) return
  if (!unlocked(day)) {
    void refuse(day)
    return
  }
  returnFocusTo = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null
  if (opened.value.has(day) || prefersReducedMotion()) {
    showDoor(day)
    return
  }
  flippingDay.value = day
  later(() => {
    flippingDay.value = null
    showDoor(day)
  }, FLIP_MS)
}

function onDialogClose(): void {
  if (activeDay.value === null) return
  const day = activeDay.value
  activeDay.value = null
  // Intentional: on /advent/12 this rewrites the URL to /advent/ while the
  // day-12 page stays loaded, unless that page shows its article (then it stays /advent/12).
  replaceUrl(closeTargetPath(props.initialDay, articleShown.value))
  const target = returnFocusTo ?? doorButtons.get(day) ?? null
  returnFocusTo = null
  void nextTick(() => target?.focus())
}

onMounted(() => {
  const current = resolveNow(location.search, new Date())
  now.value = current
  articleShown.value = showDoorArticle(current)
  opened.value = readOpened(storage())
  const day = props.initialDay
  const action = initialDoorAction(day, current)
  if (day === undefined) return
  if (shouldAutoOpen(action, articleShown.value)) {
    returnFocusTo = doorButtons.get(day) ?? null
    showDoor(day)
  } else if (action === 'locked') {
    void announce(lockedMessage(day))
  }
})

onBeforeUnmount(() => {
  for (const t of timers) clearTimeout(t)
  timers.clear()
  clearTimeout(shakeTimer)
})
</script>

<template>
  <div class="gw-page adv">
    <section class="adv-hero">
      <div class="adv-inner">
        <h1 class="adv-title">Git Advent Calendar</h1>
        <p class="adv-sub">24 little-known git commands, one a day until Christmas.</p>
        <p class="adv-progress">{{ openedCount }}/{{ DOOR_COUNT }} opened</p>
        <p v-if="state?.phase === 'not-started'" class="adv-phase">Doors open on December 1.</p>
        <p v-else-if="state?.phase === 'over'" class="adv-phase">Every door is open — merry Christmas.</p>
      </div>
    </section>

    <section class="adv-inner adv-grid-wrap">
      <ol class="adv-grid">
        <li v-for="day in days" :key="day" class="adv-cell">
          <button
            :ref="(el) => setDoorRef(day, el)"
            type="button"
            class="adv-door"
            :class="[
              `adv-door--${doorState(day)}`,
              {
                'adv-door--flipping': flippingDay === day,
                'adv-door--shake': shakingDay === day,
                'adv-door--last': day === 24,
                'adv-door--is-today': isToday(day),
              },
            ]"
            :aria-label="doorLabel(day)"
            @click="onDoorClick(day, $event)"
          >
            <span class="adv-door__inside" aria-hidden="true">
              <span class="adv-door__cmd">{{ showsCommand(day) ? doorsByDay.get(day)?.command : '' }}</span>
            </span>
            <span class="adv-door__leaf" aria-hidden="true">
              <span v-if="day === 24" class="adv-door__tree">🎄</span>
              <span class="adv-door__num">{{ day }}</span>
            </span>
          </button>
        </li>
      </ol>
      <p class="adv-live" aria-live="polite">{{ liveMessage }}</p>
    </section>

    <section v-if="articleDoor" class="adv-inner adv-article-wrap">
      <article class="adv-article" :aria-labelledby="ARTICLE_TITLE_ID">
        <AdventDoorContent :door="articleDoor" :title-id="ARTICLE_TITLE_ID" />
        <p class="adv-article__footer">
          <a class="adv-article__download" :href="DOWNLOAD_URL">Download GitWand</a>
        </p>
      </article>
    </section>

    <AdventDoorDialog :door="activeDoor" @close="onDialogClose" />
  </div>
</template>

<style scoped>
.adv {
  background: var(--nc-canvas);
  color: var(--nc-text);
  font-family: var(--nc-font-sans);
  padding-bottom: 72px;
}
.adv-inner {
  max-width: 960px;
  margin: 0 auto;
  padding: 0 24px;
}
.adv-hero {
  padding: 72px 0 36px;
  text-align: center;
  background:
    radial-gradient(ellipse 70% 60% at 50% -10%, color-mix(in srgb, var(--nc-accent) 18%, transparent) 0%, transparent 70%),
    var(--nc-canvas);
}
.adv-title {
  margin: 0 0 12px;
  font-size: 44px;
  line-height: 1.15;
  font-weight: var(--nc-weight-title);
  letter-spacing: var(--nc-track-title);
  color: var(--nc-accent-100);
}
.adv-sub {
  margin: 0 auto 18px;
  max-width: 560px;
  font-size: 18px;
  line-height: 1.6;
  color: var(--nc-neutral-400);
}
.adv-progress {
  display: inline-block;
  margin: 0;
  padding: 4px 12px;
  font-family: var(--nc-font-mono);
  font-size: 12.5px;
  color: var(--nc-accent-300);
  border: 1px solid var(--nc-neutral-800);
  border-radius: 999px;
}
.adv-phase {
  margin: 14px 0 0;
  font-size: 15px;
  color: var(--nc-neutral-300);
}

.adv-grid-wrap {
  padding-top: 12px;
}
.adv-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}
.adv-cell {
  margin: 0;
  padding: 0;
  min-width: 0;
}

.adv-door {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 1;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  perspective: 700px;
  border-radius: var(--nc-radius-lg);
}
.adv-door:focus-visible {
  outline: 2px solid var(--nc-accent-300);
  outline-offset: 3px;
}

/* What is behind the door. */
.adv-door__inside {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  overflow: hidden;
  border-radius: var(--nc-radius-lg);
  background: var(--nc-bg);
  border: 1px dashed var(--nc-neutral-800);
}
.adv-door__cmd {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  --cmd-lh: 1.3;
  max-width: 100%;
  /* Fallback where line-clamp is unsupported: cap at 4 lines and cut. */
  max-height: calc(4 * var(--cmd-lh) * 1em);
  overflow: hidden;
  font-family: var(--nc-font-mono);
  font-size: 11.5px;
  line-height: var(--cmd-lh);
  text-align: center;
  color: var(--nc-settled);
  overflow-wrap: anywhere;
}

/* The door leaf, hinged on its left edge. */
.adv-door__leaf {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border-radius: var(--nc-radius-lg);
  background: var(--nc-surface);
  border: 1px solid var(--nc-neutral-800);
  transform-origin: left center;
  backface-visibility: hidden;
  transition:
    transform 400ms var(--nc-ease),
    opacity 400ms var(--nc-ease-out),
    border-color 150ms,
    box-shadow 150ms;
}
.adv-door__num {
  font-family: var(--nc-font-mono);
  font-size: 22px;
  font-weight: 500;
  color: var(--nc-neutral-300);
}
.adv-door__tree {
  font-size: 18px;
  line-height: 1;
}

.adv-door--pending,
.adv-door--locked {
  cursor: default;
}
.adv-door--pending .adv-door__num,
.adv-door--locked .adv-door__num {
  color: var(--nc-neutral-600);
}
.adv-door--locked .adv-door__leaf {
  background: color-mix(in srgb, var(--nc-surface) 55%, var(--nc-canvas));
}

/* Day 24: a quiet accent frame and glow, whatever its state. */
.adv-door--last .adv-door__leaf {
  border-color: var(--nc-accent-500);
  box-shadow: var(--nc-glow-soft);
}
.adv-door--last .adv-door__num {
  color: var(--nc-accent-300);
}
.adv-door--last.adv-door--pending .adv-door__num,
.adv-door--last.adv-door--locked .adv-door__num {
  color: var(--nc-accent-600);
}

.adv-door--available .adv-door__leaf {
  border-color: var(--nc-neutral-700);
}
.adv-door--available:hover .adv-door__leaf {
  border-color: var(--nc-accent-600);
}

.adv-door--today .adv-door__leaf {
  background: color-mix(in srgb, var(--nc-accent) 16%, var(--nc-surface));
  border-color: var(--nc-waiting);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--nc-waiting) 40%, transparent), 0 0 26px color-mix(in srgb, var(--nc-waiting) 22%, transparent);
}
.adv-door--today .adv-door__num {
  color: var(--nc-waiting);
}
.adv-door--today:hover .adv-door__leaf {
  transform: rotateY(-12deg);
}

.adv-door--opened .adv-door__inside,
.adv-door--flipping .adv-door__inside {
  border-style: solid;
  border-color: color-mix(in srgb, var(--nc-settled) 35%, transparent);
}
.adv-door--opened .adv-door__leaf {
  transform: rotateY(-100deg);
  opacity: 0;
  pointer-events: none;
}

/* Today's door keeps its accent ring once opened, so "today" stays identifiable. */
.adv-door--opened.adv-door--is-today .adv-door__inside {
  border-style: solid;
  border-color: var(--nc-waiting);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--nc-waiting) 40%, transparent), 0 0 26px color-mix(in srgb, var(--nc-waiting) 22%, transparent);
}

.adv-door--flipping .adv-door__leaf {
  transform: rotateY(-100deg);
  opacity: 0;
}

.adv-door--shake {
  animation: adv-shake 450ms var(--nc-ease-out);
}
@keyframes adv-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-5px); }
  40% { transform: translateX(5px); }
  60% { transform: translateX(-3px); }
  80% { transform: translateX(3px); }
}

.adv-article-wrap {
  margin-top: 40px;
}
.adv-article {
  max-width: 640px;
  margin: 0 auto;
  padding: 28px 28px 22px;
  background: var(--nc-bg);
  border: 1px solid var(--nc-neutral-800);
  border-radius: var(--nc-radius-xl);
}
.adv-article__footer {
  margin: 22px 0 0;
  padding-top: 16px;
  border-top: 1px solid var(--nc-rule);
}
.adv-article__download {
  font-size: 13px;
  color: var(--nc-neutral-400);
  text-decoration: none;
}
.adv-article__download:hover {
  color: var(--nc-accent-300);
}
.adv-article__download:focus-visible {
  outline: 2px solid var(--nc-accent-300);
  outline-offset: 2px;
}

.adv-live {
  min-height: 1.6em;
  margin: 20px 0 0;
  text-align: center;
  font-size: 15px;
  color: var(--nc-waiting);
}

@media (max-width: 640px) {
  .adv-hero {
    padding: 48px 0 28px;
  }
  .adv-title {
    font-size: 32px;
  }
  .adv-sub {
    font-size: 16px;
  }
  .adv-inner {
    padding: 0 16px;
  }
  .adv-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }
  .adv-door__num {
    font-size: 18px;
  }
  .adv-article {
    padding: 22px 18px 18px;
  }
  .adv-door__inside {
    padding: 5px;
  }
  .adv-door__cmd {
    --cmd-lh: 1.25;
    font-size: 9px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .adv-door__leaf {
    transition: none;
  }
  .adv-door--today:hover .adv-door__leaf,
  .adv-door--flipping .adv-door__leaf {
    transform: none;
  }
  .adv-door--shake {
    animation: none;
  }
}
</style>
