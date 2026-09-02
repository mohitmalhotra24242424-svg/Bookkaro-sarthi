/**
 * Extensible INTENT REGISTRY.
 *
 * Step 1 defines the vocabulary + metadata only. The intent detection engine
 * (NLU mapping user language → intent) is NOT IMPLEMENTED yet.
 */

import type { Intent, IntentDefinition } from './types/intent.js';

export const INTENT_REGISTRY: Readonly<Record<Intent, IntentDefinition>> = {
  BOOK_TRAIN: {
    intent: 'BOOK_TRAIN',
    title: 'Book a train ticket',
    description: 'End-to-end booking conversation: journey → train → class → availability/fare → fare review → explicit confirmation.',
    examplePhrases: ['Mujhe Amritsar se Ludhiana jaana hai', '2 ticket chahiye', 'Kal ki train book karo'],
    suggestedTools: ['searchTrains', 'getAvailability', 'getFare', 'createBookingDraft', 'reviewFare', 'confirmBooking'],
    requiresExplicitConfirmation: true,
    notes: 'confirmBooking is DETERMINISTIC_ONLY — AI may guide the flow but can never execute the booking.',
  },
  SEARCH_TRAIN: {
    intent: 'SEARCH_TRAIN',
    title: 'Search trains',
    description: 'List trains between two stations on a date.',
    examplePhrases: ['Amritsar se Ludhiana koi train hai?', 'Jammu se Beas ki trains batao'],
    suggestedTools: ['searchTrains'],
    requiresExplicitConfirmation: false,
    notes: null,
  },
  LIVE_TRAIN_STATUS: {
    intent: 'LIVE_TRAIN_STATUS',
    title: 'Live train status',
    description: 'Current running status / delay of a train.',
    examplePhrases: ['12014 ka live status batao', 'meri train kahan hai'],
    suggestedTools: ['getLiveStatus'],
    requiresExplicitConfirmation: false,
    notes: 'Live location/delay must come from a provider; never estimated by AI.',
  },
  GET_AVAILABILITY: {
    intent: 'GET_AVAILABILITY',
    title: 'Seat availability',
    description: 'Availability / waitlist for a train, class, date and quota.',
    examplePhrases: ['is train mein seat available hai?', 'SL class mein seat milegi?'],
    suggestedTools: ['getAvailability'],
    requiresExplicitConfirmation: false,
    notes: null,
  },
  GET_FARE: {
    intent: 'GET_FARE',
    title: 'Fare',
    description: 'Fare for a train/class/route.',
    examplePhrases: ['fare kitna hai?', 'kitne ka ticket banega?'],
    suggestedTools: ['getFare'],
    requiresExplicitConfirmation: false,
    notes: 'Fares are only ever shown from a verified provider quote.',
  },
  GET_TRAIN_INFO: {
    intent: 'GET_TRAIN_INFO',
    title: 'Train info',
    description: 'General information about a train number.',
    examplePhrases: ['12014 ke baare mein batao', '14542 ki info do'],
    suggestedTools: ['getTrainInfo'],
    requiresExplicitConfirmation: false,
    notes: null,
  },
  GET_TIMETABLE: {
    intent: 'GET_TIMETABLE',
    title: 'Timetable',
    description: 'Schedule / stop list of a train.',
    examplePhrases: ['12014 ka time table batao', 'is train ka route nikalo'],
    suggestedTools: ['getTimetable'],
    requiresExplicitConfirmation: false,
    notes: null,
  },
  LOOKUP_STATION: {
    intent: 'LOOKUP_STATION',
    title: 'Station lookup',
    description: 'Resolve a station name to its code.',
    examplePhrases: ['Ludhiana ka station code kya hai?', 'Beas station code'],
    suggestedTools: ['lookupStation'],
    requiresExplicitConfirmation: false,
    notes: null,
  },
  CHECK_PNR: {
    intent: 'CHECK_PNR',
    title: 'PNR status',
    description: 'Check PNR status.',
    examplePhrases: ['PNR check karo', '2345678901 ka PNR status batao'],
    suggestedTools: ['checkPNR'],
    requiresExplicitConfirmation: false,
    notes: 'PNR data comes only from a provider; never invented.',
  },
  VIEW_BOOKINGS: {
    intent: 'VIEW_BOOKINGS',
    title: 'View bookings',
    description: "Show the user's ticket history.",
    examplePhrases: ['Meri ticket history dikhao', 'mere bookings batao'],
    suggestedTools: ['getBookings'],
    requiresExplicitConfirmation: false,
    notes: null,
  },
  VIEW_WALLET: {
    intent: 'VIEW_WALLET',
    title: 'View wallet',
    description: 'Show wallet balance and transactions (read-only).',
    examplePhrases: ['wallet ka balance dikhao', 'mere wallet transactions batao'],
    suggestedTools: ['getWallet'],
    requiresExplicitConfirmation: false,
    notes: 'AI may READ the wallet but can never debit, credit or refund.',
  },
  GET_CANCELLED_TRAINS: {
    intent: 'GET_CANCELLED_TRAINS',
    title: 'Cancelled trains',
    description: 'List cancelled trains for a date/route.',
    examplePhrases: ['aaj koi train cancel hai kya?', 'kal ki cancelled trains'],
    suggestedTools: ['getCancelledTrains'],
    requiresExplicitConfirmation: false,
    notes: null,
  },
  COMPARE_TRAINS: {
    intent: 'COMPARE_TRAINS',
    title: 'Compare trains',
    description: 'Compare two or more trains to help the user choose.',
    examplePhrases: ['12014 aur 14542 mein kaunsi better hai?'],
    suggestedTools: ['compareTrains'],
    requiresExplicitConfirmation: false,
    notes: 'Comparison must be computed only from verified provider data for both trains.',
  },
  GENERAL_RAILWAY_QUERY: {
    intent: 'GENERAL_RAILWAY_QUERY',
    title: 'General railway question',
    description: 'Concept questions (classes, quotas, rules) answered from approved railway knowledge.',
    examplePhrases: ['CC kya hota hai?', 'tatkal quota kya hai?'],
    suggestedTools: [],
    requiresExplicitConfirmation: false,
    notes: 'Answers must come from an approved knowledge base — never invented.',
  },
  NORMAL_CHAT: {
    intent: 'NORMAL_CHAT',
    title: 'Off-scope chat',
    description: 'Non-railway small talk — politely declined with scope clarification. No tools, no railway claims.',
    examplePhrases: ['India mein weather kaisa hai?', 'cricket match ka score batao'],
    suggestedTools: [],
    requiresExplicitConfirmation: false,
    notes: 'Never answered with railway data or web.',
  },
  HELP: {
    intent: 'HELP',
    title: 'Help',
    description: 'Explain what the assistant can do.',
    examplePhrases: ['help', 'kya kya kar sakte ho?'],
    suggestedTools: [],
    requiresExplicitConfirmation: false,
    notes: null,
  },
  UNKNOWN: {
    intent: 'UNKNOWN',
    title: 'Unknown',
    description: 'Fallback when the request cannot be understood. Ask a clarifying question — never guess.',
    examplePhrases: ['asdf ghjkl'],
    suggestedTools: [],
    requiresExplicitConfirmation: false,
    notes: 'Never map an unclear request to a railway answer.',
  },
};

/** Stable, ordered list of every registered intent. */
export const INTENTS: readonly Intent[] = Object.keys(INTENT_REGISTRY) as readonly Intent[];

export function isKnownIntent(value: unknown): value is Intent {
  return typeof value === 'string' && value in INTENT_REGISTRY;
}

export function getIntentDefinition(intent: Intent): IntentDefinition | null {
  return INTENT_REGISTRY[intent] ?? null;
}

export function suggestedToolsForIntent(intent: Intent): readonly import('./types/tools.js').ToolName[] {
  return getIntentDefinition(intent)?.suggestedTools ?? [];
}

export function intentsThatSuggestTool(tool: import('./types/tools.js').ToolName): readonly Intent[] {
  return INTENTS.filter((intent) => INTENT_REGISTRY[intent].suggestedTools.includes(tool));
}
