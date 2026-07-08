//! v3.5.0 — Rust secrets scanning engine (production desktop path).
//!
//! Mirrors `packages/core/src/secrets/scanner.ts` + `patterns.ts` exactly — regex bodies,
//! entropy math, redaction, and ignore semantics must stay in sync. The parity test
//! (`apps/desktop/tests/parity/scan-secrets.test.mjs`) is the drift lock; if Rust and the TS
//! engine disagree on a fixture, fix the engine that is wrong, never weaken the fixture.
//!
//! `scan_lines` is a pure function kept separate from the async `#[tauri::command]` (added in
//! Task 5) so it is unit-testable without a Tokio runtime — same split as `build_repo_tree` in
//! `commands/files.rs`.

use regex::Regex;

use crate::git::cmd::git_cmd;
use crate::types::{SecretFinding, SecretsScanConfig};

/// Cap on returned findings — see apps/desktop/CLAUDE.md P6.4 "IPC payloads" rule.
const MAX_FINDINGS: usize = 500;

/// v3.5.0 (D5) — Generated-file globs ignored by DEFAULT, regardless of `config.ignore`. Without
/// this, a routine `pnpm install` lockfile bump (`integrity: sha512-…`) trips a `high_entropy`
/// finding on nearly every real commit. Always applied on top of the user's `.gitwandrc`
/// `secrets.ignore[]` entries (additive, never replaced). EXACT MIRROR of the TS
/// `DEFAULT_IGNORE_GLOBS` in `packages/core/src/secrets/scanner.ts` — locked by the parity test
/// (`scan-secrets.test.mjs`). Any change to this list must be reflected on both sides.
const DEFAULT_IGNORE_GLOBS: &[&str] = &[
    "*.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
    "*.min.js",
    "*.min.css",
    "dist/**",
    "build/**",
    "node_modules/**",
    "*.map",
];

/// Minimum token length submitted to the entropy pass.
const MIN_ENTROPY_TOKEN_LENGTH: usize = 20;

/// One added line, already extracted from a staged diff.
pub(crate) struct ScanLine {
    pub line: u32,
    pub text: String,
}

/// One file's added lines, already extracted from `git diff --cached`.
pub(crate) struct ScanFileInput {
    pub path: String,
    pub added_lines: Vec<ScanLine>,
}

struct BuiltInPattern {
    id: &'static str,
    regex: &'static str,
    severity: &'static str,
    #[allow(dead_code)] // kept for parity with the TS catalog; not surfaced over IPC yet
    description: &'static str,
}

/// Built-in detector catalog. MUST mirror `packages/core/src/secrets/patterns.ts`
/// `BUILT_IN_PATTERNS` id-for-id and regex-for-regex.
const BUILT_IN_PATTERNS: &[BuiltInPattern] = &[
    BuiltInPattern {
        id: "aws_access_key_id",
        regex: r"\bAKIA[0-9A-Z]{16}\b",
        severity: "high",
        description: "AWS access key ID",
    },
    BuiltInPattern {
        id: "aws_secret_access_key",
        regex: r"(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*['\x22]?[A-Za-z0-9/+]{40}['\x22]?",
        severity: "high",
        description: "AWS secret access key",
    },
    BuiltInPattern {
        id: "gcp_api_key",
        regex: r"\bAIza[0-9A-Za-z_-]{35}\b",
        severity: "high",
        description: "GCP API key",
    },
    BuiltInPattern {
        id: "azure_storage_account_key",
        regex: r"AccountKey=[A-Za-z0-9+/]{20,}==",
        severity: "high",
        description: "Azure storage account key",
    },
    BuiltInPattern {
        id: "azure_client_secret",
        regex: r"(?:client_secret|AZURE_CLIENT_SECRET)\s*[:=]\s*['\x22]?[A-Za-z0-9_.~-]{34,}['\x22]?",
        severity: "medium",
        description: "Azure client secret",
    },
    BuiltInPattern {
        id: "github_pat_classic",
        regex: r"\bghp_[A-Za-z0-9]{36}\b",
        severity: "high",
        description: "GitHub personal access token (classic)",
    },
    BuiltInPattern {
        id: "github_pat_fine_grained",
        regex: r"\bgithub_pat_[A-Za-z0-9_]{22,}\b",
        severity: "high",
        description: "GitHub fine-grained personal access token",
    },
    BuiltInPattern {
        id: "gitlab_pat",
        regex: r"\bglpat-[A-Za-z0-9_-]{20}\b",
        severity: "high",
        description: "GitLab personal access token",
    },
    BuiltInPattern {
        id: "slack_token",
        regex: r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b",
        severity: "high",
        description: "Slack token",
    },
    BuiltInPattern {
        id: "stripe_live_key",
        regex: r"\bsk_live_[0-9A-Za-z]{24,}\b",
        severity: "high",
        description: "Stripe live secret key",
    },
    BuiltInPattern {
        id: "openai_api_key",
        regex: r"\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b",
        severity: "high",
        description: "OpenAI API key",
    },
    BuiltInPattern {
        id: "anthropic_api_key",
        regex: r"\bsk-ant-[A-Za-z0-9_-]{20,}\b",
        severity: "high",
        description: "Anthropic API key",
    },
    BuiltInPattern {
        id: "private_key_header",
        regex: r"-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----",
        severity: "high",
        description: "Private key header (RSA/EC/OpenSSH/PGP)",
    },
    BuiltInPattern {
        id: "jwt",
        regex: r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
        severity: "medium",
        description: "JSON Web Token",
    },
];

