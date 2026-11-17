// Frontend for Ankush's personal AI. Token is NOT hard-coded here — paste it
// once in the prompt (it lives in .env.local on the server). No external CDN,
// no tracking, no data leaves 127.0.0.1.
let token = sessionStorage.getItem('anku_token') || '';
// In the desktop app the preload bridge supplies the token (see the
// async init at the bottom) — never prompt there. In a plain browser
// the owner pastes it once, as before.
if (!token && !(window.piplet && window.piplet.getToken)) {
  token = prompt('Piplet token (from .env.local in the app folder):') || '';
  sessionStorage.setItem('anku_token', token);
}
// Language: English / Hindi / Telugu, chosen in the header, remembered in
// localStorage. Only UI chrome is translated; model replies and saved
// content stay in their original language (see public/i18n.js).
const I18N = window.PipletI18n || { STRINGS: { en: {} }, LANGS: [{ code: 'en' }], t: (k) => k };
let lang = localStorage.getItem('piplet_lang') || 'en';
if (!I18N.STRINGS[lang]) lang = 'en';
const t = (key) => I18N.t(key, lang);
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  const sel = document.getElementById('lang-select');
  if (sel) sel.value = lang;
}
function loadAll() {
  loadStatus(); loadJobs(); loadApprovals(); loadNotes(); loadFreeze();
  loadQueue(); loadRoutines(); loadSettings(); loadNotifications(); loadSync(); loadReplay();
  loadSkills(); loadMemoryFacts();
}
// `let`, not `const`: the desktop-app init below may resolve the token
// from the preload bridge after load and rebuild these headers.
let H = { 'Content-Type': 'application/json', 'X-Anku-Token': token };
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j.error || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return j;
}
// H-7: every loader shows its own error state + Retry instead of leaving
// a blank section and an unhandled rejection. A 401 anywhere also raises
// the global auth banner (token wrong / server restarted) with a
// re-enter-token control. The banner is shown once per page load.
let authBannerShown = false;
function showAuthBanner() {
  if (authBannerShown) return;
  authBannerShown = true;
  const banner = document.getElementById('auth-banner');
  document.getElementById('auth-banner-text').textContent = t('auth_failed');
  document.getElementById('reenter-token').textContent = t('reenter_token');
  banner.hidden = false;
}
document.getElementById('reenter-token').addEventListener('click', () => {
  sessionStorage.removeItem('anku_token');
  location.reload();
});
function sectionError(container, err, retryFn) {
  if (err && err.status === 401) showAuthBanner();
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  el.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'section-error';
  wrap.setAttribute('role', 'status');
  wrap.textContent = `${t('load_failed')}: ${err ? err.message : 'unknown error'} `;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = t('retry');
  btn.addEventListener('click', () => { retryFn(); });
  wrap.appendChild(btn);
  el.appendChild(wrap);
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
async function loadStatus() {
  try {
    const s = await api('/api/status');
    document.getElementById('status').innerHTML =
      `${esc(t('brain_order'))}: ${esc(s.brain_order.join(' → '))}<br>` +
      `Gemini direct: ${s.providers_configured.gemini_direct} · Gemini VM helper: ${s.providers_configured.gemini_vm_helper} · Groq: ${s.providers_configured.groq} · OpenAI: ${s.providers_configured.openai} · Anthropic: ${s.providers_configured.anthropic} · Ollama: ${esc(JSON.stringify(s.providers_configured.ollama_models))}<br>` +
      `OpenClaw gateway up: ${s.openclaw_gateway_up} · goose: ${esc(s.goose_version || 'not found')}<br>` +
      `${esc(t('fast_routing_status'))}: ${s.fast_routing ? 'ON' : 'off'} · ${esc(t('sync_peer'))}: ${s.sync.peer_configured ? 'configured' : 'not configured'} · last push ${esc(s.sync.last_push_sent || 'never')} · last pull ${esc(s.sync.last_pull || 'never')} · conflicts ${s.sync.conflicts}<br>` +
      `DB — ${esc(t('counts_messages'))} ${s.counts.messages} · ${esc(t('counts_jobs'))} ${s.counts.jobs} · ${esc(t('counts_notes'))} ${s.counts.notes} · ${esc(t('counts_approvals'))} ${s.counts.approvals_pending} · ${esc(t('counts_notifications'))} ${s.counts.notifications_unread} · ${esc(t('counts_replay'))} ${s.counts.replay_sessions}`;
  } catch (e) { sectionError('status', e, loadStatus); }
}
const KEY_VARS = { gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
// H-9: snapshot typed (unsaved) key inputs so a settings re-render never
// wipes them. Keys are never echoed back by the server, so a rebuilt
// password input is always empty — restoring the typed value preserves
// in-progress work. [data-field] inputs are NOT restored: after a save
// the server is the source of truth for those.
function snapshotTypedKeys() {
  const snap = {};
  document.querySelectorAll('#settings-box [data-key]').forEach(el => { if (el.value) snap[el.dataset.key] = el.value; });
  return snap;
}
function restoreTypedKeys(snap) {
  document.querySelectorAll('#settings-box [data-key]').forEach(el => { if (snap[el.dataset.key] && !el.value) el.value = snap[el.dataset.key]; });
}
async function loadSettings(opts = {}) {
  const preserveKeys = opts.preserveKeys !== false;
  const typedKeys = preserveKeys ? snapshotTypedKeys() : {};
  const box = document.getElementById('settings');
  try {
    const s = await api('/api/settings/providers');
    // H-5: the editable input gets the CONFIGURED order (what was saved,
    // including providers with no key yet); the resolved chain is shown
    // read-only below the form. Pre-filling with the resolved chain and
    // saving it back silently dropped unconfigured providers.
    document.getElementById('order-input').value = (s.configured_order || s.order).join(',');
    document.getElementById('order-resolved').textContent = `${t('order_resolved')} ${s.order.join(' → ')}`;
    document.getElementById('fast-routing').checked = !!s.fast_routing;
    box.innerHTML = s.providers.map(p => {
      const test = p.lastTest ? (p.lastTest.ok ? `last test OK · ${esc(p.lastTest.model || '')} · ${p.lastTest.ms}ms · ${esc(p.lastTest.at || '')}` : `last test FAILED · ${esc(p.lastTest.error || '')}`) : 'never tested';
      let fields = '';
      if (KEY_VARS[p.id]) fields += `<input type="password" data-key="${KEY_VARS[p.id]}" placeholder="Paste new key here (leave blank to keep current)" autocomplete="off" maxlength="500"> <button data-remove-key="${KEY_VARS[p.id]}">${esc(t('remove_key'))}</button>`;
      if (p.baseUrl !== undefined) fields += `<input data-field="OPENAI_BASE_URL" value="${esc(p.baseUrl)}" placeholder="Base URL — empty = api.openai.com, or any OpenAI-compatible endpoint" maxlength="500">`;
      if (p.model !== undefined) fields += `<input data-field="${p.id === 'openai' ? 'OPENAI_MODEL' : p.id === 'anthropic' ? 'ANTHROPIC_MODEL' : 'OLLAMA_MODEL'}" value="${esc(p.model)}" placeholder="Model" maxlength="200">`;
      if (p.maxTokens !== undefined) fields += `<input data-field="ANTHROPIC_MAX_TOKENS" value="${esc(p.maxTokens)}" placeholder="Max tokens" maxlength="10">`;
      if (p.host !== undefined) fields += `<input data-field="OLLAMA_HOST" value="${esc(p.host)}" placeholder="Ollama host (empty = http://127.0.0.1:11434)" maxlength="500">`;
      return `<div class="provider"><b>${esc(p.label)}</b> ${p.freeTier ? '(free tier available)' : '(paid)'}<br>` +
        `<small>${esc(p.note)}</small><br>` +
        `Status: ${p.configured ? `configured ${esc(p.masked || '')}` : 'missing'} · ${test}` +
        (p.keyUrl ? ` · <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">get a key</a>` : '') +
        `<br>${fields} <button data-test-provider="${p.id}">${esc(t('test_connection'))}</button> <span data-test-result="${p.id}" role="status"></span></div>`;
    }).join('');
    document.getElementById('channels').innerHTML =
      `<p>Telegram — token ${s.channels.telegram.tokenConfigured ? `configured ${esc(s.channels.telegram.tokenMasked || '')}` : 'missing'} · chat id ${esc(s.channels.telegram.chatId || 'not set')}</p>` +
      `<input type="password" data-key="TELEGRAM_BOT_TOKEN" placeholder="Telegram bot token (from @BotFather)" autocomplete="off" maxlength="500"> ` +
      `<input data-field="TELEGRAM_CHAT_ID" value="${esc(s.channels.telegram.chatId)}" placeholder="Telegram chat id" maxlength="20"> ` +
      `<select data-field="TELEGRAM_TRANSPORT" title="Telegram transport — takes effect on restart"><option value="polling"${s.channels.telegram.transport !== 'grammy' ? ' selected' : ''}>polling (built-in)</option><option value="grammy"${s.channels.telegram.transport === 'grammy' ? ' selected' : ''}>grammy</option></select> ` +
      `<p>Sync — peer ${esc(s.channels.sync.peerUrl || 'not set')} · token ${s.channels.sync.tokenConfigured ? `configured ${esc(s.channels.sync.tokenMasked || '')}` : 'missing'}</p>` +
      `<input data-field="SYNC_PEER_URL" value="${esc(s.channels.sync.peerUrl)}" placeholder="Sync peer URL (https, or http to Tailscale 100.x)" maxlength="500"> ` +
      `<input type="password" data-key="SYNC_TOKEN" placeholder="Sync token" autocomplete="off" maxlength="500">`;
    restoreTypedKeys(typedKeys);
    box.querySelectorAll('[data-test-provider]').forEach(b => b.addEventListener('click', async () => {
      const out = document.querySelector(`[data-test-result="${b.dataset.testProvider}"]`);
      out.textContent = 'testing…';
      try {
        const r = await api('/api/settings/test', { method: 'POST', body: JSON.stringify({ provider: b.dataset.testProvider }) });
        out.textContent = `OK · ${r.model} · ${r.ms}ms`;
      } catch (e) { out.textContent = 'FAILED: ' + e.message; }
      // H-8/H-9: NO loadSettings() here — re-rendering would destroy
      // this result text and wipe any key the user is typing. The
      // per-provider "last test" line refreshes on the next full load.
    }));
    box.querySelectorAll('[data-remove-key]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`Remove ${b.dataset.removeKey}? The key is deleted from .env.local.`)) return;
      await api('/api/settings/providers', { method: 'POST', body: JSON.stringify({ updates: { [b.dataset.removeKey]: '' } }) });
      loadSettings();
    }));
  } catch (e) { sectionError(box, e, loadSettings); }
}
// Save handler at top level (H-8): the button + result span are static
// HTML outside the re-rendered containers, so the feedback text survives
// the reload that follows a successful save.
document.getElementById('save-settings').addEventListener('click', async () => {
  const updates = {};
  document.querySelectorAll('#settings-box [data-key]').forEach(el => { if (el.value) updates[el.dataset.key] = el.value; });
  document.querySelectorAll('#settings-box [data-field]').forEach(el => { updates[el.dataset.field] = el.value; });
  const out = document.getElementById('settings-result');
  try {
    const r = await api('/api/settings/providers', { method: 'POST', body: JSON.stringify({ updates }) });
    out.textContent = `Saved: ${r.changed.join(', ') || 'nothing changed'}`;
    loadSettings({ preserveKeys: false }); loadStatus();
  } catch (e) {
    out.textContent = 'Save failed: ' + e.message;
    // No reload on failure: typed values stay put for a retry (H-9).
  }
});
document.getElementById('order-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/settings/order', { method: 'POST', body: JSON.stringify({ order: document.getElementById('order-input').value }) });
    document.getElementById('settings-result').textContent = t('order_saved');
    loadSettings(); loadStatus();
  }
  catch (err) { alert('Order save failed: ' + err.message); }
});
document.getElementById('fast-routing').addEventListener('change', async e => {
  await api('/api/settings/fast-routing', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) });
  loadStatus();
});
async function loadNotifications() {
  try {
    const j = await api('/api/notifications');
    document.getElementById('notifications').innerHTML = j.notifications.map(x =>
      `<li><b>${esc(x.title)}</b> — ${esc(x.body)} <small>(${esc(x.source || '')} · ${esc(x.created_at)}${x.read_at ? ' · read' : ''})</small> ${x.read_at ? '' : `<button data-notif-read="${x.id}">${esc(t('mark_read'))}</button>`}</li>`).join('') || `<li>${esc(t('no_notifications'))}</li>`;
    document.querySelectorAll('[data-notif-read]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/notifications/${b.dataset.notifRead}/read`, { method: 'POST', body: '{}' });
      loadNotifications();
    }));
  } catch (e) { sectionError('notifications', e, loadNotifications); }
}
async function loadSync() {
  try {
    const s = await api('/api/sync/status');
    document.getElementById('sync-status').innerHTML =
      `This device: ${esc(s.device_id)}<br>` +
      `Peer: ${s.peer_configured ? esc(s.peer_url || '') : 'not configured — set SYNC_PEER_URL + SYNC_TOKEN in Settings to sync with the cloud node'}<br>` +
      `Last push sent: ${esc(s.last_push_sent || 'never')} · last push received: ${esc(s.last_push_received || 'never')} · last pull: ${esc(s.last_pull || 'never')} · conflicts: ${s.conflicts}<br>` +
      `Synced tables: ${esc(s.synced_tables.join(', '))} · Never synced: ${esc(s.never_synced.join(', '))}<br><small>${esc(s.note)}</small>`;
  } catch (e) { sectionError('sync-status', e, loadSync); }
}
async function loadShot(stepId, imgEl) {
  const r = await fetch(`/api/replay/shot/${stepId}`, { headers: H });
  if (!r.ok) { imgEl.alt = 'screenshot unavailable (pruned or never recorded)'; return; }
  const blob = await r.blob();
  imgEl.src = URL.createObjectURL(blob);
}
async function loadReplay() {
  try {
    const j = await api('/api/replay');
    document.getElementById('replay').innerHTML = j.sessions.map(x =>
      `<li>#${x.id} ${esc(x.task)} — ${esc(x.status)} · ${x.steps} steps · ${esc(x.created_at)} <button data-replay-view="${x.id}">${esc(t('view'))}</button> <button data-replay-delete="${x.id}">${esc(t('delete_session'))}</button></li>`).join('') || `<li>${esc(t('no_replay'))}</li>`;
    document.querySelectorAll('[data-replay-view]').forEach(b => b.addEventListener('click', async () => {
      const s = await api(`/api/replay/${b.dataset.replayView}`);
      const detail = document.getElementById('replay-detail');
      detail.innerHTML = `<h3>Session #${s.session.id} — ${esc(s.session.task)}</h3>` +
        s.session.steps.map(st =>
          `<div class="step"><b>Step ${st.step_index}:</b> ${esc(st.action)} <small>${esc(st.args_json)} · ${st.latency_ms ?? '?'}ms · hash ${esc((st.screenshot_hash || '').slice(0, 12))}</small><br>` +
          (st.shot_path ? `<img data-shot="${st.id}" alt="step screenshot">` : '<small>no screenshot</small>') + `</div>`).join('') +
        `<button id="replay-run">Verified replay this session</button> <span id="replay-run-result"></span>`;
      detail.querySelectorAll('[data-shot]').forEach(img => loadShot(img.dataset.shot, img));
      document.getElementById('replay-run').addEventListener('click', async () => {
        const out = document.getElementById('replay-run-result');
        out.textContent = 'replaying…';
        try {
          const r = await api(`/api/replay/${s.session.id}/replay`, { method: 'POST', body: JSON.stringify({}) });
          out.textContent = r.done ? `Replayed ${r.matched}/${r.total} steps.` : `Stopped at step ${r.stoppedAt}: ${r.reason}`;
        } catch (e) { out.textContent = 'Replay failed: ' + e.message; }
      });
    }));
    document.querySelectorAll('[data-replay-delete]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Purge this session and its screenshots? This cannot be undone.')) return;
      await api(`/api/replay/${b.dataset.replayDelete}`, { method: 'DELETE' });
      loadReplay();
    }));
  } catch (e) { sectionError('replay', e, loadReplay); }
}
document.getElementById('refresh-notifications').addEventListener('click', loadNotifications);
document.getElementById('refresh-sync').addEventListener('click', loadSync);
document.getElementById('refresh-replay').addEventListener('click', loadReplay);
async function loadJobs() {
  try {
    const j = await api('/api/jobs');
    document.getElementById('jobs').innerHTML = j.jobs.map(x =>
      `<li>#${x.id} ${esc(x.task)} — ${esc(x.status)} · ${esc(x.model || '')} / ${esc(x.provider || '')} · ${esc(x.created_at)}</li>`).join('') || `<li>${esc(t('no_jobs'))}</li>`;
  } catch (e) { sectionError('jobs', e, loadJobs); }
}
async function loadSkills() {
  try {
    const j = await api('/api/skills');
    const label = { active: t('skills_status_active'), draft: t('skills_status_draft'), changed: t('skills_status_changed'), invalid: t('skills_status_invalid') };
    document.getElementById('skills').innerHTML = j.skills.map(x =>
      `<li><b>${esc(x.name)}</b> — ${esc(x.description)} · ${esc(label[x.status] || x.status)}${x.reason ? ` <small>(${esc(x.reason)})</small>` : ''}</li>`).join('') || `<li>${esc(t('no_skills'))}</li>`;
  } catch (e) { sectionError('skills', e, loadSkills); }
}
async function verifyAudit() {
  const out = document.getElementById('audit-result');
  try {
    const v = await api('/api/audit/verify');
    out.textContent = v.ok
      ? `${t('audit_chain_ok')} — ${v.checked} chained entries verified, ${v.unchained} legacy unchained, ${v.total} total.`
      : `${t('audit_chain_failed')} — first bad entry #${v.firstBadId}: ${v.reason}`;
  } catch (e) { out.textContent = 'Verify failed: ' + e.message; }
}
async function showReceipt() {
  const pre = document.getElementById('receipt');
  try {
    const r = await fetch('/api/audit/receipt?format=md', { headers: H });
    pre.textContent = await r.text();
  } catch (e) { pre.textContent = 'Receipt failed: ' + e.message; }
}
document.getElementById('refresh-skills').addEventListener('click', loadSkills);
document.getElementById('verify-audit').addEventListener('click', verifyAudit);
document.getElementById('show-receipt').addEventListener('click', showReceipt);
async function loadApprovals() {
  try {
    const j = await api('/api/approvals');
    // H-6: pending approvals can be decided from the UI. Deciding only
    // records the decision — it never executes the action (the server
    // enforces that; the note in each row says so).
    document.getElementById('approvals').innerHTML = j.approvals.map(x =>
      `<li>#${x.id} ${esc(x.action)} — ${esc(x.status)} · ${esc(x.details)}` +
      (x.status === 'pending'
        ? ` <button data-approval-decide="${x.id}" data-decision="approved">${esc(t('approve'))}</button> <button data-approval-decide="${x.id}" data-decision="rejected">${esc(t('reject'))}</button> <small>${esc(t('approval_decide_note'))}</small>`
        : '') + `</li>`).join('') || `<li>${esc(t('no_approvals'))}</li>`;
    document.querySelectorAll('[data-approval-decide]').forEach(b => b.addEventListener('click', async () => {
      try {
        await api(`/api/approvals/${b.dataset.approvalDecide}/decide`, { method: 'POST', body: JSON.stringify({ status: b.dataset.decision }) });
        loadApprovals();
      } catch (e) { alert('Decide failed: ' + e.message); }
    }));
  } catch (e) { sectionError('approvals', e, loadApprovals); }
}
async function loadNotes() {
  try {
    const j = await api('/api/notes');
    document.getElementById('notes').innerHTML = j.notes.map(x =>
      `<li><b>${esc(x.title)}</b> — ${esc(x.body)}</li>`).join('') || `<li>${esc(t('no_notes'))}</li>`;
  } catch (e) { sectionError('notes', e, loadNotes); }
}
// Memory facts (cycle 4): view, forget (permanent delete), and inline
// edit. Each fact shows its source + date — its citation.
async function loadMemoryFacts() {
  try {
    const j = await api('/api/memory');
    const list = document.getElementById('memory-facts');
    list.innerHTML = j.facts.map(x =>
      `<li><b>${esc(x.topic || '—')}</b> — ${esc(x.content)} <small>(${esc(x.source || '')} · ${esc(x.created_at)})</small> ` +
      `<button data-memory-edit="${x.id}">${esc(t('memory_edit'))}</button> <button data-memory-forget="${x.id}">${esc(t('memory_forget'))}</button></li>`
    ).join('') || `<li>${esc(t('no_memory'))}</li>`;
    list.querySelectorAll('[data-memory-forget]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/memory/${b.dataset.memoryForget}`, { method: 'DELETE' });
      loadMemoryFacts();
    }));
    list.querySelectorAll('[data-memory-edit]').forEach(b => b.addEventListener('click', () => {
      const li = b.closest('li');
      const fact = j.facts.find(f => String(f.id) === b.dataset.memoryEdit);
      li.innerHTML = `<input id="memory-edit-input" maxlength="2000" value="${esc(fact.content)}"> <button data-memory-save>${esc(t('memory_save'))}</button> <button data-memory-cancel>${esc(t('memory_cancel'))}</button>`;
      li.querySelector('[data-memory-save]').addEventListener('click', async () => {
        await api(`/api/memory/${fact.id}`, { method: 'PUT', body: JSON.stringify({ content: li.querySelector('#memory-edit-input').value }) });
        loadMemoryFacts();
      });
      li.querySelector('[data-memory-cancel]').addEventListener('click', loadMemoryFacts);
    }));
  } catch (e) { sectionError('memory-facts', e, loadMemoryFacts); }
}
// Chat messages are appended as nodes (appendChild, not re-rendering the
// whole history), so a long chat stays fast. A pending bubble
// shows while the brain works, so the page never looks stuck.
function addMsg(html) {
  const box = document.getElementById('messages');
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const node = tmp.firstChild;
  box.appendChild(node);
  box.scrollTop = box.scrollHeight;
  return node;
}
document.getElementById('chat-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim(); if (!text) return;
  input.value = '';
  addMsg(`<div class="msg"><b>${esc(t('you'))}:</b> ${esc(text)}</div>`);
  const pending = addMsg(`<div class="msg pending"><b>AI:</b> ${esc(t('thinking'))}</div>`);
  try {
    const r = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text }) });
    pending.remove();
    addMsg(`<div class="msg"><b>AI (${esc(r.model)} / ${esc(r.provider)}):</b> ${esc(r.reply)}<br><small>Actions: ${esc(JSON.stringify(r.actions))} · ${r.latencyMs ?? '?'}ms${r.route ? ` · route ${esc(r.route)}` : ''}</small></div>`);
  } catch (err) {
    pending.remove();
    addMsg(`<div class="msg"><b>${esc(t('error_label'))}:</b> ${esc(err.message)}</div>`);
  }
  loadJobs();
});
document.getElementById('refresh-jobs').addEventListener('click', loadJobs);
document.getElementById('approval-form').addEventListener('submit', async e => {
  e.preventDefault();
  await api('/api/approvals', { method: 'POST', body: JSON.stringify({ action: document.getElementById('ap-action').value, details: document.getElementById('ap-details').value }) });
  loadApprovals();
});
document.getElementById('note-form').addEventListener('submit', async e => {
  e.preventDefault();
  await api('/api/notes', { method: 'POST', body: JSON.stringify({ title: document.getElementById('note-title').value, body: document.getElementById('note-body').value }) });
  loadNotes();
});
document.getElementById('memory-form').addEventListener('submit', async e => {
  e.preventDefault();
  await api('/api/memory', { method: 'POST', body: JSON.stringify({ topic: document.getElementById('memory-topic').value, content: document.getElementById('memory-content').value }) });
  document.getElementById('memory-topic').value = '';
  document.getElementById('memory-content').value = '';
  loadMemoryFacts();
});
async function loadFreeze() {
  try {
    const f = await api('/api/freeze');
    document.getElementById('freeze-state').textContent = f.frozen ? `${t('frozen_state')} ${f.frozen_at || ''} (${f.reason || ''})` : t('running_state');
    document.getElementById('freeze-btn').textContent = f.frozen ? t('unfreeze') : t('freeze');
  } catch (e) { sectionError('freeze-state', e, loadFreeze); }
}
async function loadQueue() {
  try {
    const q = await api('/api/queue');
    document.getElementById('queue').innerHTML =
      `<li>pending ${q.counts.pending} · processing ${q.counts.processing} · done ${q.counts.done} · dead ${q.counts.dead}</li>` +
      q.items.map(x => `<li>#${x.id} ${esc(x.kind)} — ${esc(x.status)} · attempts ${x.attempts}/${x.max_attempts} · next retry ${esc(x.next_retry_at || '')}</li>`).join('');
  } catch (e) { sectionError('queue', e, loadQueue); }
}
async function loadRoutines() {
  try {
    const r = await api('/api/routines');
    document.getElementById('routines').innerHTML = r.routines.map(x =>
      `<li>#${x.id} <b>${esc(x.name)}</b> — ${esc(JSON.stringify(x.schedule))} · ${x.enabled ? 'enabled' : 'disabled'} · next run ${esc(x.next_run_at || '')} <button data-routine-run="${x.id}">${esc(t('run_now_dry'))}</button></li>`).join('') || `<li>${esc(t('no_routines'))}</li>`;
    document.querySelectorAll('[data-routine-run]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/routines/${b.dataset.routineRun}/run`, { method: 'POST', body: JSON.stringify({ dry_run: true }) });
      loadRoutines();
    }));
  } catch (e) { sectionError('routines', e, loadRoutines); }
}
document.getElementById('freeze-btn').addEventListener('click', async () => {
  const f = await api('/api/freeze');
  await api('/api/freeze', { method: 'POST', body: JSON.stringify({ frozen: !f.frozen, reason: 'web UI button' }) });
  loadFreeze();
});
document.getElementById('refresh-queue').addEventListener('click', loadQueue);
document.getElementById('drain-queue').addEventListener('click', async () => { await api('/api/queue/drain', { method: 'POST', body: '{}' }); loadQueue(); });
document.getElementById('routine-form').addEventListener('submit', async e => {
  e.preventDefault();
  const time = document.getElementById('routine-time').value.trim();
  await api('/api/routines', { method: 'POST', body: JSON.stringify({ name: document.getElementById('routine-name').value, task: document.getElementById('routine-task').value, schedule: { type: 'daily', time } }) });
  loadRoutines();
});
document.getElementById('lang-select').addEventListener('change', e => {
  lang = I18N.STRINGS[e.target.value] ? e.target.value : 'en';
  localStorage.setItem('piplet_lang', lang);
  applyLang();
  // H-9: no loadAll() here — re-rendering every section wiped keys the
  // user was typing in Settings. Static chrome switches immediately;
  // list contents switch language on their next refresh.
});
applyLang();
(async () => {
  // Desktop app: the preload bridge hands over the session token, so
  // the owner is never prompted. A bridge failure falls through to the
  // no-token state below (plain message, no 401 storm) instead of
  // hanging the page.
  if (!token && window.piplet && window.piplet.getToken) {
    try { token = await window.piplet.getToken(); } catch { token = ''; }
    if (token) {
      sessionStorage.setItem('anku_token', token);
      H = { 'Content-Type': 'application/json', 'X-Anku-Token': token };
    }
  }
  if (!token) {
    // No token (prompt cancelled / bridge unavailable): say so plainly
    // instead of firing eleven calls that all 401. Refreshing the page
    // asks for the token again.
    document.getElementById('status').textContent = t('token_missing');
  } else {
    loadAll();
  }
})();
