//! Running a worktree's hooks (spec §4, §5.4): placeholders, environment,
//! and the trust gate. Every executor goes through
//! `assert_hooks_trusted_at`, which re-reads the main worktree's hooks and
//! returns them only if they still hash to what the user trusted; only the
//! returned strings ever run.

use super::{record, slug};
use crate::commands::terminal::{shell_invocation, SpawnKind, SpawnSpec};
use crate::commands::worktree_trust::{assert_hooks_trusted_at, main_worktree_root};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HookVars {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub base: String,
    pub repo_root: String,
}

/// The values for a linked worktree of the repo at `cwd`.
pub(crate) fn vars_for(cwd: &Path, worktree: &Path) -> Result<HookVars, String> {
    let wt = crate::commands::worktree_processes::linked_worktree(cwd, worktree)?;
    let main = main_worktree_root(&cwd.to_string_lossy())?;
    let name = wt
        .file_name()
        .and_then(|n| slug::slugify(&n.to_string_lossy()))
        .ok_or_else(|| format!("Cannot derive a worktree name from {}", wt.display()))?;
    let branch = crate::git::git_cmd()
        .args(["symbolic-ref", "--short", "-q", "HEAD"])
        .current_dir(&wt)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let base = record::common_dir(&main)
        .ok()
        .and_then(|c| record::find(&c, &wt))
        .map(|r| r.base_ref)
        .unwrap_or_default();
    Ok(HookVars {
        name,
        path: display_path(&wt),
        branch,
        base,
        repo_root: display_path(&main),
    })
}

/// How a placeholder value is made one literal argument.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuoteStyle {
    /// `'…'`, with `'` as `'\''`.
    Posix,
    /// `"…"` for `cmd.exe`. The command reaches cmd through
    /// `%GITWAND_HOOK_COMMAND%`, expanded once, so a `%` in the value is not
    /// expanded again; inside quotes `&`, `|`, `<`, `>` and `^` are literal.
    Cmd,
}

impl QuoteStyle {
    fn current() -> Self {
        if cfg!(windows) {
            QuoteStyle::Cmd
        } else {
            QuoteStyle::Posix
        }
    }
}

fn quote(s: &str, style: QuoteStyle) -> String {
    match style {
        QuoteStyle::Posix => format!("'{}'", s.replace('\'', "'\\''")),
        QuoteStyle::Cmd => format!("\"{}\"", s.replace('"', "\"\"")),
    }
}

/// `{name}` as is (its charset needs no quoting), `{path}`, `{branch}` and
/// `{base}` quoted; anything else in braces is left alone.
pub(crate) fn expand(command: &str, v: &HookVars) -> String {
    let style = QuoteStyle::current();
    if style == QuoteStyle::Cmd {
        // cmd expands `%GITWAND_HOOK_COMMAND%` once and never rescans the
        // result, so the `%VAR%`s written in the hook are expanded here,
        // from the hook's environment: the five GITWAND_* values, then what
        // the child inherits (never a stripped secret). Placeholder values
        // are inserted afterwards and stay literal.
        let hook_env = env(v);
        let lookup = |name: &str| {
            let upper = name.to_ascii_uppercase();
            if let Some(value) = hook_env.get(&upper) {
                return Some(value.clone());
            }
            if crate::types::CLAUDE_AUTH_OVERRIDE_ENV
                .iter()
                .any(|k| k.eq_ignore_ascii_case(name))
            {
                return None;
            }
            std::env::var(name).ok()
        };
        return expand_with(&expand_percent_vars(command, &lookup), v, style);
    }
    expand_with(command, v, style)
}

