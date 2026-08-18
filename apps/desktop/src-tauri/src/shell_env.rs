//! macOS login-shell environment preload at app startup.
//!
//! ## Why this exists
//!
//! On macOS, GUI apps launched from Finder/Dock/Spotlight inherit a minimal
//! environment from `launchd`:
//!   - `PATH=/usr/bin:/bin:/usr/sbin:/sbin`
//!   - `HOME`, `USER`, `TMPDIR`
//!   - **Nothing from `~/.zshrc`, `~/.zprofile`, `~/.bashrc`, etc.**
//!
//! This breaks subprocess like `gh`, `glab`, `claude`, `codex`, `pnpm`, `node`
//! for users whose tooling depends on shell-rc-set variables: `SSH_AUTH_SOCK`,
//! `XDG_CONFIG_HOME`, `LANG`/`LC_ALL`, `GH_TOKEN`/`GITHUB_TOKEN`, custom
//! `PATH` prefixes (asdf, mise, nvm), and `nix-darwin` exports.
//!
//! Symptom in v2.8.x: `gh pr list` from Tauri hangs ≥30s while the same
//! command runs in ~1s from the user's terminal. Root cause: `gh`'s
//! credential resolution chain falls back to the macOS keychain when other
//! auth paths (env-var token, gh-config token) are unavailable, and the
//! keychain prompt fired from a launchd-spawned subprocess often hangs
//! silently or retries indefinitely without surfacing a UI dialog.
//!
//! Same symptom reappeared for `glab` (#149): `glab auth login --use-keyring`
//! stores the GitLab PAT in the macOS keychain instead of `config.yml`, so a
//! user on that auth mode hits the identical ACL mismatch. Fixed the same
//! way — see `extract_glab_token` below.
//!
//! This is the same pattern VS Code, Sublime Text, IntelliJ, and most
//! macOS-savvy GUI dev tools handle via "shell environment detection".
//!
//! ## What this module does
//!
//! Spawn `$SHELL -l -c env` once at startup (bounded by a 3s timeout),
//! parse its output, and propagate everything-not-already-set into the
//! current process env. Subsequent subprocess (`Command::new`) inherit
//! the enriched env automatically.
//!
//! - `PATH` is **not** overwritten — `hidden_cmd` in `git/cmd.rs` does its
//!   own PATH enrichment with the Homebrew prefixes for predictability;
//!   we don't want shell-rc PATH changes to defeat that.
//! - `PWD`, `OLDPWD`, `SHLVL`, `_` are skipped — these are shell-local
//!   and meaningless once propagated.
//! - On Linux/Windows this is a no-op. Linux distros launch GUI apps with
//!   the full session env most of the time; Windows installs always have
//!   the user env (HKCU\Environment).

