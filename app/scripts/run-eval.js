#!/usr/bin/env node
// Eval CLI — run the golden task set in a throwaway sandbox and print the
// report. Usage:
//   node scripts/run-eval.js [--repeat N] [--md] [--keep] [--json]
// Defaults: --repeat 3, JSON report on stdout, temp dirs deleted.
// --keep prints the temp workspace/DB paths instead of deleting them.
// Exit code is 1 when any task fails.
//
// The temp workspace + temp database MUST be configured before any app
// module loads: db.js and tools.js read their paths at require time.
// Nothing here touches the real database, the real workspace, or the
// network, and no model is called.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const repeat = Math.max(1, Math.min(10, Number((args.find(a => a.startsWith('--repeat=')) || '--repeat=3').split('=')[1]) || 3));
const asMarkdown = args.includes('--md');
const keep = args.includes('--keep');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piplet-eval-'));
const tmpWorkspace = path.join(tmpRoot, 'workspace');
const tmpDb = path.join(tmpRoot, 'eval.db');
fs.mkdirSync(tmpWorkspace, { recursive: true });
process.env.WORKSPACE = tmpWorkspace;
process.env.PIPLET_DB_PATH = tmpDb;

async function main() {
  const { runGoldenSet, renderEvalMarkdown } = require('../eval-runner');
  const report = await runGoldenSet({ repeat });
  if (asMarkdown) console.log(renderEvalMarkdown(report));
  else console.log(JSON.stringify(report, null, 2));
  if (keep) {
    console.error(`kept: workspace=${tmpWorkspace} db=${tmpDb}`);
  } else {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
  process.exit(report.totals.failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('eval run failed:', e.message);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(2);
});
