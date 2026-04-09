import { readFileSync, existsSync } from 'node:fs';

/**
 * Mapping from environment variable names to Docker secret file names.
 * Docker secrets are mounted at /run/secrets/<secret_name>.
 */
const SECRET_NAME_MAP: Record<string, string> = {
  DATABASE_URL: 'db_url',
  REDIS_PASSWORD: 'redis_password',
  SYSTEM_STELLAR_SECRET_KEY: 'stellar_secret',
  SHOPIFY_API_SECRET: 'shopify_secret',
  SHOPIFY_WEBHOOK_SECRET: 'shopify_webhook_secret',
  AWS_SECRET_ACCESS_KEY: 'aws_secret',
};

/**
 * Read a secret from Docker secrets (/run/secrets/<name>),
 * falling back to the corresponding environment variable.
 *
 * This allows the same code to work both in Docker (with secrets)
 * and locally (with .env files).
 */
export function readSecret(name: string): string | undefined {
  const secretName = SECRET_NAME_MAP[name] || name.toLowerCase();
  const secretPath = `/run/secrets/${secretName}`;

  if (existsSync(secretPath)) {
    return readFileSync(secretPath, 'utf-8').trim();
  }

  return process.env[name];
}
