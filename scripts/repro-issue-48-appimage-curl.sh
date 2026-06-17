#!/usr/bin/env bash
#
# Headless reproduction + regression check for GitHub issue #48:
#   "Github & Azure Oauth | Failed to parse device-code response"
#
# Root cause: GitWand shells out to the system `curl` for all forge HTTP
# traffic (github_api.rs / azure.rs -> curl_util.rs -> git/cmd.rs::hidden_cmd).
# In the released Linux AppImage, AppRun rewrites LD_LIBRARY_PATH to point at
# the bundle's own libraries. The spawned `curl` inherits that env, loads an
# ABI-incompatible bundled libcurl/libssl, and dies before completing the TLS
# request -> empty stdout -> serde_json reports the cryptic
# "EOF while parsing a value at line 1 column 0".
#
# This script does NOT need the GUI, the Tauri toolchain, or an AppImage build.
# It runs on any Linux (e.g. an OrbStack/Lima/UTM arm64 Ubuntu, or CI):
#
#   1. CLEAN     : run curl with a normal env                 -> must succeed
#   2. POLLUTED  : simulate AppRun (APPDIR + a bundle dir with a *broken*
#                  libcurl.so on LD_LIBRARY_PATH)              -> must FAIL  (== issue #48)
#   3. SCRUBBED  : apply the exact env fix from hidden_cmd      -> must succeed (== the fix)
#
# Exit code 0 only if all three behave as expected, so it doubles as a test.
#
# Usage:  bash scripts/repro-issue-48-appimage-curl.sh
#
set -u

# A lightweight HTTPS endpoint: any successful TLS request proves libcurl/libssl
# loaded correctly. The real app POSTs to https://github.com/login/device/code;
# the failure mode (curl can't complete the TLS handshake) is identical.
PROBE_URL="${PROBE_URL:-https://api.github.com/}"

# Variables AppRun pollutes — kept in lockstep with APPIMAGE_POLLUTED_VARS in
# apps/desktop/src-tauri/src/git/cmd.rs.
POLLUTED_VARS=(
  LD_LIBRARY_PATH LD_PRELOAD GTK_PATH GIO_MODULE_DIR GSETTINGS_SCHEMA_DIR
  GDK_PIXBUF_MODULE_FILE GDK_PIXBUF_MODULEDIR GST_PLUGIN_SYSTEM_PATH
  GST_PLUGIN_PATH QT_PLUGIN_PATH PYTHONPATH PYTHONHOME PERLLIB
)

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

command -v curl >/dev/null 2>&1 || { red "curl not found — install it first."; exit 2; }
if [ "$(uname -s)" != "Linux" ]; then
  red "This harness must run on Linux (it relies on LD_LIBRARY_PATH library resolution)."
  red "Run it inside your VM, not on macOS."
  exit 2
fi

WORK="$(mktemp -d)"
BUNDLE="$WORK/bundle/usr/lib"
mkdir -p "$BUNDLE"
trap 'rm -rf "$WORK"' EXIT

# ── Build a fake AppImage "bundle" whose libcurl/libssl are deliberately broken.
# We name bogus files exactly like the sonames the system curl depends on; the
# dynamic linker searches LD_LIBRARY_PATH first and picks our broken copy,
# reproducing the bundled-lib ABI conflict (here as an outright load failure,
# which is a strict superset of the real "loads then crashes at TLS init").
mapfile -t SONAMES < <(
  ldd "$(command -v curl)" 2>/dev/null \
    | grep -oE '(libcurl|libssl|libcrypto)\.so[0-9.]*' \
    | sort -u
)
if [ "${#SONAMES[@]}" -eq 0 ]; then
  red "Could not detect curl's libcurl/libssl sonames via ldd — is curl statically linked?"
  red "The pollution step may not reproduce on this system."
  SONAMES=(libcurl.so.4)
fi
for so in "${SONAMES[@]}"; do
  printf 'this is not a valid shared object\n' > "$BUNDLE/$so"
done
bold "Fake bundle libs planted: ${SONAMES[*]}"
echo