#[cfg(target_os = "macos")]
pub(crate) fn init_login_shell_env() {
    use std::sync::mpsc;
    use std::time::Duration;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Spawn the shell read on a separate thread so we can bound it with a
    // recv_timeout. A misbehaving rc file that hangs forever shouldn't
    // freeze app startup — we just skip the enrichment and continue.
    let (tx, rx) = mpsc::channel();
    let shell_for_thread = shell.clone();
    std::thread::spawn(move || {
        let output = std::process::Command::new(&shell_for_thread)
            .args(["-l", "-c", "env"])
            .output();
        let _ = tx.send(output);
    });

    let output = match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            eprintln!("[gitwand] login shell `{}` failed to spawn: {}", shell, e);
            return;
        }
        Err(_) => {
            eprintln!(
                "[gitwand] login shell `{} -l -c env` timed out (3s) — \
                 continuing with minimal launchd env",
                shell
            );
            return;
        }
    };

    if !output.status.success() {
        eprintln!(
            "[gitwand] `{} -l -c env` exit non-zero: {}",
            shell,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return;
    }

    let env_str = String::from_utf8_lossy(&output.stdout);
    let mut imported = 0usize;
    let mut skipped_existing = 0usize;

    for line in env_str.lines() {
        let Some((key, value)) = line.split_once('=') else {
            // Skip lines that aren't KEY=VALUE (multi-line values are rare
            // in `env` output but possible — we conservatively skip).
            continue;
        };
        if key.is_empty() || key.contains('\0') {
            continue;
        }
        // Shell-local noise that should not be propagated.
        if matches!(key, "PWD" | "OLDPWD" | "SHLVL" | "_" | "SHELL") {
            continue;
        }
        // PATH is owned by `hidden_cmd` — don't let the shell rc override
        // the Homebrew enrichment logic.
        if key == "PATH" {
            continue;
        }
        // Don't overwrite anything launchd already set (HOME, USER, TMPDIR).
        if std::env::var(key).is_ok() {
            skipped_existing += 1;
            continue;
        }
        std::env::set_var(key, value);
        imported += 1;
    }

    eprintln!(
        "[gitwand] login shell env: imported {} vars, skipped {} already-set",
        imported, skipped_existing
    );

    // ─── GH_TOKEN extraction ─────────────────────────────────────
    //
    // Even with the full shell env, `gh` subprocess from a signed Tauri
    // app may hang on macOS keychain access: the keychain ACL treats
    // GitWand.app as a different application than iTerm/Terminal, and
    // the `security` helper (called by gh to retrieve the token) silently
    // waits for an authorization dialog that never gets focus.
    //
    // Workaround: run `gh auth token` once from a login shell (where the
    // keychain ACL works because the shell has been granted access
    // historically), capture the token, and inject as `GH_TOKEN` env var.
    // gh subprocess from Tauri then bypasses the keychain entirely.
    //
    // No-op if GH_TOKEN is already set (user explicitly exported it) or
    // if gh isn't installed / not authenticated. Failure is silent —
    // gh subprocess will still try keychain and fail cleanly, but we
    // don't want to fail app startup on this.
    if std::env::var("GH_TOKEN").is_err() && std::env::var("GITHUB_TOKEN").is_err() {
        extract_gh_token(&shell);
    }
    if std::env::var("GITLAB_TOKEN").is_err()
        && std::env::var("GITLAB_ACCESS_TOKEN").is_err()
        && std::env::var("OAUTH_TOKEN").is_err()
    {
        extract_glab_token(&shell);
    }
}

/// Spawn `$SHELL -l -c "gh auth token"` and propagate the result as `GH_TOKEN`.
/// Bounded by a 3s timeout. Silent on any failure path.
#[cfg(target_os = "macos")]
fn extract_gh_token(shell: &str) {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel();
    let shell_for_thread = shell.to_string();
    std::thread::spawn(move || {
        let output = std::process::Command::new(&shell_for_thread)
            .args(["-l", "-c", "gh auth token 2>/dev/null"])
            .output();
        let _ = tx.send(output);
    });

    let output = match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(o)) => o,
        Ok(Err(_)) | Err(_) => {
            eprintln!("[gitwand] gh auth token preload skipped (timeout or spawn error)");
            return;
        }
    };

    if !output.status.success() {
        // gh not installed, not authenticated, or some other issue —
        // no log noise, gh subprocess will surface its own error later.
        return;
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() || !token.starts_with("gh") {
        // Sanity check: gh tokens start with `gho_`, `ghp_`, `ghs_`, etc.
        // If the output isn't a token (auth error, weird shell init), skip.
        return;
    }

    std::env::set_var("GH_TOKEN", &token);
    eprintln!(
        "[gitwand] GH_TOKEN preloaded from login shell (length={})",
        token.len()
    );
}

