/**
 * NVIDIA AI provider (REAL REST adapter, activated only when AI_API_KEY is
 * configured server-side). Talks to the NVIDIA integrate API with a
 * JSON-constrained prompt and returns STRICT structured output which the
 * orchestrator validates before use.
 *
 * The key arrives via constructor injection (never read from the environment in this module), is sent
 * only in the Authorization header to the NVIDIA endpoint, and is never
 * logged. Timeout bounded by the caller (orchestrator) + a transport-level
 * AbortController.
 */

import { NotImplementedError } from '../../shared/index.js';
import type {
  AIReplyInput,
  AIReplyResult,
  AIUnderstandingInput,
  AIUnderstandingResult,
  AISlotExtraction,
  ConversationContext,
  Intent,
} from '../../shared/index.js';
import type { AIProvider } from '../AIProvider.js';

export interface NvidiaAIProviderOptions {
  /** Primary key — answers always prefer this one. */
  apiKey: string;
  /** Backup keys, tried in order when the primary fails with 401/402/403/429. */
  fallbackApiKeys?: string[];
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export class NvidiaAIProvider implements AIProvider {
  readonly providerId = 'nvidia';

  private readonly apiKeys: string[];
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly disableThinking: boolean;

  constructor(options: NvidiaAIProviderOptions) {
    this.apiKeys = [options.apiKey, ...(options.fallbackApiKeys ?? [])].filter((key) => key.trim().length > 0);
    this.model = options.model ?? 'meta/llama-3.1-70b-instruct';
    this.disableThinking = /nemotron-3/i.test(this.model);
    this.baseUrl = (options.baseUrl ?? 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async understand(input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
    const body = await this.chat(
      [
        { role: 'system', content: nluSystemPrompt(input.availableIntents as readonly string[], input.availableTools as readonly string[]) },
        {
          role: 'user',
          content: `${conversationNluHint(input.conversation)}\n${conversationTranscriptHint(input.conversation, input.userMessage)}\nUser message: ${input.userMessage}`,
        },
      ],
      0.0, // NLU selection must be near-deterministic
    );
    // The orchestrator's validator sanitizes this — the provider never trusts its own model.
    const parsed = extractJson(body);
    // The model may now REQUEST a tool/API (read-only, money-safe). The orchestrator
    // re-validates the request against the tool registry before ever executing it.
    const toolReq = parsed.toolRequest;
    const toolName = typeof parsed.tool === 'string' && parsed.tool.length > 0
      ? parsed.tool
      : toolReq && typeof (toolReq as Record<string, unknown>).tool === 'string'
        ? String((toolReq as Record<string, unknown>).tool)
        : null;
    const toolInput =
      parsed.toolInput ??
      (toolReq && typeof (toolReq as Record<string, unknown>).input === 'object' ? (toolReq as Record<string, unknown>).input : null);
    const rationale = typeof parsed.rationale === 'string'
      ? parsed.rationale
      : toolReq && typeof (toolReq as Record<string, unknown>).rationale === 'string'
        ? String((toolReq as Record<string, unknown>).rationale)
        : null;
    const toolRequest = toolName
      ? { tool: toolName as import('../../shared/index.js').ToolName, input: (toolInput as Record<string, unknown> | null) ?? {}, rationale: rationale ?? null }
      : null;
    return {
      intent: parsed.intent as Intent, // sanitized + whitelisted by the orchestrator validator
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      slots: { ...emptySlots(), ...((parsed.slots ?? parsed.entities ?? {}) as Partial<AISlotExtraction>) },
      missingFields: Array.isArray(parsed.missingFields ?? parsed.missing)
        ? ((parsed.missingFields ?? parsed.missing) as AIUnderstandingResult['missingFields'])
        : [],
      toolRequest,
      searchFilter: (parsed.searchFilter ?? null) as AIUnderstandingResult['searchFilter'],
    };
  }

  async generateResponse(input: AIReplyInput): Promise<AIReplyResult> {
    const user = input.userMessage?.trim() ? `User asked: "${input.userMessage.trim()}"` : 'User asked a railway question.';
    const body = await this.chat([
      {
        role: 'system',
        content:
          'You are BookKaro, a friendly Indian railway assistant. Reply in Hinglish (1–4 short sentences). ' +
          'If the tool-results JSON has data: answer the USER question using ONLY those facts. Never invent train numbers, times, dates, fares, availability, stations or stop times. If the data does not contain the answer, say so plainly. ' +
          'STOPPAGE vs SEATS: you do not memorize which trains halt where. If a timetable/stops list is in the JSON and the asked from/to station is NOT in it, say the train does NOT halt there. Never say AVAILABLE, waitlist, or "seats nahi" for a non-halt — that is stoppage, not inventory. ' +
          'If tool results are empty: this is conversation (greeting, thanks, help, off-topic). Greet warmly, say you handle trains, live status, fare, PNR and booking, and invite them to ask. Never invent live railway facts. ' +
          'No URLs, no markdown tables.',
      },
      { role: 'user', content: `${user}\n\nVerified tool results JSON (only these facts may be used):\n${JSON.stringify(input.toolResults).slice(0, 4_000)}\n\nWrite the reply.` },
    ]);
    return { message: typeof body === 'string' ? body : String(body), askForField: null };
  }

  /**
   * PUBLIC chat-completions entry for the Semantic AI Tool Planner. Reuses the
   * exact same transport: server-side key, key rotation on 401/402/403/429,
   * per-model timeout + AbortController, thinking disabled for Nemotron 3.x.
   * Returns the raw assistant text (already validated/parsed by the caller).
   */
  async complete(messages: Array<{ role: string; content: string }>, temperature = 0.2): Promise<unknown> {
    return this.chat(messages, temperature);
  }

  /** Auth/quota failures that justify rotating to the NEXT key. */
  private static readonly KEY_ROTATION_STATUSes = [401, 402, 403, 429];

  private async chat(messages: Array<{ role: string; content: string }>, temperature = 0.2): Promise<unknown> {
    let lastError: unknown = null;
    for (const apiKey of this.apiKeys) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            // Server-side only; never logged, never exposed to the browser.
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature,
            max_tokens: 1600, // headroom when thinking is enabled
            stream: false,
            // Nemotron 3.x reasoning models: structured NLU extraction does not need
            // thinking tokens — disabling them cuts latency from ~25s to ~1s.
            ...(this.disableThinking ? { chat_template_kwargs: { thinking: false } } : {}),
          }),
          signal: controller.signal,
        });
        if (response.ok) {
          const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
          return payload.choices?.[0]?.message?.content ?? null;
        }
        if (!NvidiaAIProvider.KEY_ROTATION_STATUSes.includes(response.status)) {
          throw new NotImplementedError(`NVIDIA API error ${response.status}`); // not a key problem — do not rotate
        }
        lastError = new NotImplementedError(`NVIDIA API error ${response.status} (key rotated)`); // try next key
      } catch (error) {
        if (error instanceof NotImplementedError && NvidiaAIProvider.KEY_ROTATION_STATUSes.some((status) => error.message.includes(String(status)))) {
          lastError = error; // rotation case — continue to the next key
          continue;
        }
        throw error; // timeout/network — not a key problem
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new NotImplementedError('NVIDIA API error: all keys exhausted');
  }
}

