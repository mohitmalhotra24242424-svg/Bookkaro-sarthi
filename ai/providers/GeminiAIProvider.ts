/**
 * Gemini AI provider (REAL REST adapter, activated only when AI_API_KEY is
 * configured server-side). Uses Gemini generateContent with JSON response
 * mime type; output goes through the same strict orchestrator validation as
 * every other provider. Key handling mirrors the NVIDIA adapter: injected,
 * server-side only, never logged.
 */

import { NotImplementedError } from '../../shared/index.js';
import type {
  AIReplyInput,
  AIReplyResult,
  AIUnderstandingInput,
  AIUnderstandingResult,
  AISlotExtraction,
  Intent,
} from '../../shared/index.js';
import type { AIProvider } from '../AIProvider.js';
import { conversationNluHint, conversationTranscriptHint, emptySlots, extractJson, nluSystemPrompt } from './NvidiaAIProvider.js';

export interface GeminiAIProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export class GeminiAIProvider implements AIProvider {
  readonly providerId = 'gemini';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GeminiAIProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'gemini-2.0-flash';
    this.baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async understand(input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
    const payload = await this.generate([
      { role: 'user', parts: [{ text: `${nluSystemPrompt(input.availableIntents as readonly string[], input.availableTools as readonly string[])}\n\n${conversationNluHint(input.conversation)}\n${conversationTranscriptHint(input.conversation, input.userMessage)}\nUser message: ${input.userMessage}` }] },
    ]);
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    const parsed = extractJson(text);
    return {
      intent: parsed.intent as Intent, // sanitized + whitelisted by the orchestrator validator
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      slots: { ...emptySlots(), ...((parsed.slots ?? parsed.entities ?? {}) as Partial<AISlotExtraction>) },
      missingFields: Array.isArray(parsed.missingFields ?? parsed.missing)
        ? ((parsed.missingFields ?? parsed.missing) as AIUnderstandingResult['missingFields'])
        : [],
      toolRequest: (() => {
        const toolReq = parsed.toolRequest as Record<string, unknown> | null | undefined;
        const toolName = typeof parsed.tool === 'string' && parsed.tool.length > 0
          ? parsed.tool
          : toolReq && typeof toolReq.tool === 'string'
            ? String(toolReq.tool)
            : null;
        if (!toolName) return null;
        const toolInput =
          parsed.toolInput ??
          (toolReq && typeof toolReq.input === 'object' && toolReq.input !== null ? toolReq.input : null);
        const rationaleRaw = typeof parsed.rationale === 'string'
          ? parsed.rationale
          : toolReq && typeof toolReq.rationale === 'string' ? String(toolReq.rationale) : null;
        return { tool: toolName as import('../../shared/index.js').ToolName, input: (toolInput as Record<string, unknown> | null) ?? {}, rationale: rationaleRaw ?? null };
      })(),
      searchFilter: (parsed.searchFilter ?? null) as AIUnderstandingResult['searchFilter'],
    };
  }

  async generateResponse(input: AIReplyInput): Promise<AIReplyResult> {
    const user = input.userMessage?.trim() ? `User asked: "${input.userMessage.trim()}"` : 'User asked a railway question.';
    const payload = await this.generate([
      {
        role: 'user',
        parts: [
          {
            text:
              `Answer the user's question in friendly Hinglish using ONLY the facts in this verified JSON. Never invent trains, fares, availability, stations or stop times; if the asked station is not in the stop list, say so plainly; if data is missing, say unavailable. No URLs, no markdown tables.\n${user}\n\nVerified JSON:\n` +
              JSON.stringify(input.toolResults).slice(0, 4_000),
          },
        ],
      },
    ]);
    return { message: payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? '', askForField: null };
  }

  private async generate(contents: Array<{ role: string; parts: Array<{ text: string }> }>): Promise<GeminiResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { temperature: 0.2, maxOutputTokens: 1600, responseMimeType: 'application/json' } }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new NotImplementedError(`Gemini API error ${response.status}`);
      }
      return (await response.json()) as GeminiResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}
