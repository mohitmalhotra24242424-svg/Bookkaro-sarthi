/**
 * AUTONOMOUS REPLY GENERATOR — natural, human, ChatGPT-style replies.
 *
 * Produces Hinglish replies that sound like a real person talking:
 *   - Greetings, thanks, praise, frustration → warm natural responses
 *   - Never robotic "I don't understand" — always helpfully guides
 *   - Handles corrections, pauses, resumes, go-backs naturally
 *   - Integrates railway data (search results, fare, live status, etc.)
 *     with a conversational wrapper around the verified data.
 *   - Supports multiple tones (friendly, patient, apologetic, urgent…).
 *   - Re-invites the user back into the booking flow after detours.
 *
 * Design:
 *   - Replies are built from a rich context + understanding + (optionally)
 *     tool results.
 *   - When tool results are present, they are presented clearly with a
 *     human preamble; never in a raw dump.
 *   - When no tool results are needed (greetings, small-talk), short and
 *     friendly templates with random variation.
 */

import type { ConversationContext } from '../../shared/index.js';
import type { AutonomousUnderstanding } from './AutonomousIntentEngine.js';
import type { ToolResult } from '../../shared/index.js';

export interface ReplyInput {
  understanding: AutonomousUnderstanding;
  context: ConversationContext;
  toolResults?: ToolResult[];
  /** When the assistant has just asked a question; passes it through cleanly. */
  pendingQuestion?: string | null;
  /** Train cards / UI panels (pre-rendered by existing UI layer). */
  cards?: unknown[] | null;
  panel?: unknown | null;
}

export interface ReplyOutput {
  text: string;
  /** The natural voice/warmup line that precedes structured data. */
  preamble: string;
  /** Structured data summary (if any). */
  dataSummary: string;
  /** Follow-up nudge to keep conversation flowing. */
  followUp: string;
}

// ── Response templates (multiple variations so replies feel alive) ────────────

const GREETINGS = [
  'Namaste! 🙏 BookKaro mein aapka swagat hai. Main aapke liye trains search, seat availability, fare, live status, PNR, booking — sab kuch kar sakta hoon. Batayein kya chahiye?',
  'Hi! Main BookKaro AI hoon — aapka apna railway assistant. Trains dhoondhna, ticket book karna, live status dekhna, kuch bhi — batayein kaise madad karoon?',
  'Hello ji! 😊 Aaj kya karna hai? Trains dekhni hain? Ticket book karni hai? Ya kisi train ka status chahiye? Bataiye main hoon na!',
];

const FAREWELLS = [
  'Alvida! 🚂 Baad mein kabhi bhi aa jaana — trains ya booking se related kuch chahiye, yaad kar lena. Safe travels!',
  'Bye bye! Apna khayal rakhna. Aur kabhi ticket chahiye to BookKaro hai na! 😊',
  'Theek hai, chalta hoon! Dhanyavaad BookKaro use karne ke liye. Phir milenge! 🙏',
];

const THANKS_REPLIES = [
  'Aapka swagat hai! 😊 Aur kuch chahiye ho to batana.',
  'Koi baat nahi! Yahi hoon main — aur madad chahiye to bataiye.',
  'Dhanyavaad aapka! Aur kuch jaanna ya karna ho to hamesha tayyar hoon. 🚂',
];

const PRAISE_REPLIES = [
  'Shukriya! 🙏 Aapke liye better service dene ki koshish karte rahenge.',
  'Bahut bahut dhanyavaad! Aise hi BookKaro par bharosa rakhiye.',
  'Wah! 🌟 Aapki khushi hamari success hai. Aur kuch help chahiye?',
];

const FRUSTRATION_REPLIES = [
  'Maaf kijiye pareshani ke liye 🙏. Main poori koshish karunga ki aapki problem solve ho jaye. Thoda detail mein batayein kya galat hua?',
  'Main samajh gaya hoon aapko gussa aa raha hai. Galti hamari hai, maaf kijiye. Ab kya help chahiye main turant karta hoon.',
  'Sorry bhai/bahan! 😔 Pareshan nahi hona. Batayein exactly kya chahiye — main abhi respond karta hoon.',
];