// ── shared prompt/parse helpers (used by NVIDIA and Gemini) ──────────────────

function toolCatalogueLine(tools: readonly string[]): string {
  if (tools.length === 0) return '';
  return 'AVAILABLE TOOLS (use only these; arg names are exact): ' + tools.join(', ');
}

export function nluSystemPrompt(intents: readonly string[], availableTools: readonly string[] = []): string {
  return [
    'You are the NLU + understanding layer of BookKaro, an Indian railway assistant. Reply with ONLY a JSON object, no markdown:',
    '{"intent": "<one of: ' + intents.join(', ') + '>", "confidence": 0..1,',
    ' "entities": {"origin": str|null, "destination": str|null, "dateText": "aaj|kal|parso|YYYY-MM-DD|null",',
    ' "passengerCount": 1-6|null, "trainNumber": str|null, "secondTrainNumber": str|null, "travelClass": "SL|3A|2A|1A|CC|EC|2S|3E"|null,',
    ' "pnr": 10-digits|null, "resultReference": "pehli|doosri|last|<trainNumber>"|null, "isCorrection": bool,',
    ' "mentionedStations": [..], "glossaryTerm": str|null},',
    ' "searchFilter": {"kind":"dayPart|timeWindow","dayPart":"morning|afternoon|evening|night","fromMin":0-1439,"toMin":0-1439,"source":"<the exact time words the user wrote>"}|null, "tool": "<one of the available tool names>|null", "toolInput": {...}|null, "rationale": "one short line why this tool"|null, "missing": ["origin","destination","journeyDate","passengerCount"]}',
    'YOUR ROLE (primary autonomous agent — think like ChatGPT for Indian railways):',
    '  - Understand ANY phrasing: Hindi (Devanagari), Hinglish, English, typos, slang, short answers, multi-intent, follow-ups ("uska fare", "wo kitni late"), corrections ("nahi kal nahi parso"). Infer intent from conversation context — never say you do not understand a reasonable railway request.',
    '  - GREETINGS (hi/hello/hey/namaste/namaskar) → intent HELP. THANKS/bye → intent HELP. Off-topic (weather/cricket/movies) → intent NORMAL_CHAT.',
    '  - origin/destination are ONLY station names or codes (Amritsar, ASR, Ludhiana, LDH, New Delhi, NDLS). NEVER put filler words there (mujhe, kal, bhai, subah, train, ticket, chahiye, jaana).',
    '  - Example: "bhai kal subah asr se ldh 2 ticket" → origin="ASR" (or Amritsar), destination="LDH" (or Ludhiana), dateText="kal", passengerCount=2, searchFilter morning, intent BOOK_TRAIN, tool searchTrains.',
    '  - You UNDERSTAND the user and DECIDE which railway tool/API must be called: fill "tool" (one of the AVAILABLE TOOLS below), "toolInput" (correct arg names) and "rationale" (one short line).',
    '  - Example: "12014 live status" → {intent:"LIVE_TRAIN_STATUS", tool:"getLiveStatus", toolInput:{trainNumber:"12014"}}. "fare kitna hai ASR se LDH" → {intent:"GET_FARE", tool:"getFare", toolInput:{from:"ASR",to:"LDH",trainNumber:null}}. "Amritsar se Ludhiana trains" → {intent:"BOOK_TRAIN", tool:"searchTrains", toolInput:{from:"Amritsar",to:"Ludhiana"}}. "seat milegi 12014 SL" → {intent:"GET_AVAILABILITY", tool:"getAvailability", toolInput:{trainNumber:"12014",travelClass:"SL"}}. "PNR check" → {intent:"CHECK_PNR", tool:"checkPNR", toolInput:{pnr:"<10-digit>"}}. "wallet balance" → {intent:"VIEW_WALLET", tool:"getWallet", toolInput:{}}.',
    '  - Set "tool":null when the answer needs no live railway fetch (help, glossary, off-scope chat, a booking slot using existing same-turn context), OR when you need to ask the user a question first.',
    '  - A deterministic SERVER engine (ToolGate/ToolExecutor/ProviderRouter) executes and verifies your tool call. You NEVER invent the result; you request it. The server rejects any protected tool (booking confirm, wallet write).',
    '  - You are the planner+decider: pick the right tool, give correct input, and rely on the verified result to answer. Never invent stations, codes, dates, fares, counts or trains.',
    '  - Reply in the SAME language the user wrote in for the JSON "searchFilter.source" field (keep their exact words); everything else is machine JSON.',
    toolCatalogueLine(availableTools),
    'CLOCK / DAY-PART (EXACT, authoritative — the server uses these same boundaries):',
    '  - morning = 00:00–11:59. After midnight (12:00 AM) a NEW day begins, so 00:00–04:59 is EARLY MORNING of that day, NOT night. e.g. a 4:55 AM train is a MORNING train.',
    '  - afternoon = 12:00–16:59; evening = 17:00–20:59; night = 21:00–23:59 only.',
    '  - So "subah"/"morning" → dayPart:"morning"; "raat"/"night" → dayPart:"night". ALWAYS apply the midnight rule: "12 baje ke baad" is AM/next-day morning, never night.',
    '  - An explicit clock window "4am se 6am"/"04:00 se 06:00"/"4 se 6 baje" → kind:"timeWindow", fromMin/toMin in minutes from 00:00.',
    '  - Set searchFilter null when the user names NO time of day.',
    'Rules: extract only what the user literally said; never invent stations, codes, dates or numbers;',
    'LANGUAGES: the user may write in ENGLISH, HINDI (Devanagari, e.g. "मुझे अमृतसर से लुधियाना कल सुबह की ट्रेन चाहिए"), or HINGLISH — often mixed. Understand all three identically. If a station is written in Devanagari, output origin/destination in its standard Latin spelling (अमृतसर → Amritsar); NEVER invent or change to a different station — if unsure, keep it exactly as the user wrote it.',
    'LANG origin/destination: "A se B" → origin=A, destination=B; "from A to B" → same; "अमृतसर से लुधियाना" → origin="Amritsar", destination="Ludhiana".',
    'LANG dateText: today/aaj/आज; tomorrow/kal/कल; day-after-tomorrow/parso/परसों; "next Monday"/"अगले सोमवार"; "27 August" etc.',
    'LANG classes: sleeper/स्लीपर=SL; chair car/चेयर कार=CC; 3 AC / third ac / तीसरा एसी=3A; 2 AC / second ac / दूसरा एसी=2A; 1 AC / first ac / पहला एसी=1A; 3E; 2S; EC.',
    'LANG passengerCount: "2 tickets"/"2 टिकट"/"हम 3 लोग"/"तीन टिकट" → 3.',
    'LANG intents: live/लाइव स्टेटस/स्थिति→LIVE_TRAIN_STATUS; PNR/पीएनआर→CHECK_PNR; fare/किराया→GET_FARE; available/उपलब्धता/milegi→GET_AVAILABILITY; timetable/टाइम टेबल/समय सारिणी→GET_TIMETABLE; cancelled/रद्द→GET_CANCELLED_TRAINS; wallet/वॉलेट→VIEW_WALLET; bookings/मेरी बुकिंग→VIEW_BOOKINGS; station code/स्टेशन कोड→LOOKUP_STATION.',
    'YOU ARE NOT A RAILWAY DATABASE: thousands of trains × stations. NEVER memorize or guess whether a train HALTS, has seats, or a fare. Live APIs are the only source. If you do not have a verified tool result, request a tool or ask a missing slot — never bluff.',
    'STOPPAGE: "X Y pe rukti hai?", "does train X stop at Y?" → {intent:"GET_TIMETABLE", tool:"getTimetable", toolInput:{trainNumber:"X"}} and put Y in mentionedStations (or origin/destination if "A se B"). You never decide halt yourself.',
    'AVAILABILITY/FARE/BOOKING on ANY named train + from/to: set tool getAvailability or getFare (or getTimetable). The SERVER always fetches the live commercial schedule first for THAT train and refuses if either station is not a commercial stop (passing a city ≠ halt). Same rule for every train — no special cases. NEVER invent "seats nahi"/WL/AVAILABLE for a non-halt; that is stoppage, not inventory.',
    'SEARCH: searchTrains results are filtered by the SERVER — only trains whose live commercial schedule HALTS at both from and to are listed. A DLI (Delhi Jn) train is not an NDLS train (do not merge Delhi terminals). BCT and MMCT are the same Mumbai Central station; CSTM and CSMT are the same CSMT. Never invent extra trains.',
    'LIST INTELLIGENCE: when searchResults are already on screen and the user asks fastest / sabse tez / sabse fast / fast train / kam time / less time / jaldi pahunch / pahunchaye / earliest / latest / longest / slowest / kaunsi tez — intent COMPARE_TRAINS, tool null. NEVER call searchTrains again. Do NOT fill origin/destination unless the user named a NEW "X se Y" route this turn. The server picks the winner from the CURRENT verified list and shows ONLY that train.',
    'LANG digits: accept Devanagari digits too (१२३ → 123) for train numbers and PNR.',
    'Intent hints: available/milegi/milega/WL questions → GET_AVAILABILITY; fare/price/paisa questions → GET_FARE;',
    'Wanting a class is BOOKING, not availability: "3A chahiye", "sleeper seat", "12014 mein 3A", "SL wali" → intent BOOK_TRAIN, fill trainNumber and/or travelClass.',
    'Spoken classes: sleeper=SL, chair car=CC, 3AC/third ac/3 ac/teen ac=3A, 2AC/second ac=2A, 1AC/first ac=1A, 3E=3E, 2S=second sitting, EC=executive chair.',
    'While search results are showing, a bare train number ("12014") or ordinal ("pehli wali") → BOOK_TRAIN + trainNumber/resultReference.',
    'Do NOT use GET_AVAILABILITY unless the user asks available/milegi/waitlist. "seat chahiye" means they want to book that class.',
    '"kal"=tomorrow "parso"=day-after-tomorrow "aaj"=today only when the user says so;',
    'a bare short answer (just a date/count/class/ordinal like "pehli wali") gets intent UNKNOWN with the entity filled — the server continues the pending question.',
    'NEVER return UNKNOWN for a railway-related message if a closer intent exists (BOOK_TRAIN, LIVE_TRAIN_STATUS, GET_FARE, GET_AVAILABILITY, GET_TIMETABLE, CHECK_PNR, HELP).',
  ].filter((line) => line.length > 0).join('\n');
}

