/**
 * Production build helper: copies the static frontend shell from /app into
 * dist/public so the compiled API server can serve it without the source tree.
 */
import { cpSync } from 'node:fs';

const source = new URL('../app', import.meta.url);
const destination = new URL('../dist/public', import.meta.url);

cpSync(source, destination, { recursive: true });
console.log('[bookkaro-build] copied app/ -> dist/public');
