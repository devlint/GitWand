#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bump-version.sh — Update every version mention across the GitWand monorepo.
#
# Usage:
#   ./scripts/bump-version.sh 1.10.0
#   ./scripts/bump-version.sh v1.10.0   # leading "v" is stripped automatically
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

NEW="${1-}"
NEW="${NEW#v}"   # strip optional leading "v"

if [[ -z "$NEW" ]]; then
  echo "Usage: $0 <version>   (e.g. 1.10.0 or v1.10.0)"
  exit 1
fi

if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be in X.Y.Z semver format, got: '$NEW'"
  exit 1
fi

# Source of truth for the current version
OLD=$(node -p "require('./packages/core/package.json').version")

if [[ "$OLD" == "$NEW" ]]; then
  echo "Already at $NEW — nothing to bump."
  exit 0
fi

echo "Bumping $OLD → $NEW"
echo ""

# Cross-platform in-place sed (macOS requires '' after -i, GNU/Linux doesn't)
sedi() {
  if sed --version 2>/dev/null | grep -q GNU; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

bump() {
  local file="$1"
  local pattern="$2"
  sedi "$pattern" "$file"
  echo "  ✓ $file"
}

# ── Root package.json (private; generic pattern — was historically desynced) ─
bump package.json \
  "s/\"version\": \"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\"/\"version\": \"${NEW}\"/"

# ── package.json files ───────────────────────────────────────────────────────
for f in \
  apps/desktop/package.json \
  packages/core/package.json \
  packages/cli/package.json \
  packages/mcp/package.json \
  website/package.json
do
  bump "$f" "s/\"version\": \"${OLD}\"/\"version\": \"${NEW}\"/"
done

# ── Cargo.toml ([package] version only, not deps) ───────────────────────────
# The `[package]` version is a standalone `version = "X.Y.Z"` line, so its first
# field is literally `version`; dependency lines start with the crate name
# (`tauri = { version = "2" }` → first field `tauri`) and are never matched.
# awk is used instead of sed's GNU-only `0,/re/` range address, which is a
# no-op on macOS/BSD sed and silently left Cargo.toml unbumped.
bump_cargo_toml() {
  local file="apps/desktop/src-tauri/Cargo.toml"
  awk -v old="$OLD" -v new="$NEW" '
    !done && $1 == "version" && $0 ~ ("\"" old "\"") {
      sub("\"" old "\"", "\"" new "\""); done = 1
    }
    { print }
  ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
  echo "  ✓ $file"
}
bump_cargo_toml

# ── Cargo.lock (keep the gitwand-desktop entry in sync with Cargo.toml) ─────
# `cargo build --locked` (used in CI) fails if Cargo.lock disagrees with
# Cargo.toml, so the lock file must be refreshed in the same commit as the
# version bump. `--offline` avoids a network round-trip since only the local
# package's own version changed, not any dependency.
if command -v cargo >/dev/null 2>&1; then
  ( cd apps/desktop/src-tauri && cargo update --offline -p gitwand-desktop --precise "${NEW}" ) \
    && echo "  ✓ apps/desktop/src-tauri/Cargo.lock"
else
  echo "  ⚠ cargo not found — apps/desktop/src-tauri/Cargo.lock NOT updated, fix manually before tagging"
fi

# ── tauri.conf.json ──────────────────────────────────────────────────────────
bump apps/desktop/src-tauri/tauri.conf.json \
  "s/\"version\": \"${OLD}\"/\"version\": \"${NEW}\"/"

# ── packages/mcp/server.json (version appears twice: root + server entry) ───
bump packages/mcp/server.json \
  "s/\"version\": \"${OLD}\"/\"version\": \"${NEW}\"/g"

# ── website/.well-known MCP server card ──────────────────────────────────────
bump website/public/.well-known/mcp/server-card.json \
  "s/\"version\": \"${OLD}\"/\"version\": \"${NEW}\"/"

# ── packages/mcp/src/server.ts ───────────────────────────────────────────────
bump packages/mcp/src/server.ts \
  "s/version: \"${OLD}\"/version: \"${NEW}\"/"

# ── README.md (badge URL) ────────────────────────────────────────────────────
bump README.md \
  "s/version-${OLD}-/version-${NEW}-/"

# ── website/HomeLanding.vue (LATEST const + all locale badge strings) ────────
# Use a generic semver pattern so the replacement works even when the file
# wasn't updated in a previous bump (e.g. LATEST was pinned to an older value).
bump website/.vitepress/theme/HomeLanding.vue \
  "s/const LATEST = '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*'/const LATEST = '${NEW}'/"
bump website/.vitepress/theme/HomeLanding.vue \
  "s/v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]* · /v${NEW} · /g"

# ── website/HomeLanding.vue: "What's new in vX.Y" CTA labels (5 locales) ────
# These reference major.minor (e.g. "v2.0"), not the full semver, and the
# format varies per locale: "What's new in v2.0", "Nouveautés v2.0",
# "Novedades v2.0", "Novidades v2.0", "v2.0 新特性". We constrain the
# substitution to lines containing the `whatsNew:` key so feature-card
# content elsewhere in the file isn't accidentally rewritten. POSIX BRE.
NEW_MM="${NEW%.*}"
bump website/.vitepress/theme/HomeLanding.vue \
  "/whatsNew: /s/v[0-9][0-9]*\\.[0-9][0-9]*/v${NEW_MM}/"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Done — $OLD → $NEW"
echo ""
echo "Next steps:"
echo "  git diff                                    # review"
echo "  git commit -am \"chore: bump version to $NEW\""
echo "  git tag v$NEW && git push origin main v$NEW"