/// `%NAME%` → its value when `lookup` knows it; anything else stays as
/// written (cmd's rule on a command line). No `%VAR:~…%` substring forms.
pub(crate) fn expand_percent_vars(
    command: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> String {
    let mut out = String::with_capacity(command.len());
    let mut rest = command;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match (!name.is_empty()).then(|| lookup(name)).flatten() {
                    Some(value) => {
                        out.push_str(&value);
                        rest = &after[end + 1..];
                    }
                    None => {
                        out.push('%');
                        rest = after;
                    }
                }
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub(crate) fn expand_with(command: &str, v: &HookVars, style: QuoteStyle) -> String {
    let mut out = String::with_capacity(command.len());
    let mut rest = command;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(end) = after.find('}') else {
            out.push_str(after);
            return out;
        };
        let key = &after[1..end];
        match key {
            "name" => out.push_str(&v.name),
            "path" => out.push_str(&quote(&v.path, style)),
            "branch" => out.push_str(&quote(&v.branch, style)),
            "base" => out.push_str(&quote(&v.base, style)),
            _ => out.push_str(&after[..=end]),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\x` → `\\srv\x`: Windows' verbatim
/// form (what `canonicalize` returns there), which `cmd.exe` refuses as a
/// working directory and most tools mishandle. Other paths are unchanged.
pub(crate) fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    match p.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => p.to_string(),
    }
}

/// A path as hooks, records and the frontend see it.
pub(crate) fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if cfg!(windows) {
        strip_verbatim(&s)
    } else {
        s
    }
}

pub(crate) fn env(v: &HookVars) -> HashMap<String, String> {
    HashMap::from([
        ("GITWAND_WORKTREE_NAME".to_string(), v.name.clone()),
        ("GITWAND_WORKTREE_PATH".to_string(), v.path.clone()),
        ("GITWAND_WORKTREE_BRANCH".to_string(), v.branch.clone()),
        ("GITWAND_WORKTREE_BASE".to_string(), v.base.clone()),
        ("GITWAND_REPO_ROOT".to_string(), v.repo_root.clone()),
    ])
}

/// The hooks a worktree operation may run, if the trust gate passes.
fn gate(
    cwd: &Path,
    hash: &str,
    store: &Path,
) -> Result<crate::commands::worktree_trust::WorktreeHooks, String> {
    assert_hooks_trusted_at(&cwd.to_string_lossy(), hash, store)
}

/// The PTY session that runs `setup` for `worktree`, or why it may not.
pub(crate) fn setup_spec(
    cwd: &Path,
    worktree: &Path,
    hash: &str,
    store: &Path,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<SpawnSpec, String> {
    let hooks = gate(cwd, hash, store)?;
    let setup = hooks
        .setup
        .ok_or_else(|| "This repository defines no setup hook.".to_string())?;
    let vars = vars_for(cwd, worktree)?;
    Ok(SpawnSpec {
        cwd: PathBuf::from(&vars.path),
        kind: SpawnKind::Command {
            command: expand(&setup, &vars),
            shell,
        },
        env: env(&vars),
        cols,
        rows,
    })
}

/// Runs a command line through the user's shell in `cwd` and returns the
/// first non-empty line of its output, killing it after `timeout`.
pub(crate) fn run_captured(
    command: &str,
    vars: &HookVars,
    shell: Option<String>,
    timeout: Duration,
) -> Result<Option<String>, String> {
    let (program, args, extra) = shell_invocation(&shell, command);
    let mut cmd = std::process::Command::new(program);
    cmd.args(&args)
        .envs(extra)
        .current_dir(&vars.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for var in crate::types::CLAUDE_AUTH_OVERRIDE_ENV {
        cmd.env_remove(var);
    }
    #[cfg(target_os = "macos")]
    if let Some(extra) = crate::git::macos_enriched_path() {
        cmd.env("PATH", extra);
    }
    cmd.envs(env(vars));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // so a timeout kills what it started too
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot run the hook: {e}"))?;
    let read_all = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_string(&mut s);
            }
            s
        })
    };
    let out = read_all(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err = read_all(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                #[cfg(unix)]
                if let Ok(pgid) = libc::pid_t::try_from(child.id()) {
                    // SAFETY: signals the group this child leads (process_group(0)).
                    unsafe {
                        libc::kill(-pgid, libc::SIGKILL);
                    }
                }
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let Some(status) = status else {
        return Err(format!(
            "The url hook timed out after {} s.",
            timeout.as_secs()
        ));
    };
    let stdout = out.join().unwrap_or_default();
    if !status.success() {
        let stderr = err.join().unwrap_or_default();
        let tail: Vec<&str> = stderr.lines().rev().take(5).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        return Err(format!(
            "The url hook failed ({status}): {}",
            tail.join("\n").trim()
        ));
    }
    Ok(stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string))
}

/// `url` for `worktree`, if the repo defines one and the gate passes.
pub(crate) fn url_for(
    cwd: &Path,
    worktree: &Path,
    hash: &str,
    store: &Path,
    shell: Option<String>,
    timeout: Duration,
) -> Result<Option<String>, String> {
    let hooks = gate(cwd, hash, store)?;
    let Some(url) = hooks.url else {
        return Ok(None);
    };
    let vars = vars_for(cwd, worktree)?;
    run_captured(&expand(&url, &vars), &vars, shell, timeout)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::commands::terminal::{event_sinks, spawn_session, TerminalEvent};
    use crate::commands::worktree_trust::{hooks_from_rc_text, hooks_hash, save_store};
    use crate::worktree::create::{create_worktree, CreateRequest};
    use crate::worktree::record::Kind;
    use crate::worktree::test_support::TempRepo;
    use std::sync::{Arc, Mutex};

    fn vars(path: &str) -> HookVars {
        HookVars {
            name: "n".into(),
            path: path.into(),
            branch: "task/n".into(),
            base: "origin/main".into(),
            repo_root: "/r".into(),
        }
    }

    #[test]
    fn expand_quotes_hostile_values() {
        let hostile = "/tmp/a b/it's $(x);y \"q\"";
        let cmd = expand("printf %s {path}", &vars(hostile));
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &cmd])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), hostile);
        assert_eq!(expand("x {name} {other} {", &vars("/p")), "x n {other} {");
    }

    #[test]
    fn cmd_quoting_keeps_values_literal() {
        let v = HookVars {
            name: "n".into(),
            path: r"C:\Users\John Doe\r.worktrees\x".into(),
            branch: "feat/100%done".into(),
            base: "origin/main".into(),
            repo_root: r"C:\r".into(),
        };
        assert_eq!(
            expand_with("up {path} {branch} {name}", &v, QuoteStyle::Cmd),
            r#"up "C:\Users\John Doe\r.worktrees\x" "feat/100%done" n"#
        );
    }

    /// cmd expands `%GITWAND_HOOK_COMMAND%` once and never rescans it, so
    /// the `%VAR%`s the user wrote are expanded by GitWand, from the hook's
    /// environment; unknown names stay literal, as on a cmd command line.
    #[test]
    fn cmd_vars_written_in_the_hook_are_expanded() {
        let lookup = |k: &str| match k.to_ascii_uppercase().as_str() {
            "GITWAND_WORKTREE_PATH" => Some(r"C:\w\x".to_string()),
            "USERPROFILE" => Some(r"C:\Users\me".to_string()),
            _ => None,
        };
        assert_eq!(
            expand_percent_vars(
                r"cd %GITWAND_WORKTREE_PATH% && copy %userprofile%\.npmrc . %NOPE% 100%",
                &lookup
            ),
            r"cd C:\w\x && copy C:\Users\me\.npmrc . %NOPE% 100%"
        );
    }

    #[test]
    fn cmd_invocation_never_puts_the_command_on_the_command_line() {
        let (program, args, env) =
            crate::commands::terminal::cmd_invocation(r#"bin\up "a b" & echo %X%"#);
        assert_eq!(program, "cmd");
        assert_eq!(args, vec!["/D", "/C", "%GITWAND_HOOK_COMMAND%"]);
        assert_eq!(
            env,
            vec![(
                "GITWAND_HOOK_COMMAND".to_string(),
                r#"bin\up "a b" & echo %X%"#.to_string()
            )]
        );
    }

    #[test]
    fn verbatim_prefix_is_stripped() {
        assert_eq!(strip_verbatim(r"\\?\C:\a\b"), r"C:\a\b");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(strip_verbatim("/tmp/a"), "/tmp/a");
    }

    /// A repo with `rc` as `.gitwandrc`, a task worktree, and a store that
    /// trusts the hooks. Returns (repo, worktree path, hash, store).
    fn trusted(rc: &str) -> (TempRepo, PathBuf, String, PathBuf) {
        let repo = TempRepo::new();
        repo.write(".gitwandrc", rc);
        let c = create_worktree(
            &repo.path,
            CreateRequest {
                name: "Hook Test".into(),
                base: None,
                branch: None,
                path: None,
                kind: Kind::Task,
            },
            Duration::from_secs(20),
        )
        .unwrap();
        let hash = hooks_hash(&hooks_from_rc_text(rc)).unwrap();
        let store = repo.sandbox.join("trust.json");
        let root = main_worktree_root(&repo.path.to_string_lossy()).unwrap();
        save_store(
            &store,
            &HashMap::from([(root.to_string_lossy().to_string(), hash.clone())]),
        )
        .unwrap();
        (repo, PathBuf::from(c.path), hash, store)
    }

    #[test]
    fn run_hook_refuses_stale_hash() {
        let (repo, wt, hash, store) = trusted(r#"{"worktree":{"setup":"true"}}"#);
        let other =
            hooks_hash(&hooks_from_rc_text(r#"{"worktree":{"setup":"rm -rf /"}}"#)).unwrap();
        assert!(setup_spec(&repo.path, &wt, &other, &store, None, 80, 24).is_err());
        // Rewritten after trust: the trusted hash no longer matches.
        repo.write(".gitwandrc", r#"{"worktree":{"setup":"echo changed"}}"#);
        assert!(setup_spec(&repo.path, &wt, &hash, &store, None, 80, 24).is_err());
    }

    #[test]
    fn setup_runs_in_worktree_with_env() {
        let (repo, wt, hash, store) = trusted(
            r#"{"worktree":{"setup":"pwd; echo N=$GITWAND_WORKTREE_NAME {branch}; exit 4"}}"#,
        );
        let spec = setup_spec(
            &repo.path,
            &wt,
            &hash,
            &store,
            Some("/bin/sh".into()),
            200,
            24,
        )
        .unwrap();
        let out = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&out);
        let (tx, rx) = std::sync::mpsc::channel();
        let (on_chunk, on_exit) = event_sinks(move |e| {
            match e {
                TerminalEvent::Chunk { data } => sink.lock().unwrap().push_str(&data),
                TerminalEvent::Exit { code } => {
                    let _ = tx.send(code);
                }
            }
            true
        });
        spawn_session(spec, on_chunk, on_exit).unwrap();
        let code = rx.recv_timeout(Duration::from_secs(10)).expect("no exit");
        let out = out.lock().unwrap().clone();
        assert!(out.contains(&wt.to_string_lossy().to_string()), "{out:?}");
        assert!(out.contains("N=hook-test task/hook-test"), "{out:?}");
        assert_eq!(code, Some(4));
    }

    #[test]
    fn url_returns_first_non_empty_line() {
        let (repo, wt, hash, store) =
            trusted(r#"{"worktree":{"url":"printf '\\n  http://x/{name} \\nmore'"}}"#);
        let url = url_for(
            &repo.path,
            &wt,
            &hash,
            &store,
            Some("/bin/sh".into()),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(url.as_deref(), Some("http://x/hook-test"));
    }

    #[test]
    fn url_times_out() {
        let (repo, wt, hash, store) = trusted(r#"{"worktree":{"url":"sleep 30"}}"#);
        let started = Instant::now();
        let err = url_for(
            &repo.path,
            &wt,
            &hash,
            &store,
            Some("/bin/sh".into()),
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
