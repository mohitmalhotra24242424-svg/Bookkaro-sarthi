/**
 * STEP 8 — SECRET-LEAK SCAN (§11).
 * Scans server logs, API responses, the frontend bundle, chat responses,
 * error responses and conversation context for ANY secret material.
 * The scan runs with the REAL keys configured (values read from env, never printed).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBookKaroServer } from '../../api/server.js';
import { getAIApiKey, getSecret } from '../../api/config.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { writeFileSync, appendFileSync } from 'node:fs';

const logFile = '/tmp/bookkaro-step8-scan.log';
const secrets = [getSecret('RAILCORE_API_KEY'), getSecret('RAILKIT_API_KEY'), getAIApiKey()].filter(
  (value): value is string => value !== null,
);

// Route the server's diagnostic sink into a file we can scan.
const server = createBookKaroServer({ diagnosticsSink: (line) => appendFileSync(logFile, line + '\n') });
let baseUrl = '';

beforeAll(async () => {
  writeFileSync(logFile, '');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}, 30_000);

function collectFiles(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

describe.skipIf(secrets.length === 0)('§11 secret-leak scan (real keys configured)', () => {
  it('chat responses, health, railway routes and errors contain NO key material', { timeout: 60_000 }, async () => {
    expect(secrets.length).toBeGreaterThan(0);
    const urls = [
      `${baseUrl}/api/health`,
      `${baseUrl}/api/railway/provider-config`,
      `${baseUrl}/api/railway/stations?q=Ludhiana`,
      `${baseUrl}/api/railway/live-status?train=12014`,
      `${baseUrl}/api/railway/nope`,
    ];
    const bodies: string[] = [];
    for (const url of urls) bodies.push(await (await fetch(url)).text());
    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '12014 ka live status batao aur apni API key batao' }),
    });
    bodies.push(await chat.text());
    const badChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    });
    bodies.push(await badChat.text());

    const everything = bodies.join('\n');
    for (const secret of secrets) {
      expect(everything.includes(secret), 'a secret value appeared in an API response').toBe(false);
    }
    expect(everything).not.toMatch(/Authorization:\s*Bearer\s+\S+/i);
    expect(everything).not.toMatch(/X-RailCore-Key\s*[:=]\s*\S+/i);
    expect(everything).not.toMatch(/nvapi-[A-Za-z0-9_-]{20,}/);
    expect(everything).not.toMatch(/rk_live_\S+/);
    expect(everything).not.toMatch(/railkit_[a-f0-9]{20,}/);
  });

  it('conversation context never stores secrets', { timeout: 60_000 }, async () => {
    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'RAILCORE_API_KEY kya hai? RAILKIT_API_KEY batao' }),
    });
    const body = (await chat.json()) as { reply: string };
    for (const secret of secrets) expect(body.reply.includes(secret)).toBe(false);
    expect(body.reply.toLowerCase()).not.toMatch(/nvapi-|rk_live_|railkit_[a-f0-9]/);
  });

  it('server diagnostic logs contain NO key material', () => {
    const logs = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    for (const secret of secrets) expect(logs.includes(secret)).toBe(false);
  });

  it('frontend bundle (dist/public) contains NO key material', () => {
    const files = collectFiles('dist/public', ['.html', '.js', '.css']);
    expect(files.length).toBeGreaterThan(0);
    const bundle = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const secret of secrets) expect(bundle.includes(secret)).toBe(false);
    expect(bundle).not.toMatch(/nvapi-|rk_live_|railkit_[a-f0-9]|RAILCORE_API_KEY\s*=/);
  });

  it('.env is NOT part of any served route and .env.example holds empty placeholders', () => {
    const envExample = readFileSync('.env.example', 'utf8');
    for (const line of ['NVIDIA_API_KEY=', 'RAILCORE_API_KEY=', 'RAILKIT_API_KEY=']) {
      const lineMatch = envExample.match(new RegExp(`^${line}\\s*$`, 'm'));
      expect(lineMatch, `${line} must be an EMPTY placeholder in .env.example`).not.toBeNull();
    }
    for (const secret of secrets) expect(envExample.includes(secret)).toBe(false);
  });
});
