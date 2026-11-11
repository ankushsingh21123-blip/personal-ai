// Internship Tracker — frontend. Vanilla JS, no CDN, no framework.
// Talks to the local Express API on the same origin; token is sent as
// X-Anku-Token and kept in sessionStorage (cleared when the tab closes).
'use strict';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'internship-tracker-token';

let token = sessionStorage.getItem(TOKEN_KEY) || '';

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Anku-Token': token, ...(options.headers || {}) },
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

async function loadStats() {
  const res = await api('/api/stats');
  if (!res.ok) throw new Error('stats failed: ' + res.status);
  const data = await res.json();
  $('stat-total').textContent = data.stats.total;
  $('stat-applied').textContent = data.stats.applied;
  $('stat-interview').textContent = data.stats.interview;
  $('stat-offer').textContent = data.stats.offer;
  $('stat-rejected').textContent = data.stats.rejected;
}

async function loadList() {
  const status = $('filter-status').value;
  const sort = $('sort').value;
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (sort) params.set('sort', sort);
  const res = await api('/api/applications?' + params.toString());
  if (!res.ok) throw new Error('list failed: ' + res.status);
  const data = await res.json();
  const rows = $('app-rows');
  rows.innerHTML = '';
  $('empty').hidden = data.applications.length !== 0;
  for (const a of data.applications) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + escapeHtml(a.company) + '</td>' +
      '<td>' + escapeHtml(a.role) + '</td>' +
      '<td><span class="badge ' + escapeHtml(a.status) + '">' + escapeHtml(a.status) + '</span></td>' +
      '<td>' + escapeHtml(a.deadline || '—') + '</td>' +
      '<td>' + (a.link ? '<a href="' + escapeHtml(a.link) + '" target="_blank" rel="noreferrer">link</a>' : '—') + '</td>' +
      '<td>' + escapeHtml(a.notes || '') + '</td>' +
      '<td><button type="button" class="mini" data-edit="' + a.id + '">Edit</button>' +
      '<button type="button" class="mini secondary" data-delete="' + a.id + '">Delete</button></td>';
    rows.appendChild(tr);
  }
}

async function refresh() {
  try {
    await loadStats();
    await loadList();
    $('list-error').hidden = true;
  } catch (e) {
    showError($('list-error'), e.message);
  }
}

function setConnected(connected) {
  $('stats-card').hidden = !connected;
  $('form-card').hidden = !connected;
  $('list-card').hidden = !connected;
  $('auth-status').textContent = connected
    ? 'Connected to the local server.'
    : 'Not connected.';
}

async function connect() {
  token = $('token').value.trim();
  if (!token) { showError($('auth-status'), 'Paste your ANKU_TOKEN first.'); return; }
  const res = await api('/api/stats');
  if (!res.ok) {
    setConnected(false);
    showError($('auth-status'), 'Token rejected (HTTP ' + res.status + '). Check .env.local.');
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, token);
  setConnected(true);
  await refresh();
}

function resetForm() {
  $('app-form').reset();
  $('edit-id').value = '';
  $('form-title').textContent = 'Add application';
  $('submit-btn').textContent = 'Add application';
  $('cancel-edit').hidden = true;
  $('form-error').hidden = true;
}

async function submitForm(e) {
  e.preventDefault();
  const id = $('edit-id').value;
  const body = {
    company: $('company').value.trim(),
    role: $('role').value.trim(),
    status: $('status').value,
    deadline: $('deadline').value || null,
    link: $('link').value.trim() || null,
    notes: $('notes').value.trim(),
  };
  const res = await api(id ? '/api/applications/' + id : '/api/applications', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showError($('form-error'), data.error || ('save failed: ' + res.status)); return; }
  resetForm();
  await refresh();
}

async function onTableClick(e) {
  const editId = e.target.getAttribute('data-edit');
  const deleteId = e.target.getAttribute('data-delete');
  if (editId) {
    const res = await api('/api/applications/' + editId);
    if (!res.ok) return;
    const { application: a } = await res.json();
    $('edit-id').value = a.id;
    $('company').value = a.company;
    $('role').value = a.role;
    $('status').value = a.status;
    $('deadline').value = a.deadline || '';
    $('link').value = a.link || '';
    $('notes').value = a.notes || '';
    $('form-title').textContent = 'Edit application';
    $('submit-btn').textContent = 'Save changes';
    $('cancel-edit').hidden = false;
    $('form-card').scrollIntoView({ behavior: 'smooth' });
  }
  if (deleteId) {
    if (!window.confirm('Delete this application?')) return;
    const res = await api('/api/applications/' + deleteId, { method: 'DELETE' });
    if (!res.ok) { showError($('list-error'), 'delete failed: ' + res.status); return; }
    await refresh();
  }
}

$('save-token').addEventListener('click', connect);
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
$('app-form').addEventListener('submit', submitForm);
$('cancel-edit').addEventListener('click', resetForm);
$('filter-status').addEventListener('change', refresh);
$('sort').addEventListener('change', refresh);
$('app-rows').addEventListener('click', onTableClick);

// If a token is already saved in this tab, try to connect automatically.
if (token) {
  $('token').value = token;
  connect();
}
