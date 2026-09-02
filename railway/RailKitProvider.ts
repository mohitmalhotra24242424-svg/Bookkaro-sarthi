/**
 * Public RailKit exports. The real adapter wraps the official `railkit` npm
 * SDK and lives in ./providers/railkit/ — this path is kept stable for
 * existing Step 1 imports.
 */

export {
  RailKitProvider,
  RAILKIT_CAPABILITIES,
  RAILKIT_ENDPOINT_STATUS,
} from './providers/railkit/index.js';
export type { RailKitProviderOptions, RailKitSdkLike } from './providers/railkit/index.js';
