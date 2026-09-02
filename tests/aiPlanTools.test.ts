/**
 * AI-FIRST TOOL PLANNING (§"AI primary"): the AI (semantic planner) decides which
 * tool(s)/API(s) to fetch — including MULTI-tool requests — and the deterministic
 * regex gate is only a fallback when the AI fails or yields no usable plan.
 */

import { describe, expect, it } from 'vitest';
import { createAiPlanTools, runAiOrchestrator } from '../api/ai/orchestrator.js';
import { contextWithJourney } from './orchestration/railwayQueries.helpers.js';
import type { ConversationContext } from '../shared/index.js';
import { createHarness } from './orchestration/harness.js';

/** Stub AI planner: returns a given semantic ToolPlan verbatim. */
function stubPlanner(plans: {
  toolPlan: { tool: string; args?: Record<string, unknown> }[];
  usedNlu: boolean;
}) {
  return {
    plan: async (_message: string, _context: ConversationContext) => ({
      plan: { toolPlan: plans.toolPlan } as never,
      usedNlu: plans.usedNlu,
    }),
  };
}

describe('createAiPlanTools — AI decides the tool set', () => {
  it('maps two semantic tools to catalog ids and returns a MULTI_TOOL_QUERY plan', async () => {
    const planTools = createAiPlanTools(stubPlanner({ usedNlu: false, toolPlan: [
      { tool: 'GET_FARE', args: { trainNumber: '12014' } },
      { tool: 'CHECK_AVAILABILITY', args: { trainNumber: '12014', quota: 'SL' } },
    ] }));
    const plan = await planTools('12014 ka fare aur SL availability dono batao', contextWithJourney());
    expect(plan).not.toBeNull();
    expect(plan?.intent).toBe('MULTI_TOOL_QUERY');
    expect(plan?.tools).toEqual([
      { tool: 'GET_FARE', args: { trainNumber: '12014' } },
      { tool: 'GET_AVAILABILITY', args: { trainNumber: '12014', quota: 'SL' } },
    ]);
  });

  it('returns null when the plan comes from NLU fallback (AI failed) → deterministic may decide', async () => {
    const planTools = createAiPlanTools(stubPlanner({ usedNlu: true, toolPlan: [
      { tool: 'GET_FARE', args: { trainNumber: '12014' } },
      { tool: 'CHECK_AVAILABILITY', args: { trainNumber: '12014' } },
    ] }));
    const plan = await planTools('12014 ka fare aur SL availability', contextWithJourney());
    expect(plan).toBeNull();
  });

  it('returns null for a single tool (handled by the AI-primary conversational path)', async () => {
    const planTools = createAiPlanTools(stubPlanner({ usedNlu: false, toolPlan: [
      { tool: 'CHECK_AVAILABILITY', args: { trainNumber: '12014' } },
    ] }));
    const plan = await planTools('12014 ki availability', contextWithJourney());
    expect(plan).toBeNull();
  });

  it('drops any tool mapped to a non-selectable (PROHIBITED) catalog id', async () => {
    const planTools = createAiPlanTools(stubPlanner({ usedNlu: false, toolPlan: [
      { tool: 'CHECK_AVAILABILITY', args: { trainNumber: '12014' } },
      // A non-selectable/unknown semantic id must never reach the executor.
      { tool: 'CONFIRM_BOOKING', args: {} },
    ] }));
    const plan = await planTools('12014 ki availability', contextWithJourney());
    // Only one valid tool remains → not a multi-tool plan.
    expect(plan).toBeNull();
  });

  it('returns null when the planner throws (AI failure is non-fatal)', async () => {
    const planTools = createAiPlanTools({
      plan: async () => { throw new Error('AI timeout'); },
    });
    const plan = await planTools('12014 fare aur availability', contextWithJourney());
    expect(plan).toBeNull();
  });

  it('does NOT hijack a comparison query onto the multi-tool path (stays COMPARE_TRAINS)', async () => {
    // The planner proposes two getTimetable fetches, but a comparison message must
    // NOT become MULTI_TOOL_QUERY — it belongs to the deterministic COMPARE_TRAINS.
    const planTools = createAiPlanTools(stubPlanner({ usedNlu: false, toolPlan: [
      { tool: 'GET_TIMETABLE', args: { trainNumber: '12014' } },
      { tool: 'GET_TIMETABLE', args: { trainNumber: '14542' } },
    ] }));
    expect(await planTools('12014 aur 14542 mein se kaunsi tez hai', contextWithJourney())).toBeNull();
    expect(await planTools('kaunsi better hai 12014 ya 14542', contextWithJourney())).toBeNull();
  });
});

describe('runAiOrchestrator with an injected AI planner (end-to-end)', () => {
  it('executes the AI-chosen multi-tool set through the catalog executor', async () => {
    const harness = createHarness();
    const context = contextWithJourney();

    // AI (semantic planner) decides fare + availability.
    const planTools = createAiPlanTools(stubPlanner({ usedNlu: false, toolPlan: [
      { tool: 'GET_FARE', args: { trainNumber: '12014', fromStationCode: 'ASR', toStationCode: 'LDH', journeyDate: '2026-08-27' } },
      { tool: 'CHECK_AVAILABILITY', args: { trainNumber: '12014', journeyDate: '2026-08-27', travelClass: 'SL', fromStationCode: 'ASR', toStationCode: 'LDH' } },
    ] }));

    const fareBefore = harness.countCapability('fare');
    const availBefore = harness.countCapability('availability');

    const output = await runAiOrchestrator(
      { message: '12014 ka fare aur SL availability dono batao', conversationId: context.id, context },
      { ai: harness.deps.ai, registry: harness.toolRegistry, planTools },
    );

    expect(output.intent).toBe('MULTI_TOOL_QUERY');
    expect(output.requiredTools.sort()).toEqual(['GET_AVAILABILITY', 'GET_FARE']);
    // Both tools executed exactly once through the catalog executor.
    expect(harness.countCapability('fare')).toBe(fareBefore + 1);
    expect(harness.countCapability('availability')).toBe(availBefore + 1);
    // Reply is data-backed (from the executed tools), not a clarification.
    expect(output.response).toBeTruthy();
  });

  it('falls through to the deterministic regex gate when the AI plan is unusable', async () => {
    const harness = createHarness();
    const context = contextWithJourney();

    // AI produced no usable plan (single tool / NLU) → planner returns null.
    const planTools = createAiPlanTools(stubPlanner({ usedNlu: true, toolPlan: [
      { tool: 'GET_FARE', args: { trainNumber: '12014' } },
      { tool: 'CHECK_AVAILABILITY', args: { trainNumber: '12014' } },
    ] }));

    const output = await runAiOrchestrator(
      { message: '12014 ka fare aur CC availability dono batao', conversationId: context.id, context },
      { ai: harness.deps.ai, registry: harness.toolRegistry, planTools },
    );
    // Deterministic gate still catches the multi-tool query as a fallback.
    expect(output.intent).toBe('MULTI_TOOL_QUERY');
    expect(output.requiredTools.sort()).toEqual(['GET_AVAILABILITY', 'GET_FARE']);
  });
});
