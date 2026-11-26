# GitWand — app map, first pass (raw inventory)

_Generated 2026-11-26 from `main` at 97186433 by a script (string and import matching, no build). It counts and locates; it does not judge. Known limits: a command is "called" when its name appears as a string literal in non-test frontend code; importers are found by import path; bundle weight is not measured here (needs a build with stats). Next pass: group by v4 domain, add bundle weight per domain, mark what the new workspace keeps, re-homes or removes._

## Size

- Tauri commands: **347** in 29 Rust files
- Vue components: **105** (69935 lines)
- Composables: **153** (35107 lines)
- Other frontend modules (utils, workers, directives, locales…): 91 files
- `App.vue`: 6652 lines

## Tauri commands by Rust module

| Module | Commands | dev:web route | GAP (no route yet) | Desktop only | Not in registry | No frontend caller |
|---|---|---|---|---|---|---|
| `commands/ops.rs` | 86 | 78 | 2 | 3 | 3 | 0 |
| `commands/gh.rs` | 38 | 23 | 8 | 0 | 7 | 0 |
| `commands/gitlab.rs` | 35 | 3 | 28 | 0 | 4 | 4 |
| `commands/azure.rs` | 27 | 0 | 27 | 0 | 0 | 0 |
| `commands/bitbucket.rs` | 22 | 1 | 21 | 0 | 0 | 0 |
| `commands/gitea.rs` | 21 | 8 | 13 | 0 | 0 | 0 |
| `commands/read.rs` | 19 | 19 | 0 | 0 | 0 | 0 |
| `commands/ai.rs` | 15 | 15 | 0 | 0 | 0 | 0 |
| `commands/worktree.rs` | 13 | 13 | 0 | 0 | 0 | 0 |
| `commands/gh_issues.rs` | 9 | 8 | 0 | 0 | 1 | 0 |
| `commands/workspace.rs` | 9 | 9 | 0 | 0 | 0 | 0 |
| `commands/files.rs` | 8 | 8 | 0 | 0 | 0 | 0 |
| `commands/stack.rs` | 6 | 6 | 0 | 0 | 0 | 0 |
| `commands/terminal.rs` | 4 | 4 | 0 | 0 | 0 | 0 |
| `commands/mcp_catalog.rs` | 4 | 0 | 4 | 0 | 0 | 0 |
| `commands/snapshots.rs` | 4 | 4 | 0 | 0 | 0 | 0 |
| `commands/github_api.rs` | 3 | 3 | 0 | 0 | 0 | 0 |
| `commands/scratch.rs` | 3 | 1 | 2 | 0 | 0 | 0 |
| `commands/credentials.rs` | 3 | 0 | 0 | 3 | 0 | 0 |
| `commands/ai_http.rs` | 3 | 3 | 0 | 0 | 0 | 0 |
| `commands/telemetry.rs` | 2 | 2 | 0 | 0 | 0 | 0 |
| `commands/tracked_ignored.rs` | 2 | 2 | 0 | 0 | 0 | 0 |
| `commands/worktree_trust.rs` | 2 | 2 | 0 | 0 | 0 | 0 |
| `commands/combined.rs` | 2 | 2 | 0 | 0 | 0 | 0 |
| `commands/watcher.rs` | 2 | 2 | 0 | 0 | 0 | 0 |
| `commands/render_fallback.rs` | 2 | 2 | 0 | 0 | 0 | 0 |
| `commands/worktree_processes.rs` | 1 | 1 | 0 | 0 | 0 | 0 |
| `commands/network.rs` | 1 | 1 | 0 | 0 | 0 | 0 |
| `commands/secrets.rs` | 1 | 1 | 0 | 0 | 0 | 0 |
| **Total** | 347 | 221 | 105 | 6 | 15 | 4 |

### Commands with no frontend caller found

_Candidates only: some are called from Rust, from events, or by a name built at runtime._

`gl_approve_mr_inner`, `gl_checkout_mr_inner`, `gl_merge_mr_inner`, `gl_mr_notes_inner`

## Components

