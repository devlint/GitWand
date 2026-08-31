/**
 * accuracy lot D — Registre des écosystèmes régénérables (v1).
 *
 * Le moteur n'exécute jamais de commande : il se contente de savoir, pour un
 * chemin de fichier généré donné, QUELLE commande le régénérerait et QUELS
 * fichiers doivent être propres au préalable (`sourcesOfTruth`). L'exécution
 * elle-même appartient toujours à l'appelant (CLI aujourd'hui, desktop plus
 * tard) — voir `plan.ts` et le brief de la tâche.
 *
 * v1 est délibérément restreint aux écosystèmes qui exposent un mode
 * "lockfile-only" ET une façon de couper les scripts de cycle de vie :
 * `go.sum`, `Gemfile.lock`, `poetry.lock` et la régénération de snapshots
 * (`jest -u`) sont hors scope v1 (exécutent du code arbitraire du dépôt).
 *
 * Contrainte globale : les flags de suppression de scripts sont des
 * CONSTANTES du registre, jamais quelque chose que l'appelant peut
 * surcharger. Une entrée sans eux ne doit pas passer la revue de code.
 */

/** accuracy lot D — un écosystème que le tier de régénération sait piloter. */
export interface RegenEcosystem {
  id: "npm" | "pnpm" | "yarn-berry" | "composer" | "cargo";
  /** Le fichier généré que possède cette entrée (matche GENERATED_FILE_PATTERNS). */
  lockfile: RegExp;
  /** Fichiers qui doivent être propres (ou résolus par le moteur) avant régénération. */
  sourcesOfTruth: string[];
  /** Commande lockfile-only, scripts coupés. Jamais un install complet. */
  command: { bin: string; args: string[] };
  network: "required" | "offline-capable";
  defaultTimeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * v1 registry — 5 entrées, une par écosystème supporté. Voir le brief de la
 * tâche (§ "v1 registry") pour la justification de chaque commande exacte.
 */
export const REGEN_ECOSYSTEMS: readonly RegenEcosystem[] = [
  {
    id: "npm",
    lockfile: /package-lock\.json$/i,
    sourcesOfTruth: ["package.json"],
    command: { bin: "npm", args: ["install", "--package-lock-only", "--ignore-scripts"] },
    network: "required",
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  },
  {
    id: "pnpm",
    lockfile: /pnpm-lock\.yaml$/i,
    sourcesOfTruth: ["package.json"],
    command: { bin: "pnpm", args: ["install", "--lockfile-only", "--ignore-scripts"] },
    network: "required",
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  },
  {
    id: "yarn-berry",
    lockfile: /yarn\.lock$/i,
    // Ruling P-3 (brief) — yarn.lock est matché sans distinction classic/berry
    // par GENERATED_FILE_PATTERNS, mais v1 ne pilote QUE berry (`--mode=update-lockfile`
    // n'existe pas en classic). `.yarnrc.yml` est le marqueur berry : en son
    // absence (ou conflit), le plan est non-runnable — voir plan.ts.
    sourcesOfTruth: ["package.json", ".yarnrc.yml"],
    // `--mode=update-lockfile` ne fait jamais tourner d'install ni de scripts de
    // cycle de vie (postinstall…) : il ne fait que mettre à jour le lockfile.
    command: { bin: "yarn", args: ["install", "--mode=update-lockfile"] },
    network: "required",
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  },
  {
    id: "composer",
    lockfile: /composer\.lock$/i,
    sourcesOfTruth: ["composer.json"],
    command: { bin: "composer", args: ["update", "--lock", "--no-scripts", "--no-install"] },
    network: "required",
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  },
  {
    id: "cargo",
    lockfile: /Cargo\.lock$/i,
    sourcesOfTruth: ["Cargo.toml"],
    // `generate-lockfile` résout les dépendances, il ne construit jamais rien :
    // aucun build.rs ni script de cycle de vie ne s'exécute.
    command: { bin: "cargo", args: ["generate-lockfile"] },
    network: "offline-capable",
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  },
];

/**
 * Retourne l'entrée du registre dont `lockfile` matche `path`, ou `undefined`
 * si aucune ne correspond (ex: `.min.js` — généré mais hors registre v1).
 */
export function findEcosystem(path: string): RegenEcosystem | undefined {
  return REGEN_ECOSYSTEMS.find((eco) => eco.lockfile.test(path));
}
