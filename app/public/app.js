// Frontend for Ankush's personal AI. Token is NOT hard-coded here — paste it
// once in the prompt (it lives in .env.local on the server). No external CDN,
// no tracking, no data leaves 127.0.0.1.
let token = sessionStorage.getItem('anku_token') || '';
if (!token) {
  token = prompt('Personal AI token (from .env.local in the app folder):') || '';
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
      `DB — messages ${s.counts.messages} · jobs ${s.counts.jobs} · notes ${s.counts.notes} · approvals pending ${s.counts.approvals_pending}`;
  } catch (e) { document.getElementById('status').textContent = 'Status failed: ' + e.message + ' — is the token right?'; }
}
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
    box.innerHTML += `<div class="msg"><b>AI (${esc(r.model)} / ${esc(r.provider)}):</b> ${esc(r.reply)}<br><small>Actions: ${esc(JSON.stringify(r.actions))}</small></div>`;
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
loadStatus(); loadJobs(); loadApprovals(); loadNotes(); loadFreeze(); loadQueue(); loadRoutines();
