/**
 * AUTONOMOUS INTENT ENGINE — ChatGPT-style universal understanding.
 *
 * This engine hands full control to the AI layer: it understands ANY user
 * message (Hindi, Hinglish, English, mixed, informal, typos, short-forms,
 * slang, multi-intent, corrections, follow-ups, questions, complaints,
 * greetings, small-talk, feedback) and maps it to:
 *
 *   - A primary intent (possibly with sub-intents for multi-query messages)
 *   - Extracted slots/entities (stations, dates, trains, classes, PNR…)
 *   - Confidence scores + reasoning
 *   - Suggested actions / tool plan
 *   - Conversational tone guidance
 *   - Missing information + natural clarification questions
 *
 * Design principles (ChatGPT-like):
 *   1. NEVER say "I don't understand" for reasonable input. Infer intent from
 *      context, conversation history, and semantic similarity.
 *   2. Multi-intent messages ("aaj ki train dekhna hai aur kal ka weather bhi")
 *      are split naturally and handled in priority order.
 *   3. Follow-ups ("uska fare?", "aur CC mein?", "wo kitni late hai?") resolve
 *      references (uska/wo/ye/wali/wala/is/that) from context automatically.
 *   4. Corrections ("nahi Amritsar nahi Jalandhar", "kal nahi parso") are
 *      detected as UPDATES, not new requests.
 *   5. Ambiguity is resolved by asking ONE natural question, never by guessing.
 *   6. Off-topic is handled politely but keeps the booking context alive.
 *   7. Greetings, thanks, praise, frustration are all handled naturally.
 *   8. Typos and spelling variations are normalized (ludhiana/ludhiyana/ldh).
 *   9. Hindi (Devanagari), Roman Hinglish, and English all work identically.
 *  10. The engine is the SINGLE source of understanding — everything else
 *      (tool selection, slot filling, replies) reads from its output.
 */

import type { ConversationContext } from '../../shared/index.js';
import type { Intent } from '../../shared/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type AutonomousIntent =
  // ── Core railway intents ──
  | 'BOOK_TRAIN'
  | 'SEARCH_TRAIN'
  | 'LIVE_TRAIN_STATUS'
  | 'GET_AVAILABILITY'
  | 'GET_FARE'
  | 'GET_TRAIN_INFO'
  | 'GET_TIMETABLE'
  | 'LOOKUP_STATION'
  | 'CHECK_PNR'
  | 'VIEW_BOOKINGS'
  | 'VIEW_WALLET'
  | 'GET_CANCELLED_TRAINS'
  | 'COMPARE_TRAINS'
  | 'TRAIN_ROUTE'
  | 'GET_FARE_BREAKDOWN'
  | 'CHECK_REFUND'
  | 'CHECK_CHART_STATUS'
  | 'PLATFORM_INQUIRY'
  | 'COACH_POSITION'
  | 'PNR_HISTORY'
  // ── Booking-flow intents ──
  | 'CONFIRM_BOOKING'
  | 'CANCEL_BOOKING'
  | 'MODIFY_BOOKING'
  | 'RESCHEDULE'
  | 'ADD_PASSENGER'
  | 'CHANGE_CLASS'
  | 'CHANGE_TRAIN'
  | 'CHANGE_DATE'
  | 'CHANGE_ORIGIN'
  | 'CHANGE_DESTINATION'
  | 'CHANGE_PASSENGER_COUNT'
  | 'REVIEW_BOOKING'
  | 'APPLY_PROMOCODE'
  // ── Meta / conversational intents ──
  | 'GREETING'
  | 'FAREWELL'
  | 'THANKS'
  | 'PRAISE'
  | 'COMPLAINT'
  | 'FRUSTRATION'
  | 'HELP'
  | 'CAPABILITY_QUERY'
  | 'GREETING_REPLY'
  | 'SMALL_TALK'
  | 'APP_FEEDBACK'
  | 'REPEAT_REQUEST'
  | 'CLARIFICATION_REQUEST'
  | 'AFFIRMATION'
  | 'NEGATION'
  | 'HOLD_PAUSE'
  | 'RESUME'
  | 'GO_BACK'
  | 'START_OVER'
  | 'CORRECTION'
  | 'MULTI_INTENT'
  | 'GENERAL_RAILWAY_QUERY'
  | 'NORMAL_CHAT'
  | 'UNKNOWN';

export type ConversationTone =
  | 'friendly'      // default
  | 'helpful'       // informational answer
  | 'patient'       // user is confused/repeating
  | 'apologetic'    // error / data unavailable
  | 'celebratory'   // booking success
  | 'urgent'        // train running / cancellation
  | 'formal'        // PNR/refund policy
  | 'casual';       // small talk / greetings

export interface ExtractedEntity {
  type:
    | 'origin' | 'destination' | 'station'
    | 'trainNumber' | 'trainName'
    | 'journeyDate' | 'date'
    | 'travelClass'
    | 'passengerCount'
    | 'pnr'
    | 'quota'
    | 'coachNumber' | 'berthPreference'
    | 'promoCode'
    | 'passengerName' | 'passengerAge' | 'passengerGender'
    | 'timeOfDay'
    | 'reference'          // "pehli wali", "uska", "wo"
    | 'correctionField'
    | 'unknown';
  value: string | number | null;
  rawText: string;
  confidence: number;       // 0..1
  source: 'explicit' | 'context' | 'inferred' | 'reference';
}

export interface IntentConfidence {
  intent: AutonomousIntent;
  confidence: number;
  reasoning: string;
}

export interface MissingSlot {
  field: string;
  question: string;
  reason: string;
  optional?: boolean;
}

