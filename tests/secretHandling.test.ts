import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_VERSION,
  SECRET_ENV_NAMES,
  describeSecretState,
  getSecret,
  isSecretEnvName,
  redactSecrets,
} from '../api/config.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function readProjectFile(relativePath: string): string {
  return readFileSync(`${projectRoot}/${relativePath}`, 'utf8');
}

describe('.env.example contains placeholder names only', () => {
  it('exists and declares exactly the three future secret names', () => {
    const content = readProjectFile('.env.example');
    for (const name of SECRET_ENV_NAMES) {
      expect(content, `${name} documented`).toMatch(new RegExp(`^${name}=`, 'm'));
    }
  });

  it('every secret value is EMPTY — no real credentials in the repo', () => {
    const content = readProjectFile('.env.example');
    for (const name of SECRET_ENV_NAMES) {
      expect(content).toMatch(new RegExp(`^${name}=\\s*$`, 'm'));
    }
  });

  it('.gitignore ignores .env files but keeps .env.example', () => {
    const gitignore = readProjectFile('.gitignore');
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^\.env\.\*$/m);
    expect(gitignore).toMatch(/^!\.env\.example$/m);
  });
});

describe('secret access is server-side only', () => {
  afterEach(() => {
    delete process.env.RAILCORE_API_KEY;
    delete process.env.AI_API_KEY;
    delete (globalThis as Record<string, unknown>).window;
  });

  it('isSecretEnvName whitelists only known names', () => {
    expect(isSecretEnvName('RAILCORE_API_KEY')).toBe(true);
    expect(isSecretEnvName('RAILKIT_API_KEY')).toBe(true);
    expect(isSecretEnvName('AI_API_KEY')).toBe(true);
    expect(isSecretEnvName('PORT')).toBe(false);
  });

  it('getSecret reads the server environment (test placeholder, not a real key)', () => {
    process.env.RAILCORE_API_KEY = 'unit-test-placeholder-not-a-real-key';
    expect(getSecret('RAILCORE_API_KEY')).toBe('unit-test-placeholder-not-a-real-key');
    delete process.env.RAILCORE_API_KEY;
    expect(getSecret('RAILCORE_API_KEY')).toBeNull();
    expect(() => getSecret('SOME_RANDOM_KEY')).toThrowError(/not a known secret/);
  });

  it('getSecret refuses to run in a browser-like runtime (frontend can never read keys)', () => {
    (globalThis as Record<string, unknown>).window = {};
    expect(() => getSecret('AI_API_KEY')).toThrowError(/SECRETS_ARE_SERVER_SIDE_ONLY/);
  });

  it('describeSecretState reports booleans only — values are never exposed', () => {
    process.env.AI_API_KEY = 'unit-test-placeholder-not-a-real-key';
    const state = describeSecretState();
    expect(state.AI_API_KEY).toBe(true);
    expect(state.RAILCORE_API_KEY).toBe(false);
    expect(JSON.stringify(state)).not.toContain('unit-test-placeholder');
  });
});

describe('redactSecrets: keys and auth headers never reach the logs', () => {
  it('scrubs KEY=value patterns for all known secrets', () => {
    const line = redactSecrets('RAILCORE_API_KEY=supersecret123 calling provider');
    expect(line).not.toContain('supersecret123');
    expect(line).toMatch(/RAILCORE_API_KEY=\[REDACTED\]/);
  });

  it('scrubs Authorization headers (bearer, basic, token)', () => {
    expect(redactSecrets('Authorization: Bearer ey-jwt-token-xyz')).not.toContain('ey-jwt-token-xyz');
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz');
    expect(redactSecrets('authorization: Token abc123')).not.toContain('abc123');
  });

  it('scrubs generic secret-ish assignments', () => {
    const output = redactSecrets('error while using api_key=deadbeef and password=hunter2');
    expect(output).not.toContain('deadbeef');
    expect(output).not.toContain('hunter2');
  });

  it('leaves ordinary log lines untouched', () => {
    const line = 'GET /api/health 200 in 12ms';
    expect(redactSecrets(line)).toBe(line);
  });
});

describe('no secrets or env access outside the api layer', () => {
  const SOURCE_DIRS = ['shared', 'ai', 'tools', 'railway', 'booking', 'wallet', 'app'];

  it('non-api source never touches process.env', () => {
    for (const dir of SOURCE_DIRS) {
      const absolute = join(projectRoot, dir);
      if (!existsSync(absolute)) continue;
      for (const file of collectFiles(absolute)) {
        if (!file.endsWith('.ts') && !file.endsWith('.html') && !file.endsWith('.js')) continue;
        const content = readFileSync(file, 'utf8');
        expect(content, `${file} must not use process.env`).not.toMatch(/process\.env/);
      }
    }
  });

  it('every frontend page contains no external URLs and no env access (no CDN, no railway APIs)', () => {
    for (const page of ['app/index.html', 'app/chat.html', 'app/privacy.html', 'app/terms.html']) {
      const html = readProjectFile(page);
      expect(html, `${page} external URL`).not.toMatch(/https?:\/\//);
      expect(html, `${page} process env`).not.toMatch(/process\.env/);
    }
  });
});

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else out.push(full);
  }
  return out;
}

describe('app metadata', () => {
  it('exposes a step-1 version marker', () => {
    expect(APP_VERSION).toMatch(/^0\.9\.0-step9$/);
  });
});
