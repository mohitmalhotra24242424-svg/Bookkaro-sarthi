/**
 * POST /api/chat — AI-FIRST conversation endpoint.
 *
 * Railway questions are handed to the REAL AI (NVIDIA GPT-OSS → Nemotron
 * via runAiOrchestrator / orchestrateTurn) so intent is understood like
 * ChatGPT — not a regex keyword engine. The regex autonomous layer is
 * kept ONLY for pure meta chat (hi / thanks / bye) where no railway
 * slots or booking state are involved.
 *
 * Fallback chain (safe, never 500s):
 *   meta (autonomous) → NVIDIA orchestrator → deterministic NLU → honest apology.
 *
 * All tool execution still flows through the deterministic, validated
 * ToolRegistry → RailwayProviderRouter (RailCore primary → RailKit fallback).
 * AI can NEVER book/move money.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { orchestrateTurn } from '../../ai/orchestrator.js';
import { runAiOrchestrator } from '../ai/orchestrator.js';
import type { OrchestratorDependencies } from '../../ai/orchestrator.js';
import type { ToolRegistry } from '../../tools/index.js';
import type { ConversationStore } from '../conversations.js';
import type { ConversationContext } from '../../shared/index.js';
import { handleAutonomously, understandAutonomously } from '../../ai/autonomous/index.js';

export interface ChatRouteContext {
  orchestrator: OrchestratorDependencies;
  toolRegistry: ToolRegistry;
  conversations: ConversationStore;
  /** When true (default), the ChatGPT-style autonomous engine handles the turn. */
  enableAutonomousHandler?: boolean;
  /** AI-first tool planner (optional). */
  planTools?: (message: string, context: ConversationContext) => Promise<{ intent: string; tools: { tool: string; args?: Record<string, unknown> }[] } | null>;
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

function apology(conversation: ConversationContext, code?: string) {
  return {
    ok: true as const,
    conversationId: conversation.id,
    reply: 'Abhi railway data available nahi ho raha. Thodi der baad try karein.',
    intent: 'UNKNOWN',
    usedFallbackNlu: true,
    executedTools: [] as string[],
    safetyRejections: code ? [code] : [] as string[],
    cards: null,
    panel: null,
    chips: null,
    slots: slotsOf(conversation),
    autonomous: { used: false, intent: 'UNKNOWN', confidence: 0, tone: 'apologetic', sentiment: 'negative' },
    orchestration: {
      intent: 'UNKNOWN', entities: {}, requiredTools: [], toolArguments: {},
      missingSlots: [], interrupt: false, resumeContext: null,
      safety: { rejections: code ? [code] : [], aiCanBook: false as const, aiCanMoveMoney: false as const, providersChosenBy: 'server-router' as const, toolCallBudget: 5 },
      toolEnvelopes: [], sourceClass: null,
    },
  };
}

/** Pure conversational intents the regex engine may handle without touching railway tools. */
const META_ALWAYS = new Set([
  'GREETING', 'FAREWELL', 'THANKS', 'PRAISE', 'HELP', 'CAPABILITY_QUERY',
]);
const META_IDLE = new Set([
  ...META_ALWAYS,
  'AFFIRMATION', 'NEGATION', 'HOLD_PAUSE', 'RESUME', 'GO_BACK', 'START_OVER',
  'SMALL_TALK', 'NORMAL_CHAT', 'COMPLAINT', 'FRUSTRATION', 'REPEAT_REQUEST',
]);

function looksLikeRailwayUtterance(message: string): boolean {
  return (
    /\b(\d{4,6}|\d{10})\b/.test(message) ||
    /\b(se|from|to|tak|train|trains|ticket|tickets|pnr|fare|book|booking|live|status|seat|seats|class|station|availability|timetable|cancel|cancelled|wallet|jaana|jana|chahiye)\b/i.test(message) ||
    /से|ट्रेन|टिकट|किराया|स्टेशन/.test(message)
  );
}

/**
 * Fast-path greetings/thanks through the regex layer. Everything else —
 * especially journey search, follow-ups, "kal", "haan", station chips —
 * goes to the NVIDIA AI orchestrator (the ChatGPT-like understander).
 */
function shouldUseAutonomousMeta(message: string, conversation: ConversationContext): boolean {
  if (conversation.stationChoices) return false;
  if (conversation.lastAskedField) return false;
  if (conversation.pendingQuestion) return false;
  if (conversation.pendingDataRoute) return false;
  if (looksLikeRailwayUtterance(message)) return false;

  const preview = understandAutonomously(message, conversation);
  if (META_ALWAYS.has(preview.primaryIntent) && preview.requiresNoTools) return true;
  const idle = !conversation.bookingStage || conversation.bookingStage === 'IDLE';
  return idle && META_IDLE.has(preview.primaryIntent) && preview.requiresNoTools;
}

