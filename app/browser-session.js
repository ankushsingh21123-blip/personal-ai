// Stateful browser sessions — FULL browser control, Muse-style (computer-use
// cycle, 18 Nov 2026). Unlike browser.js (one page, one request, then close),
// a session keeps a persistent Playwright context alive across turns: tabs,
// cookies, localStorage, console/network observation, and DOM state all
// survive between tool calls. State lives in the server process; the
// persistent profile directory survives a server restart on the same machine.
//
// Deny-first, same as browser.js:
//   - navigate: https only, no private/local IPs — unless the session was
//     created with allowLoopback (tests + the local demo script ONLY; the
//     agent tool path never sets it).
//   - Typing into a password field is REFUSED outright (sign-ins are the
//     user's own act). Credential/OTP/admin automation stays non-negotiable.
//   - submit, set_files (upload) and downloads REQUIRE an approved approval
//     record — checked against the approvals table, never trusted from args.
//   - Every mutating action runs a DOM CHECK afterwards: the caller may pass
//     `expect` assertions, and every action reports a pre/post state digest
//     (url/title/text-hash) so "it changed" is evidence, never a claim.
//   - Every action is audit-logged. Downloads without an approved expectation
//     are deleted, never kept. Screenshots stay in memory (base64 in the
//     result) unless the caller stores them via the replay log.
// Console/network observation is capped ring buffers (100 entries each);
// URLs in network entries are credential-redacted and length-capped.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { audit, safePath, WORKSPACE } = require('./tools');
const { assertNotFrozen } = require('./freeze');
const { validateUrl, capability } = require('./browser');

const MAX_TABS = 10;
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const OBSERVE_CAP = 100;

const SESSION_ACTIONS = new Set([
  'navigate', 'back', 'forward', 'reload',
  'new_tab', 'switch_tab', 'close_tab', 'list_tabs',
  'snapshot', 'a11y', 'dom', 'text', 'title', 'url',
  'click', 'type', 'select', 'check', 'set_files', 'submit',
  'scroll', 'wait', 'screenshot', 'zoom', 'dom_check', 'observe', 'close',
]);
const MUTATING = new Set(['navigate', 'back', 'forward', 'reload', 'new_tab', 'switch_tab', 'close_tab',
  'click', 'type', 'select', 'check', 'set_files', 'submit', 'scroll']);
const CHECK_TYPES = new Set(['text_present', 'text_absent', 'selector_count', 'value_equals',
  'attribute_equals', 'url_matches', 'title_contains', 'checked', 'visible']);

function sanitizeText(s) {
  return String(s || '').replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@');
}

function validateSessionId(id) {
  if (id === undefined || id === null) return 'default';
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('session id must be 1..64 chars, letters/digits/_/- only');
  return id;
}

function validateSelector(selector) {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 500) throw new Error('selector required, max 500 chars');
  return selector;
}

function validateChecks(checks) {
  if (checks === undefined) return [];
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 20) throw new Error('expect/checks must be an array of 1..20 checks');
  return checks.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`check #${i} must be an object`);
    if (!CHECK_TYPES.has(c.type)) throw new Error(`check #${i}: unknown type ${String(c.type)}`);
    const out = { type: c.type };
    if (c.type === 'text_present' || c.type === 'text_absent' || c.type === 'title_contains') {
      if (typeof c.text !== 'string' || !c.text || c.text.length > 500) throw new Error(`check #${i} needs text, 1..500 chars`);
      out.text = c.text;
    }
    if (c.type === 'selector_count' || c.type === 'value_equals' || c.type === 'attribute_equals' || c.type === 'checked' || c.type === 'visible') {
      out.selector = validateSelector(c.selector);
    }
    if (c.type === 'selector_count') {
      if (c.count !== undefined) { if (!Number.isInteger(c.count) || c.count < 0) throw new Error(`check #${i}: count must be an integer >= 0`); out.count = c.count; }
      if (c.gte !== undefined) { if (!Number.isInteger(c.gte) || c.gte < 0) throw new Error(`check #${i}: gte must be an integer >= 0`); out.gte = c.gte; }
      if (c.lte !== undefined) { if (!Number.isInteger(c.lte) || c.lte < 0) throw new Error(`check #${i}: lte must be an integer >= 0`); out.lte = c.lte; }
      if (out.count === undefined && out.gte === undefined && out.lte === undefined) throw new Error(`check #${i}: selector_count needs count, gte, or lte`);
    }
    if (c.type === 'value_equals') {
      if (typeof c.value !== 'string' || c.value.length > 4000) throw new Error(`check #${i} needs value, max 4000 chars`);
      out.value = c.value;
    }
    if (c.type === 'attribute_equals') {
      if (typeof c.attribute !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(c.attribute)) throw new Error(`check #${i} needs a valid attribute name`);
      if (typeof c.value !== 'string' || c.value.length > 1000) throw new Error(`check #${i} needs value, max 1000 chars`);
      out.attribute = c.attribute; out.value = c.value;
    }
    if (c.type === 'url_matches') {
      if (typeof c.pattern !== 'string' || !c.pattern || c.pattern.length > 300) throw new Error(`check #${i} needs pattern, 1..300 chars`);
      try { new RegExp(c.pattern); } catch { throw new Error(`check #${i}: pattern is not a valid regular expression`); }
      out.pattern = c.pattern;
    }
    if (c.type === 'checked') {
      if (c.checked !== undefined && typeof c.checked !== 'boolean') throw new Error(`check #${i}: checked must be a boolean`);
      out.checked = c.checked !== false;
    }
    return out;
  });
}

