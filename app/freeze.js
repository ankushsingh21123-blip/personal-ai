// Freeze — the instant stop control (spec §4.7: "The user can stop it
// instantly"). Persisted in the settings table, so a frozen agent stays
// frozen across restarts until the user unfreezes it. Every agent loop —
// screen, phone, browser, routines, queue drain — must check isFrozen()
// before each action. Freezing never deletes queued work; it only pauses
// execution. Unfreezing resumes it.
'use strict';
const { getSetting, setSetting } = require('./db');

function isFrozen() {
  return getSetting('frozen') === '1';
}

function freezeState() {
  return {
    frozen: isFrozen(),
    reason: getSetting('frozen_reason') || null,
    frozen_at: getSetting('frozen_at') || null,
  };
}

function setFrozen(frozen, reason) {
  setSetting('frozen', frozen ? '1' : '0');
  if (frozen) {
    setSetting('frozen_reason', String(reason || 'user freeze').slice(0, 200));
    setSetting('frozen_at', new Date().toISOString());
  } else {
    setSetting('frozen_reason', '');
    setSetting('frozen_at', '');
  }
  return freezeState();
}

// Throws when frozen — loops call this before every action so a freeze
// takes effect mid-task, not just between tasks.
function assertNotFrozen() {
  if (isFrozen()) throw new Error('frozen: agent stopped by user — unfreeze to resume');
}

module.exports = { isFrozen, freezeState, setFrozen, assertNotFrozen };