/// Spawn `$SHELL -l -c "glab auth status --show-token"` and propagate the
/// parsed token as `GITLAB_TOKEN` (#149). Bounded by a 3s timeout, silent on
/// any failure path — same shape as `extract_gh_token`.
///
/// Unlike `gh auth token`, glab has no subcommand that prints a bare token;
/// `--show-token` embeds it in the multi-line `auth status` report (a line
/// containing `Token:`), so the output needs parsing via `parse_glab_token`.
#[cfg(target_os = "macos")]
fn extract_glab_token(shell: &str) {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel();
    let shell_for_thread = shell.to_string();
    std::thread::spawn(move || {
        let output = std::process::Command::new(&shell_for_thread)
            .args(["-l", "-c", "glab auth status --show-token 2>/dev/null"])
            .output();
        let _ = tx.send(output);
    });

    let output = match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(o)) => o,
        Ok(Err(_)) | Err(_) => {
            eprintln!("[gitwand] glab auth token preload skipped (timeout or spawn error)");
            return;
        }
    };

    // `glab auth status` exits non-zero when not authenticated, but can also
    // exit non-zero on some versions while still printing the token line for
    // an unrelated reason (e.g. an unreachable secondary host) — parse
    // whatever stdout we got either way, same tolerant approach as the
    // status parsing already does for other glab commands in this codebase.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(token) = parse_glab_token(&stdout) else {
        return;
    };

    std::env::set_var("GITLAB_TOKEN", &token);
    eprintln!(
        "[gitwand] GITLAB_TOKEN preloaded from login shell (length={})",
        token.len()
    );
}

/// Extract the token value from `glab auth status --show-token` output.
///
/// The token appears on a line such as `  ✓ Token: glpat-xxxxxxxxxxxxxxxxxxxx`
/// (exact checkmark/indentation varies by glab version); with `--all` or
/// multiple configured hosts there can be several such lines, in which case
/// the first one wins (current-context host is reported first). ANSI color
/// codes are stripped first since glab colors this output even when it
/// detects a non-tty stdout in some versions.
fn parse_glab_token(status_output: &str) -> Option<String> {
    for line in status_output.lines() {
        let stripped = strip_ansi_codes(line);
        let Some((_, rest)) = stripped.split_once("Token:") else {
            continue;
        };
        let token = rest.trim();
        if !token.is_empty() && !token.contains(char::is_whitespace) {
            return Some(token.to_string());
        }
    }
    None
}

/// Strip ANSI CSI escape sequences (`\x1b[...<final byte>`) from a line.
/// Minimal hand-rolled version — avoids pulling in an ansi-stripping crate
/// for a startup-only, non-hot-path parse of a few lines of CLI output.
fn strip_ansi_codes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next(); // consume '['
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break; // final byte of the CSI sequence
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod glab_token_tests {
    use super::parse_glab_token;

    #[test]
    fn extracts_token_from_a_status_line() {
        let output = "gitlab.com\n  ✓ Logged in to gitlab.com as alice (keyring)\n  ✓ Token: glpat-abcdefghijklmnopqrst\n";
        assert_eq!(
            parse_glab_token(output),
            Some("glpat-abcdefghijklmnopqrst".to_string())
        );
    }

    #[test]
    fn strips_ansi_color_codes_around_the_token() {
        let output = "\u{1b}[32m✓\u{1b}[0m Token: \u{1b}[33mglpat-zzzzzzzzzzzzzzzzzzzz\u{1b}[0m\n";
        assert_eq!(
            parse_glab_token(output),
            Some("glpat-zzzzzzzzzzzzzzzzzzzz".to_string())
        );
    }

    #[test]
    fn takes_the_first_token_line_when_multiple_hosts_are_configured() {
        let output = "gitlab.com\n  ✓ Token: glpat-firsthost0000000000\n\nself-hosted.example.com\n  ✓ Token: glpat-secondhost000000000\n";
        assert_eq!(
            parse_glab_token(output),
            Some("glpat-firsthost0000000000".to_string())
        );
    }

    #[test]
    fn returns_none_when_not_authenticated() {
        let output = "gitlab.com\n  x No token found for gitlab.com\n";
        assert_eq!(parse_glab_token(output), None);
    }

    #[test]
    fn returns_none_on_empty_output() {
        assert_eq!(parse_glab_token(""), None);
    }

    #[test]
    fn ignores_a_token_line_whose_value_is_blank() {
        let output = "  ✓ Token: \n";
        assert_eq!(parse_glab_token(output), None);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn init_login_shell_env() {
    // Linux/Windows: launchers (Gnome/KDE session manager, explorer.exe,
    // the systemd user instance, etc.) typically already provide the full
    // user env. No preload needed.
}
