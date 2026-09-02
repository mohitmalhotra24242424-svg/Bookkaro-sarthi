/**
 * AUTONOMOUS HANDLER — the ChatGPT-like "handover" layer.
 *
 * This is the main entry that the server calls on every user message.
 * It:
 *   1. Runs the AutonomousIntentEngine to deeply understand the user
 *      (Hindi/Hinglish/English, typos, multi-intent, follow-ups, corrections).
 *   2. Decides autonomously what to do next:
 *        - Ask a clarifying question if information is missing.
 *        - Answer directly (greetings, thanks, small-talk, help, off-topic).
 *        - Call the deterministic tool layer (railway APIs via Router).
 *        - Pause/resume booking flow as needed.
 *        - Handle corrections, go-back, start-over, hold.
 *   3. Generates natural, conversational replies via AutonomousReplyGenerator.
 *   4. Maintains ConversationContext across turns (fills slots, resolves refs,
 *      tracks corrections, pauses/resumes booking).
 *
 * In short: the AI "samajh leta hai" user intent, khud hi solutions find karta
 * hai, aur poora customer intent handle karta hai — bilkul ChatGPT ki tarah.
 *
 * Safety invariants (PRESERVED from the original codebase):
 *   - AI UNDERSTANDS but NEVER executes directly.
 *   - Every tool call goes through the validated ToolRegistry + RailwayProviderRouter
 *     (RailCore primary → RailKit fallback).
 *   - confirmBooking / wallet mutations stay DETERMINISTIC_ONLY — AI can never
 *     execute them; at most it can request them (and is rejected by guards).
 *   - Hallucination guard: when tools return no data, honest "unavailable" wins.
 */

import type { ConversationContext, ToolResult } from '../../shared/index.js';
import { setContextSlots, savePausedBooking, restorePausedBooking } from '../../shared/index.js';
import type { ToolRegistry } from '../../tools/index.js';
import { isAiSelectableTool } from '../../api/ai/tool-catalog.js';
import { executeAiToolCalls } from '../../api/ai/tool-executor.js';
import type { AiToolCallRequest } from '../../api/ai/tool-executor.js';
import { semanticToolToCatalogId } from '../../api/ai/semantic-tools.js';
import { understandAutonomously } from './AutonomousIntentEngine.js';
import type { AutonomousUnderstanding, ExtractedEntity } from './AutonomousIntentEngine.js';
import type { TravelClassCode } from '../../shared/types/railway.js';
import { generateReply } from './AutonomousReplyGenerator.js';
import { resolveDateText } from '../slotResolution.js';
import { composeKnowledgeAnswer } from '../../shared/railwayKnowledge.js';

export interface AutonomousHandlerInput {
  message: string;
  conversationId: string | null;
  context: ConversationContext;
  /** Optional real AI model client — if provided, used for enhanced phrasing. */
  aiPhraser?: { phrase: (context: string) => Promise<string | null> } | null;
}

export interface AutonomousHandlerOutput {
  reply: string;
  intent: string;
  confidence: number;
  executedTools: string[];
  cards: unknown[] | null;
  panel: unknown | null;
  context: ConversationContext;
  diagnostics: {
    tone: string;
    sentiment: string;
    candidates: Array<{ intent: string; confidence: number }>;
    usedAutonomousEngine: true;
    correctionsApplied: string[];
    resumedPausedBooking: boolean;
    multiIntents: string[];
  };
  safety: {
    aiCanBook: false;
    aiCanMoveMoney: false;
    providersChosenBy: 'server-router';
  };
}

// ── Entity → slot mapping ────────────────────────────────────────────────────

