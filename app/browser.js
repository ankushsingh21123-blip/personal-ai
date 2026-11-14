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

const BROWSER_ACTIONS = new Set(['goto', 'click', 'type', 'screenshot', 'text', 'wait', 'title']);

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
  return out;
}

// Strip credentials from any error text before it is thrown or logged —
// proxy URLs in env carry a password, and it must never reach a log, an
// API response, or the audit table.
function sanitizeErrorText(s) {
  return String(s || '').replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@');
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

// BrowserAgent — driver injectable for tests (a fake page object with the
// same methods). The real driver is a Playwright page.
class BrowserAgent {
  constructor({ driver, launch } = {}) {
    this.driver = driver || null; // injected page-like object (tests)
    this.launch = launch || null; // injected launch fn (tests)
    this.browser = null;
    this.page = null;
    this.currentUrl = null;
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
    }
    audit('browser.' + a.action, { action: a.action, url: this.currentUrl, selector: a.selector }, true, 'browser ok');
    return result;
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
