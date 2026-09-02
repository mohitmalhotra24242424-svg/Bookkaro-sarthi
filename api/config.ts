/**
 * SERVER-ONLY configuration & secret handling.
 *
 * Rules enforced here (and by tests):
 *   - Credentials live ONLY in the server environment — this module refuses to
 *     run in a browser-like runtime, so the /app frontend can never read keys.
 *   - Secrets are never logged: redactSecrets() scrubs KEY=value patterns and
 *     Authorization headers before anything is written to logs.
 *   - .env.example documents placeholder names only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafetyViolationError, ValidationError } from '../shared/index.js';

/**
 * Minimal server-side .env loader (no dependency, no logging — values are never
 * printed). Runs once at module load; never overrides variables already set in
 * the real environment. Only the server process reads this file.
 */
function loadDotEnvIfPresent(): void {
  try {
    // Works both from source (api/) and the compiled tree (dist/api/): walk up
    // a few levels looking for the project .env.
    const here = dirname(fileURLToPath(import.meta.url));
    let envPath: string | null = null;
    for (const candidate of [join(here, '.env'), join(here, '..', '.env'), join(here, '..', '..', '.env'), join(here, '..', '..', '..', '.env')]) {
      if (existsSync(candidate)) { envPath = candidate; break; }
    }
    if (!envPath) return;
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // unreadable .env → behave as unconfigured; never log contents
  }
}
loadDotEnvIfPresent();

function dirname(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
}

export const APP_NAME = 'bookkaro';
export const APP_VERSION = '0.9.0-step9';

export const SECRET_ENV_NAMES = ['RAILCORE_API_KEY', 'RAILKIT_API_KEY', 'AI_API_KEY', 'NVIDIA_API_KEY', 'NVIDIA_API_KEY_2'] as const;
export type SecretEnvName = (typeof SECRET_ENV_NAMES)[number];

export function isSecretEnvName(name: string): name is SecretEnvName {
  return (SECRET_ENV_NAMES as readonly string[]).includes(name);
}

/** Secrets must never be read from a browser-like runtime. */
export function assertServerSide(): void {
  const globalRecord = globalThis as Record<string, unknown>;
  if (globalRecord.window !== undefined) {
    throw new SafetyViolationError(
      'SECRETS_ARE_SERVER_SIDE_ONLY — secret access was attempted from a non-server runtime.',
    );
  }
}

/** Read a whitelisted secret from the server environment (or null). */
export function getSecret(name: string): string | null {
  assertServerSide();
  if (!isSecretEnvName(name)) {
    throw new ValidationError(`"${name}" is not a known secret. Known: ${SECRET_ENV_NAMES.join(', ')}`);
  }
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : null;
}

/** Step-8 aliases: NVIDIA_API_KEY acts as AI_API_KEY when the latter is unset. */
export function getAIApiKey(): string | null {
  return getSecret('AI_API_KEY') ?? getSecret('NVIDIA_API_KEY');
}

/**
 * Ordered AI keys: [primary, backup…]. Answer always comes from the PRIMARY;
 * the backup is used ONLY when the primary fails with an auth/quota error.
 */
export function getAIApiKeys(): string[] {
  const keys = [getAIApiKey(), getSecret('NVIDIA_API_KEY_2')];
  return keys.filter((key): key is string => key !== null);
}

export function getAIModelName(): string | null {
  return process.env.NVIDIA_MODEL?.trim() || process.env.AI_MODEL?.trim() || null;
}

/**
 * RAILWAY_PROVIDER policy hint. Only 'railcore' (primary → RailKit fallback)
 * is supported; anything else is ignored in favour of the built-in default.
 */
export function getRailwayProviderPolicy(): 'railcore' {
  const raw = process.env.RAILWAY_PROVIDER?.trim().toLowerCase();
  return raw === 'railcore' || raw === '' || raw === undefined ? 'railcore' : 'railcore'; // router policy is fixed; unknown values do not weaken it
}

/** Scrub secret values from any text before logging. Never logs the values. */
export function redactSecrets(text: string): string {
  let output = text;
  for (const name of SECRET_ENV_NAMES) {
    output = output.replace(new RegExp(`${name}\\s*=\\s*\\S+`, 'gi'), `${name}=[REDACTED]`);
  }
  output = output.replace(/Authorization\s*:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]');
  output = output.replace(/Authorization\s*:\s*(Basic|Token)\s+\S+/gi, 'Authorization: $1 [REDACTED]');
  output = output.replace(/\b(api[_-]?key|secret|token|password)\b(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]');
  return output;
}

export interface AIProviderRuntimeConfig {
  provider: string;
  model: string | null;
  apiKey: string | null;
}

/**
 * Step 3 AI configuration. AI_PROVIDER / AI_MODEL are plain config names (safe
 * to surface); AI_API_KEY is a SECRET (already whitelisted above). Any
 * unconfigured provider falls back to the deterministic NLU.
 */
export function getAIProviderRuntimeConfig(): AIProviderRuntimeConfig {
  const provider = (process.env.AI_PROVIDER ?? 'deterministic').trim().toLowerCase();
  const model = process.env.AI_MODEL?.trim() || null;
  const apiKey = getSecret('AI_API_KEY');
  return { provider, model, apiKey };
}

/** Safe to log: reports only WHETHER each secret is configured, never its value. */
export function describeSecretState(): Record<SecretEnvName, boolean> {
  const state = {
    RAILCORE_API_KEY: false,
    RAILKIT_API_KEY: false,
    AI_API_KEY: false,
    NVIDIA_API_KEY: false,
    NVIDIA_API_KEY_2: false,
  };
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];
    state[name] = Boolean(value && value.trim().length > 0);
  }
  return state;
}
