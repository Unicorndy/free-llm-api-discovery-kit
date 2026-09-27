// Drives a visible Chromium window with Playwright. The person signs in and
// clicks the final buttons themselves; this module opens pages, highlights
// what to click, and watches the page for newly created API keys.
import path from 'node:path';
import { rm } from 'node:fs/promises';

export const PROFILE_DIR = path.resolve(process.cwd(), '.browser-profile');
let context = null;

async function getContext() {
  if (context) return context;
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright is not installed. Run "npm install" and "npx playwright install chromium"');
  }
  // A persistent profile keeps sign-ins between steps; the assistant offers to delete it at the end.
  context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null });
  context.on('close', () => { context = null; });
  return context;
}

export async function openPage(url) {
  const ctx = await getContext();
  let page = ctx.pages().find((p) => !p.isClosed());
  if (!page) page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  return page;
}

// Outline the first matching button or link in yellow so the person knows where to click.
export async function highlight(page, names) {
  for (const name of names) {
    try {
      const loc = page.getByRole('button', { name }).or(page.getByRole('link', { name })).first();
      if (await loc.count()) {
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
        await loc.evaluate((el) => {
          el.style.outline = '4px solid #F6D96B';
          el.style.outlineOffset = '3px';
          el.style.boxShadow = '0 0 0 10px rgba(246, 217, 107, 0.35)';
        });
        return true;
      }
    } catch { /* page changed; try the next name */ }
  }
  return false;
}

// Look through every open tab for text matching the key pattern (page text and form fields).
export async function scanForSecrets(pattern) {
  if (!context || !pattern) return [];
  const found = new Set();
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    try {
      const matches = await page.evaluate((source) => {
        const re = new RegExp(source, 'g');
        const chunks = [document.body ? document.body.innerText : ''];
        for (const el of document.querySelectorAll('input, textarea')) chunks.push(el.value || '');
        return chunks.flatMap((c) => c.match(re) || []);
      }, pattern.source);
      matches.forEach((m) => found.add(m));
    } catch { /* page navigating; try again next poll */ }
  }
  return [...found];
}

export async function closeBrowser() {
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
}

export async function deleteProfile() {
  await closeBrowser();
  await rm(PROFILE_DIR, { recursive: true, force: true });
}
