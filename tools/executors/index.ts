/**
 * Production tool wiring: Step-1 definitions + Step-3 executors.
 * confirmBooking stays executor-less and NOT_IMPLEMENTED (protected).
 */

import type { ToolName } from '../../shared/index.js';
import { ValidationError } from '../../shared/index.js';
import type { RailwayProviderRouter } from '../../railway/index.js';
import { ToolRegistry } from '../registry.js';
import { TOOL_DEFINITIONS } from '../definitions.js';
import { createRailwayToolExecutors } from './railwayTools.js';
import { createApplicationToolExecutors } from './applicationTools.js';
import { createInMemoryDraftStore } from './draftStore.js';
import type { BookingDraftStore } from './draftStore.js';
import { createMockBookingExecutors, createInMemoryBookingStore } from './bookingExecution.js';
import { createKnowledgeToolExecutor } from './knowledgeTools.js';
import type { BookingStore } from './bookingExecution.js';
import { createMockWalletService } from '../../wallet/index.js';
import type { WalletService } from '../../wallet/index.js';

export interface ProductionToolOptions {
  router: RailwayProviderRouter;
  draftStore?: BookingDraftStore;
  walletService?: WalletService;
  bookingStore?: BookingStore;
}

/** Statuses flipped to IMPLEMENTED now that deterministic executors exist. */
const IMPLEMENTED_TOOLS = new Set<ToolName>([
  'lookupStation',
  'searchTrains',
  'getTrainInfo',
  'getTimetable',
  'getLiveStatus',
  'getAvailability',
  'getFare',
  'checkPNR',
  'getCancelledTrains',
  'getBookings',
  'getWallet',
  'createBookingDraft',
  'reviewFare',
  'acknowledgeBookingConfirmation',
  'executeMockBooking',
  'getRailwayKnowledge',
]);

export function createProductionToolRegistry(options: ProductionToolOptions): ToolRegistry {
  const draftStore = options.draftStore ?? createInMemoryDraftStore();
  const walletService = options.walletService ?? createMockWalletService();
  const bookingStore = options.bookingStore ?? createInMemoryBookingStore();
  const registry = new ToolRegistry();

  const railwayExecutors = createRailwayToolExecutors(options.router);
  const applicationExecutors = createApplicationToolExecutors(draftStore, options.router);
  const bookingExecutors = createMockBookingExecutors(draftStore, walletService, bookingStore);
  const knowledgeExecutors = createKnowledgeToolExecutor();
  const executors: Record<string, (input: Record<string, unknown>, ctx: never) => Promise<unknown>> = {
    ...railwayExecutors,
    ...applicationExecutors,
    ...bookingExecutors,
    ...knowledgeExecutors,
  };

  for (const definition of TOOL_DEFINITIONS) {
    const status = IMPLEMENTED_TOOLS.has(definition.name) ? 'IMPLEMENTED' : 'NOT_IMPLEMENTED';
    const executor = executors[definition.name];
    if (status === 'IMPLEMENTED' && !executor) {
      throw new ValidationError(`No executor wired for ${definition.name}`);
    }
    // compareTrains is handled conversationally from stored results for now.
    registry.register(
      { ...definition, status },
      status === 'IMPLEMENTED' && executor ? (executor as never) : null,
    );
  }

  // confirmBooking: intentionally no executor, status NOT_IMPLEMENTED, aiRequestable false.
  return registry;
}

export { createInMemoryDraftStore } from './draftStore.js';
export type { BookingDraftStore } from './draftStore.js';
export { clearStationCacheForTests } from './railwayTools.js';
