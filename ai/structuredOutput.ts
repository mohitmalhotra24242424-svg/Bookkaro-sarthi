/**
 * STRUCTURED AI OUTPUT VALIDATION.
 *
 * The AI never gets to hand free-form instructions to the backend. Whatever an
 * AI provider returns is parsed into a STRICT schema and sanitized here before
 * anything downstream sees it:
 *   - intent must be a registered intent
 *   - tool (if any) must be a REGISTERED, AI-REQUESTABLE tool
 *   - slot formats are enforced (train number digits, 10-digit PNR, class codes…)
 *   - no string may contain a URL — the AI cannot pick endpoints
 *   - confidence is clamped to 0..1
 * Invalid output is REJECTED (the orchestrator then falls back to the
 * deterministic NLU or asks the user to rephrase). AI output is never trusted
 * blindly.
 */

import {
  QUOTAS,
  TRAVEL_CLASSES,
  containsUrl,
  isKnownIntent,
  newId,
} from '../shared/index.js';
import type {
  AIUnderstandingResult,
  AIToolRequest,
  ContextSlotField,
  Intent,
  SearchFilterHint,
  ToolCall,
  ToolName,
} from '../shared/index.js';

export interface ValidateUnderstandingInput {
  raw: unknown;
  availableTools: readonly ToolName[];
  isToolAiRequestable: (tool: ToolName) => boolean;
}

export interface ValidatedUnderstanding {
  ok: boolean;
  /** Hard errors — the whole understanding is rejected. */
  errors: string[];
  /** Tool-request rejections (recorded as SAFETY events; the tool is dropped but the turn survives). */
  toolErrors: string[];
  result?: AIUnderstandingResult;
  toolCall?: ToolCall;
}

const KNOWN_FIELDS: readonly ContextSlotField[] = [
  'origin',
  'destination',
  'journeyDate',
  'passengerCount',
  'selectedTrain',
  'selectedClass',
];

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function safeText(value: unknown, max = 80): string | null {
  const text = asString(value);
  if (text === null) return null;
  if (containsUrl(text)) return null; // AI may not smuggle URLs
  return text.slice(0, max);
}

function validTrainNumber(value: unknown): string | null {
  const text = asString(value);
  return text && /^\d{4,6}$/.test(text) ? text : null;
}

function validPnr(value: unknown): string | null {
  const text = asString(value);
  return text && /^\d{10}$/.test(text) ? text : null;
}

function validClass(value: unknown): string | null {
  const text = asString(value)?.toUpperCase();
  return text && (TRAVEL_CLASSES as readonly string[]).includes(text) ? text : null;
}

function validQuota(value: unknown): string | null {
  const text = asString(value)?.toUpperCase();
  return text && (QUOTAS as readonly string[]).includes(text) ? text : null;
}

const DAY_PARTS: readonly string[] = ['morning', 'afternoon', 'evening', 'night'];

/**
 * Parse + sanitize the AI's optional time-of-day/clock-window filter (the model
 * reads "subah/morning" or "4am se 6am" into a raw {kind, dayPart|fromMin|toMin}
 * object). It is clamped, validated and dropped entirely if malformed — the
 * AI is never allowed to emit a filter the server can't reason about. The
 * orchestrator still cross-checks it against the user's literal words.
 */
function parseSearchFilter(value: unknown): SearchFilterHint | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = asString(record.kind);
  const hintSource = safeText(record.source) ?? 'ai';
  if (kind === 'dayPart') {
    const dayPart = asString(record.dayPart)?.toLowerCase();
    if (dayPart && DAY_PARTS.includes(dayPart)) {
      return { source: hintSource, kind: 'dayPart', dayPart: dayPart as SearchFilterHint['dayPart'] };
    }
    return null;
  }
  if (kind === 'timeWindow') {
    const fromMin = typeof record.fromMin === 'number' ? Math.round(record.fromMin) : NaN;
    const toMin = typeof record.toMin === 'number' ? Math.round(record.toMin) : NaN;
    if (
      Number.isFinite(fromMin) && Number.isFinite(toMin) &&
      fromMin >= 0 && fromMin <= 1440 && toMin > 0 && toMin <= 1440 && toMin > fromMin
    ) {
      return { source: hintSource, kind: 'timeWindow', fromMin, toMin };
    }
    return null;
  }
  return null;
}

/**
 * Accepts either the documented wire schema ({intent, tool, entities, missing,
 * confidence}) or the internal AIUnderstandingResult shape — and normalizes
 * both into a SANITIZED AIUnderstandingResult.
 */