function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('browser session action must be an object');
  if (!SESSION_ACTIONS.has(action.action)) throw new Error(`unknown browser session action: ${String(action.action)}`);
  const out = { action: action.action };
  if (action.expect !== undefined) out.expect = validateChecks(action.expect);
  if (action.action === 'navigate' || (action.action === 'new_tab' && action.url !== undefined)) {
    if (typeof action.url !== 'string' || !action.url) throw new Error('navigate/new_tab needs a url');
    out.url = action.url; // URL policy enforced in navigate() — allowLoopback is a session option
  }
  if (action.action === 'switch_tab' || action.action === 'close_tab') {
    if (!Number.isInteger(action.tab) || action.tab < 0 || action.tab >= MAX_TABS) throw new Error('tab must be an integer index 0..9');
    out.tab = action.tab;
  }
  if (action.action === 'click' || action.action === 'type' || action.action === 'select' || action.action === 'check' || action.action === 'set_files' || action.action === 'submit') {
    // Exactly one targeting mode: snapshot index, CSS selector, role+name, or visible text.
    const modes = ['index', 'selector', 'role', 'text'].filter((k) => action[k] !== undefined);
    if (modes.length !== 1) {
      throw new Error(`${action.action} needs exactly one target: index, selector, role+name, or text`);
    }
    if (action.index !== undefined) {
      if (!Number.isInteger(action.index) || action.index < 0 || action.index > 10000) throw new Error('index must be an integer >= 0 from a snapshot');
      out.index = action.index;
    }
    if (action.selector !== undefined) out.selector = validateSelector(action.selector);
    if (action.role !== undefined) {
      if (typeof action.role !== 'string' || !/^[a-z]+$/.test(action.role) || action.role.length > 30) throw new Error('role must be a lowercase ARIA role name');
      if (typeof action.name !== 'string' || !action.name || action.name.length > 200) throw new Error('role targeting needs name, 1..200 chars');
      out.role = action.role; out.name = action.name;
    }
    if (action.text !== undefined && action.role === undefined) {
      if (typeof action.text !== 'string' || !action.text || action.text.length > 500) throw new Error('text targeting needs text, 1..500 chars');
      out.text = action.text;
    }
  }
  if (action.action === 'type') {
    if (typeof action.value !== 'string' || action.value.length === 0 || action.value.length > 4000) throw new Error('type needs value, 1..4000 chars');
    if (action.sensitive) throw new Error('denied: sensitive text (credentials, OTPs) is never typed in the browser');
    out.value = action.value;
  }
  if (action.action === 'select') {
    if (action.value === undefined && action.label === undefined && action.index_option === undefined) throw new Error('select needs value, label, or index_option');
    if (action.value !== undefined) { if (typeof action.value !== 'string' || action.value.length > 500) throw new Error('select value max 500 chars'); out.value = action.value; }
    if (action.label !== undefined) { if (typeof action.label !== 'string' || action.label.length > 500) throw new Error('select label max 500 chars'); out.label = action.label; }
    if (action.index_option !== undefined) { if (!Number.isInteger(action.index_option) || action.index_option < 0) throw new Error('select index_option must be an integer >= 0'); out.index_option = action.index_option; }
  }
  if (action.action === 'check') {
    if (action.checked !== undefined && typeof action.checked !== 'boolean') throw new Error('check.checked must be a boolean');
    out.checked = action.checked !== false;
  }
  if (action.action === 'set_files') {
    if (!Array.isArray(action.files) || action.files.length === 0 || action.files.length > 5) throw new Error('set_files needs files: 1..5 workspace paths');
    out.files = action.files.map((f) => {
      if (typeof f !== 'string' || !f) throw new Error('set_files file paths must be non-empty strings');
      return f;
    });
  }
  if (action.action === 'submit' || action.action === 'set_files') {
    // Approval id is REQUIRED and must reference an approved record — the
    // lookup happens in act(); here we only validate the shape.
    if (!Number.isInteger(action.approvalId) || action.approvalId < 1) throw new Error(`denied: ${action.action} needs an approved approval id — uploads and form submits never run on the agent's word alone`);
    out.approvalId = action.approvalId;
  }
  if (action.action === 'scroll') {
    if (action.selector !== undefined) out.selector = validateSelector(action.selector);
    if (action.text !== undefined) { if (typeof action.text !== 'string' || !action.text || action.text.length > 500) throw new Error('scroll text max 500 chars'); out.text = action.text; }
    if (action.deltaY !== undefined) { if (!Number.isInteger(action.deltaY) || Math.abs(action.deltaY) > 10000) throw new Error('scroll deltaY must be an integer -10000..10000'); out.deltaY = action.deltaY; }
    if (action.x !== undefined || action.y !== undefined) {
      if (!Number.isInteger(action.x) || !Number.isInteger(action.y) || action.x < 0 || action.y < 0 || action.x > 100000 || action.y > 100000) throw new Error('scroll x/y must be integers 0..100000');
      out.x = action.x; out.y = action.y;
    }
  }
  if (action.action === 'wait') {
    const timeoutMs = action.timeoutMs === undefined ? 10000 : action.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) throw new Error('wait timeoutMs must be an integer 0..30000');
    out.timeoutMs = timeoutMs;
    if (action.selector !== undefined) out.selector = validateSelector(action.selector);
    if (action.text !== undefined) { if (typeof action.text !== 'string' || !action.text || action.text.length > 500) throw new Error('wait text max 500 chars'); out.text = action.text; }
    if (action.state !== undefined) { if (!['visible', 'hidden', 'attached', 'detached'].includes(action.state)) throw new Error('wait state must be visible, hidden, attached, or detached'); out.state = action.state; }
    if (action.networkIdle !== undefined) out.networkIdle = !!action.networkIdle;
    if (action.ms !== undefined) { if (!Number.isInteger(action.ms) || action.ms < 0 || action.ms > 30000) throw new Error('wait ms must be an integer 0..30000'); out.ms = action.ms; }
  }
  if (action.action === 'screenshot') {
    if (action.fullPage !== undefined) out.fullPage = !!action.fullPage;
    if (action.clip !== undefined) {
      const c = action.clip;
      if (!c || typeof c !== 'object' || !Number.isInteger(c.x) || !Number.isInteger(c.y) || !Number.isInteger(c.width) || !Number.isInteger(c.height) ||
        c.x < 0 || c.y < 0 || c.width < 1 || c.height < 1 || c.width > 8000 || c.height > 8000) throw new Error('screenshot clip needs integer x/y/width/height within bounds');
      out.clip = { x: c.x, y: c.y, width: c.width, height: c.height };
    }
  }
  if (action.action === 'zoom') {
    const r = action.region;
    if (!Array.isArray(r) || r.length !== 4 || r.some((v) => typeof v !== 'number' || v < 0 || v > 1) || !(r[2] > r[0]) || !(r[3] > r[1])) {
      throw new Error('zoom needs region [x0, y0, x1, y1], normalised 0..1, x1 > x0 and y1 > y0');
    }
    out.region = r;
  }
  if (action.action === 'snapshot') {
    if (action.fresh !== undefined && typeof action.fresh !== 'boolean') throw new Error('snapshot fresh must be a boolean');
    out.fresh = action.fresh !== false;
  }
  if (action.action === 'dom_check') {
    out.checks = validateChecks(action.checks);
    if (!out.checks.length) throw new Error('dom_check needs checks: 1..20 assertions');
  }
  if (action.action === 'click' && action.expectDownload !== undefined) {
    // A click that starts a download: approval-gated, same as submit.
    out.expectDownload = !!action.expectDownload;
    if (out.expectDownload) {
      if (!Number.isInteger(action.approvalId) || action.approvalId < 1) throw new Error('denied: a click that downloads needs an approved approval id');
      out.approvalId = action.approvalId;
    }
  }
  return out;
}