| Component | Lines | Static importers | Lazy importers | Test |
|---|---|---|---|---|
| `SettingsPanel` | 5047 | 0 | 1 | — |
| `RepoSidebar` | 3670 | 1 | 0 | — |
| `PrDetailView` | 3598 | 0 | 1 | — |
| `CommitGraph` | 3389 | 0 | 1 | yes |
| `DashboardView` | 2615 | 0 | 1 | — |
| `MergeEditor` | 2413 | 0 | 1 | yes |
| `LaunchpadView` | 2100 | 0 | 1 | yes |
| `DiffViewer` | 1809 | 2 | 1 | yes |
| `PrCreateView` | 1778 | 0 | 1 | — |
| `BranchSelector` | 1706 | 1 | 0 | yes |
| `PrInlineDiff` | 1618 | 2 | 0 | yes |
| `CommitLog` | 1490 | 0 | 0 | — |
| `RebaseEditor` | 1451 | 0 | 1 | — |
| `PullRequestPanel` | 1403 | 0 | 0 | — |
| `AppHeader` | 1344 | 1 | 0 | — |
| `FileHistoryViewer` | 1323 | 0 | 1 | — |
| `TerminalPanel` | 1257 | 0 | 1 | — |
| `CommitDiffViewer` | 1240 | 1 | 1 | yes |
| `RepoTabStrip` | 1204 | 1 | 0 | yes |
| `PrIntelligencePanel` | 1183 | 2 | 0 | — |
| `FileExplorerPanel` | 1151 | 0 | 1 | yes |
| `WorktreeManager` | 923 | 0 | 1 | — |
| `AppDock` | 886 | 1 | 0 | — |
| `PrListSidebar` | 878 | 1 | 0 | — |
| `MergePreviewPanel` | 830 | 2 | 1 | — |
| `SettingsMcpTab` | 812 | 1 | 0 | — |
| `ImageDiffViewer` | 748 | 0 | 1 | — |
| `SettingsAccountsTab` | 746 | 1 | 0 | — |
| `HooksPanel` | 717 | 1 | 0 | — |
| `WorkspacePanel` | 710 | 0 | 0 | — |
| `AutomationsPanel` | 693 | 1 | 0 | — |
| `SplitCommitModal` | 666 | 0 | 1 | — |
| `CreateIssueModal` | 624 | 0 | 1 | yes |
| `TagsPanel` | 600 | 0 | 1 | — |
| `FolderPicker` | 587 | 0 | 1 | yes |
| `HelpView` | 586 | 0 | 1 | — |
| `StashManager` | 554 | 0 | 1 | — |
| `FolderDiffTree` | 514 | 0 | 0 | — |
| `LlmTracePanel` | 511 | 1 | 0 | yes |
| `PrCommentThread` | 508 | 1 | 0 | — |
| `SubmodulePanel` | 487 | 0 | 1 | — |
| `BaseModal` | 471 | 40 | 0 | yes |
| `AgentSessionsPanel` | 462 | 0 | 1 | — |
| `FileTreePane` | 452 | 1 | 0 | yes |
| `SyncSplitButton` | 443 | 1 | 0 | — |
| `SearchPalette` | 437 | 1 | 1 | — |
| `EmptyState` | 426 | 1 | 0 | — |
| `CloneModal` | 419 | 0 | 1 | yes |
| `RebaseProgressBanner` | 384 | 0 | 1 | yes |
| `IssueDetailView` | 363 | 0 | 1 | — |
| `UpdateModal` | 358 | 1 | 1 | — |
| `AiTemplateMenu` | 354 | 4 | 0 | — |
| `CherryPickPanel` | 350 | 0 | 0 | — |
| `ReleaseNotesModal` | 343 | 0 | 3 | — |
| `CombinedDiffBody` | 333 | 1 | 0 | yes |
| `PrReviewModal` | 321 | 2 | 0 | — |
| `BranchMenu` | 318 | 1 | 0 | — |
| `ForkModal` | 314 | 0 | 1 | — |
| `ScopePicker` | 280 | 1 | 0 | — |
| `TimeMachinePanel` | 280 | 0 | 1 | — |
| `CommitReviewModal` | 275 | 0 | 1 | yes |
| `PrReactions` | 270 | 2 | 0 | — |
| `MergeBackDialog` | 263 | 0 | 1 | — |
| `CommandLogPanel` | 247 | 0 | 1 | — |
| `FileList` | 240 | 0 | 0 | — |
| `WorktreeRemoveDialog` | 237 | 1 | 1 | — |
| `TrackedIgnoredNotice` | 229 | 1 | 0 | — |
| `StackBanner` | 205 | 0 | 1 | yes |
| `EditCommitOverlay` | 197 | 0 | 1 | — |
| `RepoTabBar` | 195 | 0 | 0 | — |
| `MergeSuccessModal` | 179 | 0 | 1 | — |
| `MonorepoPanel` | 179 | 0 | 0 | — |
| `AiContextButton` | 179 | 3 | 0 | — |
| `BranchDeleteModal` | 159 | 0 | 1 | — |
| `AiTaskCloseModal` | 154 | 0 | 1 | — |
| `SecretsFindingsModal` | 154 | 0 | 1 | yes |
| `BranchRenameModal` | 154 | 0 | 1 | — |
| `RestackDialog` | 150 | 0 | 1 | yes |
| `CommitReviewDecisionModal` | 143 | 0 | 1 | yes |
| `ResolutionPreviewPanel` | 141 | 1 | 0 | yes |
| `UndoToast` | 138 | 1 | 0 | yes |
| `ResolveAutoSummaryModal` | 133 | 1 | 0 | yes |
| `AiTaskNameModal` | 131 | 0 | 1 | — |
| `BranchNameField` | 131 | 0 | 2 | — |
| `BranchRowActions` | 130 | 1 | 0 | — |
| `CodeEditor` | 127 | 0 | 2 | — |
| `TokenMergePanel` | 126 | 1 | 0 | yes |
| `StackBranchMenu` | 117 | 0 | 1 | — |
| `BranchDirtySwitchModal` | 116 | 0 | 1 | — |
| `ConflictAlert` | 116 | 0 | 0 | — |
| `WorktreeHookTrustModal` | 113 | 0 | 1 | — |
| `Avatar` | 112 | 12 | 0 | — |
| `SearchTrigger` | 111 | 1 | 0 | — |
| `MergeApplyReport` | 106 | 1 | 0 | — |
| `AiSparkle` | 100 | 19 | 0 | — |
| `StackOnDialog` | 100 | 1 | 0 | yes |
| `IssueSuggestList` | 96 | 0 | 1 | yes |
| `AdventCard` | 91 | 0 | 1 | yes |
| `StackBadge` | 91 | 0 | 2 | yes |
| `RemoteImagesNotice` | 76 | 4 | 0 | — |
| `CombinedDiffView` | 71 | 0 | 1 | — |
| `HeaderLogo` | 50 | 1 | 0 | — |
| `ModalCloseButton` | 49 | 2 | 0 | — |
| `AgentIcon` | 44 | 1 | 0 | yes |
| `StackOnHost` | 33 | 0 | 1 | yes |

