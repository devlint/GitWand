<script setup lang="ts">
/**
 * Logos of the CLI coding agents GitWand can launch in a terminal tab.
 *
 * Marks copied from @lobehub/icons-static-svg 1.95.1 (MIT), minus the Codex
 * mark's opaque white tile (a bright square on the dark theme); the
 * logos themselves belong to their owners and are used only to identify each
 * tool. Inlined rather than v-html'd: no runtime HTML injection, and the
 * single-colour OpenCode mark can follow `currentColor`.
 *
 * Antigravity is the exception: its mark stacks 11 Gaussian-blur filters,
 * which an inline SVG re-runs on every repaint of every tab showing it. As an
 * <img> (static file, assets/agents/antigravity.svg) it is rasterised once
 * and cached.
 */
import { useId } from "vue";
import antigravityUrl from "../assets/agents/antigravity.svg?url";

withDefaults(
  defineProps<{
    agent: "claude" | "codex" | "opencode" | "antigravity";
    /** Pixel size of the square icon. */
    size?: number;
  }>(),
  { size: 14 },
);

// The colour marks define gradients, masks and filters by id. Several icons
// can be on screen at once (one per terminal tab), so each instance prefixes
// its ids: a duplicate id resolves to the first copy in the document, which
// breaks rendering when that copy sits in a hidden element.
const uid = useId();
const idFor = (name: string) => `${uid}-${name}`;
const url = (name: string) => `url(#${idFor(name)})`;
</script>

<template>
  <!-- claudecode-color, codex-color, opencode, antigravity-color -->
  <svg v-if="agent === 'claude'" :width="size" :height="size" aria-hidden="true" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="#D97757" fill-rule="evenodd"></path></svg>
  <svg v-else-if="agent === 'codex'" :width="size" :height="size" aria-hidden="true" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" :fill="url('codex')"></path><defs><linearGradient gradientUnits="userSpaceOnUse" :id="idFor('codex')" x1="12" x2="12" y1="3" y2="21"><stop stop-color="#B1A7FF"></stop><stop offset=".5" stop-color="#7A9DFF"></stop><stop offset="1" stop-color="#3941FF"></stop></linearGradient></defs></svg>
  <svg v-else-if="agent === 'opencode'" :width="size" :height="size" aria-hidden="true" fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"></path></svg>
  <img v-else-if="agent === 'antigravity'" :src="antigravityUrl" :width="size" :height="size" alt="" aria-hidden="true" decoding="async" />
</template>