// Runs INSIDE the page (page.evaluate). Numbered outline of interactive
// elements with stable selectors, input types, and checked/value state.
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
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
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
    const entry = { role: el.getAttribute('role') || el.tagName.toLowerCase(), name: nameOf(el), selector: sel };
    // v2: real rendered geometry — the visual grounding path clicks at
    // the element's centre in normalised 0..1, so it needs the rect.
    entry.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    entry.centerNorm = { x: (rect.x + rect.width / 2) / vw, y: (rect.y + rect.height / 2) / vh };
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      entry.inputType = String(el.getAttribute('type') || 'text').toLowerCase();
      if (entry.inputType === 'checkbox' || entry.inputType === 'radio') entry.checked = !!el.checked;
      else if (entry.inputType !== 'password' && entry.inputType !== 'file') entry.value = String(el.value || '').slice(0, 80);
    }
    if (tag === 'select') entry.value = String(el.value || '').slice(0, 80);
    if (tag === 'textarea') entry.value = String(el.value || '').slice(0, 80);
    out.push(entry);
  }
  return out;
}

// DOM CHECK — the verification primitive. Runs the assertions against the
// live page and returns per-check evidence. `page` is a Playwright page (or
// a test fake with evaluate/url/title). Never throws for a failed check —
// failures are data. Throws only for a broken page/evaluate.
async function domCheck(page, checks) {
  const list = validateChecks(checks);
  const url = typeof page.url === 'function' ? page.url() : '';
  const title = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
  const dom = await page.evaluate((wanted) => {
    const text = document.body ? document.body.innerText : '';
    const per = wanted.map((w) => {
      if (w.type === 'selector_count') {
        return { count: document.querySelectorAll(w.selector).length };
      }
      if (w.type === 'value_equals' || w.type === 'checked' || w.type === 'visible' || w.type === 'attribute_equals') {
        const el = document.querySelector(w.selector);
        if (!el) return { missing: true };
        const r = { value: String(el.value !== undefined ? el.value : ''), checked: !!el.checked };
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        r.visible = !((rect.width === 0 && rect.height === 0) || style.visibility === 'hidden' || style.display === 'none');
        if (w.attribute) r.attribute = el.getAttribute(w.attribute);
        return r;
      }
      return {};
    });
    return { text, per };
  }, list);
  const results = list.map((c, i) => {
    const d = dom.per[i] || {};
    let passed = false;
    let actual = null;
    if (c.type === 'text_present') { passed = dom.text.includes(c.text); actual = passed ? 'present' : 'absent'; }
    else if (c.type === 'text_absent') { passed = !dom.text.includes(c.text); actual = passed ? 'absent' : 'present'; }
    else if (c.type === 'title_contains') { passed = String(title).includes(c.text); actual = String(title).slice(0, 120); }
    else if (c.type === 'url_matches') { passed = new RegExp(c.pattern).test(String(url)); actual = String(url).slice(0, 200); }
    else if (c.type === 'selector_count') {
      actual = d.count;
      passed = (c.count === undefined || d.count === c.count) && (c.gte === undefined || d.count >= c.gte) && (c.lte === undefined || d.count <= c.lte);
    } else if (d.missing) { passed = false; actual = 'element missing'; }
    else if (c.type === 'value_equals') { passed = d.value === c.value; actual = String(d.value).slice(0, 120); }
    else if (c.type === 'attribute_equals') { passed = d.attribute === c.value; actual = String(d.attribute); }
    else if (c.type === 'checked') { passed = d.checked === c.checked; actual = d.checked; }
    else if (c.type === 'visible') { passed = d.visible === true; actual = d.visible; }
    return { check: c, passed, actual };
  });
  // v2: the page text hash — the caller reuses it for the post-action
  // state digest instead of running a second page.evaluate for the same
  // text (one redundant snapshot of the DOM per verified action removed).
  const textHash = crypto.createHash('sha256').update(String(dom.text || '')).digest('hex').slice(0, 16);
  return { ok: results.every((r) => r.passed), url, title, checks: results, textHash, textLength: String(dom.text || '').length };
}

