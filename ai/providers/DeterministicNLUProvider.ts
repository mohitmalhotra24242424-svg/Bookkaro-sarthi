/**
 * DETERMINISTIC NLU PROVIDER (default AI provider when no AI_API_KEY is
 * configured, and the mandatory fallback when a real AI provider fails,
 * times out or returns invalid JSON).
 *
 * It implements the same AIProvider interface and returns the SAME strict
 * structured output schema — so it is a drop-in for the real providers. It is
 * deliberately rule-based: it never invents railway facts (it only extracts
 * what the user literally said), which makes it safe under the fact-safety
 * rules.
 *
 * Supported understanding (Hindi/Hinglish/English):
 *   intents: live status, availability, fare, timetable, train info, PNR,
 *   bookings, wallet, cancelled trains, station lookup, comparison, glossary,
 *   book/search journey, help; slot-fillers (bare date/count/class/station/
 *   result references) surface as intent UNKNOWN + extracted slots, which the
 *   orchestrator resolves against the pending question.
 */

import type {
  AIReplyInput,
  AIReplyResult,
  AIUnderstandingInput,
  AIUnderstandingResult,
  ContextSlotField,
  Intent,
  SearchFilterHint,
  TravelClassCode,
} from '../../shared/index.js';
import { TRAVEL_CLASSES } from '../../shared/index.js';
import type { AIProvider } from '../AIProvider.js';
import { extractSearchFilterHint } from '../query-intelligence.js';

const STOPWORDS = new Set([
  'mujhe', 'main', 'hum', 'mein', 'me', 'hai', 'hain', 'haan', 'nahi', 'na', 'kya', 'kaunsi', 'kaun', 'kab',
  'kahan', 'kaha', 'kitne', 'kitni', 'kitna', 'jaana', 'jana', 'jaana', 'jaa', 'chahiye', 'chahiye', 'karna',
  'kar', 'karo', 'karun', 'batao', 'bata', 'dikhao', 'dikha', 'se', 'se', 'tak', 'to', 'from', 'the', 'a',
  'an', 'is', 'are', 'train', 'trains', 'ki', 'ke', 'ka', 'ko', 'bhi', 'please', 'ya', 'ya', 'or', 'and',
  'liye', 'keliye', 'ke liye', 'kay', 'travel', 'trip', 'safar', 'journey',
  'wali', 'wala', 'upar', 'ticket', 'tickets', 'book', 'booking', 'karunga', 'karungi', 'saab', 'sab', 'actually', 'jagah', 'badlo', 'bhai', 'yaar', 'waise', 'achha', 'chalo', 'sahi', 'dikhao',
  // greetings / pronouns / interjections — never station candidates
  'tum', 'tume', 'tumko', 'aap', 'ap', 'aapko', 'aapka', 'ham', 'hume', 'humein', 'mujhe', 'mera', 'meri', 'mere',
  'kya', 'kuch', 'batao', 'bataye', 'theek', 'thik', 'ok', 'okay', 'please', 'sir', 'ji',
  // English auxiliary / verb / preposition words — never station candidates
  'want', 'need', 'like', 'would', 'going', 'get', 'give', 'tell', 'show', 'for', 'will', 'shall',
  'that', 'there', 'this', 'those', 'these', 'us', 'we', 'you', 'your', 'our', 'their', 'am', 'be',
  'being', 'been', 'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'should', 'about', 'also', 'only',
  // English question/interrogative + function words — never station candidates
  'what', 'where', 'when', 'how', 'which', 'who', 'why', 'is', 'its', 'it', 'my', 'me', 'check', 'next',
  'in', 'on', 'at', 'by', 'of', 'for', 'with', 'via', 'into', 'out', 'up', 'down', 'after', 'before',
  'any', 'some', 'are', 'were', 'was', 'will', 'would', 'could', 'should', 'might', 'must', 'them',
  'here', 'there', 'this', 'these', 'those', 'then', 'than', 'so', 'as', 'no', 'yes', 'all', 'each',
  // travel-class words — never station candidates ('sleeper', 'ac', …)
  'sleeper', 'chair', 'executive', 'class', 'coach', 'reserved', 'sl', 'cc', 'ec', '1a', '2a', '3a', '3e', '2s',
]);

/**
 * Station-name suffixes that must stay GLUED to the station they follow
 * ("amritsar jn se …" → origin "amritsar jn"). Without this the bare "jn"/"junction"
 * token is treated as the station, and the lookup returns every "JN" station
 * (the user's "amritsar jn se ldh jn" bug). These are NOT standalone stations.
 */
const STATION_SUFFIX_TOKENS = new Set([
  'jn', 'jnc', 'junction', 'cantt', 'cant', 'cantonment', 'terminus', 'terminal', 'cst', 'ct', 'central', 'city',
  // Devanagari versions of the same suffixes — glue to the preceding station name
  'जं', 'जंक्शन', 'कैंट', 'केन्ट', 'छावनी', 'टर्मिनल', 'टर्मिनस', 'सेंट्रल', 'सिटी', 'स्टेशन',
]);

/** Merge a base station name token with any trailing station-suffix token(s). "amritsar"+"jn" → "amritsar jn". */
function stationPhraseAt(tokens: string[], idx: number): string {
  let phrase = tokens[idx]!;
  let j = idx + 1;
  while (j < tokens.length && STATION_SUFFIX_TOKENS.has(tokens[j]!.toLowerCase())) {
    phrase += ` ${tokens[j]}`;
    j += 1;
  }
  return phrase;
}

/** Matches any Devanagari (pure Hindi/Devanagari-script) character. */
const DEVANAGARI = /[\u0900-\u097F]/u;

/**
 * Devanagari (pure-Hindi) common/key words → the Latin Hinglish equivalents the
 * rest of this rule-based engine already understands. We only translate GRAMMAR
 * and KEYWORDS, never proper nouns (so a station name like "अमृतसर" is preserved
 * verbatim for station lookup). This lets one normalizer serve Hindi, English
 * and Hinglish from a single code path instead of a second regex forest.
 */
