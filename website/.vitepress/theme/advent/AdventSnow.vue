<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'

// Falling snow behind the parent's content. Client-only (canvas), paused when
// off-screen or the tab is hidden, and absent under prefers-reduced-motion.
const canvas = ref<HTMLCanvasElement | null>(null)

interface Flake { x: number; y: number; r: number; vy: number; sway: number; phase: number; alpha: number }

let raf = 0
let visible = false
let cleanup: (() => void) | null = null

onMounted(() => {
  const el = canvas.value
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const ctx = el.getContext('2d')
  if (!ctx) return

  let w = 0
  let h = 0
  let flakes: Flake[] = []
  const spawn = (y?: number): Flake => ({
    x: Math.random() * w,
    y: y ?? Math.random() * h,
    r: 0.6 + Math.random() * 1.8,
    vy: 12 + Math.random() * 26, // px per second
    sway: 6 + Math.random() * 14,
    phase: Math.random() * Math.PI * 2,
    alpha: 0.35 + Math.random() * 0.55,
  })

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = el.clientWidth
    h = el.clientHeight
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // About one flake per 5000 px², capped so wide screens stay light.
    const count = Math.min(120, Math.round((w * h) / 5000))
    flakes = Array.from({ length: count }, () => spawn())
  }

  let last = 0
  const frame = (t: number) => {
    const dt = last ? Math.min((t - last) / 1000, 0.05) : 0
    last = t
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#fff'
    for (const f of flakes) {
      f.y += f.vy * dt
      f.phase += dt * 0.8
      if (f.y - f.r > h) Object.assign(f, spawn(-f.r))
      const x = f.x + Math.sin(f.phase) * f.sway
      ctx.globalAlpha = f.alpha
      ctx.beginPath()
      ctx.arc(x, f.y, f.r, 0, Math.PI * 2)
      ctx.fill()
    }
    raf = requestAnimationFrame(frame)
  }
  const start = () => {
    if (raf || !visible || document.hidden) return
    last = 0
    raf = requestAnimationFrame(frame)
  }
  const stop = () => {
    cancelAnimationFrame(raf)
    raf = 0
  }

  const ro = new ResizeObserver(resize)
  ro.observe(el)
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting
    visible ? start() : stop()
  })
  io.observe(el)
  const onVisibility = () => (document.hidden ? stop() : start())
  document.addEventListener('visibilitychange', onVisibility)
  resize()

  cleanup = () => {
    stop()
    ro.disconnect()
    io.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
  }
})

onBeforeUnmount(() => cleanup?.())
</script>

<template>
  <canvas ref="canvas" class="advent-snow" aria-hidden="true"></canvas>
</template>

<style scoped>
.advent-snow {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  pointer-events: none;
}
</style>