async function stateDigest(page) {
  try {
    const url = typeof page.url === 'function' ? page.url() : '';
    const title = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
    const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    const hash = crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
    return { url, title: String(title).slice(0, 120), textHash: hash, textLength: String(text || '').length };
  } catch {
    return { url: null, title: null, textHash: null, textLength: null };
  }
}

function launchOptions(extra = {}) {
  const opts = { headless: extra.headed ? false : true, args: ['--no-sandbox'] };
  const proxyServer = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (proxyServer) {
    opts.proxy = { server: proxyServer };
    if (process.env.NO_PROXY) opts.proxy.bypass = process.env.NO_PROXY;
  }
  return opts;
}

// One persistent browser session: a Playwright persistent context with
// numbered tabs. `driver` injection (tests) supplies a single fake page;
// tab actions then throw a clear error instead of pretending.
class StatefulBrowserSession {
  constructor({ id, driver, launchPersistent, allowLoopback = false, headed = false, approvalLookup, userDataDir } = {}) {
    this.id = validateSessionId(id);
    this.driver = driver || null;
    this.launchPersistent = launchPersistent || null;
    this.allowLoopback = !!allowLoopback;
    this.headed = !!headed;
    this.approvalLookup = approvalLookup || null;
    this.userDataDir = userDataDir || path.join(os.tmpdir(), `piplet-browser-${this.id}`);
    this.context = null;
    this.tabs = []; // [{ id, page, console: [], network: [] }]
    this.activeTab = 0;
    this.lastSnapshot = null;
    this.pendingDownload = null; // { approvalId } consumed by the next download event
    this.closed = false;
    this.lastUsedAt = Date.now();
    this.idleTimer = null;
  }

  assertOpen() {
    if (this.closed) throw new Error(`browser session '${this.id}' is closed — create a new session`);
  }

  _attachPage(page, tabId) {
    // Deduplicate: context.newPage() also fires the 'page' event, so the
    // same page can arrive twice — track it once.
    const existing = this.tabs.find((t) => t.page === page);
    if (existing) return existing;
    const tab = { id: tabId, page, console: [], network: [] };
    if (typeof page.on === 'function') {
      page.on('console', (msg) => {
        try {
          tab.console.push({ at: new Date().toISOString(), type: String(msg.type()), text: sanitizeText(String(msg.text())).slice(0, 500) });
          if (tab.console.length > OBSERVE_CAP) tab.console.shift();
        } catch {}
      });
      page.on('request', (req) => {
        try {
          tab.network.push({ at: new Date().toISOString(), kind: 'request', method: req.method(), url: sanitizeText(req.url()).slice(0, 500) });
          if (tab.network.length > OBSERVE_CAP) tab.network.shift();
        } catch {}
      });
      page.on('response', (res) => {
        try {
          tab.network.push({ at: new Date().toISOString(), kind: 'response', status: res.status(), url: sanitizeText(res.url()).slice(0, 500) });
          if (tab.network.length > OBSERVE_CAP) tab.network.shift();
        } catch {}
      });
      page.on('download', (dl) => { this.lastDownloadPromise = this._onDownload(dl).catch(() => ({})); });
    }
    this.tabs.push(tab);
    return tab;
  }

