/**
 * RESTRICTED RAILWAY KNOWLEDGE TOOL (Step 9 §10/§11).
 *
 * Resolution order:
 *   1. APPROVED deterministic glossary/composition (source: "deterministic") —
 *      zero network, covers classes/quotas/RAC/WL/tatkal/coach types/speed.
 *   2. ALLOWLISTED official web retrieval (source: "web") — only for general
 *      concept queries the glossary cannot answer, only from approved railway
 *      domains, with a hard timeout and sanitized output.
 *
 * Safety:
 *  - Arbitrary URLs/domains are REJECTED (hostname must match the allowlist,
 *    including after redirects — we never follow redirects to other domains).
 *  - Live-data queries (train number / live / availability / PNR / fare) are
 *    REFUSED web access — web is never used for live railway data.
 *  - Retrieval failures return honest unavailable. Nothing is fabricated.
 */

import { composeKnowledgeAnswer } from '../../shared/railwayKnowledge.js';
import type { ToolResult } from '../../shared/index.js';
import type { ToolExecutionContext, ToolExecutor } from '../registry.js';
import { toolFailure, toolUnavailable } from '../results.js';

export const RAILWAY_WEB_ALLOWLIST: readonly string[] = [
  'indianrail.gov.in',
  'www.indianrail.gov.in',
  'enquiry.indianrail.gov.in',
  'indianrailways.gov.in',
  'www.indianrailways.gov.in',
  'cris.org.in',
  'www.cris.org.in',
  'irctc.co.in',
  'www.irctc.co.in',
];

const KNOWLEDGE_FETCH_TIMEOUT_MS = 6_000;
const MAX_RETRIEVED_TEXT_CHARS = 1_600;

/**
 * OFFICIAL RAILWAY KNOWLEDGE PAGES (Step 9 official-source configuration).
 * Targeted, verified indianrail.gov.in pages used for topic-directed retrieval;
 * the model NEVER picks URLs — it can only pass a query (and optionally an
 * allowlisted domain); the server maps the topic to these official pages.
 */
export interface OfficialRailwayPage {
  key: string;
  title: string;
  url: string;
  matches: RegExp;
}

export const OFFICIAL_RAILWAY_PAGES: readonly OfficialRailwayPage[] = [
  {
    key: 'tatkal',
    title: 'Tatkal Scheme — Indian Railways (official)',
    url: 'https://www.indianrail.gov.in/StaticContents/tatkal_Scheme.html',
    matches: /tatkal|premium tatkal/i,
  },
  {
    key: 'quota-codes',
    title: 'Quota Codes — Indian Railways (official)',
    url: 'https://www.indianrail.gov.in/StaticContents/quota_Code.html',
    matches: /quota code|quota kya|kaunse quota|\bgn quota\b|quota list/i,
  },
  {
    key: 'refund',
    title: 'Refund Rules — Indian Railways (official)',
    url: 'https://www.indianrail.gov.in/StaticContents/refund_Rules.html',
    matches: /refund|wapsi|cancellation charge/i,
  },
  {
    key: 'luggage',
    title: 'Luggage Rules — Indian Railways (official)',
    url: 'https://www.indianrail.gov.in/StaticContents/luggage_Rule.html',
    matches: /luggage|samaan|baggage/i,
  },
  {
    key: 'pnr-legend',
    title: 'PNR Enquiry & status legend — Indian Railways (official)',
    url: 'https://www.indianrail.gov.in/enquiry/PNR/PnrEnquiry.html',
    matches: /pnr (status|legend|terminolog|kaise)|pnr kya hota|cnf kya|wl meaning|status legend/i,
  },
  {
    key: 'seat-availability',
    title: 'Seat Availability information — Indian Railways (official)',
    url: 'https://www.indianrail.gov.in/enquiry/SEAT/SeatAvailability.html',
    matches: /seat availability information|availability kaise|seat milegi kaise/i,
  },
  {
    key: 'rules',
    title: 'Concession / Reservation Rules — Indian Railways (official)',
    url: 'https://www.indianrail.gov.in/StaticContents/Rules/ConcessionRules/conc_Rules.html',
    matches: /concession|niyam|rules?|conditions|reservation rules/i,
  },
];

