// Frontend for Ankush's personal AI. Token is NOT hard-coded here — paste it
// once in the prompt (it lives in .env.local on the server). No external CDN,
// no tracking, no data leaves 127.0.0.1.
let token = sessionStorage.getItem('anku_token') || '';
if (!token) {
  token = prompt('Piplet token (from .env.local in the app folder):') || '';
  sessionStorage.setItem('anku_token', token);
}
const H = { 'Content-Type': 'application/json', 'X-Anku-Token': token };
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
async function loadStatus() {
  try {
    const s = await api('/api/status');
    document.getElementById('status').innerHTML =
      `Brain order: ${esc(s.brain_order.join(' → '))}<br>` +
      `Gemini direct: ${s.providers_configured.gemini_direct} · Gemini VM helper: ${s.providers_configured.gemini_vm_helper} · Groq: ${s.providers_configured.groq} · OpenAI: ${s.providers_configured.openai} · Anthropic: ${s.providers_configured.anthropic} · Ollama: ${esc(JSON.stringify(s.providers_configured.ollama_models))}<br>` +
      `OpenClaw gateway up: ${s.openclaw_gateway_up} · goose: ${esc(s.goose_version || 'not found')}<br>` +
      `Fast routing: ${s.fast_routing ? 'ON' : 'off'} · Sync peer: ${s.sync.peer_configured ? 'configured' : 'not configured'} · last push ${esc(s.sync.last_push_sent || 'never')} · last pull ${esc(s.sync.last_pull || 'never')} · conflicts ${s.sync.conflicts}<br>` +
      `DB — messages ${s.counts.messages} · jobs ${s.counts.jobs} · notes ${s.counts.notes} · approvals pending ${s.counts.approvals_pending} · notifications unread ${s.counts.notifications_unread} · replay sessions ${s.counts.replay_sessions}`;
  } catch (e) { document.getElementById('status').textContent = 'Status failed: ' + e.message + ' — is the token right?'; }
}
const KEY_VARS = { gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
async function loadSettings() {
  const box = document.getElementById('settings');
  try {
    const s = await api('/api/settings/providers');
    document.getElementById('order-input').value = s.order.join(',');
    document.getElementById('fast-routing').checked = !!s.fast_routing;
    box.innerHTML = s.providers.map(p => {
      const test = p.lastTest ? (p.lastTest.ok ? `last test OK · ${esc(p.lastTest.model || '')} · ${p.lastTest.ms}ms · ${esc(p.lastTest.at || '')}` : `last test FAILED · ${esc(p.lastTest.error || '')}`) : 'never tested';
      let fields = '';
      if (KEY_VARS[p.id]) fields += `<input type="password" data-key="${KEY_VARS[p.id]}" placeholder="Paste new key here (leave blank to keep current)" autocomplete="off" maxlength="500"> <button data-remove-key="${KEY_VARS[p.id]}">Remove key</button>`;
      if (p.baseUrl !== undefined) fields += `<input data-field="OPENAI_BASE_URL" value="${esc(p.baseUrl)}" placeholder="Base URL — empty = api.openai.com, or any OpenAI-compatible endpoint" maxlength="500">`;
      if (p.model !== undefined) fields += `<input data-field="${p.id === 'openai' ? 'OPENAI_MODEL' : p.id === 'anthropic' ? 'ANTHROPIC_MODEL' : 'OLLAMA_MODEL'}" value="${esc(p.model)}" placeholder="Model" maxlength="200">`;
      if (p.maxTokens !== undefined) fields += `<input data-field="ANTHROPIC_MAX_TOKENS" value="${esc(p.maxTokens)}" placeholder="Max tokens" maxlength="10">`;
      if (p.host !== undefined) fields += `<input data-field="OLLAMA_HOST" value="${esc(p.host)}" placeholder="Ollama host (empty = http://127.0.0.1:11434)" maxlength="500">`;
      return `<div class="provider"><b>${esc(p.label)}</b> ${p.freeTier ? '(free tier available)' : '(paid)'}<br>` +
        `<small>${esc(p.note)}</small><br>` +
        `Status: ${p.configured ? `configured ${esc(p.masked || '')}` : 'missing'} · ${test}` +
        (p.keyUrl ? ` · <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">get a key</a>` : '') +
        `<br>${fields} <button data-test-provider="${p.id}">Test connection</button> <span data-test-result="${p.id}"></span></div>`;
    }).join('');
    document.getElementById('channels').innerHTML =
      `<p>Telegram — token ${s.channels.telegram.tokenConfigured ? `configured ${esc(s.channels.telegram.tokenMasked || '')}` : 'missing'} · chat id ${esc(s.channels.telegram.chatId || 'not set')}</p>` +
      `<input type="password" data-key="TELEGRAM_BOT_TOKEN" placeholder="Telegram bot token (from @BotFather)" autocomplete="off" maxlength="500"> ` +
      `<input data-field="TELEGRAM_CHAT_ID" value="${esc(s.channels.telegram.chatId)}" placeholder="Telegram chat id" maxlength="20"> ` +
      `<p>Sync — peer ${esc(s.channels.sync.peerUrl || 'not set')} · token ${s.channels.sync.tokenConfigured ? `configured ${esc(s.channels.sync.tokenMasked || '')}` : 'missing'}</p>` +
      `<input data-field="SYNC_PEER_URL" value="${esc(s.channels.sync.peerUrl)}" placeholder="Sync peer URL (https, or http to Tailscale 100.x)" maxlength="500"> ` +
      `<input type="password" data-key="SYNC_TOKEN" placeholder="Sync token" autocomplete="off" maxlength="500"> ` +
      `<button id="save-settings">Save all settings</button> <span id="settings-result"></span>`;
    box.querySelectorAll('[data-test-provider]').forEach(b => b.addEventListener('click', async () => {
      const out = document.querySelector(`[data-test-result="${b.dataset.testProvider}"]`);
      out.textContent = 'testing…';
      try {
        const r = await api('/api/settings/test', { method: 'POST', body: JSON.stringify({ provider: b.dataset.testProvider }) });
        out.textContent = `OK · ${r.model} · ${r.ms}ms`;
      } catch (e) { out.textContent = 'FAILED: ' + e.message; }
      loadSettings();
    }));
    box.querySelectorAll('[data-remove-key]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`Remove ${b.dataset.removeKey}? The key is deleted from .env.local.`)) return;
      await api('/api/settings/providers', { method: 'POST', body: JSON.stringify({ updates: { [b.dataset.removeKey]: '' } }) });
      loadSettings();
    }));
    document.getElementById('save-settings').addEventListener('click', async () => {
      const updates = {};
      document.querySelectorAll('#settings-box [data-key]').forEach(el => { if (el.value) updates[el.dataset.key] = el.value; });
      document.querySelectorAll('#settings-box [data-field]').forEach(el => { updates[el.dataset.field] = el.value; });
      const out = document.getElementById('settings-result');
      try {
        const r = await api('/api/settings/providers', { method: 'POST', body: JSON.stringify({ updates }) });
        out.textContent = `Saved: ${r.changed.join(', ') || 'nothing changed'}`;
      } catch (e) { out.textContent = 'Save failed: ' + e.message; }
      loadSettings(); loadStatus();
    });
  } catch (e) { box.textContent = 'Settings failed: ' + e.message; }
}
document.getElementById('order-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/settings/order', { method: 'POST', body: JSON.stringify({ order: document.getElementById('order-input').value }) }); loadStatus(); }
  catch (err) { alert('Order save failed: ' + err.message); }
});
document.getElementById('fast-routing').addEventListener('change', async e => {
  await api('/api/settings/fast-routing', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) });
  loadStatus();
});
async function loadNotifications() {
  const j = await api('/api/notifications');
  document.getElementById('notifications').innerHTML = j.notifications.map(x =>
    `<li><b>${esc(x.title)}</b> — ${esc(x.body)} <small>(${esc(x.source || '')} · ${esc(x.created_at)}${x.read_at ? ' · read' : ''})</small> ${x.read_at ? '' : `<button data-notif-read="${x.id}">Mark read</button>`}</li>`).join('') || '<li>No notifications.</li>';
  document.querySelectorAll('[data-notif-read]').forEach(b => b.addEventListener('click', async () => {
    await api(`/api/notifications/${b.dataset.notifRead}/read`, { method: 'POST', body: '{}' });
    loadNotifications();
  }));
}
async function loadSync() {
  const s = await api('/api/sync/status');
  document.getElementById('sync-status').innerHTML =
    `This device: ${esc(s.device_id)}<br>` +
    `Peer: ${s.peer_configured ? esc(s.peer_url || '') : 'not configured — set SYNC_PEER_URL + SYNC_TOKEN in Settings to sync with the cloud node'}<br>` +
    `Last push sent: ${esc(s.last_push_sent || 'never')} · last push received: ${esc(s.last_push_received || 'never')} · last pull: ${esc(s.last_pull || 'never')} · conflicts: ${s.conflicts}<br>` +
    `Synced tables: ${esc(s.synced_tables.join(', '))} · Never synced: ${esc(s.never_synced.join(', '))}<br><small>${esc(s.note)}</small>`;
}
async function loadShot(stepId, imgEl) {
  const r = await fetch(`/api/replay/shot/${stepId}`, { headers: H });
  if (!r.ok) { imgEl.alt = 'screenshot unavailable (pruned or never recorded)'; return; }
  const blob = await r.blob();
  imgEl.src = URL.createObjectURL(blob);
}
async function loadReplay() {
  const j = await api('/api/replay');
  document.getElementById('replay').innerHTML = j.sessions.map(x =>
    `<li>#${x.id} ${esc(x.task)} — ${esc(x.status)} · ${x.steps} steps · ${esc(x.created_at)} <button data-replay-view="${x.id}">View</button> <button data-replay-delete="${x.id}">Delete (purge screenshots)</button></li>`).join('') || '<li>No screen sessions recorded yet.</li>';
  document.querySelectorAll('[data-replay-view]').forEach(b => b.addEventListener('click', async () => {
    const s = await api(`/api/replay/${b.dataset.replayView}`);
    const detail = document.getElementById('replay-detail');
    detail.innerHTML = `<h3>Session #${s.session.id} — ${esc(s.session.task)}</h3>` +
      s.session.steps.map(st =>
        `<div class="step"><b>Step ${st.step_index}:</b> ${esc(st.action)} <small>${esc(st.args_json)} · ${st.latency_ms ?? '?'}ms · hash ${esc((st.screenshot_hash || '').slice(0, 12))}</small><br>` +
        (st.shot_path ? `<img data-shot="${st.id}" alt="step screenshot" style="max-width:480px">` : '<small>no screenshot</small>') + `</div>`).join('') +
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
}
document.getElementById('refresh-notifications').addEventListener('click', loadNotifications);
document.getElementById('refresh-sync').addEventListener('click', loadSync);
document.getElementById('refresh-replay').addEventListener('click', loadReplay);
async function loadJobs() {
  const j = await api('/api/jobs');
  document.getElementById('jobs').innerHTML = j.jobs.map(x =>
    `<li>#${x.id} ${esc(x.task)} — ${esc(x.status)} · ${esc(x.model || '')} / ${esc(x.provider || '')} · ${esc(x.created_at)}</li>`).join('') || '<li>No jobs yet.</li>';
}
async function loadApprovals() {
  const j = await api('/api/approvals');
  document.getElementById('approvals').innerHTML = j.approvals.map(x =>
    `<li>#${x.id} ${esc(x.action)} — ${esc(x.status)} · ${esc(x.details)}</li>`).join('') || '<li>No approvals yet.</li>';
}
async function loadNotes() {
  const j = await api('/api/notes');
  document.getElementById('notes').innerHTML = j.notes.map(x =>
    `<li><b>${esc(x.title)}</b> — ${esc(x.body)}</li>`).join('') || '<li>No notes yet.</li>';
}
document.getElementById('chat-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim(); if (!text) return;
  input.value = '';
  const box = document.getElementById('messages');
  box.innerHTML += `<div class="msg"><b>You:</b> ${esc(text)}</div>`;
  try {
    const r = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text }) });
    box.innerHTML += `<div class="msg"><b>AI (${esc(r.model)} / ${esc(r.provider)}):</b> ${esc(r.reply)}<br><small>Actions: ${esc(JSON.stringify(r.actions))} · ${r.latencyMs ?? '?'}ms${r.route ? ` · route ${esc(r.route)}` : ''}</small></div>`;
  } catch (err) { box.innerHTML += `<div class="msg"><b>Error:</b> ${esc(err.message)}</div>`; }
  box.scrollTop = box.scrollHeight; loadJobs();
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
async function loadFreeze() {
  const f = await api('/api/freeze');
  document.getElementById('freeze-state').textContent = f.frozen ? `FROZEN since ${esc(f.frozen_at || '')} (${esc(f.reason || '')})` : 'Running (not frozen)';
  document.getElementById('freeze-btn').textContent = f.frozen ? 'Unfreeze agent' : 'Freeze agent';
}
async function loadQueue() {
  const q = await api('/api/queue');
  document.getElementById('queue').innerHTML =
    `<li>pending ${q.counts.pending} · processing ${q.counts.processing} · done ${q.counts.done} · dead ${q.counts.dead}</li>` +
    q.items.map(x => `<li>#${x.id} ${esc(x.kind)} — ${esc(x.status)} · attempts ${x.attempts}/${x.max_attempts} · next retry ${esc(x.next_retry_at || '')}</li>`).join('');
}
async function loadRoutines() {
  const r = await api('/api/routines');
  document.getElementById('routines').innerHTML = r.routines.map(x =>
    `<li>#${x.id} <b>${esc(x.name)}</b> — ${esc(JSON.stringify(x.schedule))} · ${x.enabled ? 'enabled' : 'disabled'} · next run ${esc(x.next_run_at || '')} <button data-routine-run="${x.id}">Run now (dry)</button></li>`).join('') || '<li>No routines yet.</li>';
  document.querySelectorAll('[data-routine-run]').forEach(b => b.addEventListener('click', async () => {
    await api(`/api/routines/${b.dataset.routineRun}/run`, { method: 'POST', body: JSON.stringify({ dry_run: true }) });
    loadRoutines();
  }));
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
loadStatus(); loadJobs(); loadApprovals(); loadNotes(); loadFreeze(); loadQueue(); loadRoutines(); loadSettings(); loadNotifications(); loadSync(); loadReplay();
