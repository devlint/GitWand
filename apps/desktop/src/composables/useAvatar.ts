/**
 * useAvatar — single source of truth for the colored-initials avatar disks
 * used across the app (commit log & graph, dashboard, PR views, comment
 * threads).
 *
 * Visual language: outline style — transparent fill, with a deterministic
 * colored border and matching initials. Key the color off a stable string
 * (prefer email, fall back to name) so the same person keeps the same color
 * everywhere.
 */

import type { CSSProperties } from "vue";

/** Deterministic hue (0–359) for a string — same key always maps to the same color. */
export function avatarHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** First+last initials, uppercased. A single token yields its first two chars. */
export function avatarInitials(name: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Inline style object for an avatar disk keyed by a stable string. */
export function avatarStyle(key: string): CSSProperties {
  const color = `hsl(${avatarHue(key)} 70% 55%)`;
  return { borderColor: color, color, background: "transparent" };
}

/**
 * Gravatar URL for an email, or `null` when the value isn't a usable email.
 *
 * Uses SHA-256 of the normalized email (Gravatar accepts SHA-256 or MD5) and
 * `d=404` so Gravatar returns a 404 when the person has no avatar — callers
 * treat that as "no photo" and fall back to the colored-initials disk. Hashes
 * are cached per email for the session.
 */
const gravatarCache = new Map<string, string>();

export async function gravatarUrl(email: string | null | undefined, size = 48): Promise<string | null> {
  const e = (email ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return null;
  // crypto.subtle needs a secure context; Tauri (tauri://) and localhost qualify.
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  let hash = gravatarCache.get(e);
  if (!hash) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e));
    hash = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    gravatarCache.set(e, hash);
  }
  return `https://www.gravatar.com/avatar/${hash}?d=404&s=${size}`;
}

export function useAvatar() {
  return { avatarHue, avatarInitials, avatarStyle, gravatarUrl };
}