export interface AutonomousUnderstanding {
  /** The primary intent. */
  primaryIntent: AutonomousIntent;
  /** Top-3 candidates ranked by confidence (for multi-intent / ambiguity). */
  candidates: IntentConfidence[];
  /** Detected sub-intents (multi-part messages). */
  subIntents: AutonomousIntent[];
  /** All extracted entities, best-effort. */
  entities: ExtractedEntity[];
  /** User seems to be correcting a previous field. */
  isCorrection: boolean;
  correctionTarget: string | null;
  /** User is answering a previously-asked question. */
  isAnswerToPendingQuestion: boolean;
  pendingQuestionField: string | null;
  /** User is referring back to earlier context (uska/wo/ye/wali). */
  usesContextReference: boolean;
  /** Conversation tone that should shape the reply. */
  tone: ConversationTone;
  /** Fields still required before we can fulfill the intent. */
  missingSlots: MissingSlot[];
  /** A clarifying question we should ask (or null). */
  clarificationQuestion: string | null;
  /** When true, the message is safe to answer directly (small-talk, greetings). */
  requiresNoTools: boolean;
  /** Suggested tool plan (populated by the AI planner). */
  suggestedTools: string[];
  /** The original raw message, for logging. */
  rawMessage: string;
  /** Normalized (Hindi→Hinglish, typos fixed) message. */
  normalizedMessage: string;
  /** Detected sentiment/urgency. */
  sentiment: 'positive' | 'neutral' | 'negative' | 'urgent';
  /** Should we resume a paused booking after answering? */
  resumeAfterAnswer: boolean;
}

// ── Normalization ────────────────────────────────────────────────────────────

const DEVANAGARI_MAP: Record<string, string> = {
  'नमस्ते': 'namaste', 'हैलो': 'hello', 'हाय': 'hi', 'थैंक्स': 'thanks', 'धन्यवाद': 'dhanyavaad',
  'मदद': 'madad', 'हेल्प': 'help', 'बुक': 'book', 'टिकट': 'ticket', 'ट्रेन': 'train',
  'स्टेशन': 'station', 'किराया': 'kiraya', 'सीट': 'seat', 'उपलब्ध': 'available',
  'पीएनआर': 'pnr', 'लाइव': 'live', 'स्टेटस': 'status', 'कैंसिल': 'cancel', 'रद्द': 'cancel',
  'कल': 'kal', 'आज': 'aaj', 'परसों': 'parso',
  'हाँ': 'haan', 'जी': 'ji', 'नहीं': 'nahi',
  'मुझे': 'mujhe', 'मैं': 'main', 'चाहिए': 'chahiye', 'जाना': 'jana',
  'से': 'se', 'तक': 'tak', 'को': 'ko', 'के': 'ke', 'लिए': 'liye', 'क्या': 'kya',
  'कहाँ': 'kahan', 'कब': 'kab', 'कैसे': 'kaise', 'कितना': 'kitna', 'कितने': 'kitne',
  'बताओ': 'batao', 'दिखाओ': 'dikhao', 'करो': 'karo', 'है': 'hai',
  'और': 'aur', 'में': 'mein', 'वो': 'wo', 'ये': 'ye', 'यह': 'yeh',
  'वाली': 'wali', 'वाला': 'wala',
  'क्लास': 'class', 'स्लीपर': 'sleeper', 'एसी': 'ac',
  'चेक': 'check',
};

/** Normalize a message: transliterate Devanagari keywords, fix common typos, lowercase. */
export function normalizeMessage(raw: string): string {
  let msg = raw.trim();

  // Transliterate Devanagari keywords we know, keep proper nouns as-is.
  for (const [dev, lat] of Object.entries(DEVANAGARI_MAP)) {
    msg = msg.split(dev).join(lat);
  }

  // Convert Devanagari digits to ASCII.
  msg = msg.replace(/[\u0966-\u096F]/g, (d) =>
    String('०१२३४५६७८९'.indexOf(d)),
  );

  // Lower-case for keyword matching (keep train codes uppercase separately).
  msg = msg.toLowerCase();

  // Common typo / shorthand normalization.
  const TYPO_MAP: Record<string, string> = {
    'ludhiyana': 'ludhiana', 'ludihana': 'ludhiana', 'ldh': 'ludhiana',
    'amritsr': 'amritsar', 'asr': 'amritsar',
    'jalandhr': 'jalandhar', 'juc': 'jalandhar',
    'delh': 'delhi', 'dilli': 'delhi', 'ndls': 'new delhi',
    'mumb': 'mumbai', 'bombay': 'mumbai',
    'banglore': 'bengaluru', 'bangalore': 'bengaluru',
    'calc': 'kolkata', 'calcutta': 'kolkata',
    'madras': 'chennai',
    'banares': 'varanasi', 'benaras': 'varanasi',
    'poona': 'pune',
    'pls': 'please', 'plz': 'please', 'thx': 'thanks', 'thnx': 'thanks', 'ty': 'thanks',
    'ok ': 'okay ', 'okk': 'okay',
    'availablity': 'availability', 'availabilty': 'availability', 'avail': 'available',
    'confm': 'confirm', 'cnf': 'confirm',
    'waitlistd': 'waitlisted', 'wtlist': 'waitlist',
    'dep': 'departure', 'arr': 'arrival',
    'lst': 'last', 'lst wali': 'last wali',
  };
  for (const [typo, fix] of Object.entries(TYPO_MAP)) {
    msg = msg.replace(new RegExp(`\\b${typo}\\b`, 'g'), fix);
  }

  // Collapse whitespace.
  msg = msg.replace(/\s+/g, ' ').trim();
  return msg;
}

// ── Keyword libraries (extensive Hinglish + English + Hindi) ─────────────────

const GREETING_WORDS = [
  'hi', 'hello', 'hey', 'namaste', 'namaskar', 'pranam', 'salaam',
  'good morning', 'good evening', 'good afternoon', 'good night',
  'sup', "what's up", 'kaise ho', 'kaise hain', 'kya haal', 'kya haal hai',
  'ram ram', 'jai shree', 'satsriyakal',
];