const AFFIRMATION_REPLIES = [
  'Theek hai! 👍',
  'Bilkul!',
  'Samajh gaya!',
];

const HOLD_REPLIES = [
  'Ruko ji, hold par hoon. ⏸️ Jab taiyyar ho jao "chalo" keh dena — wahin se shuru karenge.',
  'Theek hai, thoda break lete hain. Jab continue karna ho bata dena! 😊',
];

const RESUME_REPLIES = [
  'Chalo, wapas booking par aate hain. Jahan ruke the wahi se continue karte hain.',
  'Thik hai, shuru karte hain waapis. Kya karna hai ab?',
];

const GOBACK_REPLIES = [
  'Theek hai, ek step peeche chalte hain. 🔙',
  'Pichhe chalte hain ji — kya change karna hai?',
];

const STARTOVER_REPLIES = [
  'Naye sire se shuru karte hain. 🔄 Batayein kaha se kaha jaana hai aur kab?',
  'Reset kar diya! Ab naye se batao — origin, destination, date?',
];

const HELP_REPLIES = [
  `Main BookKaro AI hoon — aapka railway assistant. Main kar sakta hoon:\n\n🚆 Trains search (kisi bhi route/date ke liye)\n🎫 Seat availability check\n💰 Fare dikhana\n📍 Live train status\n📋 Timetable / stops\n🔢 PNR status\n❌ Cancelled trains\n🆚 Train comparison\n🛒 Ticket booking (multi-passenger, class selection)\n💼 Wallet balance / booking history\n❓ Railway se related koi bhi sawaal\n\nBas Hindi / Hinglish / English mein poochhiye!`,
];

const OFFTOPIC_REPLIES = [
  'Main railway ka specialist hoon ji — is topic par meri training nahi hai. Par trains, tickets, PNR, booking, live status, fare ya Indian Railways se related kuch bhi poochhiye, turant jawab dunga! 😊',
  'Iske baare mein main certified nahi hoon 🙏 — par railway ki kisi bhi cheez ke liye main hoon na! Batayein kya chahiye?',
  'Sorry ji, main sirf railway-related help kar sakta hoon. Train ticket chahiye? Live status? PNR? Bata dijiye!',
];

const CORRECTION_ACKS = [
  'Theek hai, woh badal deta hoon. ✏️',
  'Got it! Update kar raha hoon.',
  'Samajh gaya, change kar diya.',
];

const UNKNOWN_FALLBACK = [
  'Main poori tarah samajh nahi paaya, lekin main railway ka assistant hoon. Trains, tickets, PNR, live status, fare, timetable, booking ya cancellation — in mein se kisi ke baare mein poochhiye, detail mein jawab dunga.',
  'Thoda clear kar dijiye? Main in sab mein madad kar sakta hoon: trains search, ticket availability, fare, live running status, PNR, timetable, ya booking. Batayein kya chahiye? 🚂',
];

const ERROR_REPLIES = [
  'Abhi thoda railway data fetch nahi ho pa raha hai 🙏. Thodi der baad try karein, ya check karte rahiye.',
  'Maaf kijiye, abhi railway server se data nahi mil raha. Kuch der baad try karte hain ya koi aur sawal poochhiye?',
];

const NO_RESULTS = [
  'Mujhe iske liye koi result nahi mila abhi. Kuch aur details check kar ke batayein?',
  'Abhi is query par data available nahi hai. Date ya station change karke dekhen?',
];

// ── Data formatters ──────────────────────────────────────────────────────────

