// Browser use — headless browser automation (spec §1.7: "the same browser
// use … like Muse"). Playwright (free, MIT/Apache) drives a headless
// Chromium. The module is OPTIONAL and degrades gracefully: if the
// Playwright package or the browser binary is missing, capability()
// reports exactly what is missing and actions throw a clear error —
// nothing crashes, nothing is faked.
// Rules (deny-first, same as tools.js):
//   - goto: https only, no private/local IPs (same rule as web_fetch).
//   - click/type: CSS selector, length-capped, no credential fields —
//     typing into a password field is refused (selector + input type are
//     checked before typing).
//   - NO submit/post/send action exists. The agent can fill and screenshot;
//     a human submits. Form submission that sends data needs the approvals
//     flow, and approving still does not submit it.
//   - Every action is audit-logged. Screenshots stay in memory.
// The browser runs headless, loopback-only, one page at a time; close()
// always runs (finally) so no zombie browser is left behind.
'use strict';
const { audit } = require('./tools');
const { assertNotFrozen } = require('./freeze');

function privateHost(hostname) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(hostname);
}

function validateUrl(url) {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new Error('browser goto requires an https URL');
  const u = new URL(url);
  if (privateHost(u.hostname)) throw new Error('denied: private/local URL');
  return url;
}

function validateSelector(selector) {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 500) throw new Error('selector required, max 500 chars');
  return selector;
}

const BROWSER_ACTIONS = new Set(['goto', 'click', 'type', 'screenshot', 'text', 'wait', 'title', 'back', 'forward', 'snapshot', 'click_ref', 'type_ref', 'find_text', 'click_text']);

function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('browser action must be an object');
  if (!BROWSER_ACTIONS.has(action.action)) throw new Error(`unknown browser action: ${String(action.action)} — no submit/post/send action exists by design`);
  const out = { action: action.action };
  if (action.action === 'goto') out.url = validateUrl(action.url);
  if (action.action === 'click' || action.action === 'type') out.selector = validateSelector(action.selector);
  if (action.action === 'type') {
    if (typeof action.text !== 'string' || action.text.length === 0 || action.text.length > 4000) throw new Error('type needs text, 1..4000 chars');
    if (action.sensitive) throw new Error('denied: sensitive text (credentials, OTPs) is never typed in the browser');
    out.text = action.text;
  }
  if (action.action === 'wait') {
    const ms = action.ms === undefined ? 1000 : action.ms;
    if (!Number.isInteger(ms) || ms < 0 || ms > 30000) throw new Error('wait ms must be an integer 0..30000');
    out.ms = ms;
  }
  // Element-first actions (deterministic layer): snapshot the page into
  // numbered entries with stable selectors, then act by reference. A stale
  // reference (page changed, element gone) fails instead of acting on the
  // wrong element. This is the primary browser path; screenshots + vision
  // are the fallback for canvas/custom widgets.
  if (action.action === 'click_ref' || action.action === 'type_ref') {
    if (!Number.isInteger(action.index) || action.index < 0 || action.index > 10000) throw new Error(`${action.action} needs an integer index >= 0 from a snapshot`);
    out.index = action.index;
  }
  if (action.action === 'type_ref') {
    if (typeof action.text !== 'string' || action.text.length === 0 || action.text.length > 4000) throw new Error('type_ref needs text, 1..4000 chars');
    if (action.sensitive) throw new Error('denied: sensitive text (credentials, OTPs) is never typed in the browser');
    out.text = action.text;
  }
  if (action.action === 'find_text' || action.action === 'click_text') {
    if (typeof action.text !== 'string' || action.text.length === 0 || action.text.length > 500) throw new Error(`${action.action} needs text, 1..500 chars`);
    out.text = action.text;
  }
  return out;
}

// Strip credentials from any error text before it is thrown or logged —
// proxy URLs in env carry a password, and it must never reach a log, an
// API response, or the audit table.
function sanitizeErrorText(s) {
  return String(s || '').replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@');
}

// Best-effort current URL: the live page's url() when available, else the
// last URL the agent navigated to. Never throws.
function pageUrl(page, agent) {
  try {
    if (page && typeof page.url === 'function') {
      const u = page.url();
      if (u) return u;
    }
  } catch {}
  return agent ? agent.currentUrl : null;
}