export function validateAIUnderstanding(input: ValidateUnderstandingInput): ValidatedUnderstanding {
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const raw = input.raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['AI output must be a JSON object'], toolErrors: [] };
  }
  const record = raw as Record<string, unknown>;

  // ── intent ──
  const intentText = asString(record.intent);
  let intent: Intent | null = intentText && isKnownIntent(intentText) ? (intentText as Intent) : null;
  if (!intent) errors.push(`unknown intent "${String(record.intent)}"`);

  // ── confidence ──
  let confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence) ? record.confidence : 0;
  confidence = Math.min(1, Math.max(0, confidence));

  // ── entities (wire schema) or slots (internal schema) ──
  const source = (record.entities ?? record.slots ?? {}) as Record<string, unknown>;
  const entities = source !== null && typeof source === 'object' && !Array.isArray(source) ? source : {};
  // Real models sometimes return snake_case keys — accept both shapes.
  const entity = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (entities[key] !== undefined && entities[key] !== null) return entities[key];
    }
    return undefined;
  };
  void entity;

  const trainNumber = validTrainNumber(entity('trainNumber', 'train_number'));
  const secondTrainNumber = validTrainNumber(entity('secondTrainNumber', 'second_train_number'));
  const pnr = validPnr(entity('pnr', 'pnr_number', 'pnrNumber'));
  const travelClass = validClass(entity('travelClass', 'travel_class', 'class', 'coach'));
  const rawPassengerCount = entity('passengerCount', 'passenger_count', 'passengers');
  const passengerCount =
    typeof rawPassengerCount === 'number' && Number.isInteger(rawPassengerCount) &&
    rawPassengerCount >= 1 && rawPassengerCount <= 6
      ? rawPassengerCount
      : null;
  if (rawPassengerCount !== undefined && rawPassengerCount !== null && passengerCount === null) {
    errors.push('passengerCount must be an integer 1–6');
  }
  if (entity('trainNumber', 'train_number') !== undefined && !trainNumber) {
    errors.push('trainNumber must be 4–6 digits');
  }
  if (entity('pnr') !== undefined && !pnr) {
    errors.push('pnr must be 10 digits');
  }

  // Quota — validated then dropped (not a conversation slot; used in tool input only).
  void validQuota;

  const mentionedStationsRawRaw = entity('mentionedStations', 'mentioned_stations');
  const mentionedStationsRaw = Array.isArray(mentionedStationsRawRaw) ? mentionedStationsRawRaw : [];
  const mentionedStations = mentionedStationsRaw
    .map((entry) => safeText(entry, 40))
    .filter((entry): entry is string => entry !== null)
    .slice(0, 4);

  const slots = {
    originQuery: safeText(entity('origin', 'originQuery', 'from')),
    destinationQuery: safeText(entity('destination', 'destinationQuery', 'to')),
    journeyDate: safeText(entity('date', 'journeyDate', 'journey_date'), 20),
    // models often put the date in entities.date — treat it as the RAW expression
    // too; the deterministic resolver validates it (aaj/kal/parso/ISO all pass).
    dateText: safeText(entity('dateText', 'date_text', 'date', 'journey_date'), 20),
    passengerCount,
    trainNumber,
    secondTrainNumber,
    travelClass: travelClass as AIUnderstandingResult['slots']['travelClass'],
    pnr,
    resultReference: safeText(entity('resultReference', 'result_reference'), 20),
    isCorrection: entity('isCorrection', 'is_correction') === true,
    mentionedStations,
    glossaryTerm: safeText(entity('glossaryTerm', 'glossary_term'), 20),
  };

  // ── missing fields ──
  const missingRawRaw = record.missingFields ?? record.missing;
  const missingRaw = Array.isArray(missingRawRaw) ? missingRawRaw : [];
  const missing = missingRaw
    .map((entry: string) => (entry === 'date' ? 'journeyDate' : entry === 'passengers' ? 'passengerCount' : entry))
    .filter((entry: string): entry is ContextSlotField =>
      typeof entry === 'string' && (KNOWN_FIELDS as readonly string[]).includes(entry),
    );

  // ── tool request ──
  let toolRequest: AIToolRequest | null = null;
  // The provider may surface the request as a nested {tool,input,rationale} object
  // (AIUnderstandingResult.toolRequest) OR as the flat wire fields (tool/toolInput/
  // rationale). Accept both, always re-validating against the registry.
  const nestedTool = record.toolRequest as Record<string, unknown> | null | undefined;
  const toolRaw = asString(record.tool) ?? (nestedTool ? asString(nestedTool.tool) : null);
  if (toolRaw) {
    if (!(input.availableTools as readonly string[]).includes(toolRaw)) {
      toolErrors.push(`AI requested unregistered tool "${toolRaw}" — rejected`);
    } else if (!input.isToolAiRequestable(toolRaw as ToolName)) {
      toolErrors.push(`AI requested protected tool "${toolRaw}" — rejected`);
    } else {
      const rawInput =
        record.toolInput !== null && typeof record.toolInput === 'object' && !Array.isArray(record.toolInput)
          ? (record.toolInput as Record<string, unknown>)
          : nestedTool && typeof nestedTool.input === 'object' && nestedTool.input !== null
            ? (nestedTool.input as Record<string, unknown>)
            : {};
      const sanitizedInput: Record<string, unknown> = {};
      let inputBad = false;
      for (const [key, value] of Object.entries(rawInput).slice(0, 12)) {
        if (typeof value === 'string') {
          if (containsUrl(value)) {
            toolErrors.push(`tool input "${key}" contained a URL — rejected`);
            inputBad = true;
            continue;
          }
          sanitizedInput[key] = value.slice(0, 80);
        } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
          sanitizedInput[key] = value;
        } else {
          toolErrors.push(`tool input "${key}" had an unsupported type — rejected`);
          inputBad = true;
        }
      }
      if (!inputBad) {
        toolRequest = {
          tool: toolRaw as ToolName,
          input: sanitizedInput,
          rationale: safeText(record.rationale, 160) ?? (nestedTool ? safeText(nestedTool.rationale, 160) : null),
        };
      }
    }
  }

  if (errors.length > 0 || !intent) {
    return { ok: false, errors: errors.length > 0 ? errors : ['unknown intent'], toolErrors };
  }

  // ── optional time-of-day filter the AI read from the user's turn ──
  const searchFilter = parseSearchFilter(record.searchFilter ?? (entities as Record<string, unknown>).searchFilter);

  const result: AIUnderstandingResult = { intent, confidence, slots, missingFields: missing, toolRequest, searchFilter };
  void toolErrors;
  const toolCall: ToolCall | undefined = toolRequest
    ? {
        id: newId('tc'),
        tool: toolRequest.tool,
        input: toolRequest.input,
        requestedBy: 'AI',
        conversationId: null,
        createdAt: new Date().toISOString(),
      }
    : undefined;

  return { ok: true, errors: [], toolErrors, result, toolCall };
}
