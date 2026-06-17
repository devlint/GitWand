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

/// Store a credential in the OS keychain.
///
/// `service` — namespaced key, e.g. `"gitwand:bitbucket"`.
/// `account` — sub-key within the service, e.g. `"workspace:username"`.
/// `value`   — the secret (PAT, app-password, etc.).
#[tauri::command]
pub(crate) async fn set_credential(service: String, account: String, value: String) -> Result<(), String> {
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
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keyring init failed for {}/{}: {}", service, account, e))?;
    entry
        .get_password()
        .map_err(|_| format!(
            "No credential found for {}/{}. Please configure your account in Settings > Accounts.",
            service, account
        ))
}

/// Delete a credential from the OS keychain.
///
/// Silently succeeds if the entry does not exist (idempotent).
#[tauri::command]
pub(crate) async fn delete_credential(service: String, account: String) -> Result<(), String> {
    let entry = match keyring::Entry::new(&service, &account) {
        Ok(e) => e,
        Err(_) => return Ok(()), // Entry cannot exist if we can't init
    };
    match entry.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already gone — idempotent
        Err(e) => Err(format!("Failed to delete credential {}/{}: {}", service, account, e)),
    }
}