function formatSearchResults(data: unknown): string {
  const arr = Array.isArray(data) ? data : (data as { results?: unknown[] })?.results ?? [];
  if (!Array.isArray(arr) || arr.length === 0) {
    return pick(NO_RESULTS);
  }
  const lines: string[] = [];
  for (let i = 0; i < Math.min(arr.length, 5); i++) {
    const t = arr[i] as Record<string, any>;
    const train = t.train ?? t;
    const num = train.number ?? train.trainNumber ?? '?';
    const name = train.name ?? train.trainName ?? '';
    const dep = train.departureTime ?? train.departure ?? '?';
    const arr_ = train.arrivalTime ?? train.arrival ?? '?';
    const dur = train.duration ?? '';
    lines.push(`🔹 ${i + 1}. ${num} - ${name}\n      🕐 Departure: ${dep} | Arrival: ${arr_}${dur ? ` | Duration: ${dur}` : ''}`);
  }
  if (arr.length > 5) lines.push(`\n... aur ${arr.length - 5} trains.`);
  return lines.join('\n\n');
}

function formatLiveStatus(data: Record<string, any>): string {
  const train = data.trainNumber ?? data.train?.number ?? 'Train';
  const status = data.status ?? data.runningStatus ?? 'Status available nahi';
  const delay = data.delayMinutes != null ? ` (${data.delayMinutes} min late)` : '';
  const last = data.lastStation ?? data.lastReportedStation ?? null;
  const next = data.nextStation ?? null;
  let line = `📍 ${train} LIVE status: ${status}${delay}`;
  if (last) line += `\n   Last station: ${last}`;
  if (next) line += `\n   Next station: ${next}`;
  return line;
}

function formatFare(data: Record<string, any>): string {
  const b = data.breakdown ?? data;
  const rail = b.railwayFareMinor ?? b.railwayFare ?? null;
  const fee = b.serviceFeeMinor ?? b.serviceFee ?? null;
  const total = b.totalMinor ?? b.total ?? null;
  const fmt = (p: any) => {
    if (p == null) return '?';
    if (typeof p === 'number') return `₹${Math.round(p / 100)}`;
    return String(p);
  };
  return `💰 Fare breakdown:\n   • Railway fare: ${fmt(rail)}\n   • Service fee: ${fmt(fee)}\n   • Total: ${fmt(total)}`;
}

function formatAvailability(data: Record<string, any>): string {
  const train = data.trainNumber ?? '';
  const cls = data.travelClass ?? '';
  const status = data.status ?? '?';
  const extra =
    status === 'AVAILABLE' && data.availableCount != null ? ` (${data.availableCount} seats)` :
    status === 'RAC' && data.racCount != null ? ` (RAC ${data.racCount})` :
    status === 'WAITLIST' && data.waitlistNumber != null ? ` (WL ${data.waitlistNumber})` : '';
  return `🎫 ${train} ${cls} mein: **${status}**${extra}`;
}

function formatPnr(data: Record<string, any>): string {
  const status = data.status ?? data.currentStatus ?? '?';
  const seat = data.seatNumber ?? data.coachBerth ?? null;
  const train = data.trainNumber ?? data.train?.number ?? '';
  let s = `🔢 PNR status: **${status}**`;
  if (train) s += `\n   Train: ${train}`;
  if (seat) s += `\n   Seat/Berth: ${seat}`;
  return s;
}

function formatTimetable(data: Record<string, any>): string {
  const train = data.trainNumber ?? '';
  const stops = Array.isArray(data.stops) ? data.stops : [];
  if (stops.length === 0) return `📋 ${train} ka timetable abhi available nahi.`;
  const lines = stops.slice(0, 8).map((s: any) => {
    const name = s.stationName ?? s.name ?? '?';
    const code = s.stationCode ?? s.code ?? '';
    const arr = s.arrivalTime ?? s.arrival ?? '-';
    const dep = s.departureTime ?? s.departure ?? '-';
    return `   • ${name}${code ? ` (${code})` : ''} — Arr ${arr} / Dep ${dep}`;
  });
  if (stops.length > 8) lines.push(`   ... aur ${stops.length - 8} stops`);
  return `📋 ${train} ki route/stops:\n${lines.join('\n')}`;
}

