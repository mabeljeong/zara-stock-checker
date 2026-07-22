// Zara stock checker — headless Chrome scrape + email alert on restock.
// Cross-platform (macOS / Windows / Linux / GitHub Actions). No API keys beyond Gmail.
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

// ---------- Config (override via env; sensible defaults for this jacket) ----------
const PRODUCT_URL =
  process.env.PRODUCT_URL ||
  'https://www.zara.com/us/en/faux-leather-cropped-bomber-jacket-p06318041.html?v1=495675486';
const TARGET_SIZES = (process.env.SIZES || 'XS,S,M')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');

const EMAIL_TO = process.env.EMAIL_TO || '';
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------- Helpers ----------

// Extract a balanced JSON array that starts right after `"<key>":`
function extractArraysByKey(html, key) {
  const results = [];
  const needle = `"${key}":[`;
  let from = 0;
  while (true) {
    const start = html.indexOf(needle, from);
    if (start === -1) break;
    const arrStart = start + needle.length - 1; // points at '['
    let depth = 0,
      i = arrStart,
      inStr = false,
      esc = false;
    for (; i < html.length; i++) {
      const c = html[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { i++; break; } }
    }
    const raw = html.slice(arrStart, i);
    try { results.push(JSON.parse(raw)); } catch { /* ignore partial */ }
    from = i;
  }
  return results;
}

// From the page HTML, build { sku -> {name, availability} } for all sizes found.
function parseSizesFromHtml(html) {
  const map = new Map();
  for (const arr of extractArraysByKey(html, 'sizes')) {
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      if (s && typeof s === 'object' && s.sku && s.name && s.availability) {
        map.set(String(s.sku), { name: String(s.name).toUpperCase(), availability: s.availability });
      }
    }
  }
  return map;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendEmail(subject, text) {
  if (!EMAIL_TO || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.log('[email] skipped — EMAIL_TO / GMAIL_USER / GMAIL_APP_PASSWORD not all set.');
    return;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({ from: GMAIL_USER, to: EMAIL_TO, subject, text });
  console.log(`[email] sent to ${EMAIL_TO}: ${subject}`);
}

// ---------- Main ----------
(async () => {
  // Zara's Akamai bot-check fingerprints Playwright's bundled headless-shell (=> 403),
  // but lets *real* Chrome through. Use the system Chrome channel; fall back to bundled.
  const launchArgs = ['--disable-blink-features=AutomationControlled', '--no-sandbox'];
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome', args: launchArgs });
  } catch (e) {
    console.warn('[warn] system Chrome not available, falling back to bundled Chromium:', e.message);
    browser = await chromium.launch({ headless: true, args: launchArgs });
  }
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  // Freshest signal: intercept the internal availability API (sku -> availability)
  const apiAvail = new Map();
  page.on('response', async (r) => {
    if (r.url().includes('itxrest') && r.url().includes('/availability')) {
      try {
        const j = await r.json();
        for (const s of j.skusAvailability || []) apiAvail.set(String(s.sku), s.availability);
      } catch { /* ignore */ }
    }
  });

  const resp = await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const status = resp && resp.status();
  if (status && status >= 400) {
    console.error(`[fatal] page returned HTTP ${status} — likely bot-blocked from this IP.`);
    await browser.close();
    process.exit(2);
  }
  // give the availability XHR a moment to land
  for (let i = 0; i < 20 && apiAvail.size === 0; i++) await page.waitForTimeout(1000);

  const html = await page.content();
  await browser.close();

  const htmlSizes = parseSizesFromHtml(html); // sku -> {name, availability}
  if (htmlSizes.size === 0) {
    console.error('[fatal] could not parse any sizes from the page (layout changed?).');
    process.exit(3);
  }

  // Merge: prefer live API availability, fall back to embedded HTML availability.
  // Keyed by size name so we report one status per target size.
  const byName = new Map(); // NAME -> {sku, availability}
  for (const [sku, info] of htmlSizes) {
    const availability = apiAvail.get(sku) || info.availability;
    // if a name appears more than once (multi-color), treat in_stock if any is in stock
    const prev = byName.get(info.name);
    const inStock = availability === 'in_stock';
    if (!prev || (inStock && prev.availability !== 'in_stock')) {
      byName.set(info.name, { sku, availability });
    }
  }

  const now = new Date().toISOString();
  console.log(`\n[${now}] ${PRODUCT_URL}`);
  const rows = TARGET_SIZES.map((name) => {
    const info = byName.get(name);
    const availability = info ? info.availability : 'not_found';
    console.log(`  ${name.padEnd(4)} ${availability}`);
    return { name, availability, sku: info ? info.sku : null };
  });

  // Alert only on transition into in_stock (dedupe across runs via state file).
  const state = loadState();
  const restocked = [];
  for (const row of rows) {
    const key = `${PRODUCT_URL}#${row.name}`;
    const prev = state[key];
    if (row.availability === 'in_stock' && prev !== 'in_stock') restocked.push(row);
    state[key] = row.availability;
  }
  saveState(state);

  if (restocked.length) {
    const sizesStr = restocked.map((r) => r.name).join(', ');
    const subject = `🎉 Zara restock: ${sizesStr} back in stock`;
    const text =
      `These sizes just came back in stock:\n\n` +
      restocked.map((r) => `  • ${r.name}`).join('\n') +
      `\n\nBuy now: ${PRODUCT_URL}\n\n(Checked ${now})`;
    console.log(`\n[ALERT] Restocked: ${sizesStr}`);
    await sendEmail(subject, text);
  } else {
    console.log(`\nNo target sizes newly in stock. Watching: ${TARGET_SIZES.join(', ')}`);
  }
})().catch((e) => {
  console.error('[error]', e && e.message ? e.message : e);
  process.exit(1);
});