function slotsOf(c: ConversationContext) {
  return {
    origin: c.origin?.code ?? null,
    destination: c.destination?.code ?? null,
    journeyDate: c.journeyDate,
    passengerCount: c.passengerCount,
    selectedTrain: c.selectedTrain?.number ?? null,
    selectedClass: c.selectedClass,
  };
}

export async function handleChatRoute(
  req: IncomingMessage,
  res: ServerResponse,
  context: ChatRouteContext,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    respond(res, 400, { ok: false, code: 'INVALID_JSON_BODY', message: String(error instanceof Error ? error.message : error) });
    return;
  }

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
  if (message.length === 0) {
    respond(res, 400, { ok: false, code: 'INVALID_MESSAGE', message: 'message (non-empty string) is required' });
    return;
  }
  const userId = typeof body.userId === 'string' && body.userId.trim().length > 0 ? body.userId.trim().slice(0, 64) : 'guest';
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim().slice(0, 64) : null;
  const useAutonomous = context.enableAutonomousHandler !== false; // enabled by default

  const conversation = await context.conversations.getOrCreate(conversationId, userId);

  // ── PATH 1: meta-only (hi / thanks / bye). Railway → NVIDIA AI. ──
  if (useAutonomous && shouldUseAutonomousMeta(message, conversation)) {
    try {
      const result = await handleAutonomously(
        { message, conversationId: conversation.id, context: conversation },
        { registry: context.toolRegistry, now: context.orchestrator.now },
      );
      await context.conversations.save(result.context);
      respond(res, 200, {
        ok: true,
        conversationId: result.context.id,
        reply: result.reply,
        intent: result.intent,
        usedFallbackNlu: false,
        executedTools: result.executedTools,
        safetyRejections: [],
        cards: result.cards,
        panel: result.panel,
        chips: null,
        slots: slotsOf(result.context),
        autonomous: {
          used: true,
          intent: result.intent,
          confidence: result.confidence,
          tone: result.diagnostics.tone,
          sentiment: result.diagnostics.sentiment,
          candidates: result.diagnostics.candidates,
          correctionsApplied: result.diagnostics.correctionsApplied,
          resumedPausedBooking: result.diagnostics.resumedPausedBooking,
          multiIntents: result.diagnostics.multiIntents,
        },
        orchestration: {
          intent: result.intent,
          entities: Object.fromEntries(result.diagnostics.candidates.map((c) => [c.intent, c.confidence])),
          requiredTools: result.executedTools,
          toolArguments: {},
          missingSlots: [],
          interrupt: false,
          resumeContext: null,
          safety: { ...result.safety, rejections: [], toolCallBudget: 5 },
          toolEnvelopes: [],
          sourceClass: 'AUTONOMOUS_HANDLER',
        },
      });
      return;
    } catch (err) {
      // Non-fatal: fall through to the legacy orchestrator path.
      // eslint-disable-next-line no-console
      console.warn('[autonomous handler error, falling back]', err instanceof Error ? err.message : err);
    }
  }

  // ── PATH 2: Step-6 AI orchestrator (fallback) ──
  let orchestrated;
  let turn;
  try {
    orchestrated = await runAiOrchestrator(
      { message, conversationId: conversation.id, context: conversation },
      { ai: context.orchestrator.ai, registry: context.toolRegistry, aiTimeoutMs: context.orchestrator.aiTimeoutMs, now: context.orchestrator.now, planTools: context.planTools },
    );
    turn = orchestrated.turn ?? (await orchestrateTurn(context.orchestrator, conversation, message));
  } catch {
    respond(res, 200, apology(conversation, 'ORCHESTRATOR_FAILED'));
    return;
  }
  await context.conversations.save(turn.context);

  respond(res, 200, {
    ok: true,
    conversationId: turn.context.id,
    reply: turn.reply,
    intent: turn.intent,
    usedFallbackNlu: turn.usedFallbackNlu,
    executedTools: turn.executedTools,
    safetyRejections: turn.safetyRejections,
    cards: turn.cards,
    panel: turn.panel,
    chips: turn.chips ?? null,
    slots: slotsOf(turn.context),
    autonomous: { used: false, intent: turn.intent, confidence: 0.7, tone: 'friendly', sentiment: 'neutral' },
    orchestration: {
      intent: orchestrated.intent,
      entities: orchestrated.entities,
      requiredTools: orchestrated.requiredTools,
      toolArguments: orchestrated.toolArguments,
      missingSlots: orchestrated.missingSlots,
      interrupt: orchestrated.interrupt,
      resumeContext: orchestrated.resumeContext,
      safety: orchestrated.safety,
      toolEnvelopes: orchestrated.toolEnvelopes,
      sourceClass: orchestrated.turn?.sourceClass ?? null,
    },
  });
}

function respond(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}