  async _onDownload(download) {
    // Downloads are deny-first: without a pending APPROVED expectation the
    // download is cancelled and any partial file deleted, never kept. With
    // one, the file lands in data/downloads/ under a sanitised basename
    // (safePath-confined). Returns what happened, for the click handler.
    const pending = this.pendingDownload;
    this.pendingDownload = null;
    if (!pending) {
      try { await download.cancel().catch(() => {}); } catch {}
      const tmpPath = await download.path().catch(() => null);
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch {} }
      audit('browser.download_blocked', { session: this.id }, false, 'download without an approved expectation — cancelled and deleted');
      return { blocked: true };
    }
    try {
      // suggestedFilename() is synchronous in Playwright — no promise, no .catch.
      const suggested = sanitizeText(String(download.suggestedFilename() || 'download'));
      const base = path.basename(suggested).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'download';
      const dest = safePath(path.join('app', 'data', 'downloads', base));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await download.saveAs(dest);
      audit('browser.download', { session: this.id, file: base }, true, `saved ${base} (approval ${pending.approvalId})`);
      return { saved: dest, file: base };
    } catch (e) {
      audit('browser.download_failed', { session: this.id }, false, String(e.message).slice(0, 200));
      return { failed: true, error: String(e.message).slice(0, 200) };
    }
  }

  async ensureContext() {
    this.assertOpen();
    if (this.driver) {
      if (!this.tabs.length) this._attachPage(this.driver, 0);
      return this.tabs[this.activeTab];
    }
    if (this.context) return this.tabs[this.activeTab];
    const cap = capability();
    if (!cap.available) throw new Error(`browser unavailable: ${cap.reason}`);
    const { chromium } = require('playwright');
    const launch = this.launchPersistent || ((dir, opts) => chromium.launchPersistentContext(dir, opts));
    const opts = { ...launchOptions({ headed: this.headed }), acceptDownloads: true, viewport: { width: 1280, height: 800 } };
    try {
      this.context = await launch(this.userDataDir, opts);
    } catch (e) {
      throw new Error(`browser launch failed: ${sanitizeText(e.message).slice(0, 300)}`);
    }
    const pages = this.context.pages();
    if (pages.length) pages.forEach((p, i) => this._attachPage(p, i));
    else this._attachPage(await this.context.newPage(), 0);
    this.context.on('page', (p) => {
      // A popup/new tab opened by the page itself: track it, capped.
      if (this.tabs.length >= MAX_TABS) { p.close().catch(() => {}); return; }
      this._attachPage(p, this.tabs.length ? Math.max(...this.tabs.map((t) => t.id)) + 1 : 0);
    });
    return this.tabs[this.activeTab];
  }

  currentTab() {
    const tab = this.tabs[this.activeTab];
    if (!tab) throw new Error('no active tab — navigate or open a new tab first');
    return tab;
  }

  _checkApproved(approvalId, what) {
    if (!this.approvalLookup) throw new Error(`denied: ${what} needs an approved approval id and no approval store is configured`);
    const row = this.approvalLookup(approvalId);
    if (!row || row.status !== 'approved') throw new Error(`denied: approval ${approvalId} not found or not approved — ${what} refused`);
  }

  _checkUrl(raw) {
    if (this.allowLoopback) {
      let u;
      try { u = new URL(raw); } catch { throw new Error('navigate needs a valid URL'); }
      if (!['https:', 'http:', 'data:', 'about:'].includes(u.protocol)) throw new Error('navigate needs an http(s), data:, or about: URL');
      if (u.protocol === 'http:' && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) throw new Error('denied: loopback sessions allow http only for 127.0.0.1/localhost');
      return raw;
    }
    return validateUrl(raw);
  }

  _resolveTarget(page, a) {
    // Returns a Playwright locator for exactly one element, or throws.
    if (a.index !== undefined) {
      const entry = this._resolveRef(a.index, page);
      return page.locator(entry.selector);
    }
    if (a.selector !== undefined) return page.locator(a.selector);
    if (a.role !== undefined) return page.getByRole(a.role, { name: a.name, exact: true });
    return page.getByText(a.text, { exact: true });
  }

  _resolveRef(index, page) {
    if (!this.lastSnapshot) throw new Error('no snapshot — run the snapshot action first, then act by reference');
    const now = typeof page.url === 'function' ? page.url() : null;
    if (this.lastSnapshot.url && now && this.lastSnapshot.url !== now) {
      throw new Error('page changed since the snapshot — take a fresh snapshot');
    }
    const entry = this.lastSnapshot.entries[index];
    if (!entry) throw new Error(`snapshot has no index ${index} (0..${this.lastSnapshot.entries.length - 1})`);
    return entry;
  }

  async _refusePasswordField(page, locator, a) {
    // Resolve the element's input type before typing: password fields and
    // credential autocomplete targets are refused outright.
    const info = await page.evaluate((loc) => {
      const el = loc;
      if (!el) return null;
      return {
        type: String(el.getAttribute('type') || el.tagName).toLowerCase(),
        autocomplete: String(el.getAttribute('autocomplete') || '').toLowerCase(),
      };
    }, await locator.elementHandle().catch(() => null)).catch(() => null);
    if (!info) return; // elementHandle path unavailable (fake driver) — selector path below covers it
    if (info.type === 'password' || info.autocomplete.includes('current-password') || info.autocomplete.includes('new-password')) {
      throw new Error('denied: refusing to type into a password/credential field — sign-ins are the user\'s own act');
    }
  }

  async _refusePasswordBySelector(page, selector) {
    const info = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return {
        type: String(el.getAttribute('type') || el.tagName).toLowerCase(),
        autocomplete: String(el.getAttribute('autocomplete') || '').toLowerCase(),
      };
    }, selector).catch(() => null);
    if (info && (info.type === 'password' || info.autocomplete.includes('current-password') || info.autocomplete.includes('new-password'))) {
      throw new Error('denied: refusing to type into a password/credential field — sign-ins are the user\'s own act');
    }
  }

  async act(rawAction) {
    assertNotFrozen();
    this.assertOpen();
    const t0 = Date.now(); // v2: every action reports its own latency (ms)
    const a = validateAction(rawAction);
    // URL policy is enforced BEFORE any browser launches: a denied URL
    // must never cost a Chromium process.
    if (a.action === 'navigate' || (a.action === 'new_tab' && a.url !== undefined)) this._checkUrl(a.url);
    this.lastUsedAt = Date.now();
    const tab = await this.ensureContext();
    const page = tab.page;
    const before = MUTATING.has(a.action) ? await stateDigest(page) : null;
    let result;
    if (a.action === 'navigate') {
      const url = this._checkUrl(a.url);
      await page.goto(url, { timeout: 30000 });
      result = { ok: true, url };
    } else if (a.action === 'back') {
      await page.goBack({ timeout: 15000 }).catch(() => {});
      result = { ok: true, url: typeof page.url === 'function' ? page.url() : null };
    } else if (a.action === 'forward') {
      await page.goForward({ timeout: 15000 }).catch(() => {});
      result = { ok: true, url: typeof page.url === 'function' ? page.url() : null };
    } else if (a.action === 'reload') {
      await page.reload({ timeout: 30000 }).catch(() => {});
      result = { ok: true, url: typeof page.url === 'function' ? page.url() : null };
    } else if (a.action === 'new_tab') {
      if (this.driver) throw new Error('tabs need a real browser context — the injected driver is single-page');
      if (this.tabs.length >= MAX_TABS) throw new Error(`tab cap reached (${MAX_TABS}) — close a tab first`);
      const p = await this.context.newPage();
      const nt = this._attachPage(p, this.tabs.length ? Math.max(...this.tabs.map((t) => t.id)) + 1 : 0);
      this.activeTab = this.tabs.indexOf(nt);
      if (a.url !== undefined) {
        const url = this._checkUrl(a.url);
        await p.goto(url, { timeout: 30000 });
      }
      result = { ok: true, tab: this.activeTab, tabId: nt.id, tabs: this.tabs.length };
    } else if (a.action === 'switch_tab') {
      if (!this.tabs[a.tab]) throw new Error(`no tab index ${a.tab} (0..${this.tabs.length - 1})`);
      this.activeTab = a.tab;
      const p = this.tabs[a.tab].page;
      if (typeof p.bringToFront === 'function') await p.bringToFront().catch(() => {});
      result = { ok: true, tab: a.tab, url: typeof p.url === 'function' ? p.url() : null };
    } else if (a.action === 'close_tab') {
      const idx = a.tab !== undefined ? a.tab : this.activeTab;
      if (!this.tabs[idx]) throw new Error(`no tab index ${idx}`);
      if (this.tabs.length === 1) throw new Error('cannot close the last tab — close the session instead');
      const [gone] = this.tabs.splice(idx, 1);
      if (!this.driver) await gone.page.close().catch(() => {});
      if (this.activeTab >= this.tabs.length) this.activeTab = this.tabs.length - 1;
      result = { ok: true, closed: idx, tabs: this.tabs.length, activeTab: this.activeTab };
    } else if (a.action === 'list_tabs') {
      result = {
        ok: true,
        activeTab: this.activeTab,
        tabs: await Promise.all(this.tabs.map(async (t, i) => ({
          index: i, id: t.id,
          url: typeof t.page.url === 'function' ? t.page.url() : null,
          title: typeof t.page.title === 'function' ? await t.page.title().catch(() => '') : '',
        }))),
      };
    } else if (a.action === 'snapshot') {
      // v2: fresh:false reuses a snapshot taken <5s ago on the same URL —
      // observe-act-verify loops re-snapshot constantly, and a fresh
      // evaluate per loop step is the biggest wasted cost. Default stays
      // fresh (callers that need current geometry say so explicitly).
      const nowUrl = typeof page.url === 'function' ? page.url() : null;
      if (a.fresh === false && this.lastSnapshot && this.lastSnapshot.url === nowUrl &&
          Date.now() - this.lastSnapshot.at < 5000) {
        result = { ok: true, url: this.lastSnapshot.url, entries: this.lastSnapshot.entries, cached: true, ageMs: Date.now() - this.lastSnapshot.at };
      } else {
        const entries = await page.evaluate(snapshotDom);
        const list = (Array.isArray(entries) ? entries : []).slice(0, 200).map((e, i) => ({
          index: i, role: String(e?.role || ''), name: String(e?.name || '').slice(0, 80),
          selector: String(e?.selector || '').slice(0, 500),
          ...(e?.rect ? { rect: { x: e.rect.x, y: e.rect.y, width: e.rect.width, height: e.rect.height } } : {}),
          ...(e?.centerNorm ? { centerNorm: { x: e.centerNorm.x, y: e.centerNorm.y } } : {}),
          ...(e?.inputType ? { inputType: String(e.inputType) } : {}),
          ...(e?.checked !== undefined ? { checked: !!e.checked } : {}),
          ...(e?.value !== undefined ? { value: String(e.value).slice(0, 80) } : {}),
        }));
        this.lastSnapshot = { url: typeof page.url === 'function' ? page.url() : null, entries: list, at: Date.now() };
        result = { ok: true, url: this.lastSnapshot.url, entries: list, cached: false };
      }
    } else if (a.action === 'a11y') {
      // Prefer the real accessibility tree; the headless-shell build has
      // no page.accessibility, so fall back to a DOM-derived tree and say
      // so in the result (source field) instead of pretending.
      let tree = null;
      let source = 'accessibility-tree';
      if (page.accessibility && typeof page.accessibility.snapshot === 'function') {
        tree = await page.accessibility.snapshot({ interestingOnly: true }).catch(() => null);
      }
      if (!tree) {
        tree = await page.evaluate(a11yDomTree).catch(() => null);
        source = 'dom-fallback';
      }
      result = { ok: true, tree: pruneA11y(tree, 300), source };
    } else if (a.action === 'dom') {
      const html = await page.content().catch(() => '');
      result = { ok: true, html: String(html).slice(0, 50000), truncated: String(html).length > 50000 };
    } else if (a.action === 'text') {
      const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
      result = { ok: true, text: String(text || '').slice(0, 5000) };
    } else if (a.action === 'title') {
      result = { ok: true, title: await page.title() };
    } else if (a.action === 'url') {
      result = { ok: true, url: typeof page.url === 'function' ? page.url() : null };
    } else if (a.action === 'click') {
      const locator = this._resolveTarget(page, a);
      const count = await locator.count();
      if (count === 0) throw new Error('click target not found on the page');
      if (count > 1) throw new Error(`ambiguous click target: ${count} matches — narrow the selector or use a snapshot index`);
      if (a.expectDownload) {
        this._checkApproved(a.approvalId, 'download');
        this.pendingDownload = { approvalId: a.approvalId };
        let downloadEvent = null;
        try {
          [downloadEvent] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
            locator.click({ timeout: 10000 }),
          ]);
          if (downloadEvent && this.lastDownloadPromise) await this.lastDownloadPromise;
        } finally {
          // If no download arrived, clear the stale expectation.
          if (this.pendingDownload && this.pendingDownload.approvalId === a.approvalId) this.pendingDownload = null;
        }
        result = { ok: true, clicked: true, downloadExpected: true, downloadArrived: !!downloadEvent };
      } else {
        await locator.click({ timeout: 10000 });
        result = { ok: true, clicked: true };
      }
    } else if (a.action === 'type') {
      const locator = this._resolveTarget(page, a);
      const count = await locator.count();
      if (count === 0) throw new Error('type target not found on the page');
      if (count > 1) throw new Error(`ambiguous type target: ${count} matches — narrow the selector or use a snapshot index`);
      if (a.index !== undefined) {
        const entry = this._resolveRef(a.index, page);
        await this._refusePasswordBySelector(page, entry.selector);
        await page.fill(entry.selector, a.value, { timeout: 10000 });
      } else if (a.selector !== undefined) {
        await this._refusePasswordBySelector(page, a.selector);
        await page.fill(a.selector, a.value, { timeout: 10000 });
      } else {
        await this._refusePasswordField(page, locator, a);
        await locator.fill(a.value, { timeout: 10000 });
      }
      result = { ok: true, typed: true, chars: a.value.length };
    } else if (a.action === 'select') {
      const locator = this._resolveTarget(page, a);
      const opt = a.value !== undefined ? { value: a.value } : a.label !== undefined ? { label: a.label } : { index: a.index_option };
      const selected = await locator.selectOption(opt, { timeout: 10000 });
      result = { ok: true, selected };
    } else if (a.action === 'check') {
      const locator = this._resolveTarget(page, a);
      await locator.setChecked(a.checked, { timeout: 10000 });
      result = { ok: true, checked: a.checked };
    } else if (a.action === 'set_files') {
      this._checkApproved(a.approvalId, 'file upload');
      const resolved = a.files.map((f) => {
        const p = safePath(f); // workspace-confined, secret paths denied
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`upload file not found in workspace: ${f}`);
        return p;
      });
      const locator = this._resolveTarget(page, a);
      await locator.setInputFiles(resolved, { timeout: 15000 });
      result = { ok: true, files: a.files };
    } else if (a.action === 'submit') {
      this._checkApproved(a.approvalId, 'form submit');
      const locator = this._resolveTarget(page, a);
      const count = await locator.count();
      if (count === 0) throw new Error('submit target not found on the page');
      if (count > 1) throw new Error(`ambiguous submit target: ${count} matches — narrow the selector or use a snapshot index`);
      await locator.click({ timeout: 10000 });
      result = { ok: true, submitted: true, approvalId: a.approvalId };
    } else if (a.action === 'scroll') {
      if (a.selector !== undefined) {
        await page.locator(a.selector).first().scrollIntoViewIfNeeded({ timeout: 10000 });
      } else if (a.text !== undefined) {
        await page.getByText(a.text).first().scrollIntoViewIfNeeded({ timeout: 10000 });
      } else if (a.deltaY !== undefined) {
        await page.mouse.wheel(0, a.deltaY);
      } else if (a.x !== undefined) {
        await page.evaluate(([x, y]) => window.scrollTo(x, y), [a.x, a.y]);
      } else {
        await page.evaluate(() => window.scrollBy(0, 600));
      }
      result = { ok: true, scrolled: true };
    } else if (a.action === 'wait') {
      if (a.ms !== undefined) {
        await page.waitForTimeout(a.ms);
      } else if (a.networkIdle) {
        await page.waitForLoadState('networkidle', { timeout: a.timeoutMs }).catch(() => {});
      } else if (a.selector !== undefined) {
        await page.locator(a.selector).first().waitFor({ state: a.state || 'visible', timeout: a.timeoutMs });
      } else if (a.text !== undefined) {
        await page.getByText(a.text).first().waitFor({ state: a.state || 'visible', timeout: a.timeoutMs });
      } else {
        await page.waitForTimeout(a.timeoutMs);
      }
      result = { ok: true, waited: true };
    } else if (a.action === 'screenshot') {
      const buf = await page.screenshot({ type: 'png', fullPage: !!a.fullPage, ...(a.clip ? { clip: a.clip } : {}) });
      const b64 = Buffer.from(buf).toString('base64');
      result = { ok: true, imageBase64: b64, mimeType: 'image/png', fullPage: !!a.fullPage, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    } else if (a.action === 'zoom') {
      // Region capture at full resolution — the browser-side zoom. The
      // cropped shot is the observation the next grounding step sees; the
      // loop (computer-use.js) feeds it back instead of discarding it.
      const viewport = page.viewportSize ? page.viewportSize() : { width: 1280, height: 800 };
      const clip = {
        x: Math.max(0, Math.round(a.region[0] * viewport.width)),
        y: Math.max(0, Math.round(a.region[1] * viewport.height)),
        width: Math.max(1, Math.round((a.region[2] - a.region[0]) * viewport.width)),
        height: Math.max(1, Math.round((a.region[3] - a.region[1]) * viewport.height)),
      };
      const buf = await page.screenshot({ type: 'png', clip });
      result = { ok: true, imageBase64: Buffer.from(buf).toString('base64'), mimeType: 'image/png', region: a.region, clip, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    } else if (a.action === 'dom_check') {
      result = await domCheck(page, a.checks);
    } else if (a.action === 'observe') {
      result = {
        ok: true,
        tab: this.activeTab,
        console: tab.console.slice(-50),
        network: tab.network.slice(-50),
      };
    } else if (a.action === 'close') {
      const id = this.id;
      await this.close();
      result = { ok: true, closed: id };
    }
    // Post-action DOM CHECK: explicit expectations + state digest diff.
    // v2: when expectations were checked, domCheck already read the page
    // text — reuse its hash for the after-digest instead of a second
    // page.evaluate for the same text.
    let verification = null;
    if (MUTATING.has(a.action) && a.action !== 'close') {
      if (a.expect && a.expect.length) {
        verification = await domCheck(page, a.expect);
      }
      const after = verification
        ? { url: verification.url, title: String(verification.title).slice(0, 120), textHash: verification.textHash, textLength: verification.textLength }
        : await stateDigest(page);
      result.stateChanged = before && after && (before.url !== after.url || before.textHash !== after.textHash || before.title !== after.title);
      result.before = before;
      result.after = after;
      if (verification) {
        result.verification = verification;
        if (!verification.ok) result.ok = false;
      }
    }
    result.ms = Date.now() - t0;
    audit('browser.' + a.action, { session: this.id, action: a.action, tab: this.activeTab }, result.ok !== false, `browser session ${a.action} ok=${result.ok !== false}`);
    return result;
  }

  async close() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.closed = true;
    try { if (this.context) await this.context.close().catch(() => {}); } finally {
      this.context = null;
      this.tabs = [];
    }
  }
}