const HINDI_TO_LATIN: Record<string, string> = {
  // grammar / intent glue
  'से': 'se', 'तक': 'tak', 'के': 'ke', 'लिए': 'liye', 'की': 'ki', 'को': 'ko', 'का': 'ka',
  'और': 'aur', 'में': 'mein', 'ना': 'na', 'नहीं': 'nahi', 'है': 'hai', 'हैं': 'hain', 'हाँ': 'haan',
  'जाना': 'jaana', 'जाओ': 'jao', 'जाती': 'jaati', 'जाता': 'jaata', 'जाएँ': 'jaaye',
  'चाहिए': 'chahiye', 'करना': 'karna', 'करो': 'karo', 'करें': 'karein', 'करता': 'karta',
  'बताओ': 'batao', 'बताइए': 'bataye', 'बताऊँ': 'batau', 'दिखाओ': 'dikhao', 'दिखाइए': 'dikhaye',
  'ट्रेन': 'train', 'ट्रेनों': 'trains', 'रेलगाड़ी': 'train', 'टिकट': 'ticket', 'टिकटों': 'tickets',
  'बुकिंग': 'booking', 'बुक': 'book', 'किराया': 'fare', 'कीमत': 'price', 'सीट': 'seat', 'सीटों': 'seats',
  'उपलब्ध': 'available', 'उपलब्धता': 'availability', 'वेटलिस्ट': 'waitlist', 'स्टेशन': 'station',
  'कोड': 'code', 'कौनसी': 'kaunsi', 'कौनसा': 'kaunsa', 'किस': 'kis', 'क्या': 'kya', 'कब': 'kab',
  'कहाँ': 'kahan', 'कितना': 'kitna', 'कितने': 'kitne', 'कितनी': 'kitni', 'मुझे': 'mujhe', 'मैं': 'main',
  'वॉलेट': 'wallet', 'बैलेंस': 'balance', 'स्थिति': 'status', 'स्टेटस': 'status', 'लाइव': 'live',
  'रद्द': 'cancel', 'कैंसिल': 'cancel', 'यात्रा': 'journey', 'समय': 'time', 'टाइम': 'time',
  'वाली': 'wali', 'वाला': 'wala', 'वाले': 'wale', 'दिन': 'din', 'नाम': 'name',
  // day-part
  'सुबह': 'subah', 'सवेरे': 'savere', 'दोपहर': 'dopahar', 'शाम': 'shaam', 'रात': 'raat', 'रात्रि': 'raat',
  // date
  'कल': 'kal', 'आज': 'aaj', 'परसों': 'parso', 'अगले': 'next', 'आनेवाले': 'next',
  // classes
  'स्लीपर': 'sleeper', 'एसी': 'ac', 'एसी 3': 'ac 3', 'चेयर': 'chair', 'तीसरा': '3', 'दूसरा': '2',
  'पहला': '1', 'प्रथम': '1', 'अर्थव्यवस्था': 'economy',
  // counts
  'एक': 'ek', 'दो': 'do', 'तीन': 'teen', 'चार': 'char', 'पांच': 'panch', 'पाँच': 'panch',
  'छह': 'chhe', 'छः': 'chhe', 'लोग': 'log', 'व्यक्ति': 'log', 'यात्री': 'log',
  // scope / off-scope + misc
  'मौसम': 'mausam', 'क्रिकेट': 'cricket', 'मदद': 'help', 'कृपया': 'please',
  'आप': 'aap', 'आपका': 'aapka', 'हम': 'hum', 'हमें': 'hume', 'मेरी': 'meri', 'मेरा': 'mera', 'मेरे': 'mere',
  'रेल': 'rail', 'रेलवे': 'railway', 'भारतीय': 'indian',
  // intended-verb / live-status / info keywords (so non-journey intents classify)
  'पीएनआर': 'pnr', 'चेक': 'check', 'करके': 'karke', 'रफ्तार': 'raftar', 'गति': 'speed',
  'सारिणी': 'table', 'मार्ग': 'route', 'स्टॉप्स': 'stops', 'रूट': 'route', 'रुकती': 'rukti', 'रुकता': 'rukta',
  'बारे': 'baare', 'जानकारी': 'info', 'सूचना': 'info', 'विवरण': 'details',
  'रोज़': 'roz', 'रोज': 'roz', 'देर': 'late', 'चल': 'chal', 'रही': 'rahi', 'रहा': 'raha',
  'अगला': 'next', 'पिछला': 'last', 'मिलेगी': 'milegi', 'मिलेगा': 'milega', 'मिलती': 'milti', 'मिलता': 'milta',
  'पैसे': 'paise', 'पैसा': 'paisa', 'इतिहास': 'history', 'तुलना': 'compare', 'बेहतर': 'better',
  'बजे': 'baje', 'बजा': 'baja', 'बजते': 'bajte', 'बजने': 'bajne',
  'टेबल': 'table', 'सारणी': 'table', 'शेड्यूल': 'schedule', 'समयसारिणी': 'time table',
  'स्टॉप': 'stop', 'कैंट': 'cantt',
  'मतलब': 'matlab', 'क्लास': 'class', 'अंतर': 'antar', 'फर्क': 'fark', 'खुलता': 'khulta', 'खुलती': 'khulti',
  'बीच': 'between', 'सकते': 'sakte', 'सकता': 'sakta', 'चाहूँ': 'chahun', 'शुरू': 'shuru',
  'कंफर्म': 'confirm', 'रिफंड': 'refund', 'नियम': 'rules', 'सामान': 'luggage', 'रियायत': 'concession',
  'अपने': 'apne', 'होती': 'hoti', 'होते': 'hote', 'ये': 'ye', 'वो': 'wo', 'वह': 'wo', 'कुछ': 'kuch',
  'बाकी': 'baaki', 'लगभग': 'lagbhag', 'सेट': 'set',
};

