# Structural Merge Engine (`@gitwand/core` v2.3)

The structural merge engine resolves Git conflicts at the **AST level** rather than line-by-line. Instead of comparing raw text, it parses each file version with [tree-sitter](https://tree-sitter.github.io/tree-sitter/), identifies top-level entities (functions, classes, types, imports…), matches them across the three versions (base / ours / theirs), and merges them individually.

This covers the cases that defeat line-based heuristics: a method added by both branches in different orders, a function body changed on one side while the signature was renamed on the other, a class that grew two independent methods — all auto-resolvable at entity granularity.

---

## Supported languages

| Language | Extensions | Grammar (tree-sitter-wasms) |
|----------|------------|----------------------------|
| TypeScript | `.ts` | `tree-sitter-typescript` |
| TSX | `.tsx` | `tree-sitter-tsx` |
| JavaScript | `.js`, `.mjs`, `.cjs` | `tree-sitter-javascript` |
| JSX | `.jsx` | `tree-sitter-javascript` |
| Python | `.py` | `tree-sitter-python` |
| Go | `.go` | `tree-sitter-go` |
| Rust | `.rs` | `tree-sitter-rust` |

TypeScript declaration files (`.d.ts`) are explicitly excluded — they have no implementation to merge.

---

## Installation

`web-tree-sitter` and `tree-sitter-wasms` are **optional peer dependencies**. The structural engine is silently disabled when they are absent — `resolveAsync()` falls back to the standard hunk-based resolver.

```bash
# In the consumer package (cli, mcp, or desktop bundler)
npm install web-tree-sitter tree-sitter-wasms
# or
pnpm add web-tree-sitter tree-sitter-wasms
```

---

## Usage

### `resolveAsync()` — recommended entry point

The simplest way to benefit from structural merge is to replace calls to `resolve()` with `resolveAsync()`. The API is a superset: it accepts the same arguments and returns the same `MergeResult`.

```ts
import { resolveAsync } from "@gitwand/core";

const result = await resolveAsync(conflictedContent, "src/app.ts");

if (result.mergedContent) {
  fs.writeFileSync("src/app.ts", result.mergedContent);
}
```

Structural merge is attempted first for supported languages. If it fails for any reason (grammar unavailable, parse errors, unresolvable entity conflict), `resolveAsync` falls back transparently to the synchronous hunk-based engine.

### `tryStructuralMergeResolve()` — lower-level API

For cases where you want to handle the result explicitly:

```ts
import { tryStructuralMergeResolve, wrapStructuralResult, resolve } from "@gitwand/core";

const merged = await tryStructuralMergeResolve(conflictedContent, "src/app.ts");

if (merged !== null) {
  // Structural merge succeeded — wrap into a MergeResult
  const result = wrapStructuralResult(conflictedContent, merged, "src/app.ts");
  console.log(`${result.stats.autoResolved} conflicts resolved structurally`);
} else {
  // Fall back to hunk-based resolver
  const result = resolve(conflictedContent, "src/app.ts");
}
```

### Custom WASM loading

In environments where grammar WASM files are not auto-discoverable (e.g. a custom Tauri bundle layout or a browser SPA), pass loader options:

```ts
// Browser: WASM files served from /static/grammars/
const result = await resolveAsync(content, "src/app.ts", {}, {
  grammarBaseUrl: "/static/grammars",
});

// Tauri: WASM files in a custom resource directory
const result = await resolveAsync(content, "src/app.ts", {}, {
  grammarDir: "/path/to/resources/grammars",
});

// Custom loader (any environment)
const result = await resolveAsync(content, "src/app.ts", {}, {
  customLoader: async (grammarName) => {
    const buf = await fs.readFile(`/my/grammars/${grammarName}.wasm`);
    return new Uint8Array(buf);
  },
});
```

---

## How it works

### 1 — Version reconstruction

The conflicted file (with `<<<<<<<`/`=======`/`>>>>>>>` markers) is parsed by GitWand's existing conflict marker parser. Three clean file versions are reconstructed:

- **ours** = text segments + ours lines from each hunk
- **theirs** = text segments + theirs lines from each hunk
- **base** = text segments + base lines (diff3 format) or ours fallback (diff2)

### 2 — Tree-sitter parsing

Each version is parsed with tree-sitter. If any version produces ERROR nodes, structural merge is aborted and the hunk-based resolver takes over.

### 3 — Entity extraction

Top-level entities are extracted from each parse tree. An entity is any named top-level declaration:

| Language | Entity types |
|----------|-------------|
| TS/JS | `function_declaration`, `class_declaration`, `interface_declaration`, `type_alias_declaration`, `lexical_declaration`, `export_statement`, `import_statement`, `ambient_declaration` |
| Python | `function_definition`, `class_definition`, `decorated_definition`, `import_statement`, `import_from_statement` |
| Go | `function_declaration`, `method_declaration`, `type_declaration`, `var_declaration`, `import_declaration` |
| Rust | `function_item`, `struct_item`, `enum_item`, `trait_item`, `impl_item`, `mod_item`, `use_declaration` |

Each entity has a **signature** — a stable `kind:name` key used for matching. A renamed entity (e.g. `foo` → `bar`) is treated as a delete + add, not a rename, which is conservative but correct.

### 4 — 3-way matching

Entities are matched across base/ours/theirs by signature. Each match is classified:

| Status | Description |
|--------|-------------|
| `unchanged` | Identical in all three versions |
| `ours-only-change` | Changed in ours, unchanged in theirs |
| `theirs-only-change` | Changed in theirs, unchanged in ours |
| `both-changed-same` | Both sides made the same change (or both deleted) |
| `both-changed-diff` | Both sides changed differently → unresolvable |
| `ours-added` | New entity, added only in ours |
| `theirs-added` | New entity, added only in theirs |
| `ours-deleted` | Deleted in ours |
| `theirs-deleted` | Deleted in theirs |

### 5 — Entity-level merge

Each matched entity is resolved independently:

- `unchanged` / `both-changed-same` → emit the shared version
- `ours-only-change` → emit ours
- `theirs-only-change` → emit theirs
- `ours-added` / `theirs-added` → include in output
- `ours-deleted` (theirs unchanged) → omit
- `theirs-deleted` (ours unchanged) → omit
- `ours-deleted` (theirs modified) → **conflict** → abort
- `both-changed-diff` → **conflict** → abort

If any entity has a real conflict, the whole structural merge is aborted and the file falls back to the hunk-based resolver.

### 6 — Reconstruction

The merged file is assembled by following the **theirs** entity order (to preserve incoming structure). Inter-entity whitespace and comments are preserved verbatim from the theirs source. Entities only present in ours (`ours-added`) are appended after the theirs content.

---

## Adding a new language

1. Install the tree-sitter grammar:
   ```bash
   # Check if tree-sitter-wasms already bundles it:
   ls node_modules/tree-sitter-wasms/out/ | grep <language>
   ```

2. Add the language to `src/structural/parsers/grammars/languages.ts`:
   ```ts
   export const LANGUAGE_SPECS: Record<SupportedLanguage, LanguageSpec> = {
     // ...existing...
     kotlin: {
       grammarName: "tree-sitter-kotlin",
       extensions: [".kt", ".kts"],
     },
   };
   ```

3. Extend `nodeSignature()` in `src/structural/entities.ts` with the node types used by the language's grammar. Refer to the grammar's `grammar.js` for the exact node type names.

4. Add tests in `src/__tests__/structural/`.

The loader, adapters, matcher, merge logic, and reconstruct module require no changes — they are language-agnostic.

---

## Environment support

| Environment | WASM loading |
|-------------|-------------|
| **Node.js** | Reads from `tree-sitter-wasms/out/` via `require.resolve`, or falls back to `packages/core/assets/grammars/` |
| **Browser** | Fetches from configurable `grammarBaseUrl` (default: `/assets/grammars`) |
| **Tauri** | Fetches via `__TAURI_INTERNALS__.convertFileSrc` from configurable `grammarDir` |

All environments use the same grammar cache (keyed by grammar name, per process). The first load pays the WASM parsing cost; subsequent calls are instant.

---

## Limitations (v2.3)

- **No intra-entity structural merge**: if both sides change the body of the same function differently, it's a conflict. The hunk-based resolver handles it (potentially resolving individual lines inside that function body).
- **No rename detection**: a renamed function is treated as delete + add. Rename-aware merging is planned for v2.6 (refactoring-aware merge).
- **No cross-file analysis**: structural merge is per-file. Move-to-other-file scenarios require v2.6.
- **Grammar WASM size**: each grammar is 400–1200 KB. They are never bundled into `@gitwand/core` itself — consumers pull the grammars they need via `tree-sitter-wasms`.
