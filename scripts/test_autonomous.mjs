// Quick sanity test of the autonomous engine (no API keys needed).
// Runs directly against tsx so no compiled build required.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Dynamic import via tsx (already a dev dep).
const { understandAutonomously, normalizeMessage } = await import('../ai/autonomous/index.ts');
const { generateReply } = await import('../ai/autonomous/index.ts');
const { createConversationContext } = await import('../shared/context.ts');

function freshContext() {
  return createConversationContext({ id: 'test-cid', userId: 'guest' });
}

const tests = [
  // Greetings / meta
  ['Hi', 'GREETING'],
  ['namaste', 'GREETING'],
  ['hello ji', 'GREETING'],
  ['thanks', 'THANKS'],
  ['shukriya', 'THANKS'],
  ['bye alvida', 'FAREWELL'],
  ['help chahiye', 'HELP'],
  ['rukko thoda', 'HOLD_PAUSE'],
  ['start over karo', 'START_OVER'],
  ['kya kar sakte ho', 'HELP'],
  // Off-topic
  ['aaj mausam kaisa hai', 'NORMAL_CHAT'],
  ['cricket score batao', 'NORMAL_CHAT'],
  // Railway intents
  ['amritsar se ludhiana jana hai', 'BOOK_TRAIN'],
  ['delhi to mumbai trains dikhao', 'SEARCH_TRAIN'],
  ['mujhe kal ki train chahiye', 'BOOK_TRAIN'],
  ['12014 ka live status', 'LIVE_TRAIN_STATUS'],
  ['14542 kitni late hai', 'LIVE_TRAIN_STATUS'],
  ['12013 ka fare kitna hai', 'GET_FARE'],
  ['SL mein seat available hai?', 'GET_AVAILABILITY'],
  ['mera pnr 2345678901 check karo', 'CHECK_PNR'],
  ['12014 ka timetable', 'GET_TIMETABLE'],
  ['cc kya hota hai', 'GENERAL_RAILWAY_QUERY'],
  ['tatkal kab khulta hai', 'GENERAL_RAILWAY_QUERY'],
  ['ludhiana ka station code kya hai', 'LOOKUP_STATION'],
  ['12014 aur 14542 kaunsi tez hai', 'COMPARE_TRAINS'],
  ['meri wallet balance dikhao', 'VIEW_WALLET'],
  ['aaj ki cancelled trains', 'GET_CANCELLED_TRAINS'],
  ['platform number batao', 'PLATFORM_INQUIRY'],
  ['refund kab aayega', 'CHECK_REFUND'],
  // Corrections
  ['nahi amritsar nahi jalandhar', 'CORRECTION'],
  // Affirmation
  ['haan', 'AFFIRMATION'],
  ['nahi', 'NEGATION'],
  // Hindi
  ['अमृतसर से लुधियाना जाना है', 'BOOK_TRAIN'],
  ['१२०१४ का लाइव स्टेटस', 'LIVE_TRAIN_STATUS'],
];

let pass = 0;
let fail = 0;
for (const [msg, expected] of tests) {
  const ctx = freshContext();
  const u = understandAutonomously(msg, ctx);
  const ok = u.primaryIntent === expected || u.candidates[0]?.intent === expected;
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log(`  ✗ "${msg}"\n     expected: ${expected}\n     got: ${u.primaryIntent} (candidates: ${u.candidates.slice(0,3).map(c=>c.intent).join(', ')})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed out of ${tests.length}`);

// Also test normalization
console.log('\nNormalization samples:');
console.log('  "अमृतसर से लुधियाना" →', normalizeMessage('अमृतसर से लुधियाना'));
console.log('  "Ludhiyana se Dehi" →', normalizeMessage('Ludhiyana se Dehi'));
console.log('  "pls avblty chk" →', normalizeMessage('pls avblty chk'));

// Test reply generation for greetings
const greetingCtx = freshContext();
const greetingU = understandAutonomously('namaste', greetingCtx);
const reply = generateReply({ understanding: greetingU, context: greetingCtx });
console.log('\nGreeting reply sample:', reply.text.slice(0, 150), '...');
