import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RAILWAY_FACT_SAFETY_RULES } from '../shared/index.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function collectSourceFiles(dir: string, extension: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full, extension));
    else if (entry.name.endsWith(extension)) out.push(full);
  }
  return out;
}

describe('architectural boundary: frontend purity (every page)', () => {
  const pages = ['app/index.html', 'app/chat.html', 'app/privacy.html', 'app/terms.html'].map((rel) => join(projectRoot, rel));

  it('all UI pages exist', () => {
    for (const page of pages) expect(existsSync(page), page).toBe(true);
  });

  it('every page makes ZERO railway API calls (only relative /api routes of this app)', () => {
    const allTargets: string[] = [];
    const combined: string[] = [];
    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      combined.push(html);
      const fetchTargets = [...html.matchAll(/fetch\(\s*'([^']+)'\)/g)].map((match) => match[1] ?? '');
      for (const target of fetchTargets) {
        expect(target.startsWith('/api/'), `${page} must only call relative /api routes (got ${target})`).toBe(true);
      }
      allTargets.push(...fetchTargets);

      // No direct provider hosts, no CDN scripts, no external URLs at all.
      expect(html, `${page} external URL`).not.toMatch(/https?:\/\//);
      for (const forbidden of ['railcore', 'railkit', 'railwayapi', 'indianrail', 'erail', 'ixigo', 'confirmkit']) {
        expect(html.toLowerCase(), `${page} forbidden word ${forbidden}`).not.toContain(forbidden);
      }
    }
    // At least one page must talk to this app's OWN chat endpoint (relative, never absolute).
    const anyApi = allTargets.length > 0 || combined.join('\n').includes("'/api/chat'");
    expect(anyApi, 'chat endpoint referenced relatively on some page').toBe(true);
  });
});

describe('architectural boundary: AI layer purity', () => {
  const aiFiles = collectSourceFiles(join(projectRoot, 'ai'), '.ts');

  it('has AI source files to check', () => {
    expect(aiFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('AI code never imports wallet or booking execution code', () => {
    for (const file of aiFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${file} must not import wallet/booking modules`).not.toMatch(
        /from\s+'[^']*\b(wallet|booking)\b[^']*'/,
      );
    }
  });

  it('AI code contains no money-moving logic', () => {
    for (const file of aiFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${file} must not reference debits`).not.toMatch(/\bdebit\b/i);
      expect(content, `${file} must not execute bookings`).not.toMatch(/executeBooking|confirmBooking\(/);
    }
  });

  it('AI code makes no direct provider calls and reads no secrets', () => {
    for (const file of aiFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${file} must not use process.env`).not.toMatch(/process\.env/);
      expect(content, `${file} must not call railway providers`).not.toMatch(/from\s+'[^']*railway\//);
    }
  });
});

describe('architectural boundary: fact safety is documented and enforced', () => {
  it('the never-invent rules are explicit', () => {
    expect(RAILWAY_FACT_SAFETY_RULES.join(' ')).toMatch(/never invent/i);
    expect(RAILWAY_FACT_SAFETY_RULES.join(' ')).toMatch(/fares/i);
    expect(RAILWAY_FACT_SAFETY_RULES.join(' ')).toMatch(/PNR/i);
  });
});