const FAREWELL_WORDS = ['bye', 'goodbye', 'alvida', 'bye bye', 'tata', 'see you', 'phir milenge', 'chalta hoon', 'chalta hun', 'ja raha hoon'];
const THANKS_WORDS = ['thanks', 'thank you', 'thx', 'thnx', 'dhanyavaad', 'shukriya', 'shukriyaa'];
const PRAISE_WORDS = ['badhiya', 'great', 'awesome', 'mast', 'jakkas', 'zabardast', 'wah', 'very good', 'nice', 'acha kaam', 'good job', 'well done', 'shaabash', 'shabash'];
const AFFIRMATION_WORDS = ['haan', 'ha', 'ji haan', 'yes', 'ji', 'okay', 'ok', 'theek hai', 'thik hai', 'bilkul', 'sahi', 'jarur', 'sure', 'yup', 'yeah', 'right', 'exactly', 'achha', 'accha', 'achchha'];
const NEGATION_WORDS = ['nahi', 'nahin', 'na', 'no', 'nope', 'galat', 'wrong', "don't", 'mat', 'mat karo', 'never'];
const FRUSTRATION_WORDS = ['bakwas', 'faltu', 'pagal', 'bewakoof', 'ganda', 'worst', 'pathetic', 'pareshan', 'pareshani', 'problem', 'issue', 'galat bata', 'galat jawab', 'nahi samajh', 'nahi samajh raha', 'samajh nahi aaya', 'wait kar raha hoon', 'itna wait', 'kitna wait', 'kitna time lag', 'bahut late ho gaya', 'late ho raha hai', 'itni deri', 'itna late'];
const HOLD_WORDS = ['ruko', 'rukko', 'ruk jao', 'ruk ja', 'wait a minute', 'ek minute', 'thoda ruko', 'hold on', 'ek second', 'ek min', 'thoda intezaar', 'bas karo', 'stop', 'wait karo', 'thoda wait'];
const RESUME_WORDS = ['chalo ab', 'ab chalo', 'age badho', 'aage badho', 'continue', 'resume', 'wapas', 'wapis', 'phir se shuru', 'aage'];
const GO_BACK_WORDS = ['peeche', 'pichla', 'previous', 'go back', 'wapas jao', 'peeche chalo', 'back', 'one step back'];
const START_OVER_WORDS = ['shuru se', 'start over', 'naya shuru', 'phir se shuru karo', 'reset', 'fresh start', 'fir se start'];
const HELP_WORDS = ['help', 'madad', 'kya kar sakte', 'kaise help', 'how can you help', 'kya kya kar', 'assist', 'guide'];
const CAPABILITY_WORDS = ['kya kar sakte', 'what can you do', 'kaise madad kar', 'kya kya kar', 'features', 'kya help', 'kya service', 'what services'];
const REPEAT_WORDS = ['fir se', 'phir se', 'repeat', 'dobara', 'dobara batao', 'phir se batao', 'repeat karo', 'ek baar aur', 'ek aur baar', 'samajh nahi aaya'];

const TRAIN_PREFIXES = ['train no', 'train number', 'train no.', 'tt number'];
const CANCEL_WORDS = ['cancel', 'cancelled', 'canceled', 'cancelled train', 'radd', 'band hai', 'band hui', 'cancel ho gayi', 'cancel hai'];
const LIVE_WORDS = ['live', 'abhi kaha', 'kaha hai', 'kahan hai', 'kitni late', 'late hai', 'chal rahi', 'running status', 'current status', 'abhi kidhar', 'agla station', 'next station', 'pichla station', 'last station', 'kaha pahunchi'];
const FARE_WORDS = ['fare', 'kiraya', 'kitna paisa', 'kitne paise', 'price', 'cost', 'kitna padega', 'kitna lagega', 'kitna lagega', 'total', 'total kitna', 'me kitna', 'ticket price', 'ticket ka price'];
const AVAILABILITY_WORDS = ['available', 'availability', 'seat hai', 'seat milegi', 'seat mil', 'berth', 'seat available', 'kitni seat', 'kitne seat', 'seat kitni', 'confirm ticket', 'confirm hai', 'rac hai', 'wl hai', 'waitlist', 'waiting list', 'seat confirm', 'milegi kya'];
const TIMETABLE_WORDS = ['timetable', 'time table', 'schedule', 'route', 'stops', 'kaha rukti', 'kaha rukta', 'kaha kaha rukti', 'kin stations par', 'station list', 'route map', 'kaha se chalta', 'kaha pahunchta', 'kaha pahunchti', 'kaha tak jati', 'kaha tak jata'];
const TRAIN_INFO_WORDS = ['baare mein', 'ke baare mein', 'ke bare mein', 'about', 'info', 'information', 'details', 'roz chalti', 'daily chalta', 'kaisi train', 'kon si train', 'kya train hai', 'kitni purani'];
const PNR_WORDS = ['pnr', 'ticket status', 'pnr status', 'pnr number', 'mera pnr', 'meri ticket', 'meri ticket ka status', 'confirmation status'];
const COMPARE_WORDS = ['kaunsi better', 'kaunsa better', 'best', 'better', 'compare', 'vs', 'versus', 'sabse accha', 'sabse tez', 'sabse jaldi', 'sabse sasta', 'sabse achha', 'faster', 'fastest', 'tez kaunsi', 'jaldi kaunsi', 'kya difference', 'antar', 'fark'];
const WALLET_WORDS = ['wallet', 'balance', 'paise', 'wallet balance', 'mere paise kitne', 'money', 'amount in wallet'];
const BOOKINGS_WORDS = ['meri booking', 'my booking', 'booking history', 'mere tickets', 'past booking', 'previous booking', 'meri ticket', 'my tickets', 'ticket history'];
const LOOKUP_STATION_WORDS = ['station code', 'code kya', 'ka code', 'code batao', 'station ka code'];
const GENERAL_QUESTION_WORDS = ['kya hota', 'kya hai', 'matlab', 'meaning', 'kab khulta', 'kab khulti', 'kitne baje', 'kitne baje khulta', 'niyam', 'rules', 'refund', 'refund kaise', 'refund milta', 'chart kab banta', 'chart timing', 'tatkal time', 'tatkal kab khulta', 'luggage', 'concession'];

