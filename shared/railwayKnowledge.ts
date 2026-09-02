/**
 * APPROVED STATIC RAILWAY KNOWLEDGE (glossary).
 *
 * This is GENERAL KNOWLEDGE about stable railway concepts — classes, quotas,
 * RAC/WL, chart, tatkal. It is the ONLY thing that may be answered without a
 * tool call. It must NEVER be used to answer live questions (availability,
 * fare, live status, timetable, PNR) — those always go through the provider
 * layer. Answers here are generic by design and contain no train-specific,
 * station-specific or time-specific claims.
 */

export interface GlossaryEntry {
  term: string;
  aliases: readonly string[];
  /** Plain-language explanation (Hinglish-friendly). */
  answer: string;
}

export const RAILWAY_GLOSSARY: readonly GlossaryEntry[] = [
  {
    term: 'CC',
    aliases: ['cc', 'chair car', 'chaircar'],
    answer:
      'CC matlab Chair Car — AC seating class with reserved seats (2+3 layout). Short journeys ke liye comfortable, jaise Shatabdi trains mein milta hai.',
  },
  {
    term: 'EC',
    aliases: ['ec', 'executive', 'executive chair car'],
    answer: 'EC matlab Executive Chair Car — CC ka premium version (2+2 layout), zyada space aur service milti hai.',
  },
  {
    term: 'SL',
    aliases: ['sl', 'sleeper'],
    answer: 'SL matlab Sleeper class — non-AC reserved berth (3-tier berths). Lambi journey ka sasta popular option.',
  },
  {
    term: '1A',
    aliases: ['1a', 'first ac', 'first class ac'],
    answer: '1A matlab First AC — locked cabins, broadest berths, best service. Sabse mehngi reserved class.',
  },
  {
    term: '2A',
    aliases: ['2a', 'second ac', 'two tier ac'],
    answer: '2A matlab Second AC (2-tier) — 4 berths per bay plus side lower/upper, AC ke saath blankets milti hain.',
  },
  {
    term: '3A',
    aliases: ['3a', 'third ac', 'three tier ac'],
    answer: '3A matlab Third AC (3-tier) — 6 berths per bay plus side berths, AC ke saath medium-range comfort.',
  },
  {
    term: '3E',
    aliases: ['3e', 'third ac economy', '3ac economy'],
    answer: '3E matlab Third AC Economy — 3A jaisa, thoda kam charge, Garib Rath type trains mein common.',
  },
  {
    term: '2S',
    aliases: ['2s', 'second sitting'],
    answer: '2S matlab Second Sitting — reserved non-AC seat (berth nahi). Short daytime journeys ke liye.',
  },
  {
    term: 'RAC',
    aliases: ['rac'],
    answer:
      'RAC matlab Reservation Against Cancellation — ticket confirm nahi hoti, par seat share karti hai (side lower ke saath). Cancel hone par berth milegi.',
  },
  {
    term: 'WL',
    aliases: ['wl', 'waitlist', 'waiting list'],
    answer:
      'WL matlab Waiting List — abhi seat nahi mili; list mein aage badhte hue confirm hone ka chance. Chart banne par status clear hota hai.',
  },
  {
    term: 'GN',
    aliases: ['gn', 'general quota'],
    answer: 'GN matlab General quota — sabse common booking quota, koi special restriction nahi.',
  },
  {
    term: 'TQ',
    aliases: ['tq', 'tatkal'],
    answer:
      'TQ/Tatkal matlab same-day ya next-day journey ke liye extra seats wala quota — charge zyada, limited seats, booking ek din pehle khulti hai.',
  },
  {
    term: 'CHART',
    aliases: ['chart', 'chart prepared'],
    answer:
      'Chart matlab final passenger list — train se pehle banti hai. Chart ban jaane ke baad seat/coach allotment final ho jaata hai.',
  },
  {
    term: 'PNR',
    aliases: ['pnr'],
    answer: 'PNR matlab Passenger Name Record — 10-digit unique number jisse ticket status check hota hai.',
  },
  {
    term: 'SPEED',
    aliases: ['speed', 'raftar', 'average speed'],
    answer:
      'Trains ki speed ek fixed number nahi hai — train type (Rajdhani/Shatabdi/Express/Mail), route aur section ke hisaab se badalti hai. Kisi specific train ki exact speed ke liye us train ka official data dekhna hota hai; main andaza nahi lagata.',
  },
];

export function findGlossaryAnswer(term: string | null): GlossaryEntry | null {
  if (!term) return null;
  const normalized = term.trim().toLowerCase();
  if (normalized.length === 0) return null;
  return (
    RAILWAY_GLOSSARY.find(
      (entry) => entry.term.toLowerCase() === normalized || entry.aliases.includes(normalized),
    ) ?? null
  );
}


export interface ComposedKnowledge {
  answer: string;
  matchedTerms: string[];
}

/**
 * Deterministic knowledge composition (Step 9 §10):
 *  - "X aur Y ..." → both glossary entries + a difference line
 *  - "coach types / classes" → a listing of every travel-class entry
 * Falls back to the single-term answer, or null when nothing approved matches
 * (the restricted web capability is then attempted by the knowledge tool).
 */
export function composeKnowledgeAnswer(query: string | null): ComposedKnowledge | null {
  if (!query) return null;
  const text = query.toLowerCase();

  // listing question: coach/class types
  if (/coach\s*types?|class\s*types?|kaunse coach|classes kaunse/.test(text)) {
    const classTerms = ['1A', '2A', '3A', 'SL', 'CC', 'EC', '2S', '3E'];
    const parts: string[] = [];
    const matched: string[] = [];
    for (const term of classTerms) {
      const entry = findGlossaryAnswer(term);
      if (entry) {
        parts.push(`• ${entry.term}: ${entry.answer}`);
        matched.push(entry.term);
      }
    }
    if (parts.length > 0) {
      return { answer: `Coach/class types (approved knowledge):\n${parts.join('\n')}`, matchedTerms: matched };
    }
  }

  // "X aur Y" difference question
  const pair = text.match(/\b([a-z0-9]{2,3})\s+(?:aur|and|vs|ya)\s+([a-z0-9]{2,3})\b/);
  if (pair && /(difference|antar|fark|compare|better)/.test(text)) {
    const first = findGlossaryAnswer(pair[1]!);
    const second = findGlossaryAnswer(pair[2]!);
    if (first && second) {
      return {
        answer: `${first.term}: ${first.answer}\n\n${second.term}: ${second.answer}\n\nAntar: ${first.term} aur ${second.term} dono approved knowledge se explain kiye gaye hain — live availability/fare ke liye train number ke saath poochhiye.`,
        matchedTerms: [first.term, second.term],
      };
    }
  }

  const single = findGlossaryAnswer(query);
  if (single) return { answer: single.answer, matchedTerms: [single.term] };
  return null;
}