// Runs INSIDE the page: builds a compact accessibility-like tree from the
// DOM for environments without page.accessibility (headless shell). Only
// interesting elements are kept; capped at 300 nodes.
function a11yDomTree() {
  const ROLE_TAGS = { a: 'link', button: 'button', input: 'textbox', select: 'combobox', textarea: 'textbox', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', form: 'form', nav: 'navigation', main: 'main', img: 'img', table: 'table', ul: 'list', ol: 'list' };
  let budget = 300;
  function nameOf(el) {
    return (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('alt') || '')
      .trim().replace(/\s+/g, ' ').slice(0, 80);
  }
  function walk(el) {
    if (budget <= 0) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const role = el.getAttribute && el.getAttribute('role');
    const mapped = role || ROLE_TAGS[tag];
    const kids = [];
    for (const child of el.children || []) {
      const w = walk(child);
      if (w) kids.push(w);
      if (budget <= 0) break;
    }
    if (!mapped) return kids.length === 1 ? kids[0] : (kids.length ? { role: 'generic', children: kids } : null);
    budget--;
    const out = { role: mapped };
    const name = nameOf(el);
    if (name) out.name = name;
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) out.checked = !!el.checked;
      else if (tag === 'input' && el.type !== 'password' && el.type !== 'file') out.value = String(el.value || '').slice(0, 80);
      else if (tag !== 'input') out.value = String(el.value || '').slice(0, 80);
      if (tag === 'input') out.role = el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : el.type === 'button' || el.type === 'submit' ? 'button' : 'textbox';
    }
    if (el.disabled) out.disabled = true;
    if (kids.length) out.children = kids;
    return out;
  }
  return walk(document.body) || { role: 'generic', children: [] };
}

