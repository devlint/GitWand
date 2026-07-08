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

// ─── v2.4 — Fixtures « parse-tree validation » ──────────────
//
// Cas où la validation parse-tree (tree-sitter) est pertinente :
// résolutions qui produisent du code potentiellement invalide ou
// qui testent la robustesse du moteur face à la rétraction.
//
// Principe #6 (roadmap) : +5 fixtures par release. Ces fixtures
// sont annotées `expectedResolved: false` quand la rétraction parse-tree
// devrait invalider la résolution — mais comme tree-sitter est optional,
// le comportement réel peut varier selon l'environnement.

const F31: CorpusFixture = {
  id: "F31",
  description: "v2.4 — same_change sur une ligne TypeScript complète (parse safe)",
  filePath: "src/index.ts",
  category: "trivial",
  input: [
    `<<<<<<< ours`,
    `export const VERSION = "2.4.0";`,
    `||||||| base`,
    `export const VERSION = "2.3.0";`,
    `=======`,
    `export const VERSION = "2.4.0";`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "same_change",
  expectedResolved: true,
  expectedOutput: `export const VERSION = "2.4.0";`,
};

const F32: CorpusFixture = {
  id: "F32",
  description: "v2.4 — one_side_change : ours ajoute un type annotation (parse safe)",
  filePath: "src/parser.ts",
  category: "trivial",
  input: [
    `<<<<<<< ours`,
    `export function parse(input: string): ParseResult {`,
    `  return { ok: true };`,
    `}`,
    `||||||| base`,
    `export function parse(input) {`,
    `  return { ok: true };`,
    `}`,
    `=======`,
    `export function parse(input) {`,
    `  return { ok: true };`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "one_side_change",
  expectedResolved: true,
};

const F33: CorpusFixture = {
  id: "F33",
  description: "v2.4 — insertion_at_boundary : deux imports TS ajoutés côté différent (parse safe)",
  filePath: "src/utils.ts",
  category: "structural",
  input: [
    `<<<<<<< ours`,
    `import { A } from "./a";`,
    `import { B } from "./b";`,
    `import { X } from "./x";`,
    `||||||| base`,
    `import { A } from "./a";`,
    `import { B } from "./b";`,
    `=======`,
    `import { A } from "./a";`,
    `import { B } from "./b";`,
    `import { Y } from "./y";`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "insertion_at_boundary",
  expectedResolved: true,
};

const F34: CorpusFixture = {
  id: "F34",
  description: "v2.4 — complex : deux modifications incompatibles d'une signature TS",
  filePath: "src/api.ts",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `export async function fetchUser(id: string, opts?: RequestInit): Promise<User> {`,
    `  return fetch(\`/api/users/\${id}\`, opts).then(r => r.json());`,
    `}`,
    `||||||| base`,
    `export async function fetchUser(id: string): Promise<User> {`,
    `  return fetch(\`/api/users/\${id}\`).then(r => r.json());`,
    `}`,
    `=======`,
    `export async function fetchUser(id: number): Promise<User> {`,
    `  return fetch(\`/api/users/\${id}\`).then(r => r.json());`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

const F35: CorpusFixture = {
  id: "F35",
  description: "v2.4 — value_only_change : hash de commit dans un lockfile TS (diff2, parse safe)",
  filePath: "src/generated/checksums.ts",
  category: "semantic",
  // diff2 : pas de base — le détecteur heuristique de valeurs volatiles s'applique
  input: [
    `<<<<<<< ours`,
    `export const SCHEMA_HASH = "a1b2c3d4e5f67890";`,
    `=======`,
    `export const SCHEMA_HASH = "f9e8d7c6b5a43210";`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "value_only_change",
  expectedResolved: true,
};

// ─── v2.5 — Fixtures LLM fallback candidates ────────────────
//
// Ces fixtures documentent les conflits que le LLM fallback est censé
// améliorer. Sans LLM activé, ils restent tous "complex" et non résolus.
// Les tests async dans llm-proposed.test.ts valident la résolution avec mock.

const F36: CorpusFixture = {
  id: "F36",
  description: "v2.5 — complex : signature de fonction refactorisée des deux côtés (TS, diff3)",
  filePath: "src/api/handler.ts",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `export async function handleRequest(ctx: RequestContext, opts?: HandlerOptions): Promise<Response> {`,
    `||||||| base`,
    `export function handleRequest(ctx: Context): Response {`,
    `=======`,
    `export async function handleRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

const F37: CorpusFixture = {
  id: "F37",
  description: "v2.5 — complex : bloc try/catch réorganisé différemment des deux côtés (TS, diff3)",
  filePath: "src/utils/fetch.ts",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `  try {`,
    `    const data = await fetchWithRetry(url, { retries: 3 });`,
    `    return data.json();`,
    `  } catch (err) {`,
    `    logger.error("fetch failed", { url, err });`,
    `    throw new FetchError(url, err);`,
    `  }`,
    `||||||| base`,
    `  try {`,
    `    return await fetch(url).then(r => r.json());`,
    `  } catch (err) {`,
    `    throw err;`,
    `  }`,
    `=======`,
    `  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });`,
    `  if (!res.ok) throw new HttpError(res.status, url);`,
    `  return res.json();`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

const F38: CorpusFixture = {
  id: "F38",
  description: "v2.5 — complex : interface TS — les deux côtés modifient le même champ existant (diff3)",
  filePath: "src/types/config.ts",
  category: "complex",
  // Les deux côtés changent le type de "host" — modification incompatible, pas une insertion pure
  input: [
    `<<<<<<< ours`,
    `export interface Config {`,
    `  host: URL;`,
    `  port: number;`,
    `}`,
    `||||||| base`,
    `export interface Config {`,
    `  host: string;`,
    `  port: number;`,
    `}`,
    `=======`,
    `export interface Config {`,
    `  host: string | URL;`,
    `  port: number;`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

const F39: CorpusFixture = {
  id: "F39",
  description: "v2.5 — complex : switch/case enrichi des deux côtés (TS, diff3)",
  filePath: "src/reducers/app.ts",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `    case "SET_USER":`,
    `      return { ...state, user: action.payload, isAuthenticated: true };`,
    `    case "CLEAR_USER":`,
    `      return { ...state, user: null, isAuthenticated: false };`,
    `||||||| base`,
    `    case "SET_USER":`,
    `      return { ...state, user: action.payload };`,
    `=======`,
    `    case "SET_USER":`,
    `      return { ...state, user: action.payload, lastLogin: Date.now() };`,
    `    case "UPDATE_USER":`,
    `      return { ...state, user: { ...state.user, ...action.payload } };`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

const F40: CorpusFixture = {
  id: "F40",
  description: "v2.5 — complex : SQL query refactorisée (diff2, schema change)",
  filePath: "src/db/queries.ts",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `  const rows = await db.query(`,
    `    "SELECT id, email, role FROM users WHERE active = true AND created_at > $1",`,
    `    [sinceDate]`,
    `  );`,
    `=======`,
    `  const rows = await db.query(`,
    `    "SELECT u.id, u.email, r.name as role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.is_active = 1",`,
    `  );`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

const F41: CorpusFixture = {
  id: "F41",
  description: "v2.5 — complex : configuration Vite/rollup divergente (diff3)",
  filePath: "vite.config.ts",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `  build: {`,
    `    target: "es2022",`,
    `    outDir: "dist",`,
    `    sourcemap: true,`,
    `    minify: "esbuild",`,
    `  },`,
    `||||||| base`,
    `  build: {`,
    `    target: "es2020",`,
    `    outDir: "dist",`,
    `  },`,
    `=======`,
    `  build: {`,
    `    target: "esnext",`,
    `    outDir: "public/build",`,
    `    sourcemap: false,`,
    `    rollupOptions: { external: ["fs", "path"] },`,
    `  },`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

const F42: CorpusFixture = {
  id: "F42",
  description: "v2.5 — complex : test Vitest restructuré des deux côtés (diff3)",
  filePath: "src/__tests__/auth.test.ts",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `  it("rejects expired tokens", async () => {`,
    `    const token = createToken({ exp: Date.now() - 1000 });`,
    `    await expect(verifyToken(token)).rejects.toThrow(TokenExpiredError);`,
    `  });`,
    `||||||| base`,
    `  it("rejects invalid tokens", async () => {`,
    `    await expect(verifyToken("bad")).rejects.toThrow();`,
    `  });`,
    `=======`,
    `  it("rejects expired tokens", async () => {`,
    `    vi.setSystemTime(new Date("2020-01-01"));`,
    `    const token = await signToken({ sub: "user1" }, { expiresIn: "1s" });`,
    `    vi.setSystemTime(new Date("2020-01-02"));`,
    `    await expect(verifyToken(token)).rejects.toThrow("TokenExpired");`,
    `  });`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

const F43: CorpusFixture = {
  id: "F43",
  description: "v2.5 — complex : Rust match arm enrichi (diff3)",
  filePath: "src-tauri/src/commands.rs",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `        GitOperation::Merge => merge_branch(&repo, &args.branch, MergeStrategy::Ours)?,`,
    `        GitOperation::Rebase => rebase_onto(&repo, &args.branch)?,`,
    `||||||| base`,
    `        GitOperation::Merge => merge_branch(&repo, &args.branch)?,`,
    `=======`,
    `        GitOperation::Merge => merge_branch(&repo, &args.branch, MergeStrategy::Recursive)?,`,
    `        GitOperation::CherryPick => cherry_pick(&repo, &args.commit_sha)?,`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

const F44: CorpusFixture = {
  id: "F44",
  description: "v2.5 — complex : CSS media query conflictuelle (diff2)",
  filePath: "src/styles/responsive.css",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `@media (max-width: 768px) {`,
    `  .container { padding: 0 16px; max-width: 100%; }`,
    `  .sidebar { display: none; }`,
    `  .main { grid-column: 1 / -1; }`,
    `}`,
    `=======`,
    `@media (max-width: 640px) {`,
    `  .container { padding: 0 12px; }`,
    `  .nav { flex-direction: column; }`,
    `}`,
    `@media (max-width: 768px) {`,
    `  .sidebar { position: fixed; transform: translateX(-100%); }`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

const F45: CorpusFixture = {
  id: "F45",
  description: "v2.5 — complex : Python class method overriding (diff3)",
  filePath: "src/models/user.py",
  category: "complex",
  input: [
    `<<<<<<< ours`,
    `    def validate(self, data: dict) -> ValidationResult:`,
    `        errors = []`,
    `        if not data.get("email"):`,
    `            errors.append(ValidationError("email", "required"))`,
    `        if len(data.get("password", "")) < 12:`,
    `            errors.append(ValidationError("password", "min_length:12"))`,
    `        return ValidationResult(errors)`,
    `||||||| base`,
    `    def validate(self, data: dict) -> bool:`,
    `        return bool(data.get("email") and data.get("password"))`,
    `=======`,
    `    def validate(self, data: dict) -> ValidationResult:`,
    `        schema = UserSchema()`,
    `        return schema.validate(data)`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "complex",
  expectedResolved: false,
  expectedOutput: null,
};

// ─── Régression — deux lignes adjacentes, conflit token-level par ligne ──
// Motivé par un cas réel signalé sur resources/views/gestion/upsells/suggestions/index.blade.php
// (deux lignes HTML adjacentes, classes utilitaires Tailwind modifiées des deux côtés).
// Remarque : la variante "un seul côté change par ligne" est déjà couverte par
// non_overlapping (vérifié pendant l'implémentation — LCS 3-way la résout sans ce
// pattern). Ce cas-ci a les DEUX côtés qui modifient chaque ligne avec des tokens
// disjoints — non_overlapping échoue (chevauchement réel), seul token_level_merge résout.
const F46: CorpusFixture = {
  id: "F46",
  description: "v2.7 — token_level_merge : classes Tailwind, tokens disjoints sur 2 lignes adjacentes",
  filePath: "resources/views/gestion/upsells/suggestions/index.blade.php",
  category: "semantic",
  input: [
    `<<<<<<< ours`,
    `            <div class="flex items-baseline a b mr-2">`,
    `                <label class="font-weight-bold c d">`,
    `||||||| base`,
    `            <div class="flex items-baseline a2 b mr-2">`,
    `                <label class="font-weight-bold c2 d">`,
    `=======`,
    `            <div class="flex items-baseline a2 b2 mr-2">`,
    `                <label class="font-weight-bold c d2">`,
    `>>>>>>> theirs`,
  ].join("\n"),
  expectedType: "token_level_merge",
  expectedResolved: false,
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
  // v2.4
  F31, F32, F33, F34, F35,
  // v2.5 — LLM fallback candidates (complex sans LLM, résolus avec LLM mocké)
  F36, F37, F38, F39, F40,
  F41, F42, F43, F44, F45,
  // v2.7 — token_level_merge
  F46,
];

/** Résumé par catégorie */
export const CORPUS_CATEGORIES = {
  trivial: CORPUS.filter(f => f.category === "trivial"),
  structural: CORPUS.filter(f => f.category === "structural"),
  semantic: CORPUS.filter(f => f.category === "semantic"),
  "format-aware": CORPUS.filter(f => f.category === "format-aware"),
  complex: CORPUS.filter(f => f.category === "complex"),
};