/** Official enquiry pages used ONLY after the railway API fails (never as primary live data). */
export const API_FALLBACK_PAGES: readonly OfficialRailwayPage[] = [
  {
    key: 'ntes',
    title: 'National Train Enquiry — Indian Railways (official)',
    url: 'https://enquiry.indianrail.gov.in/ntes/',
    matches: /\blive\b|kaha hai|kahan hai|running|delay|late|train status|ntes/i,
  },
  {
    key: 'tbis',
    title: 'Trains between stations — Indian Railways (official)',
    url: 'https://www.indianrail.gov.in/enquiry/TBIS/TrainBetweenImportantStations.html',
    matches: /\btrains?\b|gaadiyan|se .* (jaana|jana)|from .+ to /i,
  },
  {
    key: 'pnr-fallback',
    title: 'PNR Enquiry — Indian Railways (official)',
    url: 'https://www.indianrail.gov.in/enquiry/PNR/PnrEnquiry.html',
    matches: /\bpnr\b/i,
  },
];

function detectFallbackPage(query: string): OfficialRailwayPage | null {
  for (const page of API_FALLBACK_PAGES) {
    if (page.matches.test(query)) return page;
  }
  for (const page of OFFICIAL_RAILWAY_PAGES) {
    if (page.matches.test(query)) return page;
  }
  return null;
}

/** Topic-directed official page for a general knowledge query (null → site root). */
export function detectOfficialPage(query: string): OfficialRailwayPage | null {
  for (const page of OFFICIAL_RAILWAY_PAGES) {
    if (page.matches.test(query)) return page;
  }
  return null;
}

/**
 * RULE-SENSITIVE topics (Step 9): answers that can change by railway policy —
 * timings, refund rules, quotas. These MUST come from official retrieval, never
 * from static/model knowledge; if the official source is unreachable the answer
 * is the honest "official source unavailable" message.
 */
export const RULE_SENSITIVE_QUERY =
  /tatkal|refund|niyam|\brules?\b|luggage|concession|premium tatkal|quota code|booking kab khult/i;

/** Live-data markers — web is NEVER consulted for these (providers only). */
const LIVE_DATA_MARKER =
  /\b\d{5}\b|\blive\b|\babhi\b|\blocation\b|\bdelay|late\b|\bavailab|seat|waitlist|\bwl\b|\brac\b|\bfare\b|\bpnr\b|\bcancel|running|status/i;

function isAllowlisted(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^www\./, '');
  return RAILWAY_WEB_ALLOWLIST.some((domain) => {
    const bare = domain.toLowerCase().replace(/^www\./, '');
    return normalized === bare || normalized.endsWith(`.${bare}`);
  });
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : ' ';
    })
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : ' ';
    });
}

function sanitizeHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Official enquiry shells are JS apps — nav chrome is not an answer. */
function stripEnquiryChrome(text: string): string {
  return text
    .replace(/Welcome to Indian Railway Passenger Reservation Enquiry/gi, ' ')
    .replace(/Toggle navigation/gi, ' ')
    .replace(/Please help Indian railways[\s\S]{0,220}?black money\.?/gi, ' ')
    .replace(/Eradicate black money\.?/gi, ' ')
    .replace(
      /Indian Railways Enquiry PNR Enquiry Reserved Train Between Stations Seat Availability Fare Enquiry Reserved Train Schedule Refund Enquiry/gi,
      ' ',
    )
    .replace(/-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isChromeOnly(text: string): boolean {
  if (text.length < 40) return true;
  const stillChrome = /Toggle navigation|Passenger Reservation Enquiry|Eradicate black money/i.test(text);
  if (!stillChrome) return false;
  return !/Tatkal Scheme|Tatkal Charges|Quotas in Indian Railways|Revised Refund Rules|Concession Rules|Rules For Luggage|booking opens/i.test(
    text,
  );
}

function usefulTextFromHtml(html: string): string {
  const text = stripEnquiryChrome(sanitizeHtml(html));
  if (isChromeOnly(text)) return '';
  return text;
}

function staticContentsUrlFromHtml(html: string, currentUrl: string): string | null {
  const match =
    html.match(/StaticContents\/'\s*\+\s*'([^']+\.html)'/i) ||
    html.match(/['"]\/StaticContents\/([^'"]+\.html)['"]/i) ||
    html.match(/StaticContents\/([A-Za-z0-9_./-]+\.html)/i);
  if (!match?.[1]) return null;
  try {
    const next = new URL(`/StaticContents/${match[1]}`, 'https://www.indianrail.gov.in/');
    if (!isAllowlisted(next.hostname)) return null;
    if (next.href === currentUrl || next.pathname === new URL(currentUrl).pathname) return null;
    return next.href;
  } catch {
    return null;
  }
}

function preferRelevantPassage(text: string, query: string): string {
  const limit = MAX_RETRIEVED_TEXT_CHARS;
  if (text.length <= limit) return text;
  const q = query.toLowerCase();
  const patterns: RegExp[] = [];
  if (/khult|open|timing|kab\b/.test(q)) patterns.push(/tatkal booking opens[\s\S]{0,420}/i);
  if (/refund|wapsi/.test(q)) patterns.push(/revised refund rules[\s\S]{0,420}/i);
  if (/luggage|samaan/.test(q)) patterns.push(/rules for luggage[\s\S]{0,420}/i);
  if (/concession/.test(q)) patterns.push(/concession is admissible[\s\S]{0,420}/i);
  for (const pattern of patterns) {
    const found = text.match(pattern);
    if (found?.index != null) {
      const start = Math.max(0, found.index - 40);
      return text.slice(start, start + limit).trim();
    }
  }
  return text.slice(0, limit);
}


/** Spec-mandated honest-unavailable message for official-source failures. */
export const HONEST_UNAVAILABLE_MESSAGE =
  'Is information ko verify karne ke liye official railway source abhi available nahi hai. Main guess nahi karta.';

export interface KnowledgeFetch {
  (url: string, init: { headers: Record<string, string>; signal?: AbortSignal; redirect?: 'error' }): Promise<{
    ok: boolean;
    status: number;
    url?: string;
    text(): Promise<string>;
  }>;
}

export interface KnowledgeToolOptions {
  /** Injectable transport for tests (defaults to global fetch with redirect:'error'). */
  fetchImpl?: KnowledgeFetch;
  now?: () => Date;
}

function callOf(context: ToolExecutionContext): { id: string | null; tool: string } {
  return { id: context.call?.id ?? null, tool: 'getRailwayKnowledge' };
}

export function createKnowledgeToolExecutor(options: KnowledgeToolOptions = {}): Record<string, ToolExecutor> {
  const fetchImpl: KnowledgeFetch =
    options.fetchImpl ??
    ((globalThis.fetch as unknown) as KnowledgeFetch);
  const now = options.now ?? (() => new Date());

  async function retrieveOfficial(
    target: string,
    query: string,
  ): Promise<{ text: string; url: string; hostname: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), KNOWLEDGE_FETCH_TIMEOUT_MS);
    try {
      const first = await fetchImpl(target, {
        headers: { accept: 'text/html' },
        signal: controller.signal,
        redirect: 'error',
      });
      const firstUrl = first.url || target;
      const hostname = new URL(firstUrl).hostname;
      if (!first.ok || !isAllowlisted(hostname)) return null;
      const html = await first.text();
      let text = usefulTextFromHtml(html);
      let finalUrl = firstUrl;
      const nested = staticContentsUrlFromHtml(html, firstUrl);
      if (nested && text.length < 80) {
        const second = await fetchImpl(nested, {
          headers: { accept: 'text/html' },
          signal: controller.signal,
          redirect: 'error',
        });
        const secondUrl = second.url || nested;
        const host2 = new URL(secondUrl).hostname;
        if (second.ok && isAllowlisted(host2)) {
          const nestedText = usefulTextFromHtml(await second.text());
          if (nestedText.length >= 40) {
            text = nestedText;
            finalUrl = secondUrl;
          }
        }
      }
      if (text.length < 40) return null;
      return { text: preferRelevantPassage(text, query), url: finalUrl, hostname: new URL(finalUrl).hostname };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getRailwayKnowledge: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx);
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (query.length < 3) return toolFailure(call, 'INVALID_INPUT', 'query is required.');

      // Optional explicit allowlisted URL (AI may propose one — it is validated, never trusted).
      const proposedUrl = typeof input.url === 'string' ? input.url.trim() : null;
      if (proposedUrl !== null) {
        let hostname = '';
        try {
          hostname = new URL(proposedUrl).hostname;
        } catch {
          return toolFailure(call, 'URL_REJECTED', 'Invalid URL.');
        }
        if (!isAllowlisted(hostname)) {
          return toolFailure(call, 'URL_REJECTED', `Domain "${hostname}" is not on the railway knowledge allowlist.`);
        }
      }

      // Optional approved-domain restriction (the ONLY domain inputs accepted).
      const domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : null;
      if (domain !== null && domain.length > 0) {
        const bare = domain.replace(/^www\./, '').replace(/^https?:\/\//, '').split('/')[0] ?? '';
        if (!isAllowlisted(bare)) {
          return toolFailure(call, 'URL_REJECTED', `Domain "${domain}" is not on the railway knowledge allowlist.`);
        }
      }

      // Rule-sensitive queries (timings/refund/rules) must be OFFICIAL-SOURCE-backed:
      // they skip the static glossary entirely and go straight to official retrieval.
      const ruleSensitive = RULE_SENSITIVE_QUERY.test(query);

      // 1. Approved deterministic knowledge first (stable concepts only, never rule-sensitive).
      if (!ruleSensitive) {
        const composed = composeKnowledgeAnswer(query);
        if (composed) {
          return {
            callId: call.id,
            tool: call.tool,
            ok: true,
            data: {
              source: 'deterministic',
              sourceTitle: composed.matchedTerms.join(' + '),
              sourceUrl: null,
              title: composed.matchedTerms.join(' + '),
              url: null,
              retrievedText: composed.answer,
              retrievedAt: now().toISOString(),
              timestamp: now().toISOString(),
            },
            unavailableReason: null,
            error: null,
            executedBy: 'SERVER',
            provider: null,
          };
        }
      }

      // 2. Allowlisted official web — ONLY for general concepts, never live data.
      if (LIVE_DATA_MARKER.test(query)) {
        return toolUnavailable(
          call,
          'NO_DATA',
          'Live railway data (status/availability/fare/PNR) web se nahi aata — sirf railway providers se aata hai.',
        );
      }
      // Topic-directed OFFICIAL page when one matches (server-controlled URL map).
      const officialPage = detectOfficialPage(query);
      let target = proposedUrl ?? (officialPage ? officialPage.url : 'https://www.indianrail.gov.in/');
      // Optional approved-domain restriction narrows the fallback target's host.
      if (domain && !proposedUrl) {
        const bare = domain.replace(/^www\./, '').replace(/^https?:\/\//, '').split('/')[0];
        const officialHost = officialPage ? new URL(officialPage.url).hostname.replace(/^www\./, '') : null;
        if (officialHost !== bare) {
          target = `https://${bare}/`;
        }
      }
      const retrieved = await retrieveOfficial(target, query);
      if (!retrieved) return toolUnavailable(call, 'NO_DATA', HONEST_UNAVAILABLE_MESSAGE);
      return {
        callId: call.id,
        tool: call.tool,
        ok: true,
        data: {
          source: 'web',
          sourceTitle: officialPage ? officialPage.title : retrieved.hostname,
          sourceUrl: retrieved.url,
          title: officialPage ? officialPage.title : retrieved.hostname,
          url: retrieved.url,
          retrievedText: retrieved.text,
          retrievedAt: now().toISOString(),
          timestamp: now().toISOString(),
        },
        unavailableReason: null,
        error: null,
        executedBy: 'SERVER',
        provider: 'web' as never,
      };
    },

    /** SERVER-ONLY: official allowlisted web after a railway API timeout/unavailable. */
    getOfficialWebFallback: async (input, ctx): Promise<ToolResult> => {
      const call = { id: ctx.call?.id ?? null, tool: 'getOfficialWebFallback' };
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (query.length < 3) return toolFailure(call, 'INVALID_INPUT', 'query is required.');
      const page = detectFallbackPage(query);
      const target = page ? page.url : 'https://www.indianrail.gov.in/';
      const retrieved = await retrieveOfficial(target, query);
      if (!retrieved) return toolUnavailable(call, 'NO_DATA', HONEST_UNAVAILABLE_MESSAGE);
      return {
        callId: call.id,
        tool: call.tool,
        ok: true,
        data: {
          source: 'web',
          sourceTitle: page ? page.title : retrieved.hostname,
          sourceUrl: retrieved.url,
          title: page ? page.title : retrieved.hostname,
          url: retrieved.url,
          retrievedText: retrieved.text,
          retrievedAt: now().toISOString(),
          timestamp: now().toISOString(),
        },
        unavailableReason: null,
        error: null,
        executedBy: 'SERVER',
        provider: 'web' as never,
      };
    },
  };
}