## Composables

| Composable | Lines | Importers | Test |
|---|---|---|---|
| `usePrPanel` | 2081 | 7 | yes |
| `useGitRepo` | 1968 | 8 | — |
| `useGitWand` | 1331 | 4 | — |
| `useCreateIssue` | 1150 | 6 | yes |
| `useCommitReview` | 812 | 1 | yes |
| `useAIProvider` | 798 | 38 | — |
| `useSettings` | 771 | 42 | — |
| `useStacks` | 694 | 12 | yes |
| `useLazyRepoTree` | 535 | 4 | yes |
| `useAbsorb` | 508 | 1 | — |
| `useCommitActions` | 463 | 1 | — |
| `usePrDescription` | 458 | 2 | — |
| `useMergePreview` | 434 | 6 | — |
| `useInteractiveRebase` | 405 | 3 | — |
| `useAppMenu` | 403 | 1 | — |
| `GitLabProvider` | 402 | 1 | yes |
| `useApplyFromPreview` | 396 | 8 | yes |
| `commitReviewState` | 378 | 2 | yes |
| `usePrCache` | 372 | 2 | yes |
| `useTerminalSessions` | 357 | 3 | yes |
| `useAutoFastForward` | 345 | 1 | yes |
| `useMcpRegistry` | 343 | 1 | — |
| `types` | 338 | 18 | — |
| `useIssueSuggest` | 336 | 3 | yes |
| `useLaunchpadInbox` | 335 | 1 | yes |
| `usePrAttachments` | 326 | 2 | yes |
| `useAiApiKey` | 318 | 3 | yes |
| `useWorktreeMergeBack` | 316 | 2 | yes |
| `useReviewIntelligence` | 314 | 1 | yes |
| `useDraggableResizable` | 310 | 2 | — |
| `useAiHunkQueue` | 305 | 1 | yes |
| `usePrPreReview` | 297 | 13 | yes |
| `useStacksFlow` | 296 | 2 | — |
| `useBranchUpdatePrompt` | 295 | 3 | yes |
| `BitbucketProvider` | 295 | 1 | — |
| `useWorktreeRemoval` | 293 | 2 | yes |
| `useRepoTabs` | 289 | 5 | yes |
| `useSafeHtml` | 287 | 13 | yes |
| `GitHubProvider` | 278 | 1 | — |
| `useConnectivity` | 274 | 2 | — |
| `useSquashSuggestion` | 262 | 1 | — |
| `useAccounts` | 259 | 4 | — |
| `useSplitCommit` | 242 | 3 | — |
| `useResolutionMemory` | 241 | 3 | — |
| `useTimeMachine` | 239 | 4 | yes |
| `useReleaseNotes` | 239 | 2 | — |
| `GiteaProvider` | 238 | 1 | yes |
| `useRepoPoller` | 234 | 1 | yes |
| `useUndoStack` | 233 | 2 | — |
| `useAiTemplates` | 225 | 10 | yes |
| `useTrackedIgnored` | 224 | 2 | yes |
| `useSecretsScanner` | 222 | 1 | yes |
| `AzureProvider` | 219 | 1 | yes |
| `useCommitSearch` | 217 | 2 | — |
| `useCommitMessage` | 216 | 2 | — |
| `useFilePreview` | 216 | 3 | yes |
| `CursorProvider` | 213 | 1 | yes |
| `useResolutionSelection` | 208 | 3 | yes |
| `useCodeMirror` | 207 | 2 | yes |
| `useFileExplorer` | 199 | 2 | yes |
| `aiTemplateDefaults` | 197 | 8 | — |
| `useScheduler` | 197 | 1 | — |
| `useCredentials` | 185 | 1 | — |
| `useLaunchpadNotifications` | 179 | 1 | yes |
| `useIdentity` | 176 | 4 | — |
| `useCustomAutomations` | 175 | 2 | — |
| `useBranchName` | 173 | 2 | — |
| `useBlameContext` | 168 | 1 | — |
| `useWorktreeCreation` | 165 | 2 | yes |
| `useMergeRisk` | 158 | 0 | — |
| `useForge` | 158 | 8 | — |
| `useHunkExplanation` | 157 | 1 | yes |
| `useLaunchpadIssues` | 157 | 2 | yes |
| `useSyncAction` | 155 | 1 | yes |
| `useCollapseOnOverflow` | 155 | 1 | yes |
| `usePrHunkCritique` | 155 | 1 | — |
| `useForcePush` | 151 | 1 | yes |
| `useStackActions` | 149 | 7 | yes |
| `useI18n` | 149 | 121 | yes |
| `useDiffEdit` | 146 | 2 | yes |
| `usePrReviewNav` | 145 | 1 | yes |
| `useDeviceFlowAuth` | 141 | 2 | — |
| `useRepoWatcher` | 140 | 2 | yes |
| `useWorkspaceScope` | 138 | 5 | yes |
| `useStashMessage` | 137 | 2 | — |
| `useTagSuggestion` | 135 | 1 | — |
| `useTierStats` | 132 | 2 | yes |
| `usePrSummary` | 132 | 2 | yes |
| `useCommitSelection` | 130 | 5 | yes |
| `useLaunchpadTeam` | 127 | 1 | yes |
| `useLogs` | 126 | 6 | — |
| `useLaunchpadPins` | 125 | 2 | yes |
| `prAnnotations` | 125 | 4 | yes |
| `useFolderHistory` | 123 | 7 | — |
| `useFileTree` | 122 | 1 | yes |
| `useWorktreeHookTrust` | 122 | 4 | yes |
| `useAiTasks` | 118 | 1 | yes |
| `fileTreeKeymap` | 117 | 1 | yes |
| `useIssuePanel` | 116 | 2 | yes |
| `useFileHistoryLists` | 115 | 1 | yes |
| `useAiPromptPresets` | 114 | 1 | — |
| `useSnapshotLabels` | 110 | 1 | yes |
| `useAvatar` | 107 | 6 | — |
| `useCombinedSummary` | 106 | 1 | yes |
| `useBranchPrSearch` | 105 | 2 | yes |
| `useLineRange` | 105 | 4 | yes |
| `useCommitReviewNav` | 105 | 2 | yes |
| `useConflictHistory` | 105 | 2 | yes |
| `useFileCompare` | 104 | 1 | yes |
| `useSnapshots` | 103 | 4 | yes |
| `useRemoteImages` | 100 | 3 | yes |
| `useRestackHost` | 100 | 1 | yes |
| `useCommitTemplates` | 98 | 2 | — |
| `useScratchWorktree` | 97 | 1 | yes |
| `useLaunchpadPrs` | 95 | 5 | yes |
| `usePinnedBranches` | 92 | 3 | — |
| `useArchivedBranches` | 90 | 2 | — |
| `useOsNotification` | 88 | 1 | — |
| `useRepoRemote` | 88 | 2 | yes |
| `usePrReviewQueue` | 81 | 2 | yes |
| `useFileHistoryCombine` | 80 | 1 | yes |
| `useAdventCard` | 80 | 1 | yes |
| `useLaunchpadPoller` | 80 | 1 | — |
| `useWatcherRefreshQueue` | 80 | 1 | yes |
| `useVirtualRows` | 78 | 2 | yes |
| `useNetworkStatus` | 75 | 1 | — |
| `useLaunchpadScope` | 73 | 1 | yes |
| `useUndoToast` | 72 | 5 | yes |
| `useBlameGutter` | 71 | 1 | yes |
| `usePrReviewKeymap` | 70 | 2 | yes |
| `createdIssueToast` | 69 | 1 | yes |
| `useRepoActionCards` | 66 | 1 | yes |
| `useHeaderAlign` | 64 | 1 | — |
| `useTreeScopeRoot` | 60 | 1 | yes |
| `branchPickerBridge` | 60 | 11 | — |
| `useConflictEditorSelection` | 59 | 1 | yes |
| `useAcceptedReports` | 52 | 1 | yes |
| `useTheme` | 51 | 6 | — |
| `commitReviewKeymap` | 50 | 2 | yes |
| `useCombinedDiff` | 49 | 5 | yes |
| `useStickyWidth` | 49 | 1 | yes |
| `usePrFindingFilter` | 43 | 2 | yes |
| `explorerTabView` | 43 | 1 | yes |
| `useAiExtraContext` | 40 | 4 | yes |
| `releaseNotesState` | 40 | 4 | — |
| `useCommandLog` | 36 | 1 | — |
| `useResizeObserver` | 35 | 2 | — |
| `useLaunchpadWip` | 35 | 1 | yes |
| `useGithubAuth` | 33 | 1 | — |
| `useAzureAuth` | 31 | 1 | — |
| `prAiLocale` | 27 | 8 | yes |
| `issueLister` | 22 | 1 | yes |
| `index` | 11 | 0 | — |