/** Replace common Devanagari function/key words with their Latin equivalents (preserving proper nouns — i.e. station names). */
function normalizeHindi(message: string): string {
  // Translate Devanagari digits (०…९) → ASCII so train-number / PNR extraction works.
  const withDigits = message.replace(/[\u0966\u0967\u0968\u0969\u096A\u096B\u096C\u096D\u096E\u096F]/g, (d) =>
    String('०१२३४५६७८९'.indexOf(d)),
  );
  return withDigits
    .split(/(\s+)/)
    .map((tok) => {
      if (!tok || /^\s+$/.test(tok)) return tok;
      const mapped = HINDI_TO_LATIN[tok];
      return mapped !== undefined ? mapped : tok;
    })
    .join('');
}

/** A token that qualifies as a station-name candidate in Devanagari (i.e. not a mapped keyword, not a known function word). */
function isDevanagariStationToken(tok: string): boolean {
  if (!DEVANAGARI.test(tok)) return false;
  if (HINDI_TO_LATIN[tok] !== undefined) return false; // grammar/keyword → not a station
  if (STATION_SUFFIX_TOKENS.has(tok.toLowerCase())) return false;
  return tok.replace(/[^\u0900-\u097F]/g, '').length >= 2; // at least 2 Devanagari letters
}

const DATE_TODAY = /\b(aaj|aa?j|today)\b/i;
const DATE_TOMORROW = /\b(kal|tomorrow)\b/i;
const DATE_DAY_AFTER = /\b(parso|parsu|day after tomorrow)\b/i;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const DMY_DATE = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/;
const MONTHS: Record<string, string> = {
  jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03', apr: '04', april: '04',
  may: '05', jun: '06', june: '06', jul: '07', july: '07', aug: '08', august: '08', augst: '08',
  sep: '09', sept: '09', september: '09', oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
};

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5, chhe: 6, che: 6,
};

const ORDINALS: Readonly<Record<string, number>> = {
  pehli: 0, pehla: 0, first: 0, '1st': 0,
  doosri: 1, dusri: 1, doosra: 1, second: 1, '2nd': 1,
  teesri: 2, tisri: 2, third: 2, '3rd': 2,
};

const GLOSSARY_TOKENS = [
  'cc', 'ec', 'sl', '1a', '2a', '3a', '3e', '2s', 'rac', 'wl', 'gn', 'tq', 'tatkal', 'chart', 'pnr', 'speed', 'cnf',
];

