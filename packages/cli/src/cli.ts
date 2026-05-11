/**
 * Parser de CLI + dispatcher de commandes.
 *
 * Ce module isole la partie « front » du CLI :
 *  - parse `process.argv` en `{ command, positional, flags }`,
 *  - imprime l'aide (`printHelp`),
 *  - dispatch vers `commands/resolve` ou `commands/status`.
 *
 * Les commandes et la mécanique de parallélisation vivent dans des
 * modules dédiés. Ici on reste volontairement léger — c'est le point
 * d'entrée lisible du binaire `gitwand`.
 *
 * Parser de flags :
 *  - `--key`          → `flags.key = true`
 *  - `--key=value`    → `flags.key = value`  (requis pour `--concurrency=N`)
 *
 * Tout token ne commençant pas par `--` est considéré comme positionnel.
 */

import { c, printBanner } from "./ui.js";
import { DEFAULT_CONCURRENCY } from "./concurrency.js";
import { cmdResolve } from "./commands/resolve.js";
import { cmdStatus } from "./commands/status.js";

function printHelp(): void {
  printBanner();
  console.log(`${c.bold}Usage:${c.reset}`);
  console.log(`  gitwand resolve [files...]      Auto-resolve trivial conflicts`);
  console.log(`  gitwand status                  Show conflict status`);
  console.log(`  gitwand --help                  Show this help`);
  console.log();
  console.log(`${c.bold}Options:${c.reset}`);
  console.log(`  --dry-run             Analyze without writing files`);
  console.log(`  --verbose             Show details for each resolution`);
  console.log(`  --no-whitespace       Don't resolve whitespace-only conflicts`);
  console.log(`  --concurrency=N       Parallel file workers (default ${DEFAULT_CONCURRENCY}, min 1)`);
  console.log(`  --ci                  CI mode: JSON output + exit code 1 if unresolved`);
  console.log(`  --json                Output results as JSON (implies --ci behavior)`);
  console.log(`  --llm-fallback        Enable LLM fallback for unresolved conflicts (opt-in, experimental)`);
  console.log(`  --llm-provider=X      LLM provider: claude (default) | openai | ollama`);
  console.log(`  --llm-model=X         Model name (e.g. claude-sonnet-4-6, gpt-4o-mini, llama3)`);
  console.log();
  console.log(`${c.bold}LLM environment:${c.reset}`);
  console.log(`  ANTHROPIC_API_KEY     Required for --llm-provider=claude`);
  console.log(`  OPENAI_API_KEY        Required for --llm-provider=openai`);
  console.log(`  OLLAMA_URL            Optional override (default http://localhost:11434)`);
  console.log();
}

/**
 * Parse `process.argv` (les args utilisateur, sans `node` ni le script) en
 * `{ command, positional, flags }`. Supporte `--flag` et `--key=value`.
 */
export function parseArgs(argv: string[]): {
  command: string | undefined;
  positional: string[];
  flags: Record<string, boolean | string>;
} {
  const command = argv[0];
  const flags: Record<string, boolean | string> = {};
  const positional: string[] = [];

  for (const arg of argv.slice(1)) {
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

/**
 * Point d'entrée logique du CLI. Lit `process.argv`, parse et dispatch.
 * Ne fait jamais de `process.exit` hors des commandes elles-mêmes : le
 * wrapper (`index.ts`) gère les erreurs non rattrapées.
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, positional, flags } = parseArgs(args);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "resolve") {
    await cmdResolve(positional, flags);
  } else if (command === "status") {
    await cmdStatus(flags);
  } else {
    console.error(`${c.red}Unknown command: ${command}${c.reset}`);
    printHelp();
    process.exit(1);
  }
}
