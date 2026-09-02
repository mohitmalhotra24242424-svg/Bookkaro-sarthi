/**
 * AUTONOMOUS HANDLER — the ChatGPT-like "handover" layer.
 *
 * This is the main entry that the server calls on every user message.
 * It:
 *   1. Runs the AutonomousIntentEngine to deeply understand the user.
 *   2. Decides autonomously what to do next.
 *   3. Generates natural, conversational replies via AutonomousReplyGenerator.
 *   4. Maintains ConversationContext across turns.
 *
 * Safety invariants PRESERVED:
 *   - AI UNDERSTANDS but NEVER executes directly.
 *   - Every tool call goes through the validated ToolRegistry + RailwayProviderRouter.
 *   - confirmBooking / wallet mutations stay DETERMINISTIC_ONLY.
 *   - Hallucination guard: when tools return no data, honest "unavailable" wins.
 */

import type { ConversationContext, ToolResult, Station } from '../../shared/index.js';
import { setContextSlots, savePausedBooking, restorePausedBooking } from '../../shared/index.js';
import type { ToolRegistry } from '../../tools/index.js';
import { validateToolArguments, isAiSelectableTool } from '../../api/ai/tool-catalog.js';
import { executeAiToolCalls } from '../../api/ai/tool-executor.js';
import type { AiToolCallRequest } from '../../api/ai/tool-executor.js';
import { semanticToolToCatalogId } from '../../api/ai/semantic-tools.js';
import { understandAutonomously } from './AutonomousIntentEngine.js';
import type { AutonomousUnderstanding, ExtractedEntity } from './AutonomousIntentEngine.js';
import type { TravelClassCode } from '../../shared/types/railway.js';
import { generateReply } from './AutonomousReplyGenerator.js';
import { resolveDateText, stationFromLookup, resolveStationChoice } from '../slotResolution.js';
import { composeKnowledgeAnswer } from '../../shared/railwayKnowledge.js';
import { newId } from '../../shared/ids.js';
import type { ToolCall } from '../../shared/types/tools.js';

