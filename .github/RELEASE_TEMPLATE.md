## What's new

<!-- Describe the changes in this release -->

## Downloads

| Platform | File |
|----------|------|
| macOS (Universal) | `GitWand_x.x.x_universal.dmg` |
| Linux | `GitWand_x.x.x_amd64.AppImage` · `GitWand_x.x.x_amd64.deb` |
| Windows | `GitWand_x.x.x_x64-setup.exe` · `GitWand_x.x.x_x64_en-US.msi` |

### macOS — first launch workaround

GitWand is not yet Apple-notarized. Gatekeeper will block the first launch. Pick one of:

1. **Right-click → Open** in Finder, then click **Open** again in the dialog.
2. **System Settings → Privacy & Security** → click **Open Anyway** after the first blocked attempt.
3. **Terminal**: `xattr -dr com.apple.quarantine /Applications/GitWand.app`

Only apply this to builds downloaded from the official [GitHub Releases](https://github.com/devlint/GitWand/releases) page.

---

## Code signing policy

Windows builds are code-signed. Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

This program will not transfer any information to other networked systems unless specifically requested by the user.