function formatCancelled(data: unknown): string {
  const arr = Array.isArray(data) ? data : [];
  if (arr.length === 0) return `✅ Abhi cancelled trains ki information nahi mil rahi.`;
  const list = arr.slice(0, 5).map((t: any) => `• ${t.trainNumber ?? t.number ?? '?'} ${t.trainName ?? t.name ?? ''}`).join('\n');
  return `❌ Cancelled trains:\n${list}`;
}

function formatTrainInfo(data: Record<string, any>): string {
  const num = data.number ?? data.trainNumber ?? '';
  const name = data.name ?? data.trainName ?? '';
  const type = data.trainType ?? data.type ?? '';
  let s = `ℹ️ ${num} - ${name}${type ? ` (${type})` : ''}`;
  if (data.runsOn) s += `\n   Runs on: ${data.runsOn}`;
  return s;
}

// ── Preamble variations per intent ───────────────────────────────────────────

function preambleFor(intent: string): string {
  const options: Record<string, string[]> = {
    SEARCH_TRAIN: ['Mil gayi trains! 🚆', 'Yeh rahi aapke liye trains:', 'Trains mil gayi hain:'],
    LIVE_TRAIN_STATUS: ['Live status mil gaya: 📍', 'Abhi ki position yeh hai:', 'Real-time update:'],
    GET_FARE: ['Fare details yeh rahe: 💰', 'Kiraya is tarah se hai:', 'Fare breakdown:'],
    GET_AVAILABILITY: ['Availability dekh li: 🎫', 'Seat is tarah se hai:', 'Availability update:'],
    GET_TIMETABLE: ['Time table dekh liya: 📋', 'Route aur stops yeh hain:', 'Schedule mil gaya:'],
    GET_TRAIN_INFO: ['Train ki details: ℹ️', 'Train ke baare mein:', 'Information:'],
    CHECK_PNR: ['PNR status yeh raha: 🔢', 'PNR check ho gaya:', 'Status:'],
    GET_CANCELLED_TRAINS: ['Cancelled trains ki list: ❌', 'Cancelled trains:', 'Jankari:'],
    COMPARE_TRAINS: ['Comparison yeh raha: ⚖️', 'Compare kar ke dikhata hoon:'],
    BOOK_TRAIN: ['Chalo booking shuru karte hain! 🎫', 'Theek hai ticket book karte hain:'],
  };
  return pick(options[intent] ?? ['Yeh raha jawab:']);
}

// ── Follow-up nudges ────────────────────────────────────────────────────────