export interface AutonomousHandlerInput {
  message: string;
  conversationId: string | null;
  context: ConversationContext;
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

function getEntityValue(entities: ExtractedEntity[], type: ExtractedEntity['type']): unknown {
  return entities.find((e) => e.type === type)?.value ?? null;
}

/** Resolve a free-text station name → Station via lookupStation (same as semantic-orchestrator). */
async function resolveStationName(
  registry: ToolRegistry,
  query: string,
  conversationId: string | null,
  now: Date,
): Promise<{ station: Station | null; ambiguous: Station[] | null }> {
  const validation = validateToolArguments('LOOKUP_STATION', { query });
  if (!validation.ok) return { station: null, ambiguous: null };
  const call: ToolCall = {
    id: newId('astn'), tool: 'lookupStation', input: validation.sanitized,
    requestedBy: 'SERVER', conversationId, createdAt: now.toISOString(),
  };
  const result = await registry.execute(call, { actor: 'SERVER', userId: null, conversationId, call });
  if (!result.ok) return { station: null, ambiguous: null };
  const stations = (result.data as Station[] | null) ?? [];
  const unique: Station[] = [];
  const seen = new Set<string>();
  for (const s of stations) {
    const code = (s.code ?? '').toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code); unique.push(s);
  }
  const byCode = unique.filter((s) => s.code.toUpperCase() === query.toUpperCase());
  if (byCode.length === 1 && byCode[0]) return { station: byCode[0], ambiguous: null };
  const resolved = stationFromLookup(query, unique);
  if (resolved.station) return { station: resolved.station, ambiguous: null };
  if (unique.length === 1) return { station: unique[0]!, ambiguous: null };
  if (resolved.choiceNeeded && resolved.choiceNeeded.length > 0) return { station: null, ambiguous: resolved.choiceNeeded };
  if (unique.length > 1) return { station: null, ambiguous: unique };
  return { station: null, ambiguous: null };
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleAutonomously(
  input: AutonomousHandlerInput,
  deps: { registry: ToolRegistry; now?: () => Date },
): Promise<AutonomousHandlerOutput> {
  const now = deps.now ?? (() => new Date());
  let context = { ...input.context };
  const contextUpdatedAt = now().toISOString();
  const correctionsApplied: string[] = [];
  let resumedPausedBooking = false;

  let u = understandAutonomously(input.message, context);

  // ── FIRST: If we're waiting for a station choice, resolve the answer deterministically.
  // The reply may be "pehla", "doosra", "LDH", "New Delhi", a station name, etc.
  if ((context as any).stationChoices) {
    const pending = (context as any).stationChoices as { field: 'origin' | 'destination'; options: readonly Station[] };
    const choice = resolveStationChoice(input.message, pending.options);
    if (!choice) {
      const optList = pending.options.slice(0, 5).map((s, i) => `   ${i + 1}. ${s.name}${s.code ? ` (${s.code})` : ''}`).join('\n');
      const reply = `Samajh nahi aaya — ${pending.field === 'origin' ? 'kaha se' : 'kaha tak'} ke liye in mein se kaunsa station hai?\n${optList}`;
      context = { ...context, pendingQuestion: reply, updatedAt: contextUpdatedAt };
      return finalize(reply, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
    }
    const patch: Record<string, unknown> = pending.field === 'origin'
      ? { origin: choice }
      : { destination: choice };
    context = setContextSlots(context, patch as any, 'FILL_MISSING', contextUpdatedAt);
    context = { ...context, stationChoices: null, pendingStationResolution: null, lastAskedField: null, pendingQuestion: null, pendingSemanticPlan: null, updatedAt: contextUpdatedAt };
    // Re-run understanding so the remaining station gets resolved / next ambiguity is asked.
    u = understandAutonomously(input.message, context);
  }

  return await runCore(input, deps, now, context, u, correctionsApplied, resumedPausedBooking, contextUpdatedAt);
}

async function runCore(
  input: AutonomousHandlerInput, deps: { registry: ToolRegistry; now?: () => Date },
  now: () => Date, context: ConversationContext, u: AutonomousUnderstanding,
  correctionsApplied: string[], resumedPausedBooking: boolean, contextUpdatedAt: string,
): Promise<AutonomousHandlerOutput> {
  // ── HOLD ──
  if (u.primaryIntent === 'HOLD_PAUSE' && context.bookingStage && context.bookingStage !== 'IDLE') {
    context = {
      ...savePausedBooking(context, 'USER_INTERRUPTION', contextUpdatedAt),
      pendingQuestion: 'Theek hai, hold par hoon. Jab continue karna ho "chalo" keh dena!',
      updatedAt: contextUpdatedAt,
    };
    return finalize(context.pendingQuestion!, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  if (u.primaryIntent === 'RESUME' && (context as any).pausedBooking) {
    context = { ...restorePausedBooking(context, contextUpdatedAt), updatedAt: contextUpdatedAt };
    resumedPausedBooking = true;
    const pending = context.pendingQuestion ?? 'Aage badhte hain?';
    return finalize(pending, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
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
    const reply = 'Naye sire se shuru karte hain. 🔄 Batayein kaha se kaha jaana hai aur kab?';
    return finalize(reply, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  // ── CORRECTIONS ──
  if (u.isCorrection && u.correctionTarget) {
    const target = u.correctionTarget;
    const val = getEntityValue(u.entities, target as ExtractedEntity['type']);
    if (val !== null && val !== undefined) {
      const slot: Record<string, unknown> = {};
      switch (target) {
        case 'travelClass': slot.selectedClass = val as TravelClassCode; break;
        case 'journeyDate': { const r = resolveDateText(String(val), now()); if (r) slot.journeyDate = r; break; }
        case 'trainNumber': slot.selectedTrain = { ...(context.selectedTrain ?? emptyTrain()), number: String(val) }; break;
        case 'passengerCount': slot.passengerCount = Number(val); break;
      }
      if (Object.keys(slot).length > 0) {
        context = setContextSlots(context, slot, 'CORRECT', contextUpdatedAt);
        correctionsApplied.push(target);
        if (['origin', 'destination', 'journeyDate', 'trainNumber'].includes(target)) {
          context = { ...context, lastSearchResults: [], selectedClass: null };
        }
      }
    }
  }

  // ── Short answer to pending question → fill that field ──
  if (u.isAnswerToPendingQuestion && u.pendingQuestionField) {
    const field = u.pendingQuestionField;
    const rawMsg = input.message.trim().toLowerCase();
    const patch: Record<string, unknown> = {};
    const resolvedDate = (() => { const d = getEntityValue(u.entities, 'journeyDate'); return d ? (resolveDateText(String(d), now()) ?? resolveDateText(rawMsg, now())) : resolveDateText(rawMsg, now()); })();
    if ((field === 'journeyDate' || field === 'date') && resolvedDate) patch.journeyDate = resolvedDate;
    else if (field === 'passengerCount') { const c = getEntityValue(u.entities, 'passengerCount'); if (c) patch.passengerCount = c; }
    else if (field === 'selectedClass') { const c = getEntityValue(u.entities, 'travelClass'); if (c) patch.selectedClass = c; }
    if (Object.keys(patch).length > 0) {
      context = setContextSlots(context, patch, 'FILL_MISSING', contextUpdatedAt);
    }
    // If answer was a station name for origin/destination, resolve below in the station step.
    context = { ...context, lastAskedField: null, pendingQuestion: null, updatedAt: contextUpdatedAt };
  }

  // ── Slot filling: origin/destination names to be resolved via lookupStation.
  // We only fill slots that are EMPTY (don't overwrite already-verified stations).
  const fillIfEmpty = <K extends keyof ConversationContext>(key: K, value: ConversationContext[K]) => {
    if (context[key] === null || context[key] === undefined) {
      context = { ...context, [key]: value, updatedAt: contextUpdatedAt };
    }
  };
  let originName: string | null = getEntityValue(u.entities, 'origin') as string | null;
  let destName: string | null = getEntityValue(u.entities, 'destination') as string | null;
  let train = getEntityValue(u.entities, 'trainNumber') as string | null;
  let tclass = getEntityValue(u.entities, 'travelClass') as TravelClassCode | null;
  let pcount = getEntityValue(u.entities, 'passengerCount') as number | null;
  let date = getEntityValue(u.entities, 'journeyDate') as string | null;
  const resolvedDate = date ? resolveDateText(String(date), now()) : null;
  if (resolvedDate) fillIfEmpty('journeyDate' as any, resolvedDate);
  else if (date) fillIfEmpty('journeyDate' as any, date);
  if (train && !context.selectedTrain) fillIfEmpty('selectedTrain' as any, { ...emptyTrain(), number: String(train) });
  if (tclass) fillIfEmpty('selectedClass' as any, tclass);
  if (pcount) fillIfEmpty('passengerCount' as any, pcount);

  // If short answer for origin/destination, treat the raw message as the name.
  if (u.isAnswerToPendingQuestion && u.pendingQuestionField === 'origin' && !originName) originName = input.message.trim();
  if (u.isAnswerToPendingQuestion && u.pendingQuestionField === 'destination' && !destName) destName = input.message.trim();

  // ── Resolve station names → verified Station objects via lookupStation.
  async function resolveAndSetStation(field: 'origin' | 'destination', name: string | null) {
    if (!name) return;
    // Don't overwrite if we already have a verified station (has code, name came from code path).
    if (field === 'origin' && context.origin?.code && !looksLikePlaceholder(context.origin)) return;
    if (field === 'destination' && context.destination?.code && !looksLikePlaceholder(context.destination)) return;
    const r = await resolveStationName(deps.registry, name, input.conversationId, now());
    if (r.ambiguous && r.ambiguous.length > 1) {
      const fieldLabel = field === 'origin' ? 'kaha se (from station)' : 'kaha tak (to station)';
      const options = r.ambiguous.map((s) => `${s.name}${s.code ? ` (${s.code})` : ''}`).join('\n   • ');
      context = {
        ...context,
        lastAskedField: field as any,
        pendingQuestion: `${fieldLabel} ke liye multiple options mil gaye — kaunsa hai?\n   • ${options}`,
        stationChoices: { field, options: r.ambiguous, askedAt: contextUpdatedAt },
        updatedAt: contextUpdatedAt,
      };
      return 'ambiguous';
    }
    if (r.station) {
      context = setContextSlots(context, { [field]: r.station } as any, 'FILL_MISSING', contextUpdatedAt);
      return 'resolved';
    }
    return null;
  }

  function looksLikePlaceholder(s: Station): boolean {
    // A placeholder station has code == uppercased name (we set this initially but it's not provider-verified).
    return s.code === (s.name ?? "").toUpperCase() && s.zone === null;
  }

  // Resolve both stations; collect ambiguity (don't early-return on first ambiguity so
  // the first unambiguous resolution still gets saved before we ask about the other).
  let ambiguousField: 'origin' | 'destination' | null = null;
  if (originName) {
    const r = await resolveAndSetStation('origin', originName);
    if (r === 'ambiguous') ambiguousField = 'origin';
  }
  if (!ambiguousField && destName) {
    const r = await resolveAndSetStation('destination', destName);
    if (r === 'ambiguous') ambiguousField = 'destination';
  }
  if (ambiguousField) {
    return finalize(context.pendingQuestion!, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  // ── META intents (no tool calls needed) ──
  if (u.requiresNoTools) {
    const META_REPLIES: Record<string, string> = {
      GREETING: pick([
        'Namaste! 🙏 BookKaro mein aapka swagat hai. Main trains search, availability, fare, live status, PNR, booking — sab kuch kar sakta hoon. Batayein kya chahiye?',
        'Hi! Main BookKaro AI hoon — aapka apna railway assistant. Trains, tickets, PNR, live status, booking, cancellation — sab kuch. Batayein kaise madad karoon?',
        'Hello ji! 😊 Aaj kya karna hai? Trains dekhni hain? Ticket book karni hai? Ya kisi train ka status chahiye? Bataiye main hoon na!',
      ]),
      FAREWELL: pick([
        'Alvida! 🚂 Baad mein kabhi bhi aa jana — ticket chahiye ya kuch bhi, yaad kar lena. Safe travels!',
        'Bye bye! Apna khayal rakhna. Jab ticket chahiye BookKaro hai na! 😊',
      ]),
      THANKS: pick(['Aapka swagat hai! 😊 Aur chahiye ho to batana.', 'Koi baat nahi! Yahi hoon main.', 'Dhanyavaad! 🙏']),
      PRAISE: pick(['Shukriya! 🙏 Aapke liye better service dete rahenge.', 'Bahut dhanyavaad! 🌟']),
      FRUSTRATION: 'Maaf kijiye pareshani ke liye 🙏. Thoda detail mein batayein kya galat hua — main turant solve karunga.',
      COMPLAINT: 'Maaf kijiye pareshani ke liye 🙏. Thoda detail mein batayein kya galat hua — main turant solve karunga.',
      HELP: `Main BookKaro AI hoon — aapka railway assistant. Main kar sakta hoon:\n\n🚆 Trains search (kisi bhi route/date)\n🎫 Seat availability\n💰 Fare dikhana\n📍 Live train status\n📋 Timetable/stops\n🔢 PNR status\n❌ Cancelled trains\n🆚 Train comparison (kaunsi better/tez)\n🛒 Ticket booking (multi-passenger)\n💼 Wallet / booking history\n❓ Railway rules / glossary (tatkal, RAC, classes)\n\nBas Hindi/Hinglish/English mein poochhiye! 😊`,
      CAPABILITY_QUERY: `Main BookKaro AI hoon — aapka railway assistant. Main kar sakta hoon:\n\n🚆 Trains search\n🎫 Seat availability\n💰 Fare\n📍 Live status\n📋 Timetable\n🔢 PNR\n❌ Cancelled trains\n🆚 Compare\n🛒 Booking\n💼 Wallet / history\n❓ Railway rules\n\nBas Hindi/Hinglish/English mein poochhiye! 😊`,
      AFFIRMATION: pick(['Theek hai! 👍', 'Bilkul!', 'Samajh gaya!']),
      NEGATION: 'Theek hai, koi baat nahi. Batayein kya chahiye?',
      GO_BACK: 'Theek hai, ek step peeche chalte hain 🔙. Ab kya change karna hai?',
      RESUME: 'Chalo, wapas booking par aate hain. Jahan ruke the wahi se continue karte hain.',
      HOLD_PAUSE: 'Ruko ji, hold par hoon. ⏸️ Jab taiyyar ho jao "chalo" keh dena — wahin se shuru karenge.',
      START_OVER: 'Naye sire se shuru karte hain. 🔄 Batayein kaha se kaha jaana hai aur kab?',
      REPEAT_REQUEST: 'Theek hai, ek baar aur bata raha hoon:',
      NORMAL_CHAT: 'Main railway ka specialist hoon ji — is topic par meri training nahi hai. Par trains, tickets, PNR, booking, fare ya Indian Railways se related kuch bhi poochhiye, turant jawab dunga! 😊',
    };
    const replyText = META_REPLIES[u.primaryIntent] ?? 'Theek hai! Aur batayein kya chahiye?';
    return finalize(replyText, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  // ── GENERAL RAILWAY QUERY ──
  if (u.primaryIntent === 'GENERAL_RAILWAY_QUERY') {
    const answer = composeKnowledgeAnswer(input.message);
    const text = answer
      ? `${answer.answer}\n\nAur kuch railway related jaanna ho to batayein! 😊`
      : 'Railway ke rules/class/quota ke baare mein main approved knowledge se hi batata hoon. Thoda specific poochhiye — jaise "CC kya hota hai?", "tatkal kitne baje khulta hai?" etc.';
    return finalize(text, u, ['getRailwayKnowledge'], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  // ── Build tool plan ──
  const TOOL_MAP: Record<string, string[]> = {
    BOOK_TRAIN: ['searchTrains'], SEARCH_TRAIN: ['searchTrains'],
    LIVE_TRAIN_STATUS: ['getLiveStatus'], GET_AVAILABILITY: ['getAvailability'],
    GET_FARE: ['getFare'], GET_TRAIN_INFO: ['getTrainInfo'], GET_TIMETABLE: ['getTimetable'],
    LOOKUP_STATION: ['lookupStation'], CHECK_PNR: ['checkPNR'],
    VIEW_BOOKINGS: ['getBookings'], VIEW_WALLET: ['getWallet'],
    GET_CANCELLED_TRAINS: ['getCancelledTrains'], COMPARE_TRAINS: ['compareTrains'],
    CHECK_CHART_STATUS: ['getLiveStatus'], PLATFORM_INQUIRY: ['getLiveStatus'],
    COACH_POSITION: ['getLiveStatus'], CHECK_REFUND: ['getRailwayKnowledge'],
  };
  const REGISTRY_TO_CATALOG: Record<string, string> = {
    searchTrains: 'SEARCH_TRAINS', lookupStation: 'LOOKUP_STATION',
    getTrainInfo: 'GET_TRAIN_INFO', getTimetable: 'GET_TIMETABLE',
    getLiveStatus: 'GET_LIVE_STATUS', getAvailability: 'CHECK_AVAILABILITY',
    getFare: 'GET_FARE', checkPNR: 'GET_PNR', getCancelledTrains: 'GET_CANCELLED_TRAINS',
    getBookings: 'GET_BOOKINGS', getWallet: 'GET_WALLET', compareTrains: 'COMPARE_TRAINS',
    getRailwayKnowledge: 'RAILWAY_KNOWLEDGE',
  };

  const toolCalls: AiToolCallRequest[] = [];
  function buildArgs(toolRegistryName: string): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    switch (toolRegistryName) {
      case 'searchTrains':
        // Use station NAMES here — executeAiToolCalls -> validateToolArguments
        // will resolve via the catalog; for now pass codes if we have them, else names.
        if (context.origin?.code) args.originCode = context.origin.code;
        else if (originName) args.originCode = originName;
        if (context.destination?.code) args.destinationCode = context.destination.code;
        else if (destName) args.destinationCode = destName;
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
    }
    return args;
  }

  const desired = TOOL_MAP[u.primaryIntent];
  const allTools = desired ? [...desired] : [];
  if (u.primaryIntent === 'MULTI_INTENT') {
    for (const si of u.subIntents) {
      const t = TOOL_MAP[si];
      if (t) allTools.push(...t);
    }
  }

  for (const tn of allTools) {
    let catalogId = semanticToolToCatalogId(tn);
    if (!catalogId) catalogId = REGISTRY_TO_CATALOG[tn] ?? null;
    if (!catalogId || !isAiSelectableTool(catalogId)) continue;
    const args = buildArgs(tn);
    toolCalls.push({ tool: catalogId, args });
  }

  // Pause booking if this is an informational query mid-booking.
  const isInfoQuery = ['LIVE_TRAIN_STATUS', 'GET_FARE', 'GET_AVAILABILITY', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'CHECK_PNR', 'CHECK_CHART_STATUS', 'PLATFORM_INQUIRY', 'COACH_POSITION', 'CHECK_REFUND', 'COMPARE_TRAINS', 'GET_CANCELLED_TRAINS'].includes(u.primaryIntent);
  if (isInfoQuery && context.bookingStage && context.bookingStage !== 'IDLE' && !(context as any).pausedBooking) {
    context = savePausedBooking(context, 'USER_INTERRUPTION', contextUpdatedAt);
  }

  // Ask for missing info one field at a time.
  if (u.missingSlots.length > 0) {
    const first = u.missingSlots[0]!;
    context = { ...context, lastAskedField: first.field as any, pendingQuestion: first.question, updatedAt: contextUpdatedAt };
    return finalize(first.question, u, [], null, null, context, correctionsApplied, resumedPausedBooking);
  }

  // Execute tools.
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

  // Resume paused booking after answer.
  if (u.resumeAfterAnswer && (context as any).pausedBooking) {
    context = restorePausedBooking(context, contextUpdatedAt);
    resumedPausedBooking = true;
  }

  const anyOkToolResult = toolResults.some((t) => t.ok === true && t.data !== null && t.data !== undefined);

  // Intent-aware honest ack when tools didn't return data (keyless/demo/offline).
  const intentAck: Record<string, string> = {
    LIVE_TRAIN_STATUS: 'Samajh gaya — aap live status dekhna chahte hain. Live status railway provider se real-time fetch hota hai; abhi data source se response nahi mila.',
    GET_FARE: 'Samajh gaya — fare dekhna chahte hain. Abhi fare data fetch nahi ho pa raha.',
    GET_AVAILABILITY: 'Samajh gaya — availability check karni hai. Abhi seat status data fetch nahi ho pa raha.',
    GET_TIMETABLE: 'Samajh gaya — timetable/route dekhna chahte hain. Abhi data fetch nahi ho pa raha.',
    GET_TRAIN_INFO: 'Samajh gaya — train ki info chahiye. Abhi data source se response nahi mila.',
    CHECK_PNR: 'Samajh gaya — PNR status check karna hai. Abhi PNR data fetch nahi ho pa raha.',
    GET_CANCELLED_TRAINS: 'Samajh gaya — cancelled trains dekhni hain. Abhi provider data available nahi.',
    LOOKUP_STATION: 'Samajh gaya — station code chahiye. Abhi station lookup API se response nahi mila.',
    VIEW_WALLET: 'Samajh gaya — wallet balance dekhna chahte hain. Abhi wallet service active response nahi de raha.',
    VIEW_BOOKINGS: 'Samajh gaya — booking history dikhani hai.',
    CHECK_CHART_STATUS: 'Samajh gaya — chart status dekhna chahte hain.',
    CHECK_REFUND: 'Refund rules ke liye thoda specific poochhiye, ya main apne approved knowledge se answer deta hoon.',
    PLATFORM_INQUIRY: 'Samajh gaya — platform number jaanna chahte hain.',
    COACH_POSITION: 'Samajh gaya — coach position dekhni hai.',
    COMPARE_TRAINS: 'Samajh gaya — compare karna chahte hain.',
  };

  if (!anyOkToolResult && intentAck[u.primaryIntent] && !u.clarificationQuestion && toolCalls.length > 0) {
    return finalize(intentAck[u.primaryIntent]!, u, executedTools, null, null, context, correctionsApplied, resumedPausedBooking);
  }

  if (u.primaryIntent === 'BOOK_TRAIN' || u.primaryIntent === 'SEARCH_TRAIN') {
    if (!context.origin) return finalize('Pehle batayein kaha se chalna hai?', u, executedTools, null, null, context, correctionsApplied, resumedPausedBooking);
    if (!context.destination) return finalize('Kaha jaana hai?', u, executedTools, null, null, context, correctionsApplied, resumedPausedBooking);
    if (!context.journeyDate) return finalize('Kis date ko jaana hai? (aaj / kal / parso)', u, executedTools, null, null, context, correctionsApplied, resumedPausedBooking);
  }

  // Generate reply.
  const reply = generateReply({
    understanding: u,
    context,
    toolResults,
    pendingQuestion: context.pendingQuestion,
  });
  context = { ...context, lastIntent: u.primaryIntent as any, updatedAt: contextUpdatedAt };
  return finalize(reply.text, u, executedTools, null, null, context, correctionsApplied, resumedPausedBooking);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptyTrain() {
  return { name: null as string | null, originStation: null, destinationStation: null, departureTime: null, arrivalTime: null, runsOn: null, travelClasses: null, pantryCar: null };
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }

function finalize(
  reply: string, u: AutonomousUnderstanding, executedTools: string[],
  cards: unknown[] | null, panel: unknown | null, context: ConversationContext,
  correctionsApplied: string[], resumedPausedBooking: boolean,
): AutonomousHandlerOutput {
  return {
    reply, intent: u.primaryIntent,
    confidence: u.candidates[0]?.confidence ?? 0.5,
    executedTools, cards, panel, context,
    diagnostics: {
      tone: u.tone, sentiment: u.sentiment,
      candidates: u.candidates.map((c) => ({ intent: c.intent, confidence: c.confidence })),
      usedAutonomousEngine: true, correctionsApplied, resumedPausedBooking, multiIntents: u.subIntents,
    },
    safety: { aiCanBook: false, aiCanMoveMoney: false, providersChosenBy: 'server-router' },
  };
}
