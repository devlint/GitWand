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

/**
 * Best-effort forge avatar URL for a user **login** (not a display name).
 *
 * Forges that expose a stable public login→avatar endpoint get a direct URL;
 * the rest return `null` so the caller's cascade falls through to Gravatar /
 * colored initials. Only GitHub is wired for now (`github.com/{login}.png`,
 * public, no auth, redirects to the current avatar). A value containing spaces
 * is treated as a display name — not a login — and yields `null`.
 */
export function forgeAvatarUrl(
  forge: string | null | undefined,
  login: string | null | undefined,
  size = 48,
): string | null {
  const l = (login ?? "").trim();
  if (!l || /\s/.test(l)) return null;
  switch (forge) {
    case "github":
      return `https://github.com/${encodeURIComponent(l)}.png?size=${size * 2}`;
    default:
      return null;
  }
}

/**
 * GitHub avatar derived from a commit **email**, or `null`.
 *
 * GitHub-authored commits typically carry a `users.noreply.github.com` email
 * that embeds the login — either `{id}+{login}@…` (modern, privacy-on) or the
 * legacy `{login}@…`. The `{id}+` form is the most reliable: `avatars.githubusercontent.com/u/{id}`
 * addresses the user by numeric id directly. Otherwise we fall back to the
 * login endpoint. Non-GitHub emails yield `null` so the caller cascades to
 * Gravatar / initials. No network/API — pure string parse.
 */
export function githubAvatarFromEmail(email: string | null | undefined, size = 48): string | null {
  const e = (email ?? "").trim().toLowerCase();
  const m = /^(?:(\d+)\+)?([a-z0-9-]+)@users\.noreply\.github\.com$/.exec(e);
  if (!m) return null;
  const [, id, login] = m;
  if (id) return `https://avatars.githubusercontent.com/u/${id}?size=${size * 2}`;
  return `https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}`;
}

export function useAvatar() {
  return { avatarHue, avatarInitials, avatarStyle, gravatarUrl, forgeAvatarUrl, githubAvatarFromEmail };
}
