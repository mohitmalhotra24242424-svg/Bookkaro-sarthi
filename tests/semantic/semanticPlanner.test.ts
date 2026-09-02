/**
 * SEMANTIC AI TOOL PLANNER — regression tests for the FINAL spec.
 *
 * These are DETERMINISTIC (no live model, no live railway calls): fake model
 * clients return controlled plans or throw (to exercise the fallback chain), and
 * the harness router provides verified mock data. The real-model/real-provider
 * passes live in tests/semantic/semanticSmoke.test.ts (skipped without keys).
 */

import { describe, expect, it } from 'vitest';
import { SemanticPlanner } from '../../api/ai/semantic-planner.js';
import type { SemanticModelClient, SemanticNlu } from '../../api/ai/semantic-planner.js';
import type { SemanticPlan, SemanticPlannerResult } from '../../api/ai/semantic-plan.js';
import { parseSemanticPlan } from '../../api/ai/semantic-plan.js';
import { SEMANTIC_TOOL_IDS, semanticToolToCatalogId } from '../../api/ai/semantic-tools.js';
import { runSemanticOrchestrator } from '../../api/ai/semantic-orchestrator.js';
import { createHarness, freshContext, makeSearchResults, isoPlusDays, ASR, LDH, NDLS } from '../orchestration/harness.js';
import { setSearchResults, setContextSlots } from '../../shared/index.js';
import type { AIUnderstandingResult } from '../../shared/index.js';

// ── fake model clients ───────────────────────────────────────────────────────

class FakeModel implements SemanticModelClient {
  readonly model: string;
  readonly baseUrl = 'https://fake.local/v1';
  constructor(model: string, private readonly plan: SemanticPlan | null, private readonly shouldThrow = false) {
    this.model = model;
  }
  async complete(): Promise<unknown> {
    if (this.shouldThrow) throw new Error('model-transport-failure');
    if (this.plan === null) return '{ not valid json';
    return JSON.stringify(this.plan);
  }
}

class FakeNlu implements SemanticNlu {
  constructor(private readonly result: AIUnderstandingResult) {}
  async understand(): Promise<AIUnderstandingResult> {
    return this.result;
  }
}

const NO_TRAIN = (): SemanticPlan => ({
  intent: 'search trains',
  confidence: 0.9,
  entities: { origin: 'ASR', destination: 'LDH', trainNumbers: [], trainName: null, date: isoPlusDays(1), travelClass: null, passengers: null, pnr: null },
  toolPlan: [{ tool: 'SEARCH_TRAINS', args: { originCode: 'ASR', destinationCode: 'LDH', journeyDate: isoPlusDays(1) } }],
  comparison: null,
  needsClarification: false,
  missingFields: [],
  clarificationQuestion: null,
});

const CLARIFY_PLAN = (): SemanticPlan => ({
  intent: 'live status',
  confidence: 0.7,
  entities: { origin: null, destination: null, trainNumbers: [], trainName: null, date: null, travelClass: null, passengers: null, pnr: null },
  toolPlan: [],
  comparison: null,
  needsClarification: true,
  missingFields: ['trainNumber'],
  clarificationQuestion: 'Kaunsi train ka live status dekhna hai?',
});

