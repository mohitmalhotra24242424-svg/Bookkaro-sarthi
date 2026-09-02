/**
 * Public RailCore exports. The real adapter (verified endpoints, X-RailCore-Key
 * auth, normalization) lives in ./providers/railcore/ — this path is kept
 * stable for existing Step 1 imports.
 */

export {
  RailCoreProvider,
  RAILCORE_CAPABILITIES,
  RAILCORE_BASE_URL,
  RAILCORE_AUTH_HEADER,
  RAILCORE_ENDPOINTS,
  RAILCORE_ENDPOINT_STATUS,
} from './providers/railcore/index.js';
export type { RailCoreProviderOptions } from './providers/railcore/index.js';