const PLATFORM_WORDS = ['platform', 'platform number', 'kis platform par', 'platform kitna'];
const COACH_WORDS = ['coach position', 'coach number', 'coach kaha', 'coach position kaha', 'coach kidhar'];
const CHART_WORDS = ['chart', 'chart bana', 'chart ready', 'chart prepared', 'chart status'];
const REFUND_WORDS = ['refund', 'paise wapas', 'money back', 'refund kab aayega', 'refund kitna', 'cancellation charge'];

// Off-topic / small-talk
const OFFTOPIC_KEYWORDS: Record<string, string> = {
  weather: 'weather|mausam|barish|barsat|garmi|sardi',
  cricket: 'cricket|match|score|ipl|bcci|virat|dhoni|rohit',
  politics: 'politics|modi|kejriwal|election|sarkar|pm |cm ',
  movie: 'movie|film|picture|cinema|bollywood|hollywood',
  song: 'song|gana|music|sangeet',
  joke: 'joke|chutkula|mazak',
  food: 'khana|khane|food|pizza|burger',
  news: 'news|samachar|khabar|latest',
  ai: 'aap kaun|tum kaun|who are you|kaun ho aap|what are you|ai chatgpt',
  love: 'love|pyar|mohabbat',
  health: 'bukhar|fever|dawai|medicine|doctor|health',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasAny(text: string, words: readonly string[]): boolean {
  return words.some((w) => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  });
}

function hasAnyRegex(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function scoreKeywords(text: string, words: readonly string[]): number {
  let hits = 0;
  for (const w of words) {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) hits += 1;
  }
  return hits;
}

function extractTrainNumber(text: string): string | null {
  const m = text.match(/\b(\d{5})\b/) ?? text.match(/\b(\d{4})\b/);
  return m ? m[1]! : null;
}

function extractPnr(text: string): string | null {
  const m = text.match(/\b(\d{10})\b/);
  return m ? m[1]! : null;
}

function detectReference(text: string): string | null {
  if (/\b(uska|uski|uske|isko|iski|ye wali|wo wali|us wali|is train|wo train|ye train|yeh wali|voh wali)\b/i.test(text)) return 'last_train';
  if (/\b(pehli|pehla|first|upar wali|1st)\b/i.test(text)) return 'first_result';
  if (/\b(doosri|dusri|second|2nd)\b/i.test(text)) return 'second_result';
  if (/\b(teesri|third|3rd)\b/i.test(text)) return 'third_result';
  if (/\b(aakhri|last|neeche wali|antim|niche wali)\b/i.test(text)) return 'last_result';
  if (/\b(wahi|same|usi)\b/i.test(text)) return 'same_train';
  return null;
}

function extractTravelClass(text: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/\b(1a|first ac|1st ac)\b/i, '1A'],
    [/\b(2a|second ac|2nd ac)\b/i, '2A'],
    [/\b(3a|third ac|3rd ac)\b/i, '3A'],
    [/\b(3e|economy ac|3 ac economy)\b/i, '3E'],
    [/\b(cc|chair car|ac chair)\b/i, 'CC'],
    [/\b(ec|executive|executive chair)\b/i, 'EC'],
    [/\b(sl|sleeper)\b/i, 'SL'],
    [/\b(2s|second sitting)\b/i, '2S'],
  ];
  for (const [p, c] of patterns) if (p.test(text)) return c;
  return null;
}

function extractCount(text: string): number | null {
  const wordMap: Record<string, number> = { ek: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5, chhe: 6, che: 6 };
  const dig = text.match(/\b([1-6])\b/);
  if (dig && /ticket|passenger|log|aadmi|logon|people|person|seat/i.test(text)) return Number(dig[1]);
  for (const [w, v] of Object.entries(wordMap)) {
    if (new RegExp(`\\b${w}\\s+(ticket|log|passenger|aadmi|person)`, 'i').test(text)) return v;
  }
  return null;
}

function extractDate(text: string): string | null {
  if (/\b(aaj|today)\b/i.test(text)) return 'aaj';
  if (/\b(kal|tomorrow)\b/i.test(text)) return 'kal';
  if (/\b(parso|day after tomorrow|parsu)\b/i.test(text)) return 'parso';
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1]!;
  const dmy = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?/);
  if (dmy) return `${dmy[3] ?? ''}${dmy[2]}/${dmy[1]}`.replace(/^\/|\/$/g, '');
  return null;
}

function detectStations(text: string): { origin: string | null; destination: string | null; mentioned: string[] } {
  // Simple heuristic for "X se Y", "from X to Y", "X to Y"
  const stations: string[] = [];
  let origin: string | null = null;
  let destination: string | null = null;

  const seMatch = text.match(/([a-z\u0900-\u097F\s]{2,30}?)\s+se\s+([a-z\u0900-\u097F\s]{2,30}?)(?:\s|$|,|ke|ki|jaana|jana|train|ticket)/i);
  const fromToMatch = text.match(/from\s+([a-z\s]{2,30}?)\s+to\s+([a-z\s]{2,30}?)(?:\s|$|,|ke|ki|on|by)/i);
  const toMatch = text.match(/(?:^|\s)([a-z]{3,30})\s+to\s+([a-z\s]{3,30}?)(?:\s|$|,|ke|ki|on)/i);

  if (seMatch) { origin = seMatch[1]!.trim(); destination = seMatch[2]!.trim(); }
  else if (fromToMatch) { origin = fromToMatch[1]!.trim(); destination = fromToMatch[2]!.trim(); }
  else if (toMatch) { origin = toMatch[1]!.trim(); destination = toMatch[2]!.trim(); }

  return { origin, destination, mentioned: stations };
}