function emptySlots(): AIUnderstandingResult['slots'] {
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

function extractTrainNumbers(text: string): string[] {
  return [...text.matchAll(/\b(\d{4,6})\b/g)].map((match) => match[1]!).filter((n) => /^\d{5}$/.test(n) || /^\d{4}$/.test(n));
}

function extractPnr(text: string): string | null {
  const match = text.match(/\b(\d{10})\b/);
  return match ? match[1]! : null;
}

function extractTravelClass(text: string): TravelClassCode | null {
  // Spoken / Hinglish forms first (more specific than bare codes).
  const spoken: ReadonlyArray<readonly [RegExp, TravelClassCode]> = [
    [/\b(sleeper(\s*(class|seat|coach|wali|wala))?|sl\s*(class|seat|coach))\b/i, 'SL'],
    [/\b(chair\s*car|ac\s*chair(\s*car)?|cc\s*(class|seat|coach))\b/i, 'CC'],
    [/\b(exec(utive)?(\s*chair(\s*car)?)?|ec\s*(class|seat|coach))\b/i, 'EC'],
    [/\b(second\s*sitting|2s\s*(class|seat|coach)|second\s*class\s*sitting)\b/i, '2S'],
    [/\b(ac\s*3\s*e(conomy)?|3e(\s*(class|economy|seat))?|3\s*economy|economy\s*ac)\b/i, '3E'],
    [/\b(third\s*ac|3rd\s*ac|3\s*ac|ac\s*3(?!\s*e)|ac3|teen\s*ac|3ac|3-ac)\b/i, '3A'],
    [/\b(second\s*ac|2nd\s*ac|2\s*ac|ac\s*2|ac2|doosr[ai]\s*ac|2ac|2-ac)\b/i, '2A'],
    [/\b(first\s*ac|1st\s*ac|1\s*ac|ac\s*1|ac1|pehl[ai]\s*ac|1ac|1-ac)\b/i, '1A'],
  ];
  for (const [pattern, code] of spoken) {
    if (pattern.test(text)) return code;
  }
  for (const code of TRAVEL_CLASSES) {
    if (new RegExp(`\\b${code}\\b`, 'i').test(text)) return code;
  }
  return null;
}

function extractPassengerCount(text: string): number | null {
  const trimmed = text.trim().toLowerCase().replace(/[?.!]+$/, '');
  // "hum 3 log hain" / "hum teen log hain"
  const humLog = text.match(/\bhum\s+(\d|ek|do|teen|char|chaar|panch|paanch|chhe)\s+log\b/i);
  if (humLog) {
    const word = humLog[1]!.toLowerCase();
    const value = /^\d$/.test(word) ? Number(word) : (NUMBER_WORDS[word] ?? null);
    if (value !== null && value >= 1 && value <= 6) return value;
  }
  // "mere liye aur meri wife ke liye" — reliably TWO parties (self + one named companion)
  if (/mere liye aur (meri?|mere|mere)\s*(wife|biwi|patni|husband|pati|bhai|behen|dost|friend|maa|papa|beta|beti)/i.test(text)) return 2;
  const digitMatch = text.match(/\b(\d)\s*(ticket|tickets|passenger|passengers|log|aadmi|seat|seats)\b/i);
  if (digitMatch) return Math.min(6, Math.max(1, Number(digitMatch[1])));
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\s+(ticket|tickets|passenger|passengers|log|aadmi)\\b`, 'i').test(text)) return value;
  }
  // a BARE 1-6 digit (or bare number word) answering a pending "kitne passengers?" question
  if (/^[1-6]$/.test(trimmed)) return Number(trimmed);
  if (Object.keys(NUMBER_WORDS).includes(trimmed) && trimmed !== 'ek') return NUMBER_WORDS[trimmed] ?? null;
  if (trimmed === 'ek') return 1;
  return null;
}

function extractDateText(text: string): string | null {
  if (ISO_DATE.test(text)) return text.match(ISO_DATE)![1]!;
  const dmy = text.match(DMY_DATE);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  // "27 August" / "August 27" / "27 aug" → day-month (resolver applies the year rule)
  const dayMonth = text.match(/\b(\d{1,2})\s+([a-z]{3,9})\b/i);
  if (dayMonth && MONTHS[dayMonth[2]!.toLowerCase()]) {
    return `${Number(dayMonth[1])}-${Number(MONTHS[dayMonth[2]!.toLowerCase()])}`;
  }
  const monthDay = text.match(/\b([a-z]{3,9})\s+(\d{1,2})\b/i);
  if (monthDay && MONTHS[monthDay[1]!.toLowerCase()]) {
    return `${Number(monthDay[2])}-${Number(MONTHS[monthDay[1]!.toLowerCase()])}`;
  }
  // weekday names: "Monday", "next Sunday", "is sunday", "agle somvar"
  const WEEKDAYS: Record<string, number> = {
    sunday: 0, ravivar: 0, sun: 0,
    monday: 1, somvar: 1, mon: 1,
    tuesday: 2, mangalvar: 2, tue: 2,
    wednesday: 3, budhvar: 3, wed: 3,
    thursday: 4, guruvar: 4, thu: 4,
    friday: 5, shukravar: 5, fri: 5,
    saturday: 6, shanivar: 6, sat: 6,
  };
  const weekend = text.match(/\b(this|is|agla|agle)?\s*weekend\b/i);
  if (weekend) return 'next-saturday';
  const weekdayMatch = text.match(/\b(next|agla|agle|coming|is|aane wale)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|ravivar|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar)\b/i);
  if (weekdayMatch && WEEKDAYS[weekdayMatch[2]!.toLowerCase()] !== undefined) {
    return `${weekdayMatch[1] ? 'next-' : 'weekday-'}${WEEKDAYS[weekdayMatch[2]!.toLowerCase()]}`;
  }
  if (DATE_DAY_AFTER.test(text)) return 'parso';
  if (DATE_TOMORROW.test(text)) return 'kal';
  if (DATE_TODAY.test(text)) return 'aaj';
  return null;
}

function extractStations(message: string): { origin: string | null; destination: string | null; mentioned: string[] } {
  const tokens = message.split(/[\s,]+/).map((t) => t.replace(/[?.!]+$/, '')).filter((t) => t.length > 0);
  const mentioned: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (STATION_SUFFIX_TOKENS.has(lower)) continue; // "jn"/"junction" glue to the name, never standalone
    if (DATE_WORDS.has(lower) || GENERIC_WORDS.has(lower)) continue;
    if (/^[A-Za-z][a-z]{2,}$/.test(token) || isDevanagariStationToken(token)) {
      mentioned.push(token);
    }
  }

  let origin: string | null = null;
  let destination: string | null = null;

  const lowerTokens = tokens.map((t) => t.toLowerCase());
  // A station candidate is a non-stopword, non-date, non-generic word (Latin or
  // Devanagari). Excluding DATE_WORDS/GENERIC_WORDS stops "today"/"morning"/
  // "sleeper" being mistaken for a station.
  const isStationToken = (tok: string | undefined): tok is string =>
    Boolean(tok) && !STOPWORDS.has(tok!.toLowerCase()) &&
    !DATE_WORDS.has(tok!.toLowerCase()) && !GENERIC_WORDS.has(tok!.toLowerCase()) &&
    (/^[A-Za-z]{2,}$/.test(tok!) || isDevanagariStationToken(tok!));

  for (let i = 0; i < lowerTokens.length; i += 1) {
    const token = lowerTokens[i]!;
    // "amritsar jn se …" — Hinglish postposition: the origin is the station BEFORE
    // "se". Step back past any suffix ("jn") so the whole name stays glued.
    if (token === 'se' && i > 0) {
      let baseIdx = i - 1;
      if (STATION_SUFFIX_TOKENS.has(tokens[baseIdx]!.toLowerCase())) baseIdx -= 1;
      if (isStationToken(tokens[baseIdx])) origin = stationPhraseAt(tokens, baseIdx);
    }
    // "from Amritsar …" — English preposition: the origin is the station AFTER
    // "from" (unlike Hinglish "se", where origin sits BEFORE it).
    if (token === 'from') {
      for (let j = i + 1; j < Math.min(i + 3, lowerTokens.length); j += 1) {
        if (isStationToken(tokens[j])) {
          origin = stationPhraseAt(tokens, j);
          break;
        }
      }
    }
    if (token === 'to' || token === 'tak') {
      for (let j = i + 1; j < Math.min(i + 3, lowerTokens.length); j += 1) {
        if (isStationToken(tokens[j])) {
          destination = stationPhraseAt(tokens, j);
          break;
        }
      }
    }
    // English "trains between X and Y" — origin is the station after "between",
    // destination the station after "and".
    if (token === 'between') {
      for (let j = i + 1; j < Math.min(i + 4, lowerTokens.length); j += 1) {
        if (isStationToken(tokens[j])) {
          origin = stationPhraseAt(tokens, j);
          break;
        }
      }
      const andIdx = lowerTokens.indexOf('and', i + 1);
      if (andIdx >= 0) {
        for (let j = andIdx + 1; j < Math.min(andIdx + 4, lowerTokens.length); j += 1) {
          if (isStationToken(tokens[j])) {
            destination = stationPhraseAt(tokens, j);
            break;
          }
        }
      }
    }
  }

  // "X se Y …" / "from X …" without explicit to/tak: destination = first station-
  // like token after the origin's separator.
  if (origin && !destination) {
    const seIndex = lowerTokens.findIndex((t, idx) => {
      if (t !== 'se' && t !== 'from') return false;
      if (t === 'from') {
        return isStationToken(tokens[idx + 1]) && stationPhraseAt(tokens, idx + 1).toLowerCase() === origin!.toLowerCase();
      }
      let baseIdx = idx - 1;
      if (baseIdx >= 0 && STATION_SUFFIX_TOKENS.has(tokens[baseIdx]!.toLowerCase())) baseIdx -= 1;
      if (baseIdx < 0) return false;
      return isStationToken(tokens[baseIdx]) && stationPhraseAt(tokens, baseIdx).toLowerCase() === origin!.toLowerCase();
    });
    if (seIndex >= 0) {
      // The origin sits BEFORE "se" but AFTER "from" — so start scanning for the
      // destination PAST the origin token (never pick the origin itself).
      const startAfter = lowerTokens[seIndex]! === 'from' ? seIndex + 2 : seIndex + 1;
      for (let j = startAfter; j < lowerTokens.length; j += 1) {
        const lowerCandidate = lowerTokens[j]!;
        if (lowerCandidate === 'se' || lowerCandidate === 'from' || lowerCandidate === 'to' || lowerCandidate === 'tak') break;
        if (isStationToken(tokens[j])) {
          destination = stationPhraseAt(tokens, j);
          break;
        }
      }
    }
  }

  return { origin, destination, mentioned: mentioned.slice(0, 4) };
}

const DATE_WORDS = new Set(['aaj', 'kal', 'parso', 'today', 'tomorrow', 'date', 'din', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const GENERIC_WORDS = new Set([
  'train', 'trains', 'status', 'live', 'seat', 'seats', 'fare', 'kitna', 'kitne', 'kitni', 'time', 'timetable',
  'schedule', 'route', 'ticket', 'tickets', 'booking', 'bookings', 'wallet', 'balance', 'pnr', 'cancel',
  'cancelled', 'station', 'code', 'please', 'batao', 'dikhao', 'chahiye', 'jaana', 'jana', 'chahta', 'chahti',
  'better', 'kaunsi', 'konsi', 'available', 'availability', 'information', 'info', 'details', 'railway', 'indian',
  // day-part + colloquial traffic words — never station candidates
  'morning', 'subah', 'subha', 'savere', 'dopahar', 'afternoon', 'shaam', 'evening', 'raat', 'night',
  'btao', 'dkhao', 'bata', 'dikha', 'btado', 'dikhado', 'pahunch', 'pahunchi', 'pahunchti', 'pahuch', 'pahuchi', 'pahuchti',
  'arrival', 'arrive', 'arrives', 'baje', 'bje', 'baja', 'destinations?',
]);

function extractResultReference(text: string, results?: readonly { train: { number: string; name: string | null } }[]): string | null {
  const numbered = text.match(/\b(\d{5})\s*(wali|wala|train|vali|vala)?\b/i);
  const ordinalEntry = Object.entries(ORDINALS).find(([word]) => new RegExp(`\\b${word}\\b`, 'i').test(text));
  if (/\b(last|aakhri|antim|neeche|niche)\s*(wali|wala|train)?\b/i.test(text)) return 'last';
  if (/\b(upar|upar wali|upar wala)\b/i.test(text)) return '1';
  if (ordinalEntry) return String(ordinalEntry[1] + 1);
  if (numbered && (/\bwali\b|\bwala\b|\btrain\b/i.test(text))) return numbered[1]!;
  // name-based reference: the word(s) before "wali/wala" matching a CURRENT result's name
  if (results && results.length > 0 && /\bwali\b|\bwala\b/i.test(text)) {
    const nameRef = text.match(/([a-z]+\s?[a-z]*)\s+(?:wali|wala)/i);
    const candidate = nameRef?.[1]?.trim().toLowerCase();
    if (candidate && candidate.length > 2) {
      const words = candidate.split(/\s+/);
      for (const word of words) {
        if (['train', 'ki', 'ka', 'ye', 'wahi', 'bhai'].includes(word)) continue;
        const match = results.find((entry) => entry.train.name?.toLowerCase().includes(word));
        if (match) return match.train.name ?? word; // name-substring ref
      }
    }
  }
  return null;
}

function extractGlossaryTerm(text: string): string | null {
  const lower = text.toLowerCase();
  for (const token of GLOSSARY_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(lower)) {
      // A bare class token with a train number + availability/fare words is a LIVE query, not glossary.
      return token.toUpperCase() === 'TATKAL' ? 'TQ' : token.toUpperCase();
    }
  }
  if (/\btatkal\b/.test(lower)) return 'TQ';
  if (/\bwaiting list\b/.test(lower)) return 'WL';
  if (/\bchair car\b/.test(lower)) return 'CC';
  return null;
}

function isGlossaryQuestion(text: string): boolean {
  // Rule-sensitive policy questions (tatkal timings, refund, rules) are KNOWLEDGE
  // questions even when they contain words like "booking".
  if (/tatkal|refund|niyam|\brules?\b|luggage|concession/i.test(text) && /kya|kab|kitn|kaunse|kaise|kaunsi/i.test(text)) return true;
  return /\b(kya hot[ai] hai?|kya hot[ai]|kya hai|matlab|meaning|what is|kaunsi class|difference|antar|fark|kya hote hain|kab khult|kab khol)\b/i.test(text);
}

/** Day-part words that can tag a train search ("morning trains", "subah wali"). */
const DAY_PART_TRAIN_PHRASE = /(morning|subah|subha|savere|dopahar|afternoon|shaam|evening|raat|night)\s+trains?\b|\b(kal|aaj|parso)\b.*\b(subah|morning|dopahar|afternoon|shaam|evening|raat|night)\b/i;

/**
 * Devanagari-safe "A se B" / "from A" route detector. JS \b treats Devanagari as
 * a NON-word char, so a leading/trailing \b around a station token silently
 * fails on pure-Hindi input. We use explicit char classes instead so Hindi
 * ("अमृतसर से लुधियाना") and English/Hinglish both detect a route.
 */
const ROUTE_ROUTE = /(?:[\u0900-\u097F]|[A-Za-z])[^\s,!.?;]*\s+(?:se|from)\s+(?:[\u0900-\u097F]|[A-Za-z])/i;

function isJourneyIntent(text: string): boolean {
  return (
    /\b(jaana|jana|jaaye|jaye|journey|travel|book|tickets?|chahiye|trains? between|se .*tak)\b/i.test(text) ||
    /\b(ki )?trains?\b[^.?!]*\b(batao|btao|bata|dikhao|dkhao|dikha|chahiye|batado|bta do|dikha do)\b/i.test(text) ||
    /\btrains?\s+(batao|btao|bata|dikhao|dkhao|dikha|chahiye|batado|bta do|dikha do)\b/i.test(text) ||
    // "amritsar se ludhiana jn morning ki train kal" — a route + "train" is a
    // journey even without chahiye/jaana; "morning ki train" (day-part + train).
    (ROUTE_ROUTE.test(text) && /\btrains?\b/i.test(text)) ||
    (ROUTE_ROUTE.test(text) && /\b(morning|subah|subha|dopahar|afternoon|shaam|evening|raat|night|kal|aaj|parso)\b/i.test(text)) ||
    DAY_PART_TRAIN_PHRASE.test(text) ||
    /\bkoi (aur |dusri |doosri )?train\b/i.test(text) ||
    /\btrain\s+(hai|chahiye|hain)\b/i.test(text) ||
    /\btrains?\b[^.?!]*\bfrom\b/i.test(text) ||
    // Natural ENGLISH journey phrasings ("from Amritsar to Ludhiana", "trains
    // between X and Y", "I want/need a train tomorrow morning").
    /\bfrom\s+\S+\s+(to|for)\s+\S+/i.test(text) ||
    /\btrains?\s+between\s+\S+\s+and\s+\S+\b/i.test(text) ||
    /\b(want|need|looking for|intend to|would like to)\b.*\btrains?\b/i.test(text) ||
    /\btrain(s)?\b.*\b(from|to|between)\b/i.test(text)
  );
}

function isSlotFillerOnly(text: string): boolean {
  const trimmed = text.trim().toLowerCase().replace(/[?.!]+$/, '');
  const stations = extractStations(text);
  if (stations.origin || stations.destination) return false;
  const hasDate = DATE_TODAY.test(trimmed) || DATE_TOMORROW.test(trimmed) || DATE_DAY_AFTER.test(trimmed) || ISO_DATE.test(trimmed) || DMY_DATE.test(trimmed);
  const bareDate = hasDate && trimmed.split(/\s+/).length <= 4 && !extractTrainNumbers(trimmed).length && !/live|status|pnr|wallet|ticket|cancel/i.test(trimmed);
  if (bareDate) return true;
  // bare passenger count "2" / "do ticket"
  if (/^(\d|ek|do|teen|char|chaar|panch|paanch|chhe)(\s+(ticket|tickets|passenger|passengers|log|aadmi))?$/.test(trimmed)) return true;
  const dataIntent = /\b(live|status|fare|price|timetable|pnr|cancel|wallet)\b/i.test(trimmed);
  const trains = extractTrainNumbers(trimmed);
  const travelClass = extractTravelClass(trimmed);
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  // "3A" / "3A chahiye" / "sleeper seat" / "SL wali"
  if (travelClass && trains.length === 0 && words <= 6 && !dataIntent) return true;
  // "12014" / "12014 mein 3A" / "12014 3A chahiye"
  if (trains.length === 1 && words <= 8 && !dataIntent) return true;
  return false;
}

const STRONG_INFO_TRIGGER = /\b(live|status|abhi kaha|kahan hai|kitni late|pnr\s*\d|pnr check|timetable|time\s*table|cancel|wallet|bookings?)\b/i;
const JOURNEY_TRIGGER = /\b(jaana|jana|jaaye|jaye|booking|book|ticket|chahiye)\b/i;

/**
 * MULTI-INTENT SPLIT (deterministic, conservative): only splits when the message
 * clearly contains BOTH an informational railway request and a booking/journey
 * request joined by a conjunction. Order: informational first, booking last —
 * so the pending-booking question is what the user sees at the end.
 */
export function splitCompoundRequest(message: string): string[] | null {
  const parts = message
    .split(/\s+(?:aur|or|and|phir|fir|bhi|also)\s+|,\s*|;\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
  if (parts.length < 2 || parts.length > 3) return null;
  const infoParts = parts.filter((part) => STRONG_INFO_TRIGGER.test(part) && !JOURNEY_TRIGGER.test(part));
  const journeyParts = parts.filter((part) => JOURNEY_TRIGGER.test(part) && !STRONG_INFO_TRIGGER.test(part));
  if (infoParts.length === 0 || journeyParts.length === 0) return null;
  const ordered = [...infoParts, ...journeyParts];
  return ordered.length === parts.length ? ordered : null;
}

export class DeterministicNLUProvider implements AIProvider {
  readonly providerId = 'deterministic-nlu';

  understand(input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
    const message = input.userMessage;
    // Normalize Devanagari/Hindi keywords to the Latin equivalents this engine
    // already understands, so pure Hindi (Devanagari), English and Hinglish all
    // run through the SAME rules path. Proper nouns (station names) are left
    // exactly as the user wrote them, for the provider-backed station lookup.
    const text = normalizeHindi(message);
    const lower = text.toLowerCase();
    const slots = emptySlots();
    // The deterministic NLU also reads a time-of-day filter wherever it can, so
    // the AI surfaced the same structured hint whichever model path runs.
    const searchFilter = extractSearchFilterHint(text);

    slots.trainNumber = extractTrainNumbers(text)[0] ?? null;
    slots.secondTrainNumber = extractTrainNumbers(text)[1] ?? null;
    slots.pnr = extractPnr(text);
    slots.travelClass = extractTravelClass(text);
    slots.passengerCount = extractPassengerCount(text);
    slots.dateText = extractDateText(text);
    slots.resultReference = extractResultReference(text, input.conversation.lastSearchResults ?? undefined);
    slots.isCorrection = /\b(nahi|nahin|no|instead|badal|badlo|change|नहीं|बदलो)\b|ki jagah/i.test(lower);
    const stations = extractStations(text);
    slots.originQuery = stations.origin;
    slots.destinationQuery = stations.destination;
    slots.mentionedStations = stations.mentioned;
    slots.glossaryTerm = extractGlossaryTerm(text);

    if (!slots.trainNumber && input.conversation.selectedTrain) {
      slots.trainNumber = input.conversation.selectedTrain.number;
    }

    // "12014 nahi 14542 ka live status" — a correction between two train numbers:
    // the SECOND number is the train the user actually means.
    if (slots.trainNumber && slots.secondTrainNumber && /\b(nahi|nahin|ki jagah|instead)\b/i.test(lower)) {
      slots.trainNumber = slots.secondTrainNumber;
      slots.secondTrainNumber = null;
    }

    // "pehli wali" / "12014" / "12014 mein 3A" / "3A chahiye" while results are shown → booking selection
    const results = input.conversation.lastSearchResults ?? [];
    const dataIntentWords = /\b(live|status|fare|price|timetable|pnr|cancel|wallet|route|stops?|kaha|kahan|abhi)\b/i.test(lower);
    const askingAvailability =
      (/\b(available|availability|milegi|milega|waitlist|\bwl\b)\b/i.test(lower) ||
        (/\b(seat|seats)\b/i.test(lower) && /\b(hai|hain|kya)\b/i.test(lower))) &&
      !/\bchahiye\b/i.test(lower);
    if (results.length > 0 && !dataIntentWords && !askingAvailability && !isGlossaryQuestion(lower) && !slots.secondTrainNumber) {
      const words = lower.split(/\s+/).filter(Boolean).length;
      const typedTrain = extractTrainNumbers(text)[0] ?? null;
      const inList = Boolean(
        typedTrain &&
          results.some((entry) => {
            const n = entry.train.number.replace(/^0+/, '') || entry.train.number;
            const t = typedTrain.replace(/^0+/, '') || typedTrain;
            return entry.train.number === typedTrain || n === t;
          }),
      );
      const classWanted = Boolean(slots.travelClass && /\b(chahiye|leni|lena|le lo|book|wali|seat|class)\b/i.test(lower));
      const askedPick =
        input.conversation.lastAskedField === 'selectedTrain' || input.conversation.lastAskedField === 'selectedClass';
      if (words <= 10 && !stations.origin && !stations.destination && (inList || slots.resultReference || classWanted || (askedPick && (slots.travelClass || typedTrain)))) {
        return Promise.resolve(resolve({ intent: 'BOOK_TRAIN', confidence: 0.9, slots, missing: [], searchFilter }));
      }
    }

    // ── intent detection (priority order matters) ──
    let intent: Intent = 'UNKNOWN';
    let confidence = 0.4;
    let missing: ContextSlotField[] = [];

    if ((slots.pnr && /pnr|status|check/i.test(lower)) || (/\bpnr\b/i.test(lower) && /check|status|mera|meri|karo/i.test(lower))) {
      intent = 'CHECK_PNR';
      confidence = slots.pnr ? 0.95 : 0.8;
    } else if (/\bspeed\b|\baraftar\b/i.test(lower) && slots.trainNumber) {
      intent = 'GET_TRAIN_INFO'; // exact speed only if the provider returns a verified field
      confidence = 0.8;
    } else if (
      !slots.secondTrainNumber &&
      !/(compare|better|vs\b|versus|kaunsi|konsi|sabse|fastest|slowest|shortest|longest)/i.test(lower) &&
      (
        (slots.trainNumber && /(kitn[ei]?\s*(baje|bje|time)|kab\s+(pahunch|pahunchti|pahuch|pahucht)|pahunch\s*(time|kab)|arrival\s*time|day\s*time)/i.test(lower)) ||
        (slots.trainNumber && /(pahunchi|pahunchti|pahuchi|pahuchti|pahuch|pahucht)\s*(thi|thae|gayi)?\s*(hai)?\b/i.test(lower))
      )
    ) {
      // Arrival-time question ("kitne baje pahunchi thi", "kab pahunchti hai") —
      // NOT a comparison (two trains / "kaunsi"), NOT a superlative. Scheduled
      // TIMETABLE is the verified source (never a guessed clock time).
      intent = 'GET_TIMETABLE';
      confidence = 0.85;
    } else if (
      /\btimetable\b|\btime\s*table\b|\bschedule\b|\broute\b|kaha kaha (ruk|rukti)|\b(ruk(ta|ti|te|a)|rukte|rukti)\b|\bstop(s|ped|s)?\s+(at|on|par)\b/i.test(lower)
    ) {
      // Timetable / stop-list, including "does train X stop at Y" ("12053 Ludhiana
      // rukti hai?", "stops at Ludhiana"). The orchestrator answers the membership
      // from the VERIFIED stops; the NLU just routes it.
      intent = 'GET_TIMETABLE';
      confidence = 0.85;
    } else if ((/\b(baare|bare|about|info|information|details)\b/i.test(lower) && slots.trainNumber) || (/\b(daily|roz)\b/i.test(lower) && /chalti|chalta|runs?/i.test(lower)) || (/\bclasses\b|kaunse class/i.test(lower) && (slots.trainNumber || /is train/i.test(lower)))) {
      intent = 'GET_TRAIN_INFO';
      confidence = 0.8;
    } else if (/\b(live|abhi|kaha|kahan|where|running|kahan hai|kitni late|late hai|chal rahi|next station|agla station)\b/i.test(lower) || (/status/i.test(lower) && !/pnr/i.test(lower))) {
      intent = 'LIVE_TRAIN_STATUS'; // orchestrator asks for the train number when none is known
      confidence = slots.trainNumber || input.conversation.selectedTrain ? 0.9 : 0.7;
    } else if (/cancel(l)?ed|cancel/i.test(lower) && (/train/i.test(lower) || slots.trainNumber !== null)) {
      intent = 'GET_CANCELLED_TRAINS';
      confidence = 0.85; // slots.trainNumber stays → "is 12014 cancelled?" gets an evidence check
    } else if (
      // "3A seat chahiye" is a class pick; "seat hai?" is availability.
      !/\bchahiye\b/i.test(lower) &&
      ((/\b(seat|seats|available|availability|milegi|milega)\b/i.test(lower) || /\brac\b/i.test(lower) || (/\b(wl|waitlist|waiting list|kitni wl)\b/i.test(lower) && !/kya hota|matlab/i.test(lower)) || (/\b(cc|ec|sl|1a|2a|3a|3e|2s)\b/i.test(lower) && /\bhain?\b|\bmileg/i.test(lower) && !/fare|price|paisa|padega|padenge/i.test(lower) && (slots.trainNumber || input.conversation.selectedTrain))) && (slots.trainNumber || input.conversation.selectedTrain || /is (train|mein)/i.test(lower)))
    ) {
      intent = 'GET_AVAILABILITY';
      confidence = 0.85;
    } else if (/\b(fare|price|rate|paisa|paise)\b/i.test(lower) || (/\bkitn[ea]?\b/i.test(lower) && /\b(fare|ticket|ka)\b/i.test(lower) && !/seat/i.test(lower) && slots.travelClass)) {
      intent = 'GET_FARE';
      confidence = 0.85;
    } else if (/meri|my/i.test(lower) && /ticket|booking|bookings|history/i.test(lower)) {
      intent = 'VIEW_BOOKINGS';
      confidence = 0.9;
    } else if (/\bwallet\b|\bbalance\b/i.test(lower)) {
      intent = 'VIEW_WALLET';
      confidence = 0.9;
    } else if ((slots.trainNumber && slots.secondTrainNumber) || (/\b(better|compare|vs|versus|kaunsi|konsi)\b/i.test(lower) && slots.trainNumber && slots.secondTrainNumber) || (/\b(fastest|sabse tez|jaldi pahunch|sabse jaldi|pehle\s+[a-z]+\s+pahunch|earliest\s+(arrival|departure)|shortest|longest|sabse\s+kam\s+samay|sabse\s+zyada\s+(samay|time|der)|zyada\s+time\s+lagat|sabse\s+dheere|slowest|latest\s+departure)\w*/i.test(lower) && (input.conversation.lastSearchResults?.length ?? 0) >= 2)) {
      intent = 'COMPARE_TRAINS';
      confidence = 0.9;
    } else if (isGlossaryQuestion(lower) && !slots.trainNumber && !/station code|code kya|ka code/i.test(lower)) {
      intent = 'GENERAL_RAILWAY_QUERY'; // glossaryTerm may be null → restricted knowledge capability handles it
      confidence = slots.glossaryTerm ? 0.9 : 0.7;
    } else if (/\bhelp\b|kya kya kar/i.test(lower)) {
      intent = 'HELP';
      confidence = 0.9;
    } else if (/\bstation code\b|\bcode kya\b/i.test(lower) && slots.mentionedStations.length > 0) {
      intent = 'LOOKUP_STATION';
      confidence = 0.85;
    } else if (/\bkitni?\s+trains?\s+hain\b|\bkitne\s+train\b/i.test(lower) && !/cancel/i.test(lower)) {
      // "Kal kitni trains hain?" → TRAIN SEARCH (never cancelled without explicit cancel words)
      intent = 'BOOK_TRAIN';
      confidence = 0.8;
    } else if (isJourneyIntent(lower) && (stations.origin || stations.destination)) {
      intent = /book/i.test(lower) || /ticket|chahiye/i.test(lower) ? 'BOOK_TRAIN' : 'BOOK_TRAIN';
      confidence = 0.8;
      if (!stations.origin) missing.push('origin');
      if (!stations.destination) missing.push('destination');
      if (!slots.dateText) missing.push('journeyDate');
    } else if (isJourneyIntent(lower) && !stations.origin && !stations.destination) {
      // "Kal jaana hai" — continuation of an existing journey conversation.
      // A SINGLE implied station in a clear journey phrase ("ludhiana ki kal ki
      // morning trains", "delhi ki trains") → treat it as the DESTINATION and ask
      // for the origin; we never guess the other endpoint.
      if (stations.mentioned.length === 1 && stations.mentioned[0] && /(ki|ke|ko|to|tak|keliye|ke liye|wali|wale)\b/i.test(lower)) {
        slots.destinationQuery = stations.mentioned[0];
        intent = 'BOOK_TRAIN';
        confidence = 0.7;
        missing.push('origin');
      } else {
        intent = 'BOOK_TRAIN';
        confidence = 0.6;
      }
    } else if (isSlotFillerOnly(message)) {
      intent = 'UNKNOWN';
      confidence = 0.7; // slot-filler — orchestrator resolves against pending question
    } else if (/^(hi|hii+|hello|hey+|namaste|namaskar|yo|hola|salaam|salam)(\s+(ji|bhai|yaar))?[\s!.]*$/i.test(text.trim())
      || /^(good\s+(morning|evening|afternoon|night))[\s!.]*$/i.test(text.trim())
      || /^(thanks|thank you|thx|thnx|dhanyavaad|shukriya)[\s!.]*$/i.test(text.trim())) {
      intent = 'HELP';
      confidence = 0.95;
    } else if (/\b(weather|mausam|cricket|movie|film|song|gaana|joke|chutkula|politics|share market|stock)\b/i.test(lower)) {
      intent = 'NORMAL_CHAT'; // off-scope small talk — politely declined, no tools
      confidence = 0.9;
    }

    return Promise.resolve(resolve({ intent, confidence, slots, missing, searchFilter }));
  }

  generateResponse(input: AIReplyInput): Promise<AIReplyResult> {
    // Deterministic replies are built by the orchestrator's template layer; the
    // provider returns the pending question when one exists, else a neutral ack.
    const pending = input.conversation.pendingQuestion;
    return Promise.resolve({ message: pending ?? 'Theek hai — aur kuch jaanna hai?', askForField: null });
  }
}

interface IntentDraft {
  intent: Intent;
  confidence: number;
  slots: AIUnderstandingResult['slots'];
  missing: ContextSlotField[];
  searchFilter?: SearchFilterHint | null;
}

function resolve(draft: IntentDraft): AIUnderstandingResult {
  return {
    intent: draft.intent,
    confidence: draft.confidence,
    slots: draft.slots,
    missingFields: draft.missing,
    toolRequest: null,
    searchFilter: draft.searchFilter ?? null,
  };
}