function launchOptions() {
  const opts = { headless: true, args: ['--no-sandbox'] };
  // Honour the standard proxy env vars (this VM's egress proxy, corporate
  // proxies on the laptop). Read at launch time, never logged.
  const proxyServer = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (proxyServer) {
    opts.proxy = { server: proxyServer };
    if (process.env.NO_PROXY) opts.proxy.bypass = process.env.NO_PROXY;
  }
  return opts;
}

function capability() {
  let pw = null;
  try { pw = require('playwright'); } catch { /* not installed */ }
  if (!pw) return { available: false, package: false, executable: false, reason: 'playwright package not installed — run: npm install playwright && npx playwright install chromium' };
  let exe = null;
  try { exe = pw.chromium.executablePath(); } catch (e) { return { available: false, package: true, executable: false, reason: `browser binary not installed: ${String(e.message).slice(0, 200)} — run: npx playwright install chromium` }; }
  const fs = require('fs');
  if (!exe || !fs.existsSync(exe)) return { available: false, package: true, executable: false, reason: 'browser binary not found at the Playwright path — run: npx playwright install chromium' };
  return { available: true, package: true, executable: true, executablePath: exe, reason: null };
}

// Runs INSIDE the page (passed to page.evaluate). Builds a numbered
// outline of interactive elements with a stable CSS selector each, so the
// agent can act by reference instead of guessing coordinates. Invisible
// and duplicate elements are skipped; capped at 200 entries.
function snapshotDom() {
  const out = [];
  const seen = new Set();
  function selectorFor(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let seg = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = parent;
    }
    return parts.join(' > ');
  }
  function nameOf(el) {
    return (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.tagName || '')
      .trim().replace(/\s+/g, ' ').slice(0, 80);
  }
  const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], h1, h2, h3');
  for (const el of els) {
    if (out.length >= 200) break;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const sel = selectorFor(el);
    if (seen.has(sel)) continue;
    seen.add(sel);
    out.push({ role: el.getAttribute('role') || el.tagName.toLowerCase(), name: nameOf(el), selector: sel });
  }
  return out;
}

// BrowserAgent — driver injectable for tests (a fake page object with the
// same methods). The real driver is a Playwright page.
class BrowserAgent {
  constructor({ driver, launch } = {}) {
    this.driver = driver || null; // injected page-like object (tests)
    this.launch = launch || null; // injected launch fn (tests)
    this.browser = null;
    this.page = null;
    this.currentUrl = null;
    this.lastSnapshot = null; // { url, entries, at } — element refs live here
  }

  async ensurePage() {
    if (this.page) return this.page;
    if (this.driver) { this.page = this.driver; return this.page; }
    const cap = capability();
    if (!cap.available) throw new Error(`browser unavailable: ${cap.reason}`);
    const { chromium } = require('playwright');
    const launch = this.launch || ((opts) => chromium.launch(opts));
    try {
      this.browser = await launch(launchOptions());
    } catch (e) {
      throw new Error(`browser launch failed: ${sanitizeErrorText(e.message).slice(0, 300)}`);
    }
    this.page = await this.browser.newPage();
    return this.page;
  }

