import { describe, it, expect } from "vitest";
import { resolve } from "../resolver.js";
import { mergeNonOverlapping, lcs, computeDiff } from "../diff.js";

/**
 * Fixtures de fichiers avec conflits Git.
 * Chaque fixture simule un cas réel.
 */

// ═══════════════════════════════════════════════════════════════
// BASIC PATTERNS
// ═══════════════════════════════════════════════════════════════

const CONFLICT_SAME_CHANGE = `import { useState } from "react";
<<<<<<< ours
import { useEffect } from "react";
||||||| base
=======
import { useEffect } from "react";
>>>>>>> theirs
export default function App() {}`;

const CONFLICT_ONE_SIDE = `const config = {
<<<<<<< ours
  port: 3000,
  host: "localhost",
||||||| base
  port: 3000,
=======
  port: 3000,
>>>>>>> theirs
};`;

const CONFLICT_DELETE_NO_CHANGE = `function main() {
<<<<<<< ours
||||||| base
  console.log("debug");
=======
  console.log("debug");
>>>>>>> theirs
  return true;
}`;

const CONFLICT_WHITESPACE = `<<<<<<< ours
function hello() {
    return "world";
}
=======
function hello() {
  return "world";
}
>>>>>>> theirs`;

// ═══════════════════════════════════════════════════════════════
// NON-OVERLAPPING PATTERNS
// ═══════════════════════════════════════════════════════════════

const CONFLICT_NON_OVERLAPPING_IMPORTS = `<<<<<<< ours
import React from "react";
import { useState } from "react";
import { useEffect } from "react";
import axios from "axios";
||||||| base
import React from "react";
import { useState } from "react";
import axios from "axios";
=======
import React from "react";
import { useState } from "react";
import axios from "axios";
import dayjs from "dayjs";
>>>>>>> theirs`;

const CONFLICT_NON_OVERLAPPING_CODE = `<<<<<<< ours
const API_URL = "https://api.example.com";
const TIMEOUT = 5000;
const RETRIES = 3;
const DEBUG = false;
||||||| base
const API_URL = "https://api.example.com";
const TIMEOUT = 5000;
const RETRIES = 3;
=======
const API_URL = "https://api.production.com";
const TIMEOUT = 5000;
const RETRIES = 3;
>>>>>>> theirs`;

const CONFLICT_OVERLAPPING = `<<<<<<< ours
const API_URL = "https://staging.example.com";
const TIMEOUT = 10000;
||||||| base
const API_URL = "https://api.example.com";
const TIMEOUT = 5000;
=======
const API_URL = "https://production.example.com";
const TIMEOUT = 3000;
>>>>>>> theirs`;

// ═══════════════════════════════════════════════════════════════
// COMPLEX / EDGE CASES
// ═══════════════════════════════════════════════════════════════

const CONFLICT_COMPLEX = `<<<<<<< ours
function calculate(a: number, b: number) {
  return a + b;
}
=======
function calculate(x: number, y: number): number {
  return x * y;
}
>>>>>>> theirs`;

const MULTIPLE_CONFLICTS = `import React from "react";
<<<<<<< ours
import { useState } from "react";
||||||| base
=======
import { useState } from "react";
>>>>>>> theirs

const App = () => {
<<<<<<< ours
  const title = "Hello GitWand";
||||||| base
  const title = "Hello World";
=======
  const title = "Hello World";
>>>>>>> theirs
  return <h1>{title}</h1>;
};`;

// ═══════════════════════════════════════════════════════════════
// REALISTIC FIXTURES — from real-world project patterns
// ═══════════════════════════════════════════════════════════════

/** package.json version bump — both branches bump the same version */
const REAL_PACKAGE_JSON_SAME = `{
  "name": "my-app",
<<<<<<< ours
  "version": "2.1.0",
||||||| base
  "version": "2.0.0",
=======
  "version": "2.1.0",
>>>>>>> theirs
  "license": "MIT"
}`;

