/**
 * AUTONOMOUS AI HANDOVER MODULE — public API.
 *
 * Usage:
 *   import { handleAutonomously } from '../ai/autonomous/index.js';
 *   const result = await handleAutonomously({ message, conversationId, context }, { registry });
 *   // result.reply, result.context, result.executedTools, result.diagnostics...
 */

export { handleAutonomously } from './AutonomousHandler.js';
export type { AutonomousHandlerInput, AutonomousHandlerOutput } from './AutonomousHandler.js';
export { understandAutonomously, normalizeMessage } from './AutonomousIntentEngine.js';
export type {
  AutonomousUnderstanding,
  AutonomousIntent,
  ConversationTone,
  ExtractedEntity,
  MissingSlot,
} from './AutonomousIntentEngine.js';
export { generateReply } from './AutonomousReplyGenerator.js';
export type { ReplyInput, ReplyOutput } from './AutonomousReplyGenerator.js';
