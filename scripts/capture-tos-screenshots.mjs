#!/usr/bin/env node
// Capture full-page screenshots of the eSewa & Khalti ToS / Privacy pages
// for the README compliance section. Re-run when the source pages change.
//
//   node scripts/capture-tos-screenshots.mjs
//
// Output: docs/compliance/<slug>-<YYYY-MM-DD>.png
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'docs', 'compliance');

const PAGES = [
  { slug: 'esewa-terms',           url: 'https://blog.esewa.com.np/terms-and-conditions' },
  { slug: 'esewa-privacy',         url: 'https://blog.esewa.com.np/privacy-policy' },
  { slug: 'khalti-terms',          url: 'https://khalti.com/info/terms/' },
  { slug: 'khalti-privacy',        url: 'https://khalti.com/info/privacy-policy/' },
];

const today = new Date().toISOString().slice(0, 10);

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const manifest = [];

// Slow-scroll the entire page to fire intersection observers / scroll-triggered
// reveals (eSewa's blog hides .post-content with `visibility: hidden` until the
// content scrolls into view), then return to the top before full-page capture.
async function autoScrollAndReveal(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const step = 400;
      let y = 0;
      const tick = setInterval(() => {
        window.scrollTo(0, y);
        y += step;
        if (y >= document.body.scrollHeight) {
          clearInterval(tick);
          resolve();
        }
      }, 100);
    });
    // Force-reveal anything still hidden by reveal-on-scroll CSS.
    document.querySelectorAll('[style*="visibility"], .post-content, .reveal, .fade-in')
      .forEach((el) => {
        el.style.visibility = 'visible';
        el.style.opacity = '1';
      });
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
}

for (const { slug, url } of PAGES) {
  const page = await ctx.newPage();
  console.log(`→ ${url}`);
  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(1500); // let lazy content settle
  await autoScrollAndReveal(page);
  const file = `${slug}-${today}.png`;
  const path = join(OUT_DIR, file);
  await page.screenshot({ path, fullPage: true });
  manifest.push({
    slug,
    url,
    file,
    capturedAt: new Date().toISOString(),
    httpStatus: resp?.status() ?? null,
    finalUrl: page.url(),
  });
  await page.close();
  console.log(`  saved ${file}`);
}

writeFileSync(
  join(OUT_DIR, `manifest-${today}.json`),
  JSON.stringify(manifest, null, 2) + '\n',
);

await browser.close();
console.log(`\nDone. ${manifest.length} screenshots + manifest in docs/compliance/`);
