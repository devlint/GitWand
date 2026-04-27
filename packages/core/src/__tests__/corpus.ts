/**
 * GitWand — Corpus de conflits de référence
 *
 * Phase 7.5 : 20 fixtures réalistes couvrant tous les types de conflit,
 * les deux formats (diff2 / diff3), et différents types de fichiers.
 *
 * Chaque fixture définit :
 * - `input`           : le fichier avec marqueurs de conflit
 * - `expectedType`    : le type attendu (ex: "same_change")
 * - `expectedResolved`: si le moteur doit auto-résoudre
 * - `expectedOutput`  : le contenu attendu après résolution (optionnel)
 * - `category`        : famille du conflit
 */

import type { ConflictType, GitWandOptions } from "../types.js";

// ─── Interface ─────────────────────────────────────────────

export interface CorpusFixture {
  id: string;
  description: string;
  filePath: string;
  input: string;
  expectedType: ConflictType;
  expectedResolved: boolean;
  /** Contenu mergé attendu (null = non résolu, undefined = ne pas vérifier) */
  expectedOutput?: string | null;
  category: "trivial" | "structural" | "semantic" | "format-aware" | "complex";
  options?: GitWandOptions;
}

// ─── Trivial — same_change ──────────────────────────────────

const F01: CorpusFixture = {
  id: "F01",
  description: "same_change — même import ajouté des deux côtés (diff3)",
  filePath: "src/utils.ts",
  category: "trivial",
  input: [
    `<<<<<<< ours`,
    `import { z } from "zod";`,
    `import { resolve } from "path";`,
    `||||||| base`,
    `import { resolve } from "path";`,
    `=======`,
    `import { z } from "zod";`,
    `import { resolve } from "path";`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "same_change",
  expectedResolved: true,
  expectedOutput: `import { z } from "zod";\nimport { resolve } from "path";`,
};

const F02: CorpusFixture = {
  id: "F02",
  description: "same_change — même bump de version dans package.json (diff3)",
  filePath: "package.json",
  category: "trivial",
  input: [
    `<<<<<<< ours`,
    `  "version": "2.1.0",`,
    `||||||| base`,
    `  "version": "2.0.0",`,
    `=======`,
    `  "version": "2.1.0",`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "same_change",
  expectedResolved: true,
  expectedOutput: `  "version": "2.1.0",`,
};

// ─── Trivial — one_side_change ──────────────────────────────

const F03: CorpusFixture = {
  id: "F03",
  description: "one_side_change — refactoring theirs uniquement (diff3)",
  filePath: "src/api/client.ts",
  category: "trivial",
  input: [
    `<<<<<<< ours`,
    `async function fetchUser(id: string) {`,
    `  return fetch(\`/api/users/\${id}\`);`,
    `}`,
    `||||||| base`,
    `async function fetchUser(id: string) {`,
    `  return fetch(\`/api/users/\${id}\`);`,
    `}`,
    `=======`,
    `async function fetchUser(id: string): Promise<Response> {`,
    `  return fetch(\`/api/users/\${id}\`, { credentials: "include" });`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "one_side_change",
  expectedResolved: true,
};

const F04: CorpusFixture = {
  id: "F04",
  description: "one_side_change — mise à jour couleur ours uniquement (diff3)",
  filePath: "src/styles/theme.css",
  category: "trivial",
  input: [
    `<<<<<<< ours`,
    `  --color-primary: #3b82f6;`,
    `  --color-secondary: #64748b;`,
    `||||||| base`,
    `  --color-primary: #2563eb;`,
    `  --color-secondary: #64748b;`,
    `=======`,
    `  --color-primary: #2563eb;`,
    `  --color-secondary: #64748b;`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "one_side_change",
  expectedResolved: true,
};

// ─── Trivial — delete_no_change ────────────────────────────

const F05: CorpusFixture = {
  id: "F05",
  description: "delete_no_change — ours supprime une fonction dépréciée (diff3)",
  filePath: "src/helpers.ts",
  category: "trivial",
  input: [
    `<<<<<<< ours`,
    `||||||| base`,
    `/** @deprecated Use formatDate() instead */`,
    `function legacyFormat(d: Date) {`,
    `  return d.toISOString();`,
    `}`,
    `=======`,
    `/** @deprecated Use formatDate() instead */`,
    `function legacyFormat(d: Date) {`,
    `  return d.toISOString();`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "delete_no_change",
  expectedResolved: true,
  expectedOutput: "",
};

const F06: CorpusFixture = {
  id: "F06",
  // theirs retire un import inutilisé → one_side_change (theirs ≠ base, ours = base)
  // delete_no_change requiert theirsLines.length === 0 (suppression totale)
  description: "one_side_change — theirs supprime un import inutilisé (diff3)",
  filePath: "src/components/Button.vue",
  category: "trivial",
  input: [
    `<<<<<<< ours`,
    `import { ref, computed } from "vue";`,
    `import { storeToRefs } from "pinia";`,
    `||||||| base`,
    `import { ref, computed } from "vue";`,
    `import { storeToRefs } from "pinia";`,
    `=======`,
    `import { ref, computed } from "vue";`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "one_side_change",
  expectedResolved: true,
};

// ─── Structural — non_overlapping ──────────────────────────

const F07: CorpusFixture = {
  id: "F07",
  // ours ajoute avant useCartStore, theirs ajoute APRÈS useCartStore → positions distinctes
  description: "non_overlapping — imports ajoutés en tête et en queue (diff3)",
  filePath: "src/store/index.ts",
  category: "structural",
  input: [
    `<<<<<<< ours`,
    `import { defineStore } from "pinia";`,
    `import { useAuthStore } from "./auth";`,
    `import { useCartStore } from "./cart";`,
    `||||||| base`,
    `import { defineStore } from "pinia";`,
    `import { useCartStore } from "./cart";`,
    `=======`,
    `import { defineStore } from "pinia";`,
    `import { useCartStore } from "./cart";`,
    `import { useProductStore } from "./products";`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "non_overlapping",
  expectedResolved: true,
};

const F08: CorpusFixture = {
  id: "F08",
  description: "non_overlapping — champs JSON ajoutés dans deux zones séparées (diff3)",
  filePath: ".env.schema.json",
  category: "structural",
  input: [
    `<<<<<<< ours`,
    `{`,
    `  "APP_NAME": { "type": "string" },`,
    `  "API_URL": { "type": "string" },`,
    `  "DB_HOST": { "type": "string" },`,
    `  "DB_PORT": { "type": "number" }`,
    `}`,
    `||||||| base`,
    `{`,
    `  "APP_NAME": { "type": "string" },`,
    `  "DB_HOST": { "type": "string" },`,
    `  "DB_PORT": { "type": "number" }`,
    `}`,
    `=======`,
    `{`,
    `  "APP_NAME": { "type": "string" },`,
    `  "DB_HOST": { "type": "string" },`,
    `  "DB_PORT": { "type": "number" },`,
    `  "REDIS_URL": { "type": "string" }`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "non_overlapping",
  expectedResolved: true,
};

// ─── Structural — whitespace_only ──────────────────────────

const F09: CorpusFixture = {
  id: "F09",
  // ours = 4 espaces, base = 2 espaces, theirs = 2 espaces
  // → theirs = base, seul ours a changé → one_side_change
  // Pour avoir whitespace_only, il faut que OURS et THEIRS diffèrent tous deux de la base
  // mais uniquement en whitespace — ex: base=2esp, ours=4esp, theirs=tabs
  description: "one_side_change — reformatage ours uniquement (diff3, theirs = base)",
  filePath: "src/utils/date.ts",
  category: "structural",
  input: [
    `<<<<<<< ours`,
    `function formatDate(date: Date): string {`,
    `    const year = date.getFullYear();`,
    `    const month = String(date.getMonth() + 1).padStart(2, "0");`,
    `    return \`\${year}-\${month}\`;`,
    `}`,
    `||||||| base`,
    `function formatDate(date: Date): string {`,
    `  const year = date.getFullYear();`,
    `  const month = String(date.getMonth() + 1).padStart(2, "0");`,
    `  return \`\${year}-\${month}\`;`,
    `}`,
    `=======`,
    `function formatDate(date: Date): string {`,
    `  const year = date.getFullYear();`,
    `  const month = String(date.getMonth() + 1).padStart(2, "0");`,
    `  return \`\${year}-\${month}\`;`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "one_side_change",
  expectedResolved: true,
};

const F10: CorpusFixture = {
  id: "F10",
  description: "whitespace_only — reformatage CSS, sans base (diff2)",
  filePath: "src/styles/reset.css",
  category: "structural",
  input: [
    `<<<<<<< ours`,
    `*,`,
    `*::before,`,
    `*::after {`,
    `    box-sizing: border-box;`,
    `    margin: 0;`,
    `    padding: 0;`,
    `}`,
    `=======`,
    `*,`,
    `*::before,`,
    `*::after {`,
    `  box-sizing: border-box;`,
    `  margin: 0;`,
    `  padding: 0;`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "whitespace_only",
  expectedResolved: true,
};

// ─── Semantic — value_only_change ──────────────────────────

const F11: CorpusFixture = {
  id: "F11",
  description: "value_only_change — hash Vite d'assets différents (diff2)",
  filePath: "dist/manifest.json",
  category: "semantic",
  input: [
    `<<<<<<< ours`,
    `  "src/main.ts": {`,
    `    "file": "assets/main-BVdDe8aQ.js",`,
    `    "css": ["assets/main-C1xPLZoN.css"]`,
    `  }`,
    `=======`,
    `  "src/main.ts": {`,
    `    "file": "assets/main-Dx9QwPzM.js",`,
    `    "css": ["assets/main-Bz7KpRvN.css"]`,
    `  }`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "value_only_change",
  expectedResolved: true,
};

const F12: CorpusFixture = {
  id: "F12",
  description: "value_only_change — bump de semver dans package.json (diff2)",
  filePath: "package.json",
  category: "semantic",
  input: [
    `<<<<<<< ours`,
    `  "dependencies": {`,
    `    "vue": "^3.4.15",`,
    `    "pinia": "^2.1.7"`,
    `  }`,
    `=======`,
    `  "dependencies": {`,
    `    "vue": "^3.4.21",`,
    `    "pinia": "^2.1.7"`,
    `  }`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "value_only_change",
  expectedResolved: true,
  options: { minConfidence: "medium" },
};

// ─── Semantic — generated_file ──────────────────────────────

const F13: CorpusFixture = {
  id: "F13",
  // hash/version/URL = tokens volatiles → value_only_change (avant le reclassement generated_file)
  // generated_file n'est déclenché que sur les hunks complex — ici le moteur détecte
  // d'abord value_only_change (tous les tokens différents sont des volatils)
  description: "value_only_change — package-lock.json : version bump + hash (diff2)",
  filePath: "package-lock.json",
  category: "semantic",
  input: [
    `<<<<<<< ours`,
    `  "node_modules/typescript": {`,
    `    "version": "5.3.3",`,
    `    "resolved": "https://registry.npmjs.org/typescript/-/typescript-5.3.3.tgz",`,
    `    "integrity": "sha512-pXWcraxM0uxAS+tN0AG/BF2TyqmHO014Z070UsJ+pFvYuRSq8KH8DmWpnbXe0pEPDHXZV3FcAbJkijJ5oqEnVA=="`,
    `  }`,
    `=======`,
    `  "node_modules/typescript": {`,
    `    "version": "5.4.5",`,
    `    "resolved": "https://registry.npmjs.org/typescript/-/typescript-5.4.5.tgz",`,
    `    "integrity": "sha512-vcI4UpRgg81oIRUFwR0WSIHKt11nJ7SAVlYNIu+QpqeyXP+gpQJy/Z4+F0aGxSE4MqZ0ytsUoiWZ2SDcTib8w=="`,
    `  }`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "value_only_change",
  expectedResolved: true,
  options: { minConfidence: "medium" },
};

const F14: CorpusFixture = {
  id: "F14",
  // build/manifest.json avec structure identique, hashes différents → value_only_change
  // Le reclassement generated_file ne se fait que depuis complex (sans base, le
  // résolveur détecte ici des tokens volatils → value_only_change en priorité)
  description: "generated_file — build/manifest.json : reclassifié, résolu via theirs",
  filePath: "public/build/manifest.json",
  category: "semantic",
  input: [
    `<<<<<<< ours`,
    `{"/js/app.js": "/js/app.abc123.js", "/css/app.css": "/css/app.def456.css"}`,
    `||||||| base`,
    `{"/js/app.js": "/js/app.aaa000.js", "/css/app.css": "/css/app.aaa000.css"}`,
    `=======`,
    `{"/js/app.js": "/js/app.xyz789.js", "/css/app.css": "/css/app.uvw012.css"}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  // diff3 + les deux côtés changent + tokens non-volatils (clés) → complex → generated_file
  expectedType: "generated_file",
  expectedResolved: true,
};

// ─── Format-aware — JSON sémantique ────────────────────────

const F15: CorpusFixture = {
  id: "F15",
  description: "format-aware JSON — dépendances ajoutées des deux côtés (fichier entier)",
  filePath: "config.json",
  category: "format-aware",
  input: [
    `<<<<<<< ours`,
    `{`,
    `  "name": "my-app",`,
    `  "version": "1.0.0",`,
    `  "features": ["auth", "logging"]`,
    `}`,
    `||||||| base`,
    `{`,
    `  "name": "my-app",`,
    `  "version": "1.0.0",`,
    `  "features": ["auth"]`,
    `}`,
    `=======`,
    `{`,
    `  "name": "my-app",`,
    `  "version": "1.0.0",`,
    `  "features": ["auth"],`,
    `  "theme": "dark"`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  // JSON resolver tenté en premier, peut échouer sur les tableaux → textuel prend le relais
  expectedType: "one_side_change",
  expectedResolved: true,
};

// ─── Format-aware — Markdown section-aware ─────────────────

const F16: CorpusFixture = {
  id: "F16",
  // v1.4 — Le résolveur Markdown merge maintenant les listes à puces en union.
  // theirs a ajouté "- fix: memory leak in session handler" dans [2.1.0].
  // Le merge bullet-list produit: ours items ∪ theirs items → résolu automatiquement.
  description: "format-aware Markdown — bullet-list merge dans une section (diff2, résolu en v1.4)",
  filePath: "CHANGELOG.md",
  category: "format-aware",
  input: [
    `<<<<<<< ours`,
    `# Changelog`,
    ``,
    `## [2.1.0] - 2025-01-15`,
    ``,
    `- feat: new authentication flow`,
    ``,
    `## [2.0.0] - 2024-12-01`,
    ``,
    `- Initial release`,
    `=======`,
    `# Changelog`,
    ``,
    `## [2.1.0] - 2025-01-15`,
    ``,
    `- feat: new authentication flow`,
    `- fix: memory leak in session handler`,
    ``,
    `## [2.0.0] - 2024-12-01`,
    ``,
    `- Initial release`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",       // Le type textuel reste complex (pas de base diff3)
  expectedResolved: true,        // v1.4 : bullet-list merge résout ce cas
  expectedOutput: undefined,     // Contenu vérifié dans les tests Markdown dédiés
};

// ─── Complex — résolution manuelle requise ──────────────────

const F17: CorpusFixture = {
  id: "F17",
  description: "complex — deux branches modifient la même fonction différemment",
  filePath: "src/auth/session.ts",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `export function createSession(userId: string): Session {`,
    `  const token = generateSecureToken(32);`,
    `  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);`,
    `  return { userId, token, expiresAt, createdAt: new Date() };`,
    `}`,
    `||||||| base`,
    `export function createSession(userId: string): Session {`,
    `  const token = generateToken();`,
    `  return { userId, token };`,
    `}`,
    `=======`,
    `export function createSession(userId: string, options: SessionOptions = {}): Session {`,
    `  const token = generateToken();`,
    `  const ttl = options.ttl ?? DEFAULT_TTL;`,
    `  return { userId, token, ttl };`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

const F18: CorpusFixture = {
  id: "F18",
  // v1.4 : les deux branches ont uniquement inséré des gardes différentes
  // sans supprimer de lignes de la base → insertion_at_boundary résout par union.
  // Résultat : [case block] + [cart-full guard] + [dedup guard] + [return] + [}]
  description: "insertion_at_boundary — gardes additives dans un reducer (diff3)",
  filePath: "src/store/cart.ts",
  category: "structural",
  input: [
    `<<<<<<< ours`,
    `case "ADD_ITEM": {`,
    `  if (state.items.length >= MAX_ITEMS) throw new Error("Cart full");`,
    `  return { ...state, items: [...state.items, action.item] };`,
    `}`,
    `||||||| base`,
    `case "ADD_ITEM": {`,
    `  return { ...state, items: [...state.items, action.item] };`,
    `}`,
    `=======`,
    `case "ADD_ITEM": {`,
    `  const existing = state.items.find(i => i.id === action.item.id);`,
    `  if (existing) return { ...state };`,
    `  return { ...state, items: [...state.items, action.item] };`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "insertion_at_boundary",
  expectedResolved: true,
};

// ─── Edge cases ────────────────────────────────────────────

const F19: CorpusFixture = {
  id: "F19",
  description: "delete_no_change (diff2) — ours supprime un bloc (confiance medium)",
  filePath: "src/legacy/adapter.ts",
  category: "structural",
  input: [
    `<<<<<<< ours`,
    `=======`,
    `// @deprecated — migrated to new API`,
    `export function legacyAdapter(data: any) {`,
    `  return { ...data, _migrated: false };`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "delete_no_change",
  expectedResolved: true,
  options: { minConfidence: "medium" },
};

const F20: CorpusFixture = {
  id: "F20",
  description: "value_only_change rejeté — trop de tokens non-volatiles (reste complex)",
  filePath: "src/config/defaults.ts",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `export const CONFIG = {`,
    `  maxRetries: 5,`,
    `  timeout: 30000,`,
    `  baseUrl: "https://api.prod.example.com",`,
    `  debug: false,`,
    `  logLevel: "warn",`,
    `};`,
    `=======`,
    `export const CONFIG = {`,
    `  maxRetries: 3,`,
    `  timeout: 10000,`,
    `  baseUrl: "https://api.staging.example.com",`,
    `  debug: true,`,
    `  logLevel: "debug",`,
    `};`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

// ─── v2.1 — Fixtures « refactor + edit » ────────────────────
//
// Cible les cas où v2.1 (Histogram diff) doit améliorer l'alignement et donc
// soit auto-résoudre, soit promouvoir la classification. `expectedResolved`
// est calibré sur le comportement *réel* après bascule Histogram. Ces fixtures
// servent de filet de régression — si v2.2 (format profiles) déplace une de
// ces lignes vers `expectedResolved: true`, on actualise la fixture.

const F21: CorpusFixture = {
  id: "F21",
  description: "v2.1 — refactor d'imports d'un côté + ajout fonction de l'autre (TS)",
  filePath: "src/handler.ts",
  category: "structural",
  input: [
    `<<<<<<< ours`,
    `import { bar } from "./bar";`,
    `import { foo } from "./foo";`,
    ``,
    `export function main() { return foo() + bar(); }`,
    `||||||| base`,
    `import { foo } from "./foo";`,
    `import { bar } from "./bar";`,
    ``,
    `export function main() { return foo() + bar(); }`,
    `=======`,
    `import { foo } from "./foo";`,
    `import { bar } from "./bar";`,
    ``,
    `export function main() { return foo() + bar(); }`,
    ``,
    `export function helper() { return 42; }`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "non_overlapping",
  expectedResolved: true,
};

const F22: CorpusFixture = {
  id: "F22",
  description: "v2.1 — déplacement bloc CSS d'un côté + modif règle de l'autre",
  filePath: "src/styles/theme.css",
  category: "format-aware",
  input: [
    `<<<<<<< ours`,
    `.header { color: red; }`,
    `.footer { color: green; }`,
    `.body { color: blue; }`,
    `||||||| base`,
    `.header { color: red; }`,
    `.body { color: blue; }`,
    `.footer { color: green; }`,
    `=======`,
    `.header { color: red; }`,
    `.body { color: navy; }`,
    `.footer { color: green; }`,
    `>>>>>>> theirs`,
  ].join("\n"),
  // v2.1 — la classification reste `complex` (le pipeline structural arrive
  // en v2.3, tree-sitter), mais le résolveur format-aware CSS auto-résout
  // grâce au meilleur alignement Histogram en amont.
  expectedType: "complex",
  expectedResolved: true,
};

const F23: CorpusFixture = {
  id: "F23",
  description: "v2.1 — réordonnancement deps package.json + ajout dep côté theirs",
  filePath: "package.json",
  category: "format-aware",
  input: [
    `<<<<<<< ours`,
    `{`,
    `  "name": "demo",`,
    `  "dependencies": {`,
    `    "lodash": "^4.17.0",`,
    `    "react": "^18.2.0"`,
    `  }`,
    `}`,
    `||||||| base`,
    `{`,
    `  "name": "demo",`,
    `  "dependencies": {`,
    `    "react": "^18.2.0",`,
    `    "lodash": "^4.17.0"`,
    `  }`,
    `}`,
    `=======`,
    `{`,
    `  "name": "demo",`,
    `  "dependencies": {`,
    `    "react": "^18.2.0",`,
    `    "lodash": "^4.17.0",`,
    `    "zod": "^3.22.0"`,
    `  }`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  // v2.1 — la combinaison Histogram diff + résolveur JSON sémantique fait
  // passer cette fixture en auto-résolu. L'output exact dépend de l'ordre
  // produit par `mergeObjects`, qu'on ne fige pas ici.
  expectedType: "complex",
  expectedResolved: true,
};

const F24: CorpusFixture = {
  id: "F24",
  description: "v2.1 — k8s yaml : block shuffle d'un côté + edit env var de l'autre",
  filePath: "k8s/deployment.yaml",
  category: "format-aware",
  input: [
    `<<<<<<< ours`,
    `apiVersion: apps/v1`,
    `kind: Deployment`,
    `spec:`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `        - name: sidecar`,
    `          image: sidecar:1.0`,
    `        - name: app`,
    `          image: app:2.0`,
    `||||||| base`,
    `apiVersion: apps/v1`,
    `kind: Deployment`,
    `spec:`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `        - name: app`,
    `          image: app:1.0`,
    `        - name: sidecar`,
    `          image: sidecar:1.0`,
    `=======`,
    `apiVersion: apps/v1`,
    `kind: Deployment`,
    `spec:`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `        - name: app`,
    `          image: app:2.0`,
    `        - name: sidecar`,
    `          image: sidecar:1.0`,
    `>>>>>>> theirs`,
  ].join("\n"),
  // v2.1 — la classification reste `complex` (résolveur YAML structurel
  // arrivera en v2.2 / v2.3) mais Histogram réaligne bien les blocs et le
  // pipeline auto-résout par fallback non-textuel.
  expectedType: "complex",
  expectedResolved: true,
};

const F25: CorpusFixture = {
  id: "F25",
  description: "v2.1 — markdown : swap de sections H2 d'un côté + edit dans une section de l'autre",
  filePath: "docs/guide.md",
  category: "format-aware",
  input: [
    `<<<<<<< ours`,
    `# Guide`,
    ``,
    `## Installation`,
    ``,
    `Run \`npm install\`.`,
    ``,
    `## Usage`,
    ``,
    `Import the module.`,
    `||||||| base`,
    `# Guide`,
    ``,
    `## Usage`,
    ``,
    `Import the module.`,
    ``,
    `## Installation`,
    ``,
    `Run \`npm install\`.`,
    `=======`,
    `# Guide`,
    ``,
    `## Usage`,
    ``,
    `Import the module via \`import x from "y"\`.`,
    ``,
    `## Installation`,
    ``,
    `Run \`npm install\`.`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

// ─── v2.2 — Fixtures « format profiles » ─────────────────────
//
// Cible les cas que v2.2 (registre de profils + RFC 6902) doit débloquer :
// arrays JSON/YAML modifiés des deux côtés sur des paths annotés (set ou
// merge-keys par identité). Les expectedResolved sont calibrés sur le
// comportement réel après hook profils.

const F26: CorpusFixture = {
  id: "F26",
  description: "v2.2 — package.json /keywords ajoutés des deux côtés (set)",
  filePath: "package.json",
  category: "format-aware",
  input: [
    `<<<<<<< ours`,
    `{`,
    `  "name": "demo",`,
    `  "keywords": ["git", "merge"]`,
    `}`,
    `||||||| base`,
    `{`,
    `  "name": "demo",`,
    `  "keywords": ["git"]`,
    `}`,
    `=======`,
    `{`,
    `  "name": "demo",`,
    `  "keywords": ["git", "diff"]`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: true,
};

const F27: CorpusFixture = {
  id: "F27",
  description: "v2.2 — package.json /scripts merge-keys (clés différentes des deux côtés)",
  filePath: "package.json",
  category: "format-aware",
  input: [
    `<<<<<<< ours`,
    `{`,
    `  "name": "demo",`,
    `  "scripts": {`,
    `    "build": "tsc",`,
    `    "lint": "eslint ."`,
    `  }`,
    `}`,
    `||||||| base`,
    `{`,
    `  "name": "demo",`,
    `  "scripts": {`,
    `    "build": "tsc"`,
    `  }`,
    `}`,
    `=======`,
    `{`,
    `  "name": "demo",`,
    `  "scripts": {`,
    `    "build": "tsc",`,
    `    "test": "vitest"`,
    `  }`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "non_overlapping",
  expectedResolved: true,
};

const F28: CorpusFixture = {
  id: "F28",
  description: "v2.2 — tsconfig.json /include divergent (set)",
  filePath: "tsconfig.json",
  category: "format-aware",
  input: [
    `<<<<<<< ours`,
    `{`,
    `  "compilerOptions": { "strict": true },`,
    `  "include": ["src", "tests"]`,
    `}`,
    `||||||| base`,
    `{`,
    `  "compilerOptions": { "strict": true },`,
    `  "include": ["src"]`,
    `}`,
    `=======`,
    `{`,
    `  "compilerOptions": { "strict": true },`,
    `  "include": ["src", "scripts"]`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: true,
};

const F29: CorpusFixture = {
  id: "F29",
  description: "v2.2 — kubernetes Deployment containers mergés par 'name'",
  filePath: "k8s/deployment.yaml",
  category: "format-aware",
  input: [
    `<<<<<<< ours`,
    `apiVersion: apps/v1`,
    `kind: Deployment`,
    `spec:`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `        - name: app`,
    `          image: app:2.0`,
    `        - name: sidecar`,
    `          image: sidecar:1.0`,
    `||||||| base`,
    `apiVersion: apps/v1`,
    `kind: Deployment`,
    `spec:`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `        - name: app`,
    `          image: app:1.0`,
    `=======`,
    `apiVersion: apps/v1`,
    `kind: Deployment`,
    `spec:`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `        - name: app`,
    `          image: app:1.0`,
    `        - name: log-shipper`,
    `          image: fluent-bit:2.0`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: true,
};

const F30: CorpusFixture = {
  id: "F30",
  description: "v2.2 — helm/values.yaml containers env mergés (set par 'name')",
  filePath: "charts/myapp/values.yaml",
  category: "format-aware",
  input: [
    `<<<<<<< ours`,
    `spec:`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `        - name: app`,
    `          image: app:1.0`,
    `        - name: cache`,
    `          image: redis:7`,
    `||||||| base`,
    `spec:`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `        - name: app`,
    `          image: app:1.0`,
    `=======`,
    `spec:`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `        - name: app`,
    `          image: app:1.0`,
    `        - name: metrics`,
    `          image: prom-exporter:0.5`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: true,
};

// ─── Export ─────────────────────────────────────────────────

export const CORPUS: CorpusFixture[] = [
  F01, F02, F03, F04, F05,
  F06, F07, F08, F09, F10,
  F11, F12, F13, F14, F15,
  F16, F17, F18, F19, F20,
  // v2.1
  F21, F22, F23, F24, F25,
  // v2.2
  F26, F27, F28, F29, F30,
];

/** Résumé par catégorie */
export const CORPUS_CATEGORIES = {
  trivial: CORPUS.filter(f => f.category === "trivial"),
  structural: CORPUS.filter(f => f.category === "structural"),
  semantic: CORPUS.filter(f => f.category === "semantic"),
  "format-aware": CORPUS.filter(f => f.category === "format-aware"),
  complex: CORPUS.filter(f => f.category === "complex"),
};