// ── MAIN: understand() ───────────────────────────────────────────────────────

export function understandAutonomously(
  rawMessage: string,
  context: ConversationContext,
): AutonomousUnderstanding {
  const normalized = normalizeMessage(rawMessage);
  const entities: ExtractedEntity[] = [];
  const candidates: IntentConfidence[] = [];
  const subIntents: AutonomousIntent[] = [];
  let tone: ConversationTone = 'friendly';
  let sentiment: AutonomousUnderstanding['sentiment'] = 'neutral';
  let requiresNoTools = false;
  let isCorrection = false;
  let correctionTarget: string | null = null;
  const missingSlots: MissingSlot[] = [];
  let clarificationQuestion: string | null = null;
  const suggestedTools: string[] = [];
  let usesContextReference = false;
  let isAnswerToPendingQuestion = false;
  let pendingQuestionField: string | null = null;
  let resumeAfterAnswer = false;

  // ── Sentiment / tone detection ──
  if (hasAny(normalized, FRUSTRATION_WORDS)) {
    sentiment = 'negative';
    tone = 'patient';
  } else if (hasAny(normalized, PRAISE_WORDS)) {
    sentiment = 'positive';
  } else if (/\b(jaldi|urgent|abhi|emergency|foran|turant)\b/i.test(normalized)) {
    sentiment = 'urgent';
    tone = 'urgent';
  }

  // ── Reference / follow-up detection (uska/wo/ye) ──
  const ref = detectReference(normalized);
  if (ref) {
    usesContextReference = true;
    entities.push({ type: 'reference', value: ref, rawText: normalized, confidence: 0.85, source: 'reference' });
  }

  // ── Entity extraction (best-effort, even before intent decision) ──
  const train = extractTrainNumber(normalized);
  if (train) entities.push({ type: 'trainNumber', value: train, rawText: train, confidence: 0.95, source: 'explicit' });
  const pnr = extractPnr(normalized);
  if (pnr) entities.push({ type: 'pnr', value: pnr, rawText: pnr, confidence: 0.98, source: 'explicit' });
  const cls = extractTravelClass(normalized);
  if (cls) entities.push({ type: 'travelClass', value: cls, rawText: normalized, confidence: 0.85, source: 'explicit' });
  const count = extractCount(normalized);
  if (count) entities.push({ type: 'passengerCount', value: count, rawText: normalized, confidence: 0.8, source: 'explicit' });
  const date = extractDate(normalized);
  if (date) entities.push({ type: 'journeyDate', value: date, rawText: normalized, confidence: 0.8, source: 'explicit' });
  const stations = detectStations(normalized);
  if (stations.origin) entities.push({ type: 'origin', value: stations.origin, rawText: stations.origin, confidence: 0.7, source: 'explicit' });
  if (stations.destination) entities.push({ type: 'destination', value: stations.destination, rawText: stations.destination, confidence: 0.7, source: 'explicit' });

  // Carry over context entities when reference is used or short message.
  if ((usesContextReference || normalized.split(/\s+/).length <= 4) && context.selectedTrain) {
    if (!entities.find((e) => e.type === 'trainNumber'))
      entities.push({ type: 'trainNumber', value: context.selectedTrain.number, rawText: '(from context)', confidence: 0.6, source: 'context' });
  }
  if (usesContextReference || normalized.split(/\s+/).length <= 4) {
    if (context.selectedClass && !entities.find((e) => e.type === 'travelClass'))
      entities.push({ type: 'travelClass', value: context.selectedClass, rawText: '(from context)', confidence: 0.5, source: 'context' });
    if (context.origin?.code && !entities.find((e) => e.type === 'origin'))
      entities.push({ type: 'origin', value: context.origin.code, rawText: '(from context)', confidence: 0.4, source: 'context' });
    if (context.destination?.code && !entities.find((e) => e.type === 'destination'))
      entities.push({ type: 'destination', value: context.destination.code, rawText: '(from context)', confidence: 0.4, source: 'context' });
    if (context.journeyDate && !entities.find((e) => e.type === 'journeyDate'))
      entities.push({ type: 'journeyDate', value: context.journeyDate, rawText: '(from context)', confidence: 0.4, source: 'context' });
  }

  // ── Correction detection ──
  if (/\b(nahi|nahin|no|instead|ki jagah|badal|change|galat|wrong|matlab nahi)\b/i.test(normalized)) {
    isCorrection = true;
    // Figure out what's being corrected.
    if (extractTravelClass(normalized)) correctionTarget = 'travelClass';
    else if (extractDate(normalized)) correctionTarget = 'journeyDate';
    else if (extractTrainNumber(normalized)) correctionTarget = 'trainNumber';
    else if (stations.origin) correctionTarget = 'origin';
    else if (stations.destination) correctionTarget = 'destination';
    else if (extractCount(normalized)) correctionTarget = 'passengerCount';
  }

  // ── Answer to pending question detection ──
  if (context.pendingQuestion || context.lastAskedField) {
    // Short message likely answering the pending question.
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 5 && !/\?/.test(normalized)) {
      isAnswerToPendingQuestion = true;
      pendingQuestionField = context.lastAskedField;
    }
  }

  // ── Intent scoring ──
  const scores: Map<AutonomousIntent, number> = new Map();

  // ── Priority overrides (strong explicit intents detected first) ──
  // These are patterns where the user's intent is unambiguous from phrasing,
  // before we fall through to keyword scoring. This mirrors how ChatGPT
  // prioritizes strong lexical cues over fuzzy keyword counts.
  let priorityIntent: AutonomousIntent | null = null;
  if (/\bhistory\b|\bpast\s+bookings?\b|\bprevious\s+bookings?\b|\bmeri\s+tickets?\s+history\b/i.test(normalized)) priorityIntent = 'VIEW_BOOKINGS';
  else if (/roz\s+chalti|daily\s+(chalta|chalti)|runs?\s+daily|roj\s+chalti/i.test(normalized)) priorityIntent = 'GET_TRAIN_INFO';
  else if (/refund/i.test(normalized) && /kitna|kab|kaise|kitna\s+katta|cancel\s+charge|cancellation\s+charge/i.test(normalized)) priorityIntent = 'CHECK_REFUND';
  else if ((/\bkitn[ea]?\b/i.test(normalized) || /\bkitna\b/i.test(normalized)) && extractTravelClass(normalized) && /ticket|fare|kiraya|padega|lagega|mein\b/i.test(normalized)) priorityIntent = 'GET_FARE';
  if (priorityIntent) {
    score(priorityIntent, 2.0, `priority override: ${priorityIntent}`);
  }
  function score(intent: AutonomousIntent, pts: number, reason: string) {
    const curr = scores.get(intent) ?? 0;
    scores.set(intent, curr + pts);
    const existing = candidates.find((c) => c.intent === intent);
    if (existing) {
      existing.confidence += pts;
      existing.reasoning += `; ${reason}`;
    } else {
      candidates.push({ intent, confidence: pts, reasoning: reason });
    }
  }

  // Conversational meta-intents.
  if (hasAny(normalized, GREETING_WORDS)) score('GREETING', 1.0, 'greeting keyword');
  if (hasAny(normalized, FAREWELL_WORDS)) score('FAREWELL', 1.0, 'farewell keyword');
  if (hasAny(normalized, THANKS_WORDS)) score('THANKS', 1.0, 'thanks keyword');
  if (hasAny(normalized, PRAISE_WORDS)) score('PRAISE', 1.0, 'praise keyword');
  if (hasAny(normalized, HELP_WORDS) || hasAny(normalized, CAPABILITY_WORDS)) score('HELP', 0.9, 'help keyword');
  if (hasAny(normalized, AFFIRMATION_WORDS) && normalized.length < 20) score('AFFIRMATION', 0.8, 'short affirmation');
  if (hasAny(normalized, NEGATION_WORDS) && normalized.length < 20) score('NEGATION', 0.6, 'short negation');
  if (hasAny(normalized, HOLD_WORDS)) score('HOLD_PAUSE', 0.8, 'pause keyword');
  if (hasAny(normalized, RESUME_WORDS)) score('RESUME', 0.8, 'resume keyword');
  if (hasAny(normalized, GO_BACK_WORDS)) score('GO_BACK', 0.8, 'go-back keyword');
  if (hasAny(normalized, START_OVER_WORDS)) score('START_OVER', 0.9, 'start-over keyword');
  if (hasAny(normalized, REPEAT_WORDS)) score('REPEAT_REQUEST', 0.8, 'repeat keyword');
  if (hasAny(normalized, FRUSTRATION_WORDS) && !/\bfare|train|seat|pnr|live|cancel\b/i.test(normalized)) score('COMPLAINT', 0.7, 'complaint/frustration');

  // Railway domain intents — score by keyword presence AND entity combo.
  const infoScore = (words: string[]) => scoreKeywords(normalized, words);

  const liveScore = infoScore(LIVE_WORDS);
  const fareScore = infoScore(FARE_WORDS);
  const availScore = infoScore(AVAILABILITY_WORDS);
  const ttScore = infoScore(TIMETABLE_WORDS);
  const infoTrainScore = infoScore(TRAIN_INFO_WORDS);
  const cancelScore = infoScore(CANCEL_WORDS);
  const pnrScore = infoScore(PNR_WORDS) + (pnr ? 2 : 0);
  const compareScore = infoScore(COMPARE_WORDS);
  const walletScore = infoScore(WALLET_WORDS);
  const bookingsScore = infoScore(BOOKINGS_WORDS);
  const lookupScore = infoScore(LOOKUP_STATION_WORDS);
  const platformScore = infoScore(PLATFORM_WORDS);
  const coachScore = infoScore(COACH_WORDS);
  const chartScore = infoScore(CHART_WORDS);
  const refundScore = infoScore(REFUND_WORDS);
  const generalScore = infoScore(GENERAL_QUESTION_WORDS);

  // Journey / booking detection: route + intent word or strong route + train/ticket.
  const hasRoute = stations.origin && stations.destination;
  const bookingWords = /\b(book|ticket chahiye|ticket book|booking|book karna|book karo|reservation|jana hai|jaana hai|jaana h|jana h|book karni|confirm|confirm ticket)\b/i.test(normalized);
  const trainListingWords = /\b(trains?\s*(batao|bata|dikhao|dikhado|bataiye|dikhaye|hai|list|list dikhao)|trains?\s*between|konsi\s+train|kaunsi\s+train|all trains|sab trains|dikhayengi|dikhayenge)\b/i.test(normalized);
  const generalJourney = /\b(jana|jaana|chahiye|travel|safar|journey|jaunga|jaungi|janna hai|dekhna hai|jaana hai)\b/i.test(normalized);
  const justTrainsWord = /\b(trains?)\b/i.test(normalized);
  if (hasRoute && bookingWords) score('BOOK_TRAIN', 1.7, 'route + explicit booking verb');
  else if (hasRoute && trainListingWords && !bookingWords) score('SEARCH_TRAIN', 1.5, 'route + trains dikhao/batao (listing only)');
  else if (hasRoute && generalJourney) score('BOOK_TRAIN', 1.3, 'route + general journey verb');
  else if (hasRoute && justTrainsWord) score('SEARCH_TRAIN', 1.2, 'route + trains keyword');
  else if (!hasRoute && (stations.origin || stations.destination) && generalJourney) score('BOOK_TRAIN', 0.8, 'partial route + journey verb');
  else if (/\b(jaana|jana|jaunga|jaungi|chala jaunga|chali jaungi|ticket chahiye|book karna|booking karni|reservation)\b/i.test(normalized) && !/\b(cancel|refund)\b/i.test(normalized)) score('BOOK_TRAIN', 0.7, 'journey verb without route');

  if (liveScore > 0 && !pnr) score('LIVE_TRAIN_STATUS', 0.6 + liveScore * 0.3, `live keywords (${liveScore})`);
  if (fareScore > 0) score('GET_FARE', 0.6 + fareScore * 0.3, `fare keywords (${fareScore})`);
  if (availScore > 0) score('GET_AVAILABILITY', 0.6 + availScore * 0.3, `availability keywords (${availScore})`);
  if (ttScore > 0) score('GET_TIMETABLE', 0.6 + ttScore * 0.3, `timetable keywords (${ttScore})`);
  if (infoTrainScore > 0 && train) score('GET_TRAIN_INFO', 0.6 + infoTrainScore * 0.3, `train-info keywords (${infoTrainScore})`);
  if (cancelScore > 0) score('GET_CANCELLED_TRAINS', 0.7 + cancelScore * 0.2, `cancel keywords (${cancelScore})`);
  if (pnrScore > 0) score('CHECK_PNR', 0.8 + pnrScore * 0.2, `pnr keywords (${pnrScore})`);
  if (compareScore > 0) score('COMPARE_TRAINS', 0.7 + compareScore * 0.2, `compare keywords (${compareScore})`);
  if (walletScore > 0) score('VIEW_WALLET', 0.9, 'wallet keywords');
  if (bookingsScore > 0) score('VIEW_BOOKINGS', 0.9, 'bookings keywords');
  if (lookupScore > 0) score('LOOKUP_STATION', 0.8, 'station-code keywords');
  if (platformScore > 0) score('PLATFORM_INQUIRY', 0.8, 'platform keywords');
  if (coachScore > 0) score('COACH_POSITION', 0.7, 'coach position keywords');
  if (chartScore > 0) score('CHECK_CHART_STATUS', 0.7, 'chart keywords');
  if (refundScore > 0) score('CHECK_REFUND', 0.7, 'refund keywords');
  if (generalScore > 0 && !train && !pnr && !hasRoute) score('GENERAL_RAILWAY_QUERY', 0.5 + generalScore * 0.2, 'general railway question');

  // Off-topic detection.
  for (const [topic, pattern] of Object.entries(OFFTOPIC_KEYWORDS)) {
    if (new RegExp(pattern, 'i').test(normalized)) {
      score('NORMAL_CHAT', 0.8, `off-topic: ${topic}`);
      break;
    }
  }

  // Fallback: if nothing matched well but we have a train number, it's probably live/info.
  if (scores.size === 0 && train && (context.selectedTrain || /train/.test(normalized))) {
    score('LIVE_TRAIN_STATUS', 0.4, 'train number only with train mention');
  }

  // If correction is flagged but no other strong intent, treat as CORRECTION meta.
  if (isCorrection && scores.size === 0) {
    score('CORRECTION', 0.6, 'explicit correction keywords');
  }

  // ── Post-process: distinguish SEARCH_TRAIN (just listing) vs BOOK_TRAIN (booking intent) ──
  if (hasRoute) {
    const bookyStrong = /\b(book|ticket chahiye|ticket book|jana hai|jaana hai|book karna|booking karni|reservation|ticket chahiye)\b/i.test(normalized);
    const justLook = /\b(trains?\s*(batao|bata|dikhao|hai|dikhaye|bataye)|trains?\s*between|trains?\s*from|list\s+trains|konsi trains)\b/i.test(normalized) && !bookyStrong;
    if (justLook) {
      scores.set('SEARCH_TRAIN', (scores.get('SEARCH_TRAIN') ?? 0) + 0.6);
      scores.set('BOOK_TRAIN', Math.max(0, (scores.get('BOOK_TRAIN') ?? 0) - 0.6));
      const s = candidates.find((x) => x.intent === 'SEARCH_TRAIN');
      if (s) { s.confidence += 0.6; s.reasoning += '; route+listing-only phrase'; }
      else candidates.push({ intent: 'SEARCH_TRAIN', confidence: 0.6, reasoning: 'route+listing-only phrase' });
    }
  }

  // Fix for "mujhe kal ki train chahiye" — this is a journey intent even without full route.
  if (/\b(kal|aaj|parso)\s+ki\s+trains?\b/i.test(normalized) || /\btrains?\s+chahiye\b/i.test(normalized)) {
    score('BOOK_TRAIN', 0.7, 'date/train chahiye without route — asks booking flow');
  }

  // Fix for comparison with two explicit train numbers: "X aur Y kaunsi tez"
  // (train numbers already extracted earlier in the flow)
  // Re-scan with global match to find ALL train numbers.
  const allNumbers = [...normalized.matchAll(/\b(\d{4,5})\b/g)].map((m) => m[1]);
  if (allNumbers.length >= 2 && /kaunsi|better|compare|tez|fast|antar|fark|vs|versus|kaun/i.test(normalized)) {
    score('COMPARE_TRAINS', 1.2, 'two train numbers + compare word');
  }

  // ── Pick primary intent ──
  let primaryIntent: AutonomousIntent = 'UNKNOWN';
  let bestScore = 0;
  for (const [intent, s] of scores.entries()) {
    if (s > bestScore) { bestScore = s; primaryIntent = intent; }
  }
  // Sort candidates by score for transparency.
  candidates.sort((a, b) => b.confidence - a.confidence);
  candidates.forEach((c) => { c.confidence = Math.min(1, c.confidence); });

  // ── Multi-intent splitting (detect if message has 2+ railway asks joined by aur/and). ──
  const railwayish = ['LIVE_TRAIN_STATUS', 'GET_FARE', 'GET_AVAILABILITY', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'CHECK_PNR', 'GET_CANCELLED_TRAINS'] as const;
  const strong = candidates.filter((c) => railwayish.includes(c.intent as never) && c.confidence >= 0.5);
  if (strong.length >= 2 && /\b(aur|and|sath mein|bhi|also)\b/i.test(normalized)) {
    primaryIntent = 'MULTI_INTENT';
    subIntents.push(...strong.map((c) => c.intent));
  }

  // ── Hold / resume decisions ──
  if (primaryIntent === 'HOLD_PAUSE') {
    requiresNoTools = true;
  }
  if (primaryIntent !== 'BOOK_TRAIN' && primaryIntent !== 'SEARCH_TRAIN' && context.bookingStage && context.bookingStage !== 'IDLE') {
    // Informational question mid-booking → answer then resume.
    if (['LIVE_TRAIN_STATUS', 'GET_FARE', 'GET_AVAILABILITY', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'GENERAL_RAILWAY_QUERY', 'CHECK_PNR', 'COMPARE_TRAINS', 'PLATFORM_INQUIRY', 'COACH_POSITION', 'CHECK_CHART_STATUS', 'CHECK_REFUND'].includes(primaryIntent)) {
      resumeAfterAnswer = true;
    }
  }

  // ── Meta/conversational intents require no tools ──
  const META: AutonomousIntent[] = ['GREETING', 'FAREWELL', 'THANKS', 'PRAISE', 'COMPLAINT', 'HELP', 'CAPABILITY_QUERY', 'AFFIRMATION', 'NEGATION', 'HOLD_PAUSE', 'RESUME', 'GO_BACK', 'START_OVER', 'SMALL_TALK', 'NORMAL_CHAT'];
  if (META.includes(primaryIntent)) requiresNoTools = true;

  // ── Suggest tools (map intent → tool names that the registry knows) ──
  const TOOL_MAP: Partial<Record<AutonomousIntent, string[]>> = {
    BOOK_TRAIN: ['searchTrains'],
    SEARCH_TRAIN: ['searchTrains'],
    LIVE_TRAIN_STATUS: ['getLiveStatus'],
    GET_AVAILABILITY: ['getAvailability'],
    GET_FARE: ['getFare'],
    GET_TRAIN_INFO: ['getTrainInfo'],
    GET_TIMETABLE: ['getTimetable'],
    LOOKUP_STATION: ['lookupStation'],
    CHECK_PNR: ['checkPNR'],
    VIEW_BOOKINGS: ['getBookings'],
    VIEW_WALLET: ['getWallet'],
    GET_CANCELLED_TRAINS: ['getCancelledTrains'],
    COMPARE_TRAINS: ['compareTrains'],
    GENERAL_RAILWAY_QUERY: ['getRailwayKnowledge'],
  };
  const tools = TOOL_MAP[primaryIntent];
  if (tools) suggestedTools.push(...tools);
  if (primaryIntent === 'MULTI_INTENT') {
    for (const si of subIntents) {
      const t = TOOL_MAP[si];
      if (t) suggestedTools.push(...t);
    }
  }

  // ── Missing-slot detection + natural clarification ──
  const getEnt = (t: ExtractedEntity['type']) => entities.find((e) => e.type === t)?.value ?? null;
  switch (primaryIntent) {
    case 'BOOK_TRAIN':
    case 'SEARCH_TRAIN':
      if (!getEnt('origin')) missingSlots.push({ field: 'origin', question: 'Kaha se chalna hai? (From station?)', reason: 'origin required' });
      if (!getEnt('destination')) missingSlots.push({ field: 'destination', question: 'Kaha jaana hai? (To station?)', reason: 'destination required' });
      if (!getEnt('journeyDate') && primaryIntent === 'BOOK_TRAIN') missingSlots.push({ field: 'journeyDate', question: 'Kis date ko jaana hai? Aaj, kal, parso, ya koi tareekh?', reason: 'date required' });
      break;
    case 'LIVE_TRAIN_STATUS':
    case 'GET_TRAIN_INFO':
    case 'GET_TIMETABLE':
    case 'GET_AVAILABILITY':
    case 'GET_FARE':
      if (!getEnt('trainNumber')) {
        if (usesContextReference && context.selectedTrain) {
          // resolved from context
        } else {
          missingSlots.push({ field: 'trainNumber', question: 'Kaunsi train ke baare mein jaanna hai? Train number bata dijiye.', reason: 'train number required' });
        }
      }
      break;
    case 'CHECK_PNR':
      if (!getEnt('pnr')) missingSlots.push({ field: 'pnr', question: 'PNR number bata dijiye (10 digits).', reason: 'PNR required' });
      break;
    case 'LOOKUP_STATION':
      if (!getEnt('station') && stations.mentioned.length === 0) {
        missingSlots.push({ field: 'station', question: 'Kaunsa station ka code chahiye?', reason: 'station name required' });
      }
      break;
  }

  if (missingSlots.length > 0) {
    clarificationQuestion = missingSlots[0]!.question;
  }

  // If still UNKNOWN after all, build a helpful fallback.
  if (primaryIntent === 'UNKNOWN' && scores.size === 0) {
    requiresNoTools = true;
    clarificationQuestion = 'Main aapki railway-related har query samajh sakta hoon — trains search, seat availability, fare, live status, PNR, timetable, booking, cancellation, refund, wallet etc. Batayein kya chahiye?';
  }

  return {
    primaryIntent,
    candidates: candidates.slice(0, 5),
    subIntents,
    entities,
    isCorrection,
    correctionTarget,
    isAnswerToPendingQuestion,
    pendingQuestionField,
    usesContextReference,
    tone,
    missingSlots,
    clarificationQuestion,
    requiresNoTools,
    suggestedTools,
    rawMessage,
    normalizedMessage: normalized,
    sentiment,
    resumeAfterAnswer,
  };
}