function nudgeFor(intent: string, context: ConversationContext, hasMissing: boolean): string {
  if (hasMissing) return '';
  switch (intent) {
    case 'SEARCH_TRAIN':
    case 'BOOK_TRAIN':
      return 'Kaunsi train leni hai? Number bata dijiye ya "pehli/doosri" keh dijiye, ya class bhi select kar sakte hain (SL, 3A, CC etc.) 😊';
    case 'LIVE_TRAIN_STATUS':
    case 'GET_TIMETABLE':
    case 'GET_TRAIN_INFO':
      return 'Aur is train ke baare mein aur kya jaanna hai? Fare, availability, ya timetable?';
    case 'GET_FARE':
    case 'GET_AVAILABILITY':
      return 'Agar class change kar ke dekhna ho (SL/3A/CC), ya availability confirm karni ho, bata dijiye!';
    case 'CHECK_PNR':
      return 'Aur koi PNR check karna ho ya train se related kuch aur chahiye, batayein!';
    case 'GREETING':
    case 'THANKS':
    case 'PRAISE':
      return '';
    default:
      return context.bookingStage && context.bookingStage !== 'IDLE'
        ? '\n\nAb booking continue karte hain...'
        : 'Aur kuch chahiye to bataiye! 😊';
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function generateReply(input: ReplyInput): ReplyOutput {
  const { understanding: u, context, toolResults, pendingQuestion, cards, panel } = input;

  // When the assistant has an active pending question, pass it through.
  if (pendingQuestion && (u.isAnswerToPendingQuestion || u.primaryIntent === 'AFFIRMATION' || u.primaryIntent === 'NEGATION')) {
    // Let the orchestrator fill this case; we just acknowledge.
  }

  // Meta / conversational intents — no data.
  if (u.primaryIntent === 'GREETING') return build(pick(GREETINGS), '', '');
  if (u.primaryIntent === 'FAREWELL') return build(pick(FAREWELLS), '', '');
  if (u.primaryIntent === 'THANKS') return build(pick(THANKS_REPLIES), '', '');
  if (u.primaryIntent === 'PRAISE') return build(pick(PRAISE_REPLIES), '', '');
  if (u.primaryIntent === 'COMPLAINT' || u.sentiment === 'negative') return build(pick(FRUSTRATION_REPLIES), '', 'Aur detail mein batayein — main solve karunga. 🙏');
  if (u.primaryIntent === 'HELP' || u.primaryIntent === 'CAPABILITY_QUERY') return build(pick(HELP_REPLIES), '', 'Toh kya chahiye aaj? 😊');
  if (u.primaryIntent === 'NORMAL_CHAT') return build(pick(OFFTOPIC_REPLIES), '', '');
  if (u.primaryIntent === 'HOLD_PAUSE') return build(pick(HOLD_REPLIES), '', '');
  if (u.primaryIntent === 'RESUME') return build(pick(RESUME_REPLIES), '', '');
  if (u.primaryIntent === 'GO_BACK') return build(pick(GOBACK_REPLIES), '', '');
  if (u.primaryIntent === 'START_OVER') return build(pick(STARTOVER_REPLIES), '', '');
  if (u.primaryIntent === 'AFFIRMATION') return build(pick(AFFIRMATION_REPLIES), '', '');
  if (u.primaryIntent === 'CORRECTION') return build(pick(CORRECTION_ACKS), '', '');

  // Clarification needed — ask for it politely.
  if (u.clarificationQuestion && (!toolResults || toolResults.length === 0)) {
    return build(u.clarificationQuestion, '', '');
  }

  // Tool results present — format conversational answer.
  if (toolResults && toolResults.length > 0) {
    const parts: string[] = [];
    let anyOk = false;
    for (const tr of toolResults) {
      if (!tr.ok) { parts.push(pick(ERROR_REPLIES)); continue; }
      anyOk = true;
      const data = (tr.data ?? {}) as Record<string, any>;
      switch (tr.tool) {
        case 'searchTrains': parts.push(formatSearchResults(data)); break;
        case 'getLiveStatus': parts.push(formatLiveStatus(data)); break;
        case 'getFare': parts.push(formatFare(data)); break;
        case 'getAvailability': parts.push(formatAvailability(data)); break;
        case 'getTimetable': parts.push(formatTimetable(data)); break;
        case 'getTrainInfo': parts.push(formatTrainInfo(data)); break;
        case 'checkPNR': parts.push(formatPnr(data)); break;
        case 'getCancelledTrains': parts.push(formatCancelled(data)); break;
        default: parts.push(JSON.stringify(data).slice(0, 300)); break;
      }
    }
    const dataSummary = parts.join('\n\n');
    const preamble = anyOk ? preambleFor(u.primaryIntent) : '';
    const pausedSnapshot = (context as unknown as { pausedBooking?: { pendingQuestion: string | null } | null }).pausedBooking;
    const followUp = u.resumeAfterAnswer && pausedSnapshot
      ? `\n\nWapas booking par chalte hain — ${pausedSnapshot?.pendingQuestion ?? 'aage badhte hain?'}`
      : nudgeFor(u.primaryIntent, context, u.missingSlots.length > 0);
    const text = [preamble, dataSummary, followUp].filter(Boolean).join('\n\n');
    return { text, preamble, dataSummary, followUp };
  }

  // Pending question is the natural reply (mid-flow).
  if (pendingQuestion) {
    return build(pendingQuestion, '', '');
  }

  // Fallback — unknown with no tools and no clarification.
  return build(pick(UNKNOWN_FALLBACK), '', '');
}

function build(text: string, preamble: string, followUp: string): ReplyOutput {
  return { text, preamble, dataSummary: '', followUp };
}