function getEntityValue(entities: ExtractedEntity[], type: ExtractedEntity['type']): unknown {
  return entities.find((e) => e.type === type)?.value ?? null;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleAutonomously(
  input: AutonomousHandlerInput,
  deps: { registry: ToolRegistry; now?: () => Date },
): Promise<AutonomousHandlerOutput> {
  const now = deps.now ?? (() => new Date());
  let context = { ...input.context };
  let contextUpdatedAt = now().toISOString();
  const correctionsApplied: string[] = [];
  let resumedPausedBooking = false;

  // 1) UNDERSTAND the user.
  const u = understandAutonomously(input.message, context);

  // 2) Handle META intents that don't need tools and don't mutate booking state much.

  if (u.primaryIntent === 'HOLD_PAUSE' && context.bookingStage && context.bookingStage !== 'IDLE') {
    // Save paused booking and acknowledge.
    context = {
      ...savePausedBooking(context, 'USER_INTERRUPTION', contextUpdatedAt),
      pendingQuestion: 'Theek hai, hold par hoon. Jab continue karna ho "chalo" keh dena!',
      updatedAt: contextUpdatedAt,
    };
    const reply = generateReply({ understanding: u, context });
    return finalize(reply.text, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  if (u.primaryIntent === 'RESUME' && context.pausedBooking) {
    context = { ...restorePausedBooking(context, contextUpdatedAt), updatedAt: contextUpdatedAt };
    resumedPausedBooking = true;
    const reply = generateReply({ understanding: u, context, pendingQuestion: context.pendingQuestion });
    return finalize(reply.text, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  if (u.primaryIntent === 'START_OVER') {
    context = {
      ...context,
      origin: null, destination: null, journeyDate: null, passengerCount: null,
      selectedTrain: null, selectedClass: null, selectedQuota: null,
      lastSearchResults: [], lastAskedField: null, bookingStage: 'IDLE',
      lastIntent: null, lastTool: null, pendingQuestion: null,
      pausedBooking: null, lastReferencedTrain: null, userCorrections: [],
      stationChoices: null, pendingStationResolution: null, pendingSemanticPlan: null,
      updatedAt: contextUpdatedAt,
    };
    const reply = generateReply({ understanding: u, context });
    return finalize(reply.text, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  // 3) Apply CORRECTIONS if detected.
  if (u.isCorrection && u.correctionTarget) {
    const target = u.correctionTarget;
    const val = getEntityValue(u.entities, target as ExtractedEntity['type']);
    if (val !== null && val !== undefined) {
      const slot: Record<string, unknown> = {};
      switch (target) {
        case 'travelClass': slot.selectedClass = val as TravelClassCode; context.selectedClass = val as TravelClassCode; break;
        case 'journeyDate': slot.journeyDate = resolveDateText(String(val), now()) ?? val; break;
        case 'trainNumber': slot.selectedTrain = context.selectedTrain ? { ...context.selectedTrain, number: String(val) } : { number: String(val), name: null }; break;
        case 'passengerCount': slot.passengerCount = Number(val); break;
      }
      if (Object.keys(slot).length > 0) {
        context = setContextSlots(context, slot, 'CORRECT', contextUpdatedAt);
        correctionsApplied.push(target);
        // Invalidate downstream booking state.
        if (['origin', 'destination', 'journeyDate', 'trainNumber'].includes(target)) {
          context = { ...context, lastSearchResults: [], selectedClass: null, bookingStage: target === 'trainNumber' ? context.bookingStage : 'IDLE' };
        }
      }
    }
  }

  // 4) Slot filling from entities (when not a correction and slots are empty).
  const fillSlot = <K extends keyof ConversationContext>(key: K, value: ConversationContext[K]) => {
    if (context[key] === null || context[key] === undefined) {
      context = { ...context, [key]: value, updatedAt: contextUpdatedAt };
    }
  };
  const origin = getEntityValue(u.entities, 'origin') as string | null;
  const dest = getEntityValue(u.entities, 'destination') as string | null;
  const date = getEntityValue(u.entities, 'journeyDate') as string | null;
  const train = getEntityValue(u.entities, 'trainNumber') as string | null;
  const tclass = getEntityValue(u.entities, 'travelClass') as string | null;
  const pcount = getEntityValue(u.entities, 'passengerCount') as number | null;

  // Also extract stations here (needed for answer-to-pending logic).
  const stations = (function () {
    // Lightweight station extraction for answers like "Ludhiana"
    const text = u.normalizedMessage;
    const seMatch = text.match(/([a-z\u0900-\u097F\s]{2,30}?)\s+se\s/i);
    const fromMatch = text.match(/from\s+([a-z\s]{2,30}?)(?:\s|$|,)/i);
    return { origin: (seMatch?.[1] ?? fromMatch?.[1] ?? '').trim() || null, destination: null };
  })();

  // Handle short answers to pending questions.
  if (u.isAnswerToPendingQuestion && u.pendingQuestionField) {
    const field = u.pendingQuestionField;
    const rawMsg = input.message.trim().toLowerCase();
    const patch: Record<string, unknown> = {};
    if (field === 'journeyDate' || field === 'date') {
      const resolved = date ? (resolveDateText(String(date), now()) ?? date) : resolveDateText(rawMsg, now());
      if (resolved) patch.journeyDate = resolved;
    } else if ((field === 'origin' || field === 'from') && (origin || stations.origin)) {
      const v = origin ?? stations.origin;
      patch.origin = { code: String(v).toUpperCase(), name: String(v), zone: null, state: null, latitude: null, longitude: null };
    } else if (field === 'destination' && dest) {
      patch.destination = { code: String(dest).toUpperCase(), name: String(dest), zone: null, state: null, latitude: null, longitude: null };
    } else if (field === 'passengerCount' && pcount) {
      patch.passengerCount = pcount;
    } else if (field === 'selectedClass' && tclass) {
      patch.selectedClass = tclass;
    } else if (field === 'selectedTrain' && train) {
      patch.selectedTrain = { ...(context.selectedTrain ?? { name: null, originStation: null, destinationStation: null, departureTime: null, arrivalTime: null, runsOn: null, travelClasses: null, pantryCar: null }), number: String(train) };
    }
    if (Object.keys(patch).length > 0) {
      context = setContextSlots(context, patch, 'FILL_MISSING', contextUpdatedAt);
    }
    context = { ...context, lastAskedField: null, pendingQuestion: null, updatedAt: contextUpdatedAt };
  }

  if (origin) fillSlot('origin' as any, { code: origin.toUpperCase(), name: origin, zone: null, state: null, latitude: null, longitude: null });
  if (dest) fillSlot('destination' as any, { code: dest.toUpperCase(), name: dest, zone: null, state: null, latitude: null, longitude: null });
  if (date) {
    const resolved = resolveDateText(String(date), now());
    if (resolved) fillSlot('journeyDate' as any, resolved);
    else fillSlot('journeyDate' as any, date);
  }
  if (train) fillSlot('selectedTrain' as any, { ...(context.selectedTrain ?? { name: null, originStation: null, destinationStation: null, departureTime: null, arrivalTime: null, runsOn: null, travelClasses: null, pantryCar: null }), number: String(train) });
  if (tclass) fillSlot('selectedClass' as any, tclass);
  if (pcount) fillSlot('passengerCount' as any, pcount);

  // 5) META intents that require no tool — answer directly.
  if (u.requiresNoTools) {
    let replyText = '';
    switch (u.primaryIntent) {
      case 'GREETING': replyText = pick([
        'Namaste! 🙏 BookKaro mein aapka swagat hai. Main trains search, availability, fare, live status, PNR, booking — sab kuch kar sakta hoon. Batayein kya chahiye?',
        'Hi! Main BookKaro AI hoon — aapka apna railway assistant. Trains, tickets, PNR, live status, booking, cancellation — sab kuch. Batayein kaise madad karoon?',
      ]); break;
      case 'FAREWELL': replyText = pick([
        'Alvida! 🚂 Baad mein kabhi bhi aa jana — ticket chahiye ya kuch bhi, yaad kar lena. Safe travels!',
        'Bye bye! Apna khayal rakhna. Jab ticket chahiye BookKaro hai na! 😊',
      ]); break;
      case 'THANKS': replyText = pick(['Aapka swagat hai! 😊 Aur chahiye ho to batana.', 'Koi baat nahi! Yahi hoon main.', 'Dhanyavaad! 🙏']); break;
      case 'PRAISE': replyText = pick(['Shukriya! 🙏 Aapke liye better service dete rahenge.', 'Bahut dhanyavaad! 🌟']); break;
      case 'COMPLAINT':
      case 'FRUSTRATION':
        replyText = 'Maaf kijiye pareshani ke liye 🙏. Thoda detail mein batayein kya galat hua — main turant solve karunga.'; break;
      case 'HELP':
      case 'CAPABILITY_QUERY':
        replyText = `Main BookKaro AI hoon — aapka railway assistant. Main kar sakta hoon:\n\n🚆 Trains search (kisi bhi route/date)\n🎫 Seat availability\n💰 Fare dikhana\n📍 Live train status\n📋 Timetable/stops\n🔢 PNR status\n❌ Cancelled trains\n🆚 Train comparison (kaunsi better/tez)\n🛒 Ticket booking (multi-passenger)\n💼 Wallet / booking history\n❓ Railway rules / glossary (tatkal, RAC, classes)\n\nBas Hindi/Hinglish/English mein poochhiye! 😊`;
        break;
      case 'AFFIRMATION':
        replyText = pick(['Theek hai! 👍', 'Bilkul!', 'Samajh gaya!']); break;
      case 'NEGATION':
        replyText = 'Theek hai, koi baat nahi. Batayein kya chahiye?'; break;
      case 'GO_BACK':
        replyText = 'Theek hai, ek step peeche chalte hain 🔙. Ab kya change karna hai?'; break;
      case 'CORRECTION':
        replyText = 'Theek hai, update kar diya ✏️. Aur batayein.'; break;
      case 'NORMAL_CHAT':
      default:
        replyText = 'Main railway ka specialist hoon ji — is topic par meri training nahi hai. Par trains, tickets, PNR, booking, fare ya Indian Railways se related kuch bhi poochhiye, turant jawab dunga! 😊';
    }
    return finalize(replyText, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  // 6) GENERAL RAILWAY QUERY (knowledge base, no tool call to external data).
  if (u.primaryIntent === 'GENERAL_RAILWAY_QUERY') {
    // Use the approved glossary + knowledge composer.
    const query = (getEntityValue(u.entities, 'reference') || input.message) as string;
    const answer = composeKnowledgeAnswer(query);
    const text = answer
      ? `${answer.answer}\n\nAur kuch railway related jaanna ho to batayein! 😊`
      : 'Railway ke rules/class/quota ke baare mein main approved knowledge se hi batata hoon. Thoda specific poochhiye — jaise "CC kya hota hai?", "tatkal kitne baje khulta hai?" etc.';
    return finalize(text, u, ['getRailwayKnowledge'], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  // 7) Build tool plan from understanding.suggestedTools.
  const toolCalls: AiToolCallRequest[] = [];
  const toolArgs = (toolName: string): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    switch (toolName) {
      case 'searchTrains':
        if (context.origin?.code) args.originCode = context.origin.code;
        if (context.destination?.code) args.destinationCode = context.destination.code;
        if (context.journeyDate) args.journeyDate = context.journeyDate;
        break;
      case 'getLiveStatus':
        if (context.selectedTrain?.number) args.trainNumber = context.selectedTrain.number;
        if (context.journeyDate) args.journeyDate = context.journeyDate;
        break;
      case 'getTrainInfo':
      case 'getTimetable':
        if (context.selectedTrain?.number) args.trainNumber = context.selectedTrain.number;
        break;
      case 'getAvailability':
        if (context.selectedTrain?.number) args.trainNumber = context.selectedTrain.number;
        if (context.journeyDate) args.journeyDate = context.journeyDate;
        if (context.selectedClass) args.travelClass = context.selectedClass;
        if (context.origin?.code) args.fromStationCode = context.origin.code;
        if (context.destination?.code) args.toStationCode = context.destination.code;
        break;
      case 'getFare':
        if (context.selectedTrain?.number) args.trainNumber = context.selectedTrain.number;
        if (context.journeyDate) args.journeyDate = context.journeyDate;
        if (context.selectedClass) args.travelClass = context.selectedClass;
        if (context.origin?.code) args.fromStationCode = context.origin.code;
        if (context.destination?.code) args.toStationCode = context.destination.code;
        break;
      case 'checkPNR': {
        const pnrVal = getEntityValue(u.entities, 'pnr') as string | null;
        if (pnrVal) args.pnr = pnrVal;
        break;
      }
      case 'getCancelledTrains':
        if (context.journeyDate) args.journeyDate = context.journeyDate;
        break;
      case 'lookupStation': {
        const stationName = (getEntityValue(u.entities, 'station') || getEntityValue(u.entities, 'origin') || getEntityValue(u.entities, 'destination')) as string | null;
        if (stationName) args.query = stationName;
        break;
      }
      case 'getBookings':
      case 'getWallet':
        break;
    }
    return args;
  };

  for (const toolName of u.suggestedTools) {
    // Map semantic/catalog ids to registry tool names if needed.
    const catalogId = semanticToolToCatalogId(toolName) ?? toolName;
    if (!isAiSelectableTool(catalogId)) continue;
    const args = toolArgs(catalogId);
    toolCalls.push({ tool: catalogId, args });
  }

  // 8) Missing slots — ask for ONE thing at a time (never overwhelm user).
  if (u.missingSlots.length > 0) {
    const first = u.missingSlots[0]!;
    context = { ...context, lastAskedField: first.field as any, pendingQuestion: first.question, updatedAt: contextUpdatedAt };
    return finalize(first.question, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  // 9) If informational query mid-booking, PAUSE the booking before answering.
  const isInfoQuery = ['LIVE_TRAIN_STATUS', 'GET_FARE', 'GET_AVAILABILITY', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'CHECK_PNR', 'CHECK_CHART_STATUS', 'PLATFORM_INQUIRY', 'COACH_POSITION', 'CHECK_REFUND', 'COMPARE_TRAINS', 'GET_CANCELLED_TRAINS'].includes(u.primaryIntent);
  if (isInfoQuery && context.bookingStage && context.bookingStage !== 'IDLE' && !context.pausedBooking) {
    context = savePausedBooking(context, 'USER_INTERRUPTION', contextUpdatedAt);
  }

  // 10) EXECUTE tools (through validated server-side boundary).
  let toolResults: ToolResult[] = [];
  const executedTools: string[] = [];
  if (toolCalls.length > 0) {
    const { executions } = await executeAiToolCalls(toolCalls, {
      userId: context.userId,
      conversationId: input.conversationId ?? context.id,
      registry: deps.registry,
    });
    for (const ex of executions) {
      executedTools.push(ex.tool);
      if (ex.result) toolResults.push(ex.result);
    }
  }

  // 11) RESUME paused booking after answering an informational query.
  if (u.resumeAfterAnswer && context.pausedBooking) {
    context = restorePausedBooking(context, contextUpdatedAt);
    resumedPausedBooking = true;
  }

  // 11b) Intent-aware reply when no tool results available (e.g. keyless demo).
  const intentAck: Record<string, string> = {
    LIVE_TRAIN_STATUS: 'Samajh gaya — aap live status dekhna chahte hain. Abhi demo mode mein railway data source connect nahi hai, isliye real-time status fetch nahi ho pa raha.',
    GET_FARE: 'Samajh gaya — fare dekhna chahte hain. Abhi demo mode mein real railway data available nahi hai.',
    GET_AVAILABILITY: 'Samajh gaya — availability check karni hai. Demo mode mein live provider connect nahi, isliye abhi seat status nahi bata pa raha.',
    GET_TIMETABLE: 'Samajh gaya — timetable/route dekhna chahte hain. Demo mode mein data fetch nahi ho pa raha.',
    GET_TRAIN_INFO: 'Samajh gaya — train ki info chahiye. Demo mode mein data source connect nahi hai.',
    CHECK_PNR: 'Samajh gaya — PNR status check karna hai. Demo mode mein PNR API connect nahi, real key configure karne par PNR status dikh jaayega.',
    GET_CANCELLED_TRAINS: 'Samajh gaya — cancelled trains dekhni hain. Demo mode mein provider data available nahi.',
    LOOKUP_STATION: 'Samajh gaya — station code chahiye. Demo mode mein station lookup API connect nahi.',
    VIEW_WALLET: 'Samajh gaya — wallet balance dekhna chahte hain. Demo mode mein wallet service active nahi hai.',
    VIEW_BOOKINGS: 'Samajh gaya — booking history dikhani hai. Demo mode mein user bookings store nahi ho rahi.',
    CHECK_CHART_STATUS: 'Samajh gaya — chart status dekhna chahte hain. Ye information live provider se hi milti hai — demo mode mein available nahi.',
    CHECK_REFUND: 'Samajh gaya — refund ke baare mein poochh rahe hain. Refund ke liye thoda specific poochhiye, ya main apne approved knowledge se answer deta hoon.',
    PLATFORM_INQUIRY: 'Samajh gaya — platform number jaanna chahte hain. Ye real-time data railway provider se milta hai — demo mode mein available nahi.',
    COACH_POSITION: 'Samajh gaya — coach position dekhni hai. Chart banne ke baad ye info milti hai — demo mode mein available nahi.',
    COMPARE_TRAINS: 'Samajh gaya — compare karna chahte hain. Demo mode mein train data fetch nahi ho pa raha.',
    GENERAL_RAILWAY_QUERY: 'Iske baare mein mujhe approved railway knowledge mein exact answer nahi mil raha. Thoda specific poochhiye — jaise "CC kya hota hai?", "tatkal kitne baje khulta hai?"',
    BOOK_TRAIN: 'Samajh gaya — aap ticket book karna chahte hain!',
    SEARCH_TRAIN: 'Samajh gaya — trains search karni hain.',
  };

  // 12) GENERATE natural reply.
  // When no tool results came back (demo/keyless/unavailable), give an intent-aware ack
  // so the customer NEVER hears "samajh nahi paaya" — they always feel understood.
  const anyOkToolResult = toolResults.some((t) => t.ok === true && t.data !== null && t.data !== undefined);
  if ((toolResults.length === 0 || !anyOkToolResult) && intentAck[u.primaryIntent] && !u.clarificationQuestion) {
    let ack = intentAck[u.primaryIntent]!;
    if (u.primaryIntent === 'BOOK_TRAIN' || u.primaryIntent === 'SEARCH_TRAIN') {
      if (!context.origin?.code) ack += ' Pehle batayein kaha se chalna hai?';
      else if (!context.destination?.code) ack += ' Kaha jaana hai?';
      else if (!context.journeyDate) ack += ' Kis date ko jaana hai? (aaj / kal / parso)';
      else ack += ' Abhi demo mode mein train search API connect nahi — RAILCORE_API_KEY set karte hi live results dikh jaayenge.';
    }
    return finalize(ack, u, executedTools, null, null, context, correctionsApplied, resumedPausedBooking);
  }

  let pendingQ: string | null = null;
  // @ts-ignore pausedBooking may not be on the public type shape but is used internally
  if (isInfoQuery && !(context as any).pausedBooking && context.pendingQuestion) {
    pendingQ = context.pendingQuestion;
  }
  if (u.primaryIntent === 'BOOK_TRAIN' || u.primaryIntent === 'SEARCH_TRAIN') {
    if (!context.journeyDate) pendingQ = 'Kis date ko jaana hai? (aaj / kal / parso / dd-mm-yyyy)';
    else if (toolResults.length === 0) pendingQ = 'Details fetch ho rahi hain...';
  }

  const reply = generateReply({
    understanding: u,
    context,
    toolResults,
    pendingQuestion: pendingQ,
  });

  // Update lastIntent.
  context = { ...context, lastIntent: u.primaryIntent as any, updatedAt: contextUpdatedAt };

  return finalize(reply.text, u, executedTools, null, null, context, correctionsApplied, resumedPausedBooking);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }

function finalize(
  reply: string,
  u: AutonomousUnderstanding,
  executedTools: string[],
  cards: unknown[] | null,
  panel: unknown | null,
  context: ConversationContext,
  correctionsApplied: string[],
  resumedPausedBooking: boolean,
): AutonomousHandlerOutput {
  return {
    reply,
    intent: u.primaryIntent,
    confidence: u.candidates[0]?.confidence ?? 0.5,
    executedTools,
    cards,
    panel,
    context,
    diagnostics: {
      tone: u.tone,
      sentiment: u.sentiment,
      candidates: u.candidates.map((c) => ({ intent: c.intent, confidence: c.confidence })),
      usedAutonomousEngine: true,
      correctionsApplied,
      resumedPausedBooking,
      multiIntents: u.subIntents,
    },
    safety: {
      aiCanBook: false,
      aiCanMoveMoney: false,
      providersChosenBy: 'server-router',
    },
  };
}
