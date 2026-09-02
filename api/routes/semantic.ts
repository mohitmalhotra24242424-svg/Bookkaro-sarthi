/**
 * POST /api/semantic/chat — the Semantic AI Tool Planner endpoint (FINAL spec).
 * Runs the multi-model planner (gpt-oss → nemotron → deterministic NLU), then
 * the backend orchestrator (catalog validation → ToolRegistry → RailCore→RailKit),
 * and returns the Hinglish reply + structured diagnostics (source/modelUsed/
 * railwayProviderUsed/…). No secrets leave the server; no booking executes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SemanticRunner } from '../ai/semantic-runner.js';
import type { ConversationStore } from '../conversations.js';

export interface SemanticRouteContext {
  semanticRunner: SemanticRunner;
  conversations: ConversationStore;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function respond(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

export async function handleSemanticChatRoute(req: IncomingMessage, res: ServerResponse, context: SemanticRouteContext): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    respond(res, 400, { ok: false, code: 'INVALID_JSON_BODY', message: 'Invalid request body.' });
    return;
  }

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
  if (message.length === 0) {
    respond(res, 400, { ok: false, code: 'INVALID_MESSAGE', message: 'message (non-empty string) is required' });
    return;
  }
  const userId = typeof body.userId === 'string' && body.userId.trim().length > 0 ? body.userId.trim().slice(0, 64) : 'guest';
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim().slice(0, 64) : null;
  const conversation = await context.conversations.getOrCreate(conversationId, userId);

  let turn;
  try {
    turn = await context.semanticRunner.run(message, conversation, { userId, conversationId: conversation.id });
  } catch {
    respond(res, 200, {
      ok: true,
      conversationId: conversation.id,
      reply: 'Abhi railway data available nahi ho raha. Thodi der baad try karein.',
      intent: 'UNKNOWN',
      usedNlu: true,
      executedTools: [],
      safetyRejections: ['runner-error'],
      diagnostics: null,
    });
    return;
  }
  await context.conversations.save(turn.context);

  respond(res, 200, {
    ok: true,
    conversationId: turn.context.id,
    reply: turn.reply,
    intent: turn.intent,
    usedFallbackNlu: turn.usedNlu,
    executedTools: turn.executedTools,
    safetyRejections: turn.safetyRejections,
    diagnostics: turn.diagnostics,
    slots: {
      origin: turn.context.origin?.code ?? null,
      destination: turn.context.destination?.code ?? null,
      journeyDate: turn.context.journeyDate,
      passengerCount: turn.context.passengerCount,
      selectedTrain: turn.context.selectedTrain?.number ?? null,
      selectedClass: turn.context.selectedClass,
    },
    stationChoices: turn.context.stationChoices
      ? {
          field: turn.context.stationChoices.field,
          options: turn.context.stationChoices.options.map((station) => ({
            code: station.code,
            name: station.name,
          })),
        }
      : null,
    chips: turn.context.stationChoices
      ? turn.context.stationChoices.options.map((station) => (station.name ? `${station.code} — ${station.name}` : station.code))
      : null,
  });
}