/// Pure, synchronously-testable core scanner. Mirrors `scanSecrets` in
/// `packages/core/src/secrets/scanner.ts`.
pub(crate) fn scan_lines(files: &[ScanFileInput], config: &SecretsScanConfig) -> Vec<SecretFinding> {
    if !config.enabled {
        return Vec::new();
    }

    // Built-ins always apply; user `.gitwandrc` entries are additive on top, never a replacement.
    let effective_ignore: Vec<String> = DEFAULT_IGNORE_GLOBS
        .iter()
        .map(|s| s.to_string())
        .chain(config.ignore.iter().cloned())
        .collect();

    // Compile built-in + user patterns once. A malformed user regex is skipped, never fatal —
    // `regex` is linear-time so it can't hang the app, but we still don't trust arbitrary
    // user-supplied syntax to compile cleanly.
    let mut compiled: Vec<(String, Regex, String)> = Vec::new();
    for p in BUILT_IN_PATTERNS {
        if let Ok(re) = Regex::new(p.regex) {
            compiled.push((p.id.to_string(), re, p.severity.to_string()));
        }
    }
    for p in &config.extra_patterns {
        if let Ok(re) = Regex::new(&p.regex) {
            compiled.push((p.id.clone(), re, p.severity.clone()));
        }
    }

    let entropy_token_re = Regex::new(r"[A-Za-z0-9+/=_-]+").expect("static regex must compile");

    let mut findings: Vec<SecretFinding> = Vec::new();

    for file in files {
        for line in &file.added_lines {
            let mut matched_ranges: Vec<(usize, usize)> = Vec::new();

            for (id, re, severity) in &compiled {
                for m in re.find_iter(&line.text) {
                    let value = m.as_str();
                    if value.is_empty() {
                        continue;
                    }
                    matched_ranges.push((m.start(), m.end()));
                    if !is_ignored(&file.path, value, &effective_ignore) {
                        findings.push(SecretFinding {
                            file: file.path.clone(),
                            line: line.line,
                            pattern_id: id.clone(),
                            severity: severity.clone(),
                            redacted_excerpt: redact(value),
                        });
                    }
                }
            }

            if config.entropy_threshold > 0.0 {
                for m in entropy_token_re.find_iter(&line.text) {
                    let token = m.as_str();
                    if token.len() < MIN_ENTROPY_TOKEN_LENGTH {
                        continue;
                    }
                    let overlaps = matched_ranges
                        .iter()
                        .any(|&(s, e)| m.start() < e && m.end() > s);
                    if overlaps {
                        continue;
                    }
                    if shannon_entropy(token) >= config.entropy_threshold
                        && !is_ignored(&file.path, token, &effective_ignore)
                    {
                        findings.push(SecretFinding {
                            file: file.path.clone(),
                            line: line.line,
                            pattern_id: "high_entropy".to_string(),
                            severity: "low".to_string(),
                            redacted_excerpt: redact(token),
                        });
                    }
                }
            }
        }
    }

    findings.truncate(MAX_FINDINGS);
    findings
}