function emptyUnderstanding(): AIUnderstandingResult {
  return {
    intent: 'UNKNOWN',
    confidence: 0,
    slots: {
      originQuery: null, destinationQuery: null, journeyDate: null, dateText: null, passengerCount: null,
      trainNumber: null, secondTrainNumber: null, travelClass: null, pnr: null, resultReference: null,
      isCorrection: false, mentionedStations: [], glossaryTerm: null,
    },
    missingFields: [],
    toolRequest: null,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('SemanticToolRegistry', () => {
  it('exposes EXACTLY the 9 approved tools (no more, no less)', () => {
    expect(SEMANTIC_TOOL_IDS).toHaveLength(9);
    expect(SEMANTIC_TOOL_IDS).toEqual([
      'SEARCH_TRAINS', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'TRACK_TRAIN', 'CHECK_AVAILABILITY',
      'GET_FARE', 'CHECK_PNR', 'GET_CANCELLED_TRAINS', 'GENERAL_RAILWAY_ANSWER',
    ]);
  });

  it('every semantic tool maps to a Step-6 catalog id', () => {
    for (const id of SEMANTIC_TOOL_IDS) {
      expect(semanticToolToCatalogId(id), id).not.toBeNull();
    }
  });
});

describe('parseSemanticPlan', () => {
  it('normalizes entities + toolPlan and rejects unknown tool ids', () => {
    const plan = parseSemanticPlan(JSON.stringify({
      intent: 'route search', confidence: 0.85,
      entities: { origin: 'Amritsar', destination: 'Ludhiana', trainNumbers: ['12014'], date: 'kal', travelClass: 'cc' },
      toolPlan: [{ tool: 'SEARCH_TRAINS', args: { originCode: 'ASR' } }, { tool: 'CALL_URL', args: { url: 'https://evil' } }],
      comparison: null, needsClarification: false, missingFields: [], clarificationQuestion: null,
    }));
    expect(plan).not.toBeNull();
    expect(plan!.toolPlan.map((call) => call.tool)).toEqual(['SEARCH_TRAINS']); // unknown dropped
    expect(plan!.entities.travelClass).toBe('CC');
    expect(plan!.entities.date).toBe('kal');
  });

  it('rejects non-JSON and empty output', () => {
    expect(parseSemanticPlan('not json at all')).toBeNull();
    expect(parseSemanticPlan('')).toBeNull();
  });
});

describe('SemanticPlanner fallback chain', () => {
  it('PRIMARY succeeds with a usable plan → source ai_primary', async () => {
    const planner = new SemanticPlanner({
      primary: new FakeModel('openai/gpt-oss-20b', NO_TRAIN()),
      secondary: new FakeModel('nvidia/nemotron-3.5-lightning-30b-a3b', NO_TRAIN()),
      nlu: new FakeNlu(emptyUnderstanding()),
    });
    const result = await planner.plan('Mujhe kal ASR se LDH jaana hai', freshContext());
    expect(result.source).toBe('ai_primary');
    expect(result.modelUsed).toBe('openai/gpt-oss-20b');
    expect(result.usedNlu).toBe(false);
    expect(result.plan?.toolPlan[0]?.tool).toBe('SEARCH_TRAINS');
  });

  it('does NOT call both models at once (primary wins, secondary untouched)', async () => {
    let secondaryCalled = 0;
    const secondary = new FakeModel('nemotron', NO_TRAIN());
    const spyComplete = secondary.complete.bind(secondary);
    secondary.complete = async () => { secondaryCalled += 1; return spyComplete(); };
    const planner = new SemanticPlanner({ primary: new FakeModel('gpt', NO_TRAIN()), secondary, nlu: new FakeNlu(emptyUnderstanding()) });
    const result = await planner.plan('kal ASR se LDH', freshContext());
    expect(result.source).toBe('ai_primary');
    expect(secondaryCalled).toBe(0);
  });

  it('PRIMARY throws → SECONDARY succeeds → source ai_secondary', async () => {
    const planner = new SemanticPlanner({
      primary: new FakeModel('gpt', null, true),
      secondary: new FakeModel('nemotron', NO_TRAIN()),
      nlu: new FakeNlu(emptyUnderstanding()),
    });
    const result = await planner.plan('kal ASR se LDH', freshContext());
    expect(result.source).toBe('ai_secondary');
    expect(result.modelUsed).toBe('nemotron');
    expect(result.usedNlu).toBe(false);
  });

  it('PRIMARY invalid JSON → SECONDARY used', async () => {
    // primary returns garbage (FakeModel with plan=null returns invalid JSON)
    const planner = new SemanticPlanner({
      primary: new FakeModel('gpt', null),
      secondary: new FakeModel('nemotron', NO_TRAIN()),
      nlu: new FakeNlu(emptyUnderstanding()),
    });
    const result = await planner.plan('kal ASR se LDH', freshContext());
    expect(result.source).toBe('ai_secondary');
  });

  it('both AI models fail → deterministic NLU (source nlu, usedNlu true)', async () => {
    const nluResult = emptyUnderstanding();
    nluResult.intent = 'SEARCH_TRAIN';
    nluResult.slots.originQuery = 'ASR';
    nluResult.slots.destinationQuery = 'LDH';
    nluResult.slots.dateText = 'kal';
    const planner = new SemanticPlanner({
      primary: new FakeModel('gpt', null, true),
      secondary: new FakeModel('nemotron', null, true),
      nlu: new FakeNlu(nluResult),
    });
    const result = await planner.plan('kal ASR se LDH', freshContext());
    expect(result.source).toBe('nlu');
    expect(result.usedNlu).toBe(true);
    expect(result.modelUsed).toBeNull();
    expect(result.plan?.toolPlan[0]?.tool).toBe('SEARCH_TRAINS');
  });

  it('primary unusable plan (empty, no clarification) falls to secondary', async () => {
    const emptyPlan: SemanticPlan = {
      intent: 'UNKNOWN', confidence: 0.1,
      entities: { origin: null, destination: null, trainNumbers: [], trainName: null, date: null, travelClass: null, passengers: null, pnr: null },
      toolPlan: [], comparison: null, needsClarification: false, missingFields: [], clarificationQuestion: null,
    };
    const planner = new SemanticPlanner({
      primary: new FakeModel('gpt', emptyPlan),
      secondary: new FakeModel('nemotron', NO_TRAIN()),
      nlu: new FakeNlu(emptyUnderstanding()),
    });
    const result = await planner.plan('kal ASR se LDH', freshContext());
    expect(result.source).toBe('ai_secondary');
  });
});

// ── orchestrator (backend execution) ─────────────────────────────────────────

function planResult(plan: SemanticPlan): SemanticPlannerResult {
  return { plan, source: 'ai_primary', modelUsed: 'gpt', fallbackReason: null, raw: null, usedNlu: false };
}

describe('runSemanticOrchestrator (backend execution over harness router)', () => {
  it('SEARCH_TRAINS executes through the registry and builds a real reply', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = setContextSlots(context, {
      origin: ASR, destination: LDH, journeyDate: isoPlusDays(1),
    } as never, 'FILL_MISSING');
    const turn = await runSemanticOrchestrator(planResult(NO_TRAIN()), context, { registry: harness.toolRegistry, now: () => new Date('2026-08-26T10:00:00.000Z') }, { userId: 'u1', conversationId: 'c1' });
    expect(turn.intent).toBe('search trains');
    expect(turn.executedTools).toContain('SEARCH_TRAINS');
    expect(turn.diagnostics.source).toBe('ai_primary');
    expect(turn.diagnostics.realData).toBe(true);
    expect(turn.reply).toMatch(/trains mili/i);
  });

  it('clarification plan → asks the question, executes nothing', async () => {
    const harness = createHarness();
    const turn = await runSemanticOrchestrator(planResult(CLARIFY_PLAN()), freshContext(), { registry: harness.toolRegistry }, { userId: 'u1', conversationId: 'c1' });
    expect(turn.reply).toMatch(/live status/i);
    expect(turn.executedTools).toHaveLength(0);
  });

  it('unknown tool name in plan is REJECTED (never executed)', async () => {
    const harness = createHarness();
    const plan = NO_TRAIN();
    plan.toolPlan = [{ tool: 'SEARCH_TRAINS', args: {} }, { tool: 'CALL_API', args: { url: 'https://evil' } }] as never;
    const turn = await runSemanticOrchestrator(planResult(plan), freshContext(), { registry: harness.toolRegistry }, { userId: 'u1', conversationId: 'c1' });
    // CALL_API is dropped by the parse/allowlist, so only SEARCH_TRAINS executes.
    expect(turn.executedTools).toContain('SEARCH_TRAINS');
    expect(turn.executedTools).not.toContain('CALL_API');
  });
});

describe('nluToSemanticPlan', () => {
  it('maps SEARCH_TRAIN intent to SEARCH_TRAINS with extracted slots', async () => {
    const { nluToSemanticPlan } = await import('../../api/ai/semantic-planner.js');
    const u = emptyUnderstanding();
    u.intent = 'SEARCH_TRAIN';
    u.slots.originQuery = 'ASR'; u.slots.destinationQuery = 'LDH'; u.slots.dateText = 'kal';
    const plan = nluToSemanticPlan(u, 'kal ASR se LDH');
    expect(plan.toolPlan[0]?.tool).toBe('SEARCH_TRAINS');
    expect(plan.entities.origin).toBe('ASR');
    expect(plan.entities.destination).toBe('LDH');
    expect(plan.entities.date).toBe('kal');
  });

  it('maps LIVE_TRAIN_STATUS to TRACK_TRAIN', async () => {
    const { nluToSemanticPlan } = await import('../../api/ai/semantic-planner.js');
    const u = emptyUnderstanding();
    u.intent = 'LIVE_TRAIN_STATUS';
    u.slots.trainNumber = '12014';
    const plan = nluToSemanticPlan(u, '12014 ka live status');
    expect(plan.toolPlan[0]?.tool).toBe('TRACK_TRAIN');
  });
});

// keep some shared imports referenced to avoid unused warnings
void ASR; void NDLS; void makeSearchResults; void setSearchResults;

import { snapshotSemanticPlan } from '../../api/ai/semantic-orchestrator.js';

describe('station disambiguation (multi-station names produce a choice, never an auto-pick)', () => {
  // "Delhi" matches >1 station in the harness index (NDLS/DLI/NZM) → ambiguous.
  const ROUTE_WITH_AMBIGUOUS = (): SemanticPlan => ({
    intent: 'search trains',
    confidence: 0.9,
    entities: { origin: 'Delhi', destination: 'LDH', trainNumbers: [], trainName: null, date: isoPlusDays(1), travelClass: null, passengers: null, pnr: null },
    toolPlan: [{ tool: 'SEARCH_TRAINS', args: { originCode: 'Delhi', destinationCode: 'LDH', journeyDate: isoPlusDays(1) } }],
    comparison: null,
    needsClarification: false,
    missingFields: [],
    clarificationQuestion: null,
  });

  it('ambiguous station → returns a choice question, executes NOTHING, and snapshots the plan', async () => {
    const harness = createHarness();
    const context = freshContext();
    const result = planResult(ROUTE_WITH_AMBIGUOUS());
    const turn = await runSemanticOrchestrator(result, context, { registry: harness.toolRegistry, now: () => new Date('2026-08-26T10:00:00.000Z') }, { userId: 'u1', conversationId: 'c1' });
    expect(turn.executedTools).toHaveLength(0);
    expect(turn.reply).toMatch(/multiple stations/i);
    expect(turn.reply).toMatch(/choose/i);
    expect(turn.context.stationChoices).not.toBeNull();
    expect(turn.context.stationChoices?.field).toBe('origin');
    expect(turn.context.pendingSemanticPlan).not.toBeNull();
    // origin/destination NOT silently filled
    expect(turn.context.origin).toBeNull();
  });

  it('resume after a station choice patches origin and executes the real search', async () => {
    const harness = createHarness();
    const context = freshContext();
    const result = planResult(ROUTE_WITH_AMBIGUOUS());
    let next = (await runSemanticOrchestrator(result, context, { registry: harness.toolRegistry, now: () => new Date('2026-08-26T10:00:00.000Z') }, { userId: 'u1', conversationId: 'c1' })).context;
    expect(next.stationChoices?.field).toBe('origin');
    // User picks "New Delhi" (the NDLS code) on the next turn.
    const resume = await runSemanticOrchestrator(planResult(result.plan!), next, { registry: harness.toolRegistry, now: () => new Date('2026-08-26T10:00:00.000Z'), message: 'NDLS' }, { userId: 'u1', conversationId: 'c1' });
    expect(resume.executedTools).toContain('SEARCH_TRAINS');
    expect(resume.context.origin?.code).toBe('NDLS');
    expect(resume.context.destination?.code).toBe('LDH');
    expect(resume.diagnostics.realData).toBe(true);
    // Plan snapshot is cleared after a successful resume.
    expect(resume.context.pendingSemanticPlan).toBeNull();
  });

  it('unmatched station choice → re-asks, does not execute', async () => {
    const harness = createHarness();
    const context = freshContext();
    const result = planResult(ROUTE_WITH_AMBIGUOUS());
    const pending = (await runSemanticOrchestrator(result, context, { registry: harness.toolRegistry, now: () => new Date('2026-08-26T10:00:00.000Z') }, { userId: 'u1', conversationId: 'c1' })).context;
    const resume = await runSemanticOrchestrator(planResult(result.plan!), pending, { registry: harness.toolRegistry, now: () => new Date('2026-08-26T10:00:00.000Z'), message: 'xyz-unknown' }, { userId: 'u1', conversationId: 'c1' });
    expect(resume.executedTools).toHaveLength(0);
    expect(resume.reply).toMatch(/Samajh nahi aaya/i);
    expect(resume.context.stationChoices).not.toBeNull();
  });

  it('snapshotSemanticPlan round-trips to restoreSemanticPlan', async () => {
    const result = planResult(ROUTE_WITH_AMBIGUOUS());
    const restored = (await import('../../api/ai/semantic-orchestrator.js')).restoreSemanticPlan(snapshotSemanticPlan(result));
    expect(restored?.source).toBe('ai_primary');
    expect(restored?.plan?.toolPlan[0]?.tool).toBe('SEARCH_TRAINS');
  });
});
