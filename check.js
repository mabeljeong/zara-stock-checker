// Zara stock checker — headless Chrome scrape + email alert on restock.
// Watches any number of products (products.json). Cross-platform (macOS / Windows /
// Linux / GitHub Actions). No API keys beyond Gmail.
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

// ---------- Config ----------
const PRODUCTS_FILE = process.env.PRODUCTS_FILE || path.join(__dirname, 'products.json');
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const LIST_ONLY = process.argv.includes('--list'); // print every size found, don't alert

const EMAIL_TO = process.env.EMAIL_TO || '';
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Single-product override (back-compat with the old PRODUCT_URL / SIZES env vars).
function loadProducts() {
  if (process.env.PRODUCT_URL) {
    return [
      {
        name: process.env.PRODUCT_NAME || process.env.PRODUCT_URL,
        url: process.env.PRODUCT_URL,
        sizes: (process.env.SIZES || 'XS,S,M').split(',').map((s) => s.trim()).filter(Boolean),
      },
    ];
  }
  const raw = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${PRODUCTS_FILE} must be a non-empty array of {name, url, sizes}`);
  }
  return raw.map((p) => ({
    name: p.name || p.url,
    url: p.url,
    sizes: (Array.isArray(p.sizes) ? p.sizes : String(p.sizes || '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean),
  }));
}

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

// Zara labels sizes inconsistently: "M", "25", "25 (US 0)", "US 0". Compare on a
// stripped form, and also against each comma/paren-separated part of the label so
// "25" matches "25 (US 0)".
const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
function sizeMatches(target, label) {
  const t = norm(target);
  if (!t) return false;
  if (norm(label) === t) return true;
  return String(label)
    .split(/[(),/|-]+/)
    .some((part) => norm(part) === t);
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

// Load one product page and return NAME -> {sku, availability} for every size on it.
async function scrapeProduct(ctx, url) {
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

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const status = resp && resp.status();
    if (status && status >= 400) {
      throw new Error(`page returned HTTP ${status} — likely bot-blocked from this IP.`);
    }
    // give the availability XHR a moment to land
    for (let i = 0; i < 20 && apiAvail.size === 0; i++) await page.waitForTimeout(1000);

    const html = await page.content();
    const htmlSizes = parseSizesFromHtml(html); // sku -> {name, availability}
    if (htmlSizes.size === 0) {
      throw new Error('could not parse any sizes from the page (layout changed?).');
    }

    // Merge: prefer live API availability, fall back to embedded HTML availability.
    // Keyed by size name so we report one status per size.
    const byName = new Map();
    for (const [sku, info] of htmlSizes) {
      const availability = apiAvail.get(sku) || info.availability;
      // if a name appears more than once (multi-color), treat in_stock if any is in stock
      const prev = byName.get(info.name);
      const inStock = availability === 'in_stock';
      if (!prev || (inStock && prev.availability !== 'in_stock')) {
        byName.set(info.name, { sku, availability });
      }
    }
    return byName;
  } finally {
    await page.close();
  }
}

// ---------- Main ----------
(async () => {
  const products = loadProducts();

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

  const now = new Date().toISOString();
  const state = loadState();
  const restocksByProduct = [];
  const failures = [];

  for (const product of products) {
    console.log(`\n[${now}] ${product.name}\n  ${product.url}`);

    let byName;
    try {
      byName = await scrapeProduct(ctx, product.url);
    } catch (e) {
      console.error(`  [fail] ${e.message}`);
      failures.push(`${product.name}: ${e.message}`);
      continue;
    }

    if (LIST_ONLY) {
      for (const [name, info] of byName) console.log(`  ${name.padEnd(12)} ${info.availability}`);
      continue;
    }

    const rows = product.sizes.map((target) => {
      let match = null;
      for (const [name, info] of byName) {
        if (!sizeMatches(target, name)) continue;
        // prefer an in-stock match if the label appears more than once
        if (!match || (info.availability === 'in_stock' && match.availability !== 'in_stock')) {
          match = { label: name, ...info };
        }
      }
      const availability = match ? match.availability : 'not_found';
      console.log(`  ${target.padEnd(6)} ${availability}${match && match.label !== target.toUpperCase() ? `  (label: ${match.label})` : ''}`);
      if (availability === 'not_found') {
        console.log(`         sizes on page: ${[...byName.keys()].join(', ') || '(none)'}`);
      }
      return { target, availability };
    });

    // Alert only on transition into in_stock (dedupe across runs via state file).
    const restocked = [];
    for (const row of rows) {
      const key = `${product.url}#${row.target.toUpperCase()}`;
      const prev = state[key];
      if (row.availability === 'in_stock' && prev !== 'in_stock') restocked.push(row);
      state[key] = row.availability;
    }
    if (restocked.length) restocksByProduct.push({ product, restocked });
  }

  await browser.close();

  if (LIST_ONLY) return;

  saveState(state);

  if (restocksByProduct.length) {
    const allSizes = restocksByProduct
      .map((r) => `${r.product.name} (${r.restocked.map((x) => x.target).join(', ')})`)
      .join('; ');
    const subject = `🎉 Zara restock: ${allSizes}`;
    const text =
      restocksByProduct
        .map(
          (r) =>
            `${r.product.name}\n` +
            r.restocked.map((x) => `  • ${x.target}`).join('\n') +
            `\n  Buy now: ${r.product.url}`
        )
        .join('\n\n') + `\n\n(Checked ${now})`;
    console.log(`\n[ALERT] Restocked: ${allSizes}`);
    await sendEmail(subject, text);
  } else {
    console.log(
      `\nNo target sizes newly in stock. Watching: ` +
        products.map((p) => `${p.name} [${p.sizes.join(', ')}]`).join(' | ')
    );
  }

  // Surface scrape failures as a non-zero exit so the Actions run goes red, but only
  // after state for the products that *did* work has been saved.
  if (failures.length) {
    console.error(`\n[fatal] ${failures.length} product(s) failed:\n  ${failures.join('\n  ')}`);
    process.exit(2);
  }
})().catch((e) => {
  console.error('[error]', e && e.message ? e.message : e);
  process.exit(1);
});
