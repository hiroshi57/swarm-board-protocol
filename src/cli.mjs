#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { validateBoard } from './index.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
  console.error('使い方: swarm-board-validate <board.jsonl> [...] [--json]');
  process.exit(2);
}

let failed = 0;
const reports = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`読めません: ${file} (${e.message})`);
    failed++;
    continue;
  }
  const r = validateBoard(text);
  reports.push({ file, ok: r.ok, errors: r.errors, warnings: r.warnings, stats: r.stats });
  if (!r.ok) failed++;

  if (json) continue;

  const mark = r.ok ? 'PASS' : 'FAIL';
  console.log(`\n${mark}  ${file}  (${r.stats.posts} posts / ${r.stats.agents.length} agents / $${r.stats.cost.usd})`);
  for (const e of r.errors) console.log(`  ERROR   L${e.line} ${e.id ?? '-'} [${e.rule}] ${e.message}`);
  for (const w of r.warnings) console.log(`  WARN    L${w.line} ${w.id ?? '-'} [${w.rule}] ${w.message}`);
  if (r.ok && r.warnings.length === 0) {
    const t = Object.entries(r.stats.byType).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  ${t}`);
    const v = Object.entries(r.stats.verdicts).map(([k, n]) => `${k}=${n}`).join(' ');
    if (v) console.log(`  verdicts: ${v}`);
  }
}

if (json) console.log(JSON.stringify(reports, null, 2));
process.exit(failed > 0 ? 1 : 0);
