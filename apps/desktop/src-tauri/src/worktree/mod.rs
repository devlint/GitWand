//! v3.13.0 — The worktree service (spec §3).
//!
//! Every GitWand worktree is created here, whatever asked for it (the
//! worktree manager or an AI task), so that the base, the `include` files,
//! the record and the hooks cannot be skipped by one path and not another.
//! Plain functions over paths; the Tauri commands live in
//! `commands/worktree.rs`.

pub(crate) mod base;
pub(crate) mod create;
pub(crate) mod guard;
pub(crate) mod hooks;
pub(crate) mod include;
pub(crate) mod merge_back;
pub(crate) mod record;
pub(crate) mod remove;
pub(crate) mod restore;
pub(crate) mod settings;
pub(crate) mod slug;

#[cfg(test)]
pub(crate) mod test_support;