/** Compact booking state so the model can parse follow-ups like "3A chahiye". */
export function conversationNluHint(conversation: ConversationContext): string {
  const bits: string[] = [];
  if (conversation.lastAskedField) bits.push(`pendingField=${conversation.lastAskedField}`);
  if (conversation.pendingQuestion) bits.push(`pendingQuestion=${conversation.pendingQuestion}`);
  if (conversation.origin?.code) bits.push(`origin=${conversation.origin.code}`);
  if (conversation.destination?.code) bits.push(`destination=${conversation.destination.code}`);
  if (conversation.journeyDate) bits.push(`date=${conversation.journeyDate}`);
  if (conversation.selectedTrain) bits.push(`selectedTrain=${conversation.selectedTrain.number}`);
  if (conversation.selectedClass) bits.push(`selectedClass=${conversation.selectedClass}`);
  if (conversation.pendingDataRoute) {
    const pdr = conversation.pendingDataRoute;
    bits.push(
      `pendingDataRoute=${pdr.intent} train=${pdr.trainNumber}${pdr.travelClass ? ` class=${pdr.travelClass}` : ''}${pdr.journeyDate ? ` date=${pdr.journeyDate}` : ''} missingOrigin=${pdr.missingOrigin} missingDestination=${pdr.missingDestination} (user is answering the ROUTE — resolve origin/destination)`,
    );
  }
  const results = conversation.lastSearchResults ?? [];
  if (results.length > 0) {
    bits.push(
      `searchResults=${results
        .slice(0, 6)
        .map((entry) => `${entry.train.number}:${(entry.train.travelClasses ?? []).join('/')}`)
        .join(',')}`,
    );
    bits.push(`listOnScreen=${results.length} trains. Superlative (fastest/sabse tez/less time/kam time/jaldi pahunch) → intent COMPARE_TRAINS, tool null — NEVER searchTrains again.`);
  }
  if (bits.length === 0) return 'Conversation context: (new chat)';
  return `Conversation context (do not invent beyond this): ${bits.join('; ')}`;
}