/** package.json — different deps added by each branch (non-overlapping) */
const REAL_PACKAGE_JSON_DEPS = `{
  "dependencies": {
<<<<<<< ours
    "axios": "^1.6.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "zustand": "^4.5.0"
||||||| base
    "axios": "^1.6.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
=======
    "axios": "^1.6.0",
    "dayjs": "^1.11.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
>>>>>>> theirs
  }
}`;

/** Laravel PHP — route files, two devs adding routes in different groups */
const REAL_LARAVEL_ROUTES = `<?php
use Illuminate\\Support\\Facades\\Route;

<<<<<<< ours
Route::get('/dashboard', [DashboardController::class, 'index']);
Route::get('/dashboard/stats', [DashboardController::class, 'stats']);
Route::get('/users', [UserController::class, 'index']);
||||||| base
Route::get('/dashboard', [DashboardController::class, 'index']);
Route::get('/users', [UserController::class, 'index']);
=======
Route::get('/dashboard', [DashboardController::class, 'index']);
Route::get('/users', [UserController::class, 'index']);
Route::get('/users/{id}/profile', [UserController::class, 'profile']);
>>>>>>> theirs`;

/** Vue SFC — one branch changes template, other changes script */
const REAL_VUE_SFC_NONOVERLAP = `<template>
<<<<<<< ours
  <div class="container">
    <h1>{{ title }}</h1>
    <p>{{ description }}</p>
    <UserList :users="users" />
  </div>
||||||| base
  <div class="container">
    <h1>{{ title }}</h1>
    <UserList :users="users" />
  </div>
=======
  <div class="container">
    <h1>{{ title }}</h1>
    <UserList :users="users" />
  </div>
>>>>>>> theirs
</template>`;

/** CSS — conflicting media queries (complex) */
const REAL_CSS_COMPLEX = `<<<<<<< ours
.header {
  display: flex;
  justify-content: space-between;
  padding: 1rem 2rem;
}
=======
.header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  padding: 0.5rem 1rem;
}
>>>>>>> theirs`;

/** Typical .env.example — one side adds, other doesn't touch */
const REAL_ENV_ONE_SIDE = `APP_NAME=MyApp
<<<<<<< ours
APP_ENV=production
APP_DEBUG=false
APP_URL=https://myapp.com
SENTRY_DSN=https://sentry.io/xxx
||||||| base
APP_ENV=production
APP_DEBUG=false
APP_URL=https://myapp.com
=======
APP_ENV=production
APP_DEBUG=false
APP_URL=https://myapp.com
>>>>>>> theirs
DB_HOST=localhost`;