function pruneA11y(node, budget) {
  // Compact the accessibility tree: keep role/name/value/checked/disabled,
  // cap total nodes so a huge page cannot flood the reply.
  let remaining = budget;
  function walk(n) {
    if (!n || typeof n !== 'object' || remaining <= 0) return null;
    remaining--;
    const out = { role: n.role };
    if (n.name) out.name = String(n.name).slice(0, 80);
    if (n.value !== undefined) out.value = String(n.value).slice(0, 80);
    if (n.checked !== undefined) out.checked = n.checked;
    if (n.disabled) out.disabled = true;
    if (Array.isArray(n.children) && n.children.length && remaining > 0) {
      out.children = n.children.map(walk).filter(Boolean);
    }
    return out;
  }
  return walk(node);
}

// Session registry — sessions persist across turns within the server
// process. Idle sessions close after 10 minutes (timer is unref'd so it
// never keeps the process alive).
class BrowserSessionManager {
  constructor({ launchPersistent, approvalLookup, idleCloseMs = IDLE_CLOSE_MS } = {}) {
    this.sessions = new Map();
    this.launchPersistent = launchPersistent || null;
    this.approvalLookup = approvalLookup || null;
    this.idleCloseMs = idleCloseMs;
  }

  get(id, opts = {}) {
    const sid = validateSessionId(id);
    let s = this.sessions.get(sid);
    if (s && !s.closed) {
      this._armIdle(s);
      return s;
    }
    s = new StatefulBrowserSession({
      id: sid,
      driver: opts.driver || null,
      launchPersistent: this.launchPersistent,
      allowLoopback: !!opts.allowLoopback,
      headed: !!opts.headed,
      approvalLookup: this.approvalLookup,
      userDataDir: opts.userDataDir,
    });
    this.sessions.set(sid, s);
    this._armIdle(s);
    return s;
  }

  _armIdle(session) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      session.close().catch(() => {});
      this.sessions.delete(session.id);
    }, this.idleCloseMs);
    if (typeof session.idleTimer.unref === 'function') session.idleTimer.unref();
  }

  list() {
    return [...this.sessions.values()].filter((s) => !s.closed).map((s) => ({
      id: s.id, tabs: s.tabs.length, activeTab: s.activeTab, lastUsedAt: s.lastUsedAt,
    }));
  }

  async close(id) {
    const sid = validateSessionId(id);
    const s = this.sessions.get(sid);
    if (s) { await s.close(); this.sessions.delete(sid); return true; }
    return false;
  }

  async closeAll() {
    for (const s of [...this.sessions.values()]) await s.close().catch(() => {});
    this.sessions.clear();
  }
}

module.exports = {
  StatefulBrowserSession, BrowserSessionManager, domCheck, validateAction,
  validateChecks, validateSessionId, SESSION_ACTIONS, MAX_TABS, snapshotDom, pruneA11y,
};