/** Cap the number of recent turns + per-message length so the prompt stays bounded. */
const TRANSCRIPT_MAX_TURNS = 8;
const TRANSCRIPT_MAX_CHARS = 300;

/**
 * CONVERSATION MEMORY — the recent user↔assistant transcript the model can see.
 *
 * This is what lets the AI answer a follow-up in real context (e.g. "uska fare
 * kitna hai" = the fare of the train we just discussed) instead of treating every
 * message as a brand-new chat. It always:
 *   - excludes the CURRENT user message (already sent separately as "User message"),
 *   - keeps only user/assistant turns (drops tool/system noise),
 *   - truncates each message and keeps only the recent tail,
 *   - never includes any secret — it is just the dialogue text.
 * The deterministic engine still owns truth; this is context only, never inventing facts.
 */
export function conversationTranscriptHint(conversation: ConversationContext, currentMessage: string): string {
  const turns = (conversation.messages ?? [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => !(m.role === 'user' && m.content === currentMessage)) // don't double-send the live turn
    .slice(-TRANSCRIPT_MAX_TURNS);
  if (turns.length === 0) return '';
  const lines = turns.map((m) => {
    const content = m.content.length > TRANSCRIPT_MAX_CHARS ? `${m.content.slice(0, TRANSCRIPT_MAX_CHARS)}…` : m.content;
    const label = m.role === 'user' ? 'User' : 'Assistant';
    return `${label}: ${content}`;
  });
  return `Recent conversation (so you answer in context):\n${lines.join('\n')}`;
}

export function emptySlots(): AISlotExtraction {
  return {
    originQuery: null,
    destinationQuery: null,
    journeyDate: null,
    dateText: null,
    passengerCount: null,
    trainNumber: null,
    secondTrainNumber: null,
    travelClass: null,
    pnr: null,
    resultReference: null,
    isCorrection: false,
    mentionedStations: [],
    glossaryTerm: null,
  };
}

export function extractJson(content: unknown): Record<string, unknown> {
  if (typeof content !== 'string') return {};
  const withoutFences = content.replace(/```json|```/g, '').trim();
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return {};
  try {
    const parsed: unknown = JSON.parse(withoutFences.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
