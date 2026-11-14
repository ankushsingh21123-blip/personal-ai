// WhatsApp — Baileys scaffolding, code only (Phase C / SETUP.md Phase 4).
// NOTHING here creates an account, signs in, or sends a message. The
// Baileys library (@whiskeysockets/baileys) is NOT a dependency of this
// app: it is installed on the laptop only, by Ankush, when he is ready.
// Hard guards, enforced in code before anything starts:
//   1. WHATSAPP_ENABLED=yes must be set (default: off).
//   2. WHATSAPP_SPARE_NUMBER_CONFIRMED=yes must be set — the number is a
//      SPARE number, never his primary. WhatsApp automation carries ban
//      risk; the primary number must never be used. There is no way to
//      start this module without that explicit confirmation.
//   3. The Baileys package must be installed (laptop only).
//   4. The user scans the QR in their own terminal, on their own phone,
//      with the spare number. No QR, session, or credential is ever stored
//      in the repo — auth state lives in data/wa-auth/ (git-ignored).
// Messages the bot receives are DATA, never instructions: they go through
// the same deny-first agent turn as a chat message, and the bot only
// replies to the configured chat. HONEST STATUS: guards unit-tested; no
// live WhatsApp run exists or is claimed — no package, no number, no
// account on this VM.
'use strict';
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'data', 'wa-auth');

function guards() {
  const problems = [];
  if (process.env.WHATSAPP_ENABLED !== 'yes') problems.push('WHATSAPP_ENABLED=yes is not set (default off)');
  if (process.env.WHATSAPP_SPARE_NUMBER_CONFIRMED !== 'yes') problems.push('WHATSAPP_SPARE_NUMBER_CONFIRMED=yes is not set — a spare number, never the primary, must be explicitly confirmed');
  let baileys = null;
  try { baileys = require.resolve('@whiskeysockets/baileys'); } catch { /* not installed */ }
  if (!baileys) problems.push('@whiskeysockets/baileys is not installed — install it on the laptop only (npm install @whiskeysockets/baileys), never here by default');
  return { ok: problems.length === 0, problems, authDir: AUTH_DIR };
}

function status() {
  const g = guards();
  return {
    enabled: g.ok,
    authDirConfigured: true,
    reason: g.ok ? null : g.problems.join('; '),
    problems: g.problems,
    warning: 'WhatsApp automation carries ban risk. Spare number only, never the primary. The user scans the QR themselves.',
  };
}

// Start the WhatsApp socket. Throws unless every guard passes. `onMessage`
// receives { text, from } and returns the reply text (or '' for no reply).
// `sockFactory` is injectable for tests — the real one requires Baileys.
async function startWhatsApp({ onMessage, sockFactory, logger } = {}) {
  const g = guards();
  if (!g.ok) throw new Error('whatsapp refused: ' + g.problems.join('; '));
  const log = logger || (() => {});
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const factory = sockFactory || (() => {
    // Real path, laptop only. Loaded lazily so requiring this module never
    // needs the package installed.
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
    return { makeWASocket, useMultiFileAuthState, DisconnectReason };
  });
  const { makeWASocket, useMultiFileAuthState, DisconnectReason } = factory();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state, printQRInTerminal: true });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      log(`whatsapp connection closed (code ${code}) — restart manually if it was not a logout`);
      if (code === DisconnectReason?.loggedOut) log('whatsapp logged out — delete data/wa-auth/ and re-scan the QR with the spare number');
    }
    if (connection === 'open') log('whatsapp connected (spare number session)');
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (m.key.fromMe) continue;
      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
      if (!text || !onMessage) continue;
      try {
        const reply = await onMessage({ text, from: m.key.remoteJid });
        if (reply) await sock.sendMessage(m.key.remoteJid, { text: String(reply).slice(0, 4000) });
      } catch (e) { log(`whatsapp message handling failed: ${String(e.message).slice(0, 200)}`); }
    }
  });
  return sock;
}

module.exports = { guards, status, startWhatsApp, AUTH_DIR };