/** Mixed file: 3 conflicts — 2 resolvable, 1 complex */
const REAL_MIXED_FILE = `import express from "express";
<<<<<<< ours
import cors from "cors";
import helmet from "helmet";
||||||| base
import cors from "cors";
=======
import cors from "cors";
>>>>>>> theirs

const app = express();

<<<<<<< ours
app.use(cors({ origin: "https://myapp.com" }));
||||||| base
app.use(cors());
=======
app.use(cors());
>>>>>>> theirs

<<<<<<< ours
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "2.0" });
});
=======
app.get("/health", (req, res) => {
  res.json({ healthy: true, uptime: process.uptime() });
});
>>>>>>> theirs

app.listen(3000);`;

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe("@gitwand/core resolve", () => {
  describe("same_change", () => {
    it("resolves when both branches made the same edit", () => {
      const result = resolve(CONFLICT_SAME_CHANGE, "app.tsx");

      expect(result.stats.totalConflicts).toBe(1);
      expect(result.stats.autoResolved).toBe(1);
      expect(result.stats.remaining).toBe(0);
      expect(result.mergedContent).toContain('import { useEffect } from "react"');
      expect(result.mergedContent).not.toContain("<<<<<<<");
      expect(result.hunks[0].type).toBe("same_change");
      expect(result.hunks[0].confidence).toBe("certain");
    });
  });

  describe("one_side_change", () => {
    it("resolves by taking the side that changed (ours)", () => {
      const result = resolve(CONFLICT_ONE_SIDE, "config.ts");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.mergedContent).toContain('host: "localhost"');
      expect(result.hunks[0].type).toBe("one_side_change");
    });
  });

  describe("delete_no_change", () => {
    it("resolves by accepting the deletion", () => {
      const result = resolve(CONFLICT_DELETE_NO_CHANGE, "main.ts");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.mergedContent).not.toContain("console.log");
      expect(result.hunks[0].type).toBe("delete_no_change");
    });
  });

  describe("whitespace_only", () => {
    it("resolves whitespace-only conflicts", () => {
      const result = resolve(CONFLICT_WHITESPACE, "hello.ts");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.hunks[0].type).toBe("whitespace_only");
    });

    it("skips whitespace if option is disabled", () => {
      const result = resolve(CONFLICT_WHITESPACE, "hello.ts", {
        resolveWhitespace: false,
      });

      expect(result.stats.autoResolved).toBe(0);
      expect(result.stats.remaining).toBe(1);
    });
  });

  describe("non_overlapping", () => {
    it("merges imports added at different locations", () => {
      const result = resolve(CONFLICT_NON_OVERLAPPING_IMPORTS, "imports.ts");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.hunks[0].type).toBe("non_overlapping");
      expect(result.hunks[0].confidence).toBe("high");
      expect(result.mergedContent).toContain("useEffect");
      expect(result.mergedContent).toContain("dayjs");
      expect(result.mergedContent).toContain("React");
      expect(result.mergedContent).toContain("useState");
      expect(result.mergedContent).toContain("axios");
    });

    it("merges code modifications at different locations", () => {
      const result = resolve(CONFLICT_NON_OVERLAPPING_CODE, "config.ts");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.hunks[0].type).toBe("non_overlapping");
      expect(result.mergedContent).toContain("DEBUG");
      expect(result.mergedContent).toContain("production.com");
    });

    it("does NOT merge when modifications overlap", () => {
      const result = resolve(CONFLICT_OVERLAPPING, "config.ts");

      expect(result.hunks[0].type).toBe("complex");
      expect(result.stats.autoResolved).toBe(0);
    });

    it("skips if option is disabled", () => {
      const result = resolve(CONFLICT_NON_OVERLAPPING_IMPORTS, "imports.ts", {
        resolveNonOverlapping: false,
      });

      expect(result.stats.autoResolved).toBe(0);
    });
  });

  describe("complex", () => {
    it("does not resolve complex conflicts", () => {
      const result = resolve(CONFLICT_COMPLEX, "calc.ts");

      expect(result.stats.autoResolved).toBe(0);
      expect(result.stats.remaining).toBe(1);
      expect(result.mergedContent).toBeNull();
      expect(result.hunks[0].type).toBe("complex");
    });
  });

  describe("multiple conflicts in one file", () => {
    it("resolves trivial conflicts and leaves others", () => {
      const result = resolve(MULTIPLE_CONFLICTS, "app.tsx");

      expect(result.stats.totalConflicts).toBe(2);
      expect(result.resolutions[0].autoResolved).toBe(true);
      expect(result.resolutions[1].autoResolved).toBe(true);
      expect(result.stats.autoResolved).toBe(2);
    });
  });

  describe("clean file (no conflicts)", () => {
    it("returns content as-is", () => {
      const clean = 'const x = 42;\nconsole.log(x);\n';
      const result = resolve(clean, "clean.ts");

      expect(result.stats.totalConflicts).toBe(0);
      expect(result.mergedContent).toBe(clean);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // REALISTIC SCENARIOS
  // ═════════════════════════════════════════════════════════════

  describe("real-world: package.json", () => {
    it("resolves identical version bumps (same_change)", () => {
      const result = resolve(REAL_PACKAGE_JSON_SAME, "package.json");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.hunks[0].type).toBe("same_change");
      expect(result.mergedContent).toContain('"version": "2.1.0"');
    });

    it("merges different dependencies added by each branch", () => {
      const result = resolve(REAL_PACKAGE_JSON_DEPS, "package.json");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.hunks[0].type).toBe("non_overlapping");
      expect(result.mergedContent).toContain("zustand");
      expect(result.mergedContent).toContain("dayjs");
      expect(result.mergedContent).toContain("react");
    });
  });

  describe("real-world: Laravel routes", () => {
    it("merges routes added in different locations", () => {
      const result = resolve(REAL_LARAVEL_ROUTES, "routes/web.php");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.hunks[0].type).toBe("non_overlapping");
      expect(result.mergedContent).toContain("stats");
      expect(result.mergedContent).toContain("profile");
    });
  });

  describe("real-world: Vue SFC", () => {
    it("resolves template change as one_side_change", () => {
      const result = resolve(REAL_VUE_SFC_NONOVERLAP, "MyComponent.vue");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.hunks[0].type).toBe("one_side_change");
      expect(result.mergedContent).toContain("description");
    });
  });

  describe("real-world: CSS conflicts", () => {
    it("does NOT auto-resolve conflicting CSS architectures", () => {
      const result = resolve(REAL_CSS_COMPLEX, "styles.css");

      expect(result.stats.autoResolved).toBe(0);
      expect(result.hunks[0].type).toBe("complex");
    });
  });

  describe("real-world: .env one-side addition", () => {
    it("resolves when one branch adds a new env variable", () => {
      const result = resolve(REAL_ENV_ONE_SIDE, ".env.example");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.hunks[0].type).toBe("one_side_change");
      expect(result.mergedContent).toContain("SENTRY_DSN");
      expect(result.mergedContent).toContain("DB_HOST");
    });
  });

  describe("real-world: mixed file (resolvable + complex)", () => {
    it("resolves 2 out of 3 conflicts, leaves the complex one", () => {
      const result = resolve(REAL_MIXED_FILE, "server.ts");

      expect(result.stats.totalConflicts).toBe(3);
      // First: one_side_change (ours added helmet)
      expect(result.resolutions[0].autoResolved).toBe(true);
      // Second: one_side_change (ours changed cors config)
      expect(result.resolutions[1].autoResolved).toBe(true);
      // Third: complex (different health endpoint implementations)
      expect(result.resolutions[2].autoResolved).toBe(false);
      expect(result.resolutions[2].hunk.type).toBe("complex");

      expect(result.stats.autoResolved).toBe(2);
      expect(result.stats.remaining).toBe(1);
      // mergedContent is null because one conflict remains
      expect(result.mergedContent).toBeNull();
    });
  });

  // ═════════════════════════════════════════════════════════════
  // DIFF UTILITIES
  // ═════════════════════════════════════════════════════════════

  describe("diff utilities", () => {
    it("lcs finds the longest common subsequence", () => {
      const a = ["a", "b", "c", "d"];
      const b = ["a", "x", "c", "d"];
      const result = lcs(a, b);
      expect(result).toEqual([[0, 0], [2, 2], [3, 3]]);
    });

    it("lcs handles empty arrays", () => {
      expect(lcs([], ["a"])).toEqual([]);
      expect(lcs(["a"], [])).toEqual([]);
      expect(lcs([], [])).toEqual([]);
    });

    it("lcs handles identical arrays", () => {
      const a = ["a", "b", "c"];
      const result = lcs(a, a);
      expect(result).toEqual([[0, 0], [1, 1], [2, 2]]);
    });

    it("computeDiff identifies additions and removals", () => {
      const base = ["a", "b", "c"];
      const branch = ["a", "x", "b", "c"];
      const diff = computeDiff(base, branch);

      const adds = diff.filter((d) => d.type === "add");
      expect(adds.length).toBe(1);
      expect(adds[0].line).toBe("x");
    });

    it("computeDiff handles complete replacement", () => {
      const base = ["a", "b"];
      const branch = ["x", "y"];
      const diff = computeDiff(base, branch);

      const removes = diff.filter((d) => d.type === "remove");
      const adds = diff.filter((d) => d.type === "add");
      expect(removes.length).toBe(2);
      expect(adds.length).toBe(2);
    });

    it("mergeNonOverlapping merges additions at different locations", () => {
      const base = ["a", "b", "c"];
      const ours = ["a", "x", "b", "c"];
      const theirs = ["a", "b", "c", "y"];

      const result = mergeNonOverlapping(base, ours, theirs);

      expect(result).not.toBeNull();
      expect(result).toEqual(["a", "x", "b", "c", "y"]);
    });

    it("mergeNonOverlapping returns null on overlapping edits", () => {
      const base = ["a", "b", "c"];
      const ours = ["a", "X", "c"];
      const theirs = ["a", "Y", "c"];

      const result = mergeNonOverlapping(base, ours, theirs);
      expect(result).toBeNull();
    });

    it("mergeNonOverlapping handles one side adding, other side deleting elsewhere", () => {
      const base = ["a", "b", "c", "d"];
      const ours = ["a", "b", "c", "d", "e"];  // added "e" at end
      const theirs = ["a", "c", "d"];            // removed "b"

      const result = mergeNonOverlapping(base, ours, theirs);

      expect(result).not.toBeNull();
      expect(result).toEqual(["a", "c", "d", "e"]);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // STATS & REPORTING
  // ═════════════════════════════════════════════════════════════

  describe("stats and reporting", () => {
    it("provides human-readable explanations for each hunk", () => {
      const result = resolve(CONFLICT_ONE_SIDE, "config.ts");

      expect(result.hunks[0].explanation).toBeTruthy();
      expect(typeof result.hunks[0].explanation).toBe("string");
      expect(result.hunks[0].explanation.length).toBeGreaterThan(10);
    });

    it("provides stats by type", () => {
      const result = resolve(MULTIPLE_CONFLICTS, "app.tsx");

      expect(result.stats.byType).toBeDefined();
      expect(typeof result.stats.byType).toBe("object");
    });

    it("counts correctly with mixed resolvable/non-resolvable", () => {
      const result = resolve(REAL_MIXED_FILE, "server.ts");

      expect(result.stats.totalConflicts).toBe(3);
      expect(result.stats.autoResolved).toBe(2);
      expect(result.stats.remaining).toBe(1);
      expect(
        result.stats.autoResolved + result.stats.remaining,
      ).toBe(result.stats.totalConflicts);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // DIFF2 IMPROVEMENTS (no base)
  // ═════════════════════════════════════════════════════════════

  describe("diff2: value_only_change", () => {
    it("detects hash-only differences in build manifest", () => {
      const manifest = `{
<<<<<<< HEAD
  "_Foo-DIwZRTuY.js": {
    "file": "assets/Foo-DIwZRTuY.js",
=======
  "_Foo-Bv7I4tRv.js": {
    "file": "assets/Foo-Bv7I4tRv.js",
>>>>>>> master
    "name": "Foo"
  }
}`;
      const result = resolve(manifest, "build/manifest.json");
      expect(result.hunks[0].type).toBe("value_only_change");
      expect(result.hunks[0].confidence).toBe("high");
      expect(result.stats.autoResolved).toBe(1);
      // Should take theirs
      expect(result.mergedContent).toContain("Bv7I4tRv");
      expect(result.mergedContent).not.toContain("DIwZRTuY");
    });

    it("detects version-only changes in diff2", () => {
      const lockEntry = `<<<<<<< HEAD
      "version": "3.2.1",
      "resolved": "https://registry.npmjs.org/foo/-/foo-3.2.1.tgz",
      "integrity": "sha512-abc123def456"
=======
      "version": "3.3.0",
      "resolved": "https://registry.npmjs.org/foo/-/foo-3.3.0.tgz",
      "integrity": "sha512-xyz789ghi012"
>>>>>>> master`;
      const result = resolve(lockEntry, "package-lock.json");
      expect(result.hunks[0].type).toBe("value_only_change");
      expect(result.stats.autoResolved).toBe(1);
    });

    it("does NOT classify as value_only when structure differs", () => {
      const diff = `<<<<<<< HEAD
export const API_URL = "https://staging.example.com";
export const TIMEOUT = 5000;
export const DEBUG = true;
=======
export const API_URL = "https://production.example.com";
export const TIMEOUT = 5000;
>>>>>>> master`;
      const result = resolve(diff, "config.ts");
      // Different number of lines → not value_only
      expect(result.hunks[0].type).toBe("complex");
    });
  });

  describe("diff2: delete_no_change (sans base)", () => {
    it("detects deletion by ours (empty ours, non-empty theirs)", () => {
      const diff = `before
<<<<<<< HEAD
=======
  some old code;
>>>>>>> master
after`;
      const result = resolve(diff, "file.ts", { minConfidence: "medium" });
      expect(result.hunks[0].type).toBe("delete_no_change");
      expect(result.hunks[0].confidence).toBe("medium");
      expect(result.stats.autoResolved).toBe(1);
      expect(result.mergedContent).toBe("before\nafter");
    });

    it("detects deletion by theirs (non-empty ours, empty theirs)", () => {
      const diff = `before
<<<<<<< HEAD
  some old code;
=======
>>>>>>> master
after`;
      const result = resolve(diff, "file.ts", { minConfidence: "medium" });
      expect(result.hunks[0].type).toBe("delete_no_change");
      expect(result.stats.autoResolved).toBe(1);
    });
  });

  describe("generated file detection", () => {
    it("reclassifies truly complex conflicts in .min.js as generated_file", () => {
      // Minified code with structural differences (not just value changes)
      const minJs = `<<<<<<< HEAD
!function(){var a=1;console.log(a);doStuff()}();
=======
!function(){var b=2;alert(b);doOther();cleanup()}();
>>>>>>> master`;
      const result = resolve(minJs, "public/dist/app.min.js", { minConfidence: "medium" });
      expect(result.hunks[0].type).toBe("generated_file");
      expect(result.stats.autoResolved).toBe(1);
    });

    it("reclassifies complex conflicts in package-lock.json as generated_file", () => {
      const lockJson = `<<<<<<< HEAD
    "node_modules/foo": {
      "version": "1.0.0",
      "requires": { "bar": "^2.0" }
    }
=======
    "node_modules/foo": {
      "version": "1.1.0",
      "requires": { "bar": "^2.0", "baz": "^1.0" }
    }
>>>>>>> master`;
      const result = resolve(lockJson, "package-lock.json", { minConfidence: "medium" });
      expect(result.hunks[0].type).toBe("generated_file");
      expect(result.stats.autoResolved).toBe(1);
    });

    it("reclassifies complex in build/manifest.json as generated_file", () => {
      const manifest = `<<<<<<< HEAD
  "resources/js/app.js": {
    "file": "assets/app-abc.js",
    "css": ["assets/app-abc.css"]
  }
=======
  "resources/js/app.js": {
    "file": "assets/app-xyz.js",
    "css": ["assets/app-xyz.css"],
    "extra": true
  }
>>>>>>> master`;
      const result = resolve(manifest, "public/build/manifest.json", { minConfidence: "medium" });
      expect(result.hunks[0].type).toBe("generated_file");
      expect(result.stats.autoResolved).toBe(1);
    });

    it("does NOT mark normal .ts files as generated", () => {
      const ts = `<<<<<<< HEAD
const x = 1;
=======
const x = 2;
>>>>>>> master`;
      const result = resolve(ts, "src/utils/config.ts");
      expect(result.hunks[0].type).not.toBe("generated_file");
    });
  });
});
