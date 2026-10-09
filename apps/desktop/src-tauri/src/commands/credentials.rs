//! OS keychain wrapper — `credentials.rs` (§3.1 Forge integrations).
//!
//! Provides three Tauri commands for storing, retrieving, and deleting secrets
//! in the platform-native credential store:
//!   - macOS  : Keychain
//!   - Linux  : libsecret (GNOME Keyring / KWallet via libsecret)
//!   - Windows: Windows Credential Manager
//!
//! Used by Bitbucket (App Passwords) and future multi-account token storage.
//!
//! **Security model**:
//! - The `value` (secret) is never logged or included in error messages.
//! - The Tauri IPC surface (`set_credential`, `get_credential`) is exposed
//!   only to the main window — same as all other GitWand commands.
//! - `service` follows the convention `"gitwand:<forge>"`, e.g.
//!   `"gitwand:bitbucket"`. `account` is a free-form label that disambiguates
//!   entries for the same service (e.g. `"workspace:username"`).
//!
//! **keyring 2.x API**:
//! ```rust,no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let entry = keyring::Entry::new("service", "account")?;
//! entry.set_password("secret")?;
//! let secret = entry.get_password()?;
//! entry.delete_password()?;
//! # Ok(())
//! # }
//! ```

/// Namespace every service handled here must live under. Without it the
/// commands would be a generic keychain reader: on Linux (libsecret) and
/// Windows (Credential Manager) nothing prompts, so a script running in the
/// webview could read any other application's stored secret by name.
const SERVICE_PREFIX: &str = "gitwand:";

/// Services the backend manages itself, through dedicated commands: the
/// generic commands below may neither read them (the AI API key is injected by
/// `ai_http_request` only) nor write or delete them (its value carries the
/// origin the key is bound to, which only `ai_api_key_set` may set — together
/// with the key).
const BACKEND_ONLY_SERVICES: &[&str] = &[crate::commands::ai_http::AI_KEY_SERVICE];

/// Refuse the generic commands on a backend-only service.
fn check_not_backend_only(service: &str) -> Result<(), String> {
    if BACKEND_ONLY_SERVICES.contains(&service) {
        return Err(format!(
            "`{}` is managed by the backend and cannot be accessed from the frontend",
            service
        ));
    }
    Ok(())
}

/// Reject services outside the GitWand namespace (see `SERVICE_PREFIX`).
fn check_service(service: &str) -> Result<(), String> {
    if !service.starts_with(SERVICE_PREFIX) || service.len() == SERVICE_PREFIX.len() {
        return Err(format!(
            "Refusing keychain access outside the `{}` namespace",
            SERVICE_PREFIX
        ));
    }
    Ok(())
}

/// Store a credential in the OS keychain.
///
/// `service` — namespaced key, e.g. `"gitwand:bitbucket"`.
/// `account` — sub-key within the service, e.g. `"workspace:username"`.
/// `value`   — the secret (PAT, app-password, etc.).
#[tauri::command]
pub(crate) async fn set_credential(
    service: String,
    account: String,
    value: String,
) -> Result<(), String> {
    check_service(&service)?;
    check_not_backend_only(&service)?;
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keyring init failed for {}/{}: {}", service, account, e))?;
    entry
        .set_password(&value)
        .map_err(|e| format!("Failed to store credential {}/{}: {}", service, account, e))
}

/// Retrieve a credential from the OS keychain.
///
/// Returns `Err` with a descriptive message if the entry does not exist or
/// the keychain is locked. The caller should surface this to the user as
/// "Please configure your credentials in Settings > Accounts."
#[tauri::command]
pub(crate) async fn get_credential(service: String, account: String) -> Result<String, String> {
    check_service(&service)?;
    check_not_backend_only(&service)?;
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keyring init failed for {}/{}: {}", service, account, e))?;
    entry.get_password().map_err(|_| {
        format!(
            "No credential found for {}/{}. Please configure your account in Settings > Accounts.",
            service, account
        )
    })
}

/// Delete a credential from the OS keychain.
///
/// Silently succeeds if the entry does not exist (idempotent).
#[tauri::command]
pub(crate) async fn delete_credential(service: String, account: String) -> Result<(), String> {
    check_service(&service)?;
    check_not_backend_only(&service)?;
    let entry = match keyring::Entry::new(&service, &account) {
        Ok(e) => e,
        Err(_) => return Ok(()), // Entry cannot exist if we can't init
    };
    match entry.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already gone — idempotent
        Err(e) => Err(format!(
            "Failed to delete credential {}/{}: {}",
            service, account, e
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreign_services_are_refused() {
        for s in [
            "Chrome Safe Storage",
            "gitwand",
            "gitwand:",
            "git-credential",
            "GITWAND:x",
        ] {
            assert!(check_service(s).is_err(), "{s} accepted");
        }
        assert!(check_service("gitwand:bitbucket").is_ok());
    }

    #[test]
    fn backend_only_service_cannot_be_read_written_or_deleted() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let svc = || crate::commands::ai_http::AI_KEY_SERVICE.to_string();
        let acct = || "api-key".to_string();
        let errs = [
            rt.block_on(get_credential(svc(), acct())).unwrap_err(),
            // Writing would let a webview script rebind the AI key to a host
            // of its choosing; deleting is the AI key's own clear command.
            rt.block_on(set_credential(
                svc(),
                acct(),
                r#"{"key":"k","origin":"https://evil.example"}"#.to_string(),
            ))
            .unwrap_err(),
            rt.block_on(delete_credential(svc(), acct())).unwrap_err(),
        ];
        for err in errs {
            assert!(err.contains("managed by the backend"), "got: {err}");
        }
    }
}