/// Shannon entropy in bits/char.
fn shannon_entropy(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    let mut freq: std::collections::HashMap<char, usize> = std::collections::HashMap::new();
    let mut len = 0usize;
    for ch in s.chars() {
        *freq.entry(ch).or_insert(0) += 1;
        len += 1;
    }
    let mut entropy = 0.0;
    for count in freq.values() {
        let p = *count as f64 / len as f64;
        entropy -= p * p.log2();
    }
    entropy
}

/// Masks a matched value: ≤3 leading + `…` + ≤3 trailing chars. For short matches, where
/// revealing 3+3 chars would expose (nearly) the whole value, mask it fully instead. The raw
/// value is NEVER returned — see AGENTS.md "never log secrets".
fn redact(value: &str) -> String {
    const VISIBLE_EDGE: usize = 3;
    const MIN_LENGTH_FOR_PARTIAL_REVEAL: usize = 12;

    let chars: Vec<char> = value.chars().collect();
    if chars.len() < MIN_LENGTH_FOR_PARTIAL_REVEAL {
        return "*".repeat(chars.len());
    }
    let lead: String = chars[..VISIBLE_EDGE].iter().collect();
    let trail: String = chars[chars.len() - VISIBLE_EDGE..].iter().collect();
    format!("{}\u{2026}{}", lead, trail)
}

/// `true` if the matched value or file should be ignored, per `.gitwandrc` `secrets.ignore[]`.
/// A `/.../ ` entry is a regex literal tested against the matched value; anything else is a path
/// glob tested against `path` (mirrors `matchGlob` in `packages/core/src/config.ts`).
fn is_ignored(path: &str, value: &str, ignore: &[String]) -> bool {
    for entry in ignore {
        if entry.len() >= 2 && entry.starts_with('/') && entry.ends_with('/') {
            let body = &entry[1..entry.len() - 1];
            if let Ok(re) = Regex::new(body) {
                if re.is_match(value) {
                    return true;
                }
            }
            continue;
        }
        if match_glob(entry, path) {
            return true;
        }
    }
    false
}

/// Minimal glob matcher — mirrors `matchGlob` in `packages/core/src/config.ts`.
/// Supports `*` (any char but `/`), `**` (any char), `?` (one char but `/`), and basename
/// matching when the pattern has no `/`.
fn match_glob(pattern: &str, file_path: &str) -> bool {
    let normalized_path = file_path.replace('\\', "/");
    let normalized_pattern = pattern.replace('\\', "/");

    if !normalized_pattern.contains('/') {
        let basename = normalized_path.rsplit('/').next().unwrap_or(&normalized_path);
        return glob_regex(&normalized_pattern).is_match(basename);
    }

    glob_regex(&normalized_pattern).is_match(&normalized_path)
}

fn glob_regex(pattern: &str) -> Regex {
    const DSTAR_PLACEHOLDER: &str = "\u{0}DSTAR\u{0}";

    let mut escaped = String::with_capacity(pattern.len() * 2);
    for ch in pattern.chars() {
        match ch {
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }

    let replaced = escaped
        .replace("**", DSTAR_PLACEHOLDER)
        .replace('*', "[^/]*")
        .replace('?', "[^/]")
        .replace(DSTAR_PLACEHOLDER, ".*");

    Regex::new(&format!("^{}$", replaced)).unwrap_or_else(|_| Regex::new("$^").expect("literal never-match regex must compile"))
}

// ─── Git extraction + Tauri command wiring ──────────────────────────

/// Extracts `ScanFileInput`s from the currently staged diff. Only `+`-prefixed content lines are
/// kept (never the `+++` header, never context/removed lines) — see AGENTS.md's diff-parsing
/// gotcha. Git is confined to `cwd` via `.current_dir()`; no path is joined on the filesystem, so
/// `safe_repo_path()` does not apply here (same reasoning as the existing `git_diff` command).
fn extract_staged_added_lines(cwd: &str) -> Result<Vec<ScanFileInput>, String> {
    fn flush(
        files: &mut Vec<ScanFileInput>,
        current_path: &mut Option<String>,
        current_lines: &mut Vec<ScanLine>,
    ) {
        if let Some(path) = current_path.take() {
            if !current_lines.is_empty() {
                files.push(ScanFileInput {
                    path,
                    added_lines: std::mem::take(current_lines),
                });
                return;
            }
        }
        current_lines.clear();
    }

    let output = git_cmd()
        .args(["diff", "--cached", "--unified=0", "--no-color", "--", "."])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git diff --cached: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git diff --cached failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut files: Vec<ScanFileInput> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_lines: Vec<ScanLine> = Vec::new();
    let mut new_line_no: u32 = 0;

    for line in stdout.lines() {
        if line.starts_with("diff --git ") {
            flush(&mut files, &mut current_path, &mut current_lines);
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            // "+++ b/<path>" for a file with new-side content, "+++ /dev/null" for a deletion.
            current_path = if rest == "/dev/null" {
                None
            } else {
                Some(rest.strip_prefix("b/").unwrap_or(rest).to_string())
            };
        } else if line.starts_with("@@") {
            // "@@ -oldStart,oldCount +newStart,newCount @@" — only the new-side start matters,
            // since we only ever record `+` lines.
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                let new_range = parts[2].strip_prefix('+').unwrap_or("0");
                new_line_no = if let Some(comma_idx) = new_range.find(',') {
                    new_range[..comma_idx].parse().unwrap_or(0)
                } else {
                    new_range.parse().unwrap_or(0)
                };
            }
        } else if line.starts_with('+') && !line.starts_with("+++") {
            // A content added line starts with a single `+`; the file header is `+++ ` —
            // distinguished above by parsing state, not by this check alone (AGENTS.md gotcha).
            if current_path.is_some() {
                current_lines.push(ScanLine {
                    line: new_line_no,
                    text: line[1..].to_string(),
                });
            }
            new_line_no += 1;
        }
        // `-`-prefixed removed lines and (irrelevant here, since --unified=0) context lines are
        // not part of the added-lines-only scan surface.
    }

    flush(&mut files, &mut current_path, &mut current_lines);

    Ok(files)
}

