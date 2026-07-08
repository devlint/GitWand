import type { SecretPattern } from "./types.js";

/**
 * v3.5.0 — Catalogue des détecteurs de secrets built-in.
 *
 * Chaque regex reste dans le sous-ensemble commun Rust (`regex` crate) + JS `RegExp` :
 * classes de caractères, ancres, quantifieurs, `\b` — jamais de lookaround ni de backreference.
 * Ce catalogue est mirroré côté Rust (`apps/desktop/src-tauri/src/commands/secrets.rs`) et
 * verrouillé par le test de parité (Task 7) — toute modification doit être répercutée des deux
 * côtés.
 */
export const BUILT_IN_PATTERNS: SecretPattern[] = [
  {
    id: "aws_access_key_id",
    regex: "\\bAKIA[0-9A-Z]{16}\\b",
    severity: "high",
    description: "AWS access key ID",
  },
  {
    id: "aws_secret_access_key",
    // Contexte requis : le nom de variable précède la valeur (l'entropie seule ne suffit pas
    // à distinguer une clé AWS d'un autre blob base64 de même forme).
    regex: "(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\\s*[:=]\\s*['\"]?[A-Za-z0-9/+]{40}['\"]?",
    severity: "high",
    description: "AWS secret access key",
  },
  {
    id: "gcp_api_key",
    regex: "\\bAIza[0-9A-Za-z_-]{35}\\b",
    severity: "high",
    description: "GCP API key",
  },
  {
    id: "azure_storage_account_key",
    regex: "AccountKey=[A-Za-z0-9+/]{20,}==",
    severity: "high",
    description: "Azure storage account key",
  },
  {
    id: "azure_client_secret",
    regex: "(?:client_secret|AZURE_CLIENT_SECRET)\\s*[:=]\\s*['\"]?[A-Za-z0-9_.~-]{34,}['\"]?",
    severity: "medium",
    description: "Azure client secret",
  },
  {
    id: "github_pat_classic",
    regex: "\\bghp_[A-Za-z0-9]{36}\\b",
    severity: "high",
    description: "GitHub personal access token (classic)",
  },
  {
    id: "github_pat_fine_grained",
    regex: "\\bgithub_pat_[A-Za-z0-9_]{22,}\\b",
    severity: "high",
    description: "GitHub fine-grained personal access token",
  },
  {
    id: "gitlab_pat",
    regex: "\\bglpat-[A-Za-z0-9_-]{20}\\b",
    severity: "high",
    description: "GitLab personal access token",
  },
  {
    id: "slack_token",
    regex: "\\bxox[baprs]-[0-9A-Za-z-]{10,}\\b",
    severity: "high",
    description: "Slack token",
  },
  {
    id: "stripe_live_key",
    regex: "\\bsk_live_[0-9A-Za-z]{24,}\\b",
    severity: "high",
    description: "Stripe live secret key",
  },
  {
    id: "openai_api_key",
    regex: "\\bsk-(?:proj-)?[A-Za-z0-9]{20,}\\b",
    severity: "high",
    description: "OpenAI API key",
  },
  {
    id: "anthropic_api_key",
    regex: "\\bsk-ant-[A-Za-z0-9_-]{20,}\\b",
    severity: "high",
    description: "Anthropic API key",
  },
  {
    id: "private_key_header",
    regex: "-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----",
    severity: "high",
    description: "Private key header (RSA/EC/OpenSSH/PGP)",
  },
  {
    id: "jwt",
    regex: "eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+",
    severity: "medium",
    description: "JSON Web Token",
  },
];