# Is the variable *named by $1* currently set (even to an empty value)?
is_set()  { declare -p "$1" >/dev/null 2>&1; }
# Value of the variable named by $1 (empty if unset). Avoids indirect
# expansion for maximum portability across bash versions.
get_var() { eval "printf '%s' \"\${$1:-}\""; }

# ── Faithful shell port of git/cmd.rs::appimage_env_fixes + its application.
# Mutates the current shell's env in place (caller runs it in a subshell).
apply_appimage_env_fix() {
  # No-op unless we look like we're inside an AppImage.
  [ -n "${APPDIR:-}" ] || [ -n "${APPIMAGE:-}" ] || return 0
  local var orig_name
  for var in "${POLLUTED_VARS[@]}"; do
    orig_name="${var}_ORIG"
    if is_set "$orig_name"; then
      # AppRun saved the pre-override value -> restore it.
      export "$var=$(get_var "$orig_name")"
    elif is_set "$var"; then
      # No saved original -> drop the override so the system default applies.
      unset "$var"
    fi
  done
}

# Mirror GitWand's transport flags: -s (silent) -S (show-error). Returns the
# exit code; prints a one-line "exit=<n> bytes=<n>" summary and any stderr.
run_curl_probe() {
  local out err code
  err="$(mktemp)"
  out="$(curl -sS -A GitWand -o - -w '' "$PROBE_URL" 2>"$err")"
  code=$?
  printf '    exit=%s  body_bytes=%s\n' "$code" "${#out}"
  if [ -s "$err" ]; then
    printf '    stderr: %s\n' "$(head -c 300 "$err" | tr '\n' ' ')"
  fi
  rm -f "$err"
  # "success" for our purposes == curl exited 0 AND returned a non-empty body.
  [ "$code" -eq 0 ] && [ -n "$out" ]
}

PASS=0
FAIL=0
check() { # check <label> <expect: ok|fail> <actual-rc>
  local label="$1" expect="$2" rc="$3"
  if { [ "$expect" = ok ] && [ "$rc" -eq 0 ]; } || { [ "$expect" = fail ] && [ "$rc" -ne 0 ]; }; then
    green "  ✓ $label (as expected)"; PASS=$((PASS+1))
  else
    red   "  ✗ $label (UNEXPECTED)"; FAIL=$((FAIL+1))
  fi
}

bold "── 1. CLEAN env (mirrors 'pnpm tauri dev') ──────────────────────────"
( unset APPDIR APPIMAGE LD_LIBRARY_PATH; run_curl_probe ); rc=$?
check "curl succeeds with a normal environment" ok $rc
echo

bold "── 2. POLLUTED env (released AppImage, pre-fix) — reproduces #48 ─────"
(
  export APPDIR="$WORK/bundle"
  export LD_LIBRARY_PATH_ORIG="${LD_LIBRARY_PATH:-}"   # what AppRun would stash
  export LD_LIBRARY_PATH="$BUNDLE${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  run_curl_probe
); rc=$?
check "curl FAILS (empty body) — this is the EOF parse error users saw" fail $rc
echo

bold "── 3. SCRUBBED env (AppImage + hidden_cmd fix) — proves the fix ─────"
(
  export APPDIR="$WORK/bundle"
  export LD_LIBRARY_PATH_ORIG="${LD_LIBRARY_PATH:-}"
  export LD_LIBRARY_PATH="$BUNDLE${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  apply_appimage_env_fix        # <- the fix
  run_curl_probe
); rc=$?
check "curl succeeds again after de-polluting the child env" ok $rc
echo

bold "── 3b. SCRUBBED with no *_ORIG (fix must unset, not restore) ─────────"
(
  export APPDIR="$WORK/bundle"
  unset LD_LIBRARY_PATH_ORIG 2>/dev/null || true
  export LD_LIBRARY_PATH="$BUNDLE"     # no original to restore
  apply_appimage_env_fix
  run_curl_probe
); rc=$?
check "curl succeeds when the polluted var is simply dropped" ok $rc
echo

bold "─────────────────────────────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  green "ALL $PASS CHECKS PASSED — bug reproduced and the fix resolves it."
  exit 0
else
  red "$FAIL check(s) failed, $PASS passed."
  exit 1
fi
