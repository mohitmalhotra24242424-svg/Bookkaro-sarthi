import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createBookKaroServer } from '../api/server.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createBookKaroServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('api server (Step 1 shell)', () => {
  it('GET /api/health → 200 with honest subsystem status', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.booking).toBe('NOT_IMPLEMENTED');
    expect(body.wallet).toBe('NOT_IMPLEMENTED');
    expect(body.railwayProviders).toBe('IMPLEMENTED_REAL_ADAPTERS');
  });

  it('health exposes only whether secrets are configured — never values', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const text = await response.text();
    expect(text).toMatch(/secretsConfigured/);
    expect(text).not.toMatch(/=\s*[A-Za-z0-9_-]{16,}/); // no key-looking values
  });

  it('POST /api/chat → 200 with a real conversational AI turn', { timeout: 90_000 }, async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'ASR se LDH jaana hai' }), // typed codes work without provider keys
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.conversationId).toBe('string');
    expect(typeof body.reply).toBe('string');
    // Keyed runs use the REAL model: it may fill the date itself (env-dependent) —
    // either asking for the date or proceeding with it is honest; fabrications are not.
    expect(body.reply).toMatch(/kis date|train|mili|available nahi|samajh nahi|naam/i);
    expect(body.intent).toBeTruthy();
    expect(body.reply).not.toMatch(/\b\d{5}\b.*\b\d{5}\b.*\b\d{5}\b/); // no fabricated train dumps

    // multi-turn memory over the same conversationId
    const second = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'kal', conversationId: body.conversationId }),
    });
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(second.status).toBe(200);
    if ((body.slots as Record<string, unknown>).origin === 'ASR') {
      expect(secondBody.slots).toMatchObject({ origin: 'ASR', destination: 'LDH' }); // preserved
    }
    // Date filled, OR honest degradation (providers exhausted/rate-limited; the live
    // model may phrase the honest outcome in English). Never fabricated trains.
    const secondDate = (secondBody.slots as Record<string, unknown>).journeyDate;
    const secondReply = String(secondBody.reply);
    if (secondDate === null || secondDate === undefined) {
      expect(secondReply).toMatch(/available nahi|nahi mili|samajh nahi|couldn.?t find|could not find|no trains/i);
    }
    // Train numbers may ONLY appear alongside a verified result listing — never bare.
    if (!/trains? mili|neeche list/i.test(secondReply)) {
      expect(secondReply).not.toMatch(/\b\d{5}\b/);
    }
    // keyless runs honestly report unavailability; keyed runs list REAL trains —
    // both are correct environment-dependent outcomes (never invented data).
    expect(String(secondBody.reply)).toMatch(/available nahi|train nahi mili|train(s)? mili|neeche list|samajh nahi/i);
  });

  it('POST /api/chat with an empty message → 400', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    expect(response.status).toBe(400);
  });

  it('GET /api/health reports the Step-3 AI orchestrator', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.step).toBe('STEP_9_AI_RAILWAY_AGENT');
    expect(body.aiOrchestrator).toBe('IMPLEMENTED');
    expect(String(body.aiProvider)).toMatch(/deterministic|nvidia/); // depends on server env keys
    expect(body.aiFallback).toBe('deterministic-nlu');
  });

  it('POST /api/chat with invalid JSON → 400', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
  });

  it('GET / serves the landing page', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toContain('BookKaro');
    expect(html).toContain('chat.html'); // landing links into the assistant
    expect(html).not.toMatch(/https?:\/\//); // self-contained, no CDNs
  });

  it('GET /chat.html (and /chat) serve the assistant page', async () => {
    for (const path of ['/chat.html', '/chat']) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html).toContain('BookKaro Assistant');
      expect(html).toContain('/api/chat');
    }
  });

  it('unknown api paths → 404 JSON; unknown static paths → 404', async () => {
    const apiResponse = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(apiResponse.status).toBe(404);
    const body = (await apiResponse.json()) as Record<string, unknown>;
    expect(body.code).toBe('NOT_FOUND');

    const staticResponse = await fetch(`${baseUrl}/no-such-file.html`);
    expect(staticResponse.status).toBe(404);
  });

  it('path traversal outside the public dir is blocked', async () => {
    const response = await fetch(`${baseUrl}/..%2F..%2Fpackage.json`);
    expect(response.status).toBe(404);
  });
});