  async act(action) {
    assertNotFrozen();
    const a = validateAction(action);
    const page = await this.ensurePage();
    let result;
    if (a.action === 'goto') {
      await page.goto(a.url, { timeout: 30000 });
      this.currentUrl = a.url;
      result = { ok: true, url: a.url };
    } else if (a.action === 'click') {
      await page.click(a.selector, { timeout: 10000 });
      result = { ok: true, selector: a.selector };
    } else if (a.action === 'type') {
      // Refuse password fields: check the input type before typing.
      const inputType = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? String(el.getAttribute('type') || el.tagName).toLowerCase() : null;
      }, a.selector).catch(() => null);
      if (inputType === 'password') throw new Error('denied: refusing to type into a password field — sign-ins are the user\'s own act');
      await page.fill(a.selector, a.text, { timeout: 10000 });
      result = { ok: true, selector: a.selector };
    } else if (a.action === 'screenshot') {
      const buf = await page.screenshot({ type: 'png' });
      result = { ok: true, imageBase64: Buffer.from(buf).toString('base64'), mimeType: 'image/png' };
    } else if (a.action === 'text') {
      const text = await page.evaluate(() => document.body ? document.body.innerText : '');
      result = { ok: true, text: String(text || '').slice(0, 5000) };
    } else if (a.action === 'wait') {
      await page.waitForTimeout(a.ms);
      result = { ok: true, ms: a.ms };
    } else if (a.action === 'title') {
      result = { ok: true, title: await page.title() };
    } else if (a.action === 'back') {
      await page.goBack({ timeout: 15000 }).catch(() => {});
      result = { ok: true, url: pageUrl(page, this) };
    } else if (a.action === 'forward') {
      await page.goForward({ timeout: 15000 }).catch(() => {});
      result = { ok: true, url: pageUrl(page, this) };
    } else if (a.action === 'snapshot') {
      const entries = await page.evaluate(snapshotDom);
      const list = (Array.isArray(entries) ? entries : []).slice(0, 200).map((e, i) => ({
        index: i, role: String(e?.role || ''), name: String(e?.name || '').slice(0, 80), selector: String(e?.selector || '').slice(0, 500),
      }));
      this.lastSnapshot = { url: pageUrl(page, this), entries: list, at: Date.now() };
      result = { ok: true, url: this.lastSnapshot.url, entries: list };
    } else if (a.action === 'click_ref' || a.action === 'type_ref') {
      const entry = this.resolveRef(a.index, page);
      // Re-verify the element still exists and is visible before acting —
      // a stale ref fails instead of clicking the wrong thing.
      const state = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return 'missing';
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if ((r.width === 0 && r.height === 0) || s.visibility === 'hidden' || s.display === 'none') return 'hidden';
        return String(el.getAttribute('type') || el.tagName).toLowerCase();
      }, entry.selector).catch(() => 'missing');
      if (state === 'missing' || state === 'hidden') throw new Error(`stale snapshot reference #${a.index} (${state}) — take a fresh snapshot`);
      if (a.action === 'click_ref') {
        await page.click(entry.selector, { timeout: 10000 });
        result = { ok: true, index: a.index, selector: entry.selector };
      } else {
        if (state === 'password') throw new Error('denied: refusing to type into a password field — sign-ins are the user\'s own act');
        await page.fill(entry.selector, a.text, { timeout: 10000 });
        result = { ok: true, index: a.index, selector: entry.selector };
      }
    } else if (a.action === 'find_text') {
      const count = await page.getByText(a.text).count();
      if (count > 0) await page.getByText(a.text).first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      result = { ok: true, text: a.text, count, found: count > 0 };
    } else if (a.action === 'click_text') {
      const count = await page.getByText(a.text).count();
      if (count === 0) throw new Error(`text not found on page: ${a.text.slice(0, 100)}`);
      if (count > 1) throw new Error(`ambiguous: ${count} matches for "${a.text.slice(0, 100)}" — take a snapshot and use click_ref`);
      await page.getByText(a.text).first().click({ timeout: 10000 });
      result = { ok: true, text: a.text };
    }
    audit('browser.' + a.action, { action: a.action, url: this.currentUrl, selector: a.selector, index: a.index }, true, 'browser ok');
    return result;
  }

  // Resolve a snapshot index to its entry. Fails when there is no snapshot
  // or the page has navigated since the snapshot was taken.
  resolveRef(index, page) {
    if (!this.lastSnapshot) throw new Error('no snapshot — run the snapshot action first, then act by reference');
    const now = pageUrl(page, this);
    if (this.lastSnapshot.url && now && this.lastSnapshot.url !== now) {
      throw new Error('page changed since the snapshot — take a fresh snapshot');
    }
    const entry = this.lastSnapshot.entries[index];
    if (!entry) throw new Error(`snapshot has no index ${index} (0..${this.lastSnapshot.entries.length - 1})`);
    return entry;
  }

  async close() {
    try { if (this.page && !this.driver) await this.page.close().catch(() => {}); } finally {
      try { if (this.browser) await this.browser.close().catch(() => {}); } finally {
        this.page = null; this.browser = null;
      }
    }
  }
}

module.exports = { BrowserAgent, capability, validateAction, validateUrl, BROWSER_ACTIONS };
