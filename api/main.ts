/** Server entrypoint. PORT is not a secret; secrets are only read via api/config.ts. */

import { APP_NAME, APP_VERSION, describeSecretState } from './config.js';
import { createBookKaroServer } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

const server = createBookKaroServer();

server.listen(port, '0.0.0.0', () => {
  console.log(`[${APP_NAME} v${APP_VERSION}] Step 1 foundation server on http://0.0.0.0:${port}`);
  console.log(`[${APP_NAME}] Secrets configured (values never logged):`, JSON.stringify(describeSecretState()));
  console.log(`[${APP_NAME}] Status: AI=NOT_IMPLEMENTED Railway=STEP2_PROVIDER_LAYER Booking=NOT_IMPLEMENTED Wallet=NOT_IMPLEMENTED`);
});

export { server };
