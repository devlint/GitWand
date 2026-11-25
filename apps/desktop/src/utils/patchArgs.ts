/**
 * git arguments for a patch the frontend reads through `gitExec` (parsed, or
 * handed to the AI). The TypeScript twin of `PATCH_CONFIG` / `PATCH_FLAGS` in
 * src-tauri/src/git/cmd.rs: the user's git config must not change the patch.
 * Names print literally, headers keep `a/` `b/`, a submodule bump stays one
 * `Subproject commit` section, no colour, no external diff tool, and no
 * textconv (the staged bytes themselves, not a rendering of them).
 */
const PATCH_CONFIG = [
  "-c", "core.quotePath=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.srcPrefix=a/",
  "-c", "diff.dstPrefix=b/",
  "-c", "diff.submodule=short",
];

const PATCH_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv"];

/** `git diff <diffArgs…>` with the patch pinned: `patchDiffArgs("--cached")`. */
export function patchDiffArgs(...diffArgs: string[]): string[] {
  return [...PATCH_CONFIG, "diff", ...PATCH_FLAGS, ...diffArgs];
}

/**
 * `git show <showArgs…>` with the patch pinned, like `git_show`: a root
 * commit prints its diff whatever `log.showRoot` says, an `-m` prints the
 * first-parent diff whatever `log.diffMerges` says, and no signature lands in
 * the output.
 */
export function patchShowArgs(...showArgs: string[]): string[] {
  return [
    ...PATCH_CONFIG,
    "-c", "log.showRoot=true",
    "-c", "log.diffMerges=first-parent",
    "show", "--no-show-signature", ...PATCH_FLAGS, ...showArgs,
  ];
}