/// Pure(-ish) core of `scan_secrets`, kept sync + separate from the `async` command so it is
/// unit-testable without a Tokio runtime.
pub(crate) fn scan_staged(cwd: &str, config: &SecretsScanConfig) -> Result<Vec<SecretFinding>, String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }
    if !config.enabled {
        return Ok(Vec::new());
    }
    let files = extract_staged_added_lines(cwd)?;
    Ok(scan_lines(&files, config))
}

#[tauri::command]
pub(crate) async fn scan_secrets(cwd: String, config: SecretsScanConfig) -> Result<Vec<SecretFinding>, String> {
    scan_staged(&cwd, &config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SecretPatternInput;

    fn base_config() -> SecretsScanConfig {
        SecretsScanConfig {
            enabled: true,
            extra_patterns: Vec::new(),
            ignore: Vec::new(),
            entropy_threshold: 0.0,
        }
    }

    fn file_with(path: &str, lines: &[&str]) -> ScanFileInput {
        ScanFileInput {
            path: path.to_string(),
            added_lines: lines
                .iter()
                .enumerate()
                .map(|(i, text)| ScanLine {
                    line: (i + 1) as u32,
                    text: text.to_string(),
                })
                .collect(),
        }
    }

    // ─── One matching line + one near-miss per built-in id ──────────

    struct Case {
        id: &'static str,
        positive: &'static str,
        near_miss: &'static str,
    }

    const CASES: &[Case] = &[
        Case { id: "aws_access_key_id", positive: "const key = \"AKIAABCDEFGHIJKLMNOP\";", near_miss: "const key = \"AKIASHORT\";" },
        Case { id: "aws_secret_access_key", positive: "aws_secret_access_key = \"AAAA0000BBBB1111CCCC2222DDDD3333EEEE4444\"", near_miss: "secret = \"AAAA0000BBBB1111CCCC2222DDDD3333EEEE4444\"" },
        Case { id: "gcp_api_key", positive: "const apiKey = \"AIzaABCDEFGABCDEFGABCDEFGABCDEFGABCDEFG\";", near_miss: "const apiKey = \"AIzaSHORT\";" },
        Case { id: "azure_storage_account_key", positive: "DefaultEndpointsProtocol=https;AccountName=mystore;AccountKey=AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH==;EndpointSuffix=core.windows.net", near_miss: "AccountKey=short==" },
        Case { id: "azure_client_secret", positive: "AZURE_CLIENT_SECRET=\"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789~7\"", near_miss: "client_secret = \"short\"" },
        Case { id: "github_pat_classic", positive: "const t = \"ghp_ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEF\";", near_miss: "const t = \"ghp_short\";" },
        Case { id: "github_pat_fine_grained", positive: "const t = \"github_pat_AAAAAAAAAAAAAAAAAAAAAAAAA\";", near_miss: "const t = \"github_pat_short\";" },
        Case { id: "gitlab_pat", positive: "const t = \"glpat-ABCDEFGHIJ0123456789\";", near_miss: "const t = \"glpat-short\";" },
        Case { id: "slack_token", positive: "const t = \"xoxb-1234567890abcdef\";", near_miss: "const t = \"xoxb-123\";" },
        Case { id: "stripe_live_key", positive: "const k = \"sk_live_ABCDEFGHIJKLMNOPQRSTUVWX\";", near_miss: "const k = \"sk_live_short\";" },
        Case { id: "openai_api_key", positive: "const k = \"sk-ABCDEFGHIJKLMNOPQRSTUVWX\";", near_miss: "const k = \"sk-short\";" },
        Case { id: "anthropic_api_key", positive: "const k = \"sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ\";", near_miss: "const k = \"sk-ant-short\";" },
        Case { id: "private_key_header", positive: "-----BEGIN RSA PRIVATE KEY-----", near_miss: "-----BEGIN CERTIFICATE-----" },
        Case { id: "jwt", positive: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123SIGNATURE_-", near_miss: "eyJhbGciOiJIUzI1NiJ9" },
    ];

    #[test]
    fn every_built_in_matches_its_positive_fixture_and_rejects_its_near_miss() {
        for case in CASES {
            let files = [file_with("src/x.ts", &[case.positive])];
            let findings = scan_lines(&files, &base_config());
            assert!(
                findings.iter().any(|f| f.pattern_id == case.id),
                "expected pattern {} to match positive fixture: {}",
                case.id,
                case.positive
            );

            let files = [file_with("src/x.ts", &[case.near_miss])];
            let findings = scan_lines(&files, &base_config());
            assert!(
                !findings.iter().any(|f| f.pattern_id == case.id),
                "expected pattern {} to NOT match near-miss fixture: {}",
                case.id,
                case.near_miss
            );
        }
    }

    #[test]
    fn detects_a_user_extra_pattern() {
        let files = [file_with("src/x.ts", &["const t = \"itok_deadbeefdeadbeef\";"])];
        let mut config = base_config();
        config.extra_patterns.push(SecretPatternInput {
            id: "internal_token".to_string(),
            regex: "itok_[0-9a-f]{16}".to_string(),
            severity: "high".to_string(),
            description: String::new(),
        });
        let findings = scan_lines(&files, &config);
        assert!(findings.iter().any(|f| f.pattern_id == "internal_token"));
    }

    #[test]
    fn a_malformed_user_regex_is_skipped_not_fatal() {
        let files = [file_with("src/x.ts", &["hello world"])];
        let mut config = base_config();
        config.extra_patterns.push(SecretPatternInput {
            id: "bad".to_string(),
            regex: "(unterminated[".to_string(),
            severity: "high".to_string(),
            description: String::new(),
        });
        // Must not panic.
        let findings = scan_lines(&files, &config);
        assert!(findings.is_empty());
    }

    #[test]
    fn an_ignore_glob_suppresses_findings_on_a_matching_path() {
        let files = [file_with("fixtures/sample.ts", &["const key = \"AKIAABCDEFGHIJKLMNOP\";"])];
        let mut config = base_config();
        config.ignore.push("fixtures/**".to_string());
        let findings = scan_lines(&files, &config);
        assert!(findings.is_empty());
    }

    #[test]
    fn an_ignore_value_regex_suppresses_a_specific_value() {
        let files = [file_with("src/x.ts", &["const key = \"AKIAABCDEFGHIJKLMNOP\";"])];
        let mut config = base_config();
        config.ignore.push("/AKIAABCDEFGHIJKLMNOP/".to_string());
        let findings = scan_lines(&files, &config);
        assert!(findings.is_empty());
    }

    #[test]
    fn ignore_does_not_suppress_unrelated_path_or_value() {
        let files = [file_with("src/x.ts", &["const key = \"AKIAABCDEFGHIJKLMNOP\";"])];
        let mut config = base_config();
        config.ignore.push("other/**".to_string());
        config.ignore.push("/NOTTHEKEY/".to_string());
        let findings = scan_lines(&files, &config);
        assert_eq!(findings.len(), 1);
    }

    // ─── Default generated-file ignore globs (D5) ────────────────────

    const HIGH_ENTROPY_LINE: &str = "  integrity: sha512-aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY1zA3bC5dE7fG9==";

    #[test]
    fn does_not_flag_a_pnpm_lock_integrity_hash_at_the_default_entropy_threshold() {
        let files = [file_with("pnpm-lock.yaml", &[HIGH_ENTROPY_LINE])];
        let mut config = base_config();
        config.entropy_threshold = 4.0;
        let findings = scan_lines(&files, &config);
        assert!(findings.is_empty());
    }

    #[test]
    fn still_flags_the_same_high_entropy_content_in_a_non_excluded_file() {
        let files = [file_with("src/config.ts", &[HIGH_ENTROPY_LINE])];
        let mut config = base_config();
        config.entropy_threshold = 4.0;
        let findings = scan_lines(&files, &config);
        assert!(findings.iter().any(|f| f.pattern_id == "high_entropy"));
    }

    #[test]
    fn suppresses_common_lockfiles_and_build_output_by_default() {
        let paths = [
            "package-lock.json",
            "pnpm-lock.yaml",
            "yarn.lock",
            "Cargo.lock",
            "vendor/foo.lock",
            "assets/app.min.js",
            "assets/app.min.css",
            "dist/bundle.js",
            "build/output.js",
            "node_modules/pkg/index.js",
            "coverage/lcov.info.map",
        ];
        for path in paths {
            let files = [file_with(path, &[HIGH_ENTROPY_LINE])];
            let mut config = base_config();
            config.entropy_threshold = 4.0;
            let findings = scan_lines(&files, &config);
            assert!(findings.is_empty(), "expected {} to be ignored by default", path);
        }
    }

    #[test]
    fn user_supplied_ignore_entries_are_additive_on_top_of_the_built_in_defaults() {
        let mut config = base_config();
        config.entropy_threshold = 4.0;
        config.ignore.push("custom/**".to_string());

        let custom_files = [file_with("custom/ignored.ts", &[HIGH_ENTROPY_LINE])];
        assert!(scan_lines(&custom_files, &config).is_empty());

        // The built-in lockfile default still applies even with a non-empty user ignore list.
        let lock_files = [file_with("pnpm-lock.yaml", &[HIGH_ENTROPY_LINE])];
        assert!(scan_lines(&lock_files, &config).is_empty());
    }

    #[test]
    fn entropy_pass_finds_a_high_entropy_token_when_threshold_enabled() {
        let files = [file_with(
            "src/x.ts",
            &["const token = \"aZ3xQ9mK2pL7vN5wR8tY1cB4fH6jD0sE2gU9iO3k\";"],
        )];
        let mut config = base_config();
        config.entropy_threshold = 4.0;
        let findings = scan_lines(&files, &config);
        assert!(findings.iter().any(|f| f.pattern_id == "high_entropy" && f.severity == "low"));
    }

    #[test]
    fn entropy_pass_does_not_flag_a_long_hex_git_sha_above_hex_max_entropy() {
        let files = [file_with(
            "src/x.ts",
            &["commit deadbeefcafe0123456789abcdef01234567deadbeefcafe0123456789"],
        )];
        let mut config = base_config();
        config.entropy_threshold = 4.5;
        let findings = scan_lines(&files, &config);
        assert!(!findings.iter().any(|f| f.pattern_id == "high_entropy"));
    }

    #[test]
    fn entropy_pass_does_not_double_report_a_regex_covered_token() {
        let files = [file_with("src/x.ts", &["const key = \"AKIAABCDEFGHIJKLMNOP\";"])];
        let mut config = base_config();
        config.entropy_threshold = 3.0;
        let findings = scan_lines(&files, &config);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].pattern_id, "aws_access_key_id");
    }

    #[test]
    fn redaction_never_equals_the_raw_planted_value() {
        let secret = "AKIAABCDEFGHIJKLMNOP";
        let files = [file_with("src/x.ts", &[&format!("const key = \"{}\";", secret)])];
        let findings = scan_lines(&files, &base_config());
        for f in &findings {
            assert_ne!(f.redacted_excerpt, secret);
            assert!(!f.redacted_excerpt.contains(secret));
        }
    }

    #[test]
    fn enabled_false_returns_empty() {
        let files = [file_with("src/x.ts", &["const key = \"AKIAABCDEFGHIJKLMNOP\";"])];
        let mut config = base_config();
        config.enabled = false;
        let findings = scan_lines(&files, &config);
        assert!(findings.is_empty());
    }

    #[test]
    fn caps_total_findings_at_500() {
        let lines: Vec<String> = (0..600)
            .map(|i| format!("const key{} = \"AKIAABCDEFGHIJKLMNOP\";", i))
            .collect();
        let line_refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        let files = [file_with("src/x.ts", &line_refs)];
        let findings = scan_lines(&files, &base_config());
        assert_eq!(findings.len(), 500);
    }

    // ─── scan_staged: real temp-repo integration tests (Task 5) ─────

    mod scan_staged_tests {
        use super::super::*;
        use super::base_config;
        use std::path::PathBuf;
        use std::process::Command as StdCommand;
        use std::sync::atomic::{AtomicU64, Ordering};

        static COUNTER: AtomicU64 = AtomicU64::new(0);

        struct TempRepo {
            path: PathBuf,
        }

        impl Drop for TempRepo {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }

        impl TempRepo {
            fn new(label: &str) -> Self {
                let n = COUNTER.fetch_add(1, Ordering::SeqCst);
                let pid = std::process::id();
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let dir = std::env::temp_dir()
                    .join(format!("gitwand-secrets-test-{}-{}-{}-{}", label, pid, n, nanos));
                std::fs::create_dir_all(&dir).unwrap();
                let repo = TempRepo { path: dir };
                repo.git(&["init", "-q"]);
                repo.git(&["config", "user.email", "test@gitwand.dev"]);
                repo.git(&["config", "user.name", "GitWand Test"]);
                repo
            }

            fn cwd(&self) -> String {
                self.path.to_string_lossy().to_string()
            }

            fn write(&self, rel: &str, content: &str) {
                let p = self.path.join(rel);
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent).unwrap();
                }
                std::fs::write(p, content).unwrap();
            }

            fn git(&self, args: &[&str]) {
                let status = StdCommand::new("git")
                    .args(args)
                    .current_dir(&self.path)
                    .status()
                    .unwrap();
                assert!(status.success(), "git {:?} failed", args);
            }
        }

        #[test]
        fn finds_a_secret_on_a_newly_staged_added_line() {
            let repo = TempRepo::new("basic");
            repo.write("src/config.ts", "const key = \"AKIAABCDEFGHIJKLMNOP\";\n");
            repo.write("src/benign.ts", "export const x = 1;\n");
            repo.git(&["add", "src/config.ts", "src/benign.ts"]);

            let findings = scan_staged(&repo.cwd(), &base_config()).unwrap();

            assert_eq!(findings.len(), 1);
            assert_eq!(findings[0].pattern_id, "aws_access_key_id");
            assert_eq!(findings[0].file, "src/config.ts");
            assert_eq!(findings[0].line, 1);
            assert_ne!(findings[0].redacted_excerpt, "AKIAABCDEFGHIJKLMNOP");
        }

        #[test]
        fn nothing_staged_returns_empty() {
            let repo = TempRepo::new("empty");
            repo.write("README.md", "# hello\n");
            // Not staged.
            let findings = scan_staged(&repo.cwd(), &base_config()).unwrap();
            assert!(findings.is_empty());
        }

        #[test]
        fn a_preexisting_committed_secret_is_not_reported() {
            let repo = TempRepo::new("preexisting");
            repo.write("src/old.ts", "const key = \"AKIAABCDEFGHIJKLMNOP\";\n");
            repo.git(&["add", "src/old.ts"]);
            repo.git(&["commit", "-q", "-m", "init with a committed secret"]);

            // No new staged changes — the committed secret must not surface.
            let findings = scan_staged(&repo.cwd(), &base_config()).unwrap();
            assert!(findings.is_empty());
        }

        #[test]
        fn rejects_empty_cwd() {
            let err = scan_staged("", &base_config()).unwrap_err();
            assert!(err.contains("cwd must not be empty"));
        }

        #[test]
        fn disabled_config_returns_empty_without_running_git() {
            let repo = TempRepo::new("disabled");
            repo.write("src/config.ts", "const key = \"AKIAABCDEFGHIJKLMNOP\";\n");
            repo.git(&["add", "src/config.ts"]);

            let mut config = base_config();
            config.enabled = false;
            let findings = scan_staged(&repo.cwd(), &config).unwrap();
            assert!(findings.is_empty());
        }
    }
}
