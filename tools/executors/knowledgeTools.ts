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
  'indianrailways.gov.in',
  'www.indianrailways.gov.in',
  'cris.org.in',
  'www.cris.org.in',
];

const KNOWLEDGE_FETCH_TIMEOUT_MS = 6_000;
const MAX_RETRIEVED_TEXT_CHARS = 1_200;

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
    url: 'https://www.indianrail.gov.in/enquiry/StaticPages/StaticEnquiry.jsp?StaticPage=tatkal_Scheme.html&locale=en',
    matches: /tatkal|premium tatkal/i,
  },
  {
    key: 'quota-codes',
    title: 'Quota Codes — Indian Railways (official)',
    url: 'https://www.indianrail.gov.in/enquiry/StaticPages/StaticEnquiry.jsp?StaticPage=hquota_Code.html&locale=en',
    matches: /quota code|quota kya|kaunse quota|\bgn quota\b|quota list/i,
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
    title: 'Reservation Rules / Conditions — Indian Railways (official)',
    url: 'https://www.indianrail.gov.in/enquiry/StaticPages/StaticEnquiry.jsp?StaticPage=conc_Rules.html',
    matches: /refund|niyam|rules?|luggage|concession|reservation rules|conditions/i,
  },
];

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

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RETRIEVED_TEXT_CHARS);
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), KNOWLEDGE_FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(target, {
          headers: { accept: 'text/html' },
          signal: controller.signal,
          redirect: 'error', // never follow redirects to unlisted domains
        });
        const finalHostname = response.url ? new URL(response.url).hostname : new URL(target).hostname;
        if (!response.ok || !isAllowlisted(finalHostname)) {
          return toolUnavailable(call, 'NO_DATA', HONEST_UNAVAILABLE_MESSAGE);
        }
        const text = sanitizeHtml(await response.text());
        if (text.length < 40) {
          return toolUnavailable(call, 'NO_DATA', HONEST_UNAVAILABLE_MESSAGE);
        }
        return {
          callId: call.id,
          tool: call.tool,
          ok: true,
          data: {
            source: 'web',
            sourceTitle: officialPage ? officialPage.title : finalHostname,
            sourceUrl: response.url || target,
            title: officialPage ? officialPage.title : finalHostname,
            url: response.url || target,
            retrievedText: text,
            retrievedAt: now().toISOString(),
            timestamp: now().toISOString(),
          },
          unavailableReason: null,
          error: null,
          executedBy: 'SERVER',
          provider: 'web' as never,
        };
      } catch {
        return toolUnavailable(call, 'NO_DATA', HONEST_UNAVAILABLE_MESSAGE);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
