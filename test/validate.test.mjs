import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateBoard, makePost, serializePost, roleOf, postId, summarize, findSecrets } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(here, '..', 'examples', 'board.jsonl');

/** Post 配列から JSONL を作るテスト用ヘルパ */
function board(...fieldsList) {
  return fieldsList
    .map((f, i) => serializePost({ ...makePost(i + 1, f), ts: f.ts ?? new Date(Date.UTC(2026, 10, 11, 4, 0, i)).toISOString() }))
    .join('\n') + '\n';
}

const rules = (r) => r.errors.map((e) => e.rule);

test('roleOf は論理名から役割を判定する', () => {
  assert.equal(roleOf('@coordinator'), 'coordinator');
  assert.equal(roleOf('@worker-12'), 'worker');
  assert.equal(roleOf('@verifier-2'), 'verifier');
  assert.equal(roleOf('@human'), 'human');
  assert.equal(roleOf('@nobody'), 'unknown');
  assert.equal(roleOf('worker-1'), 'unknown', '@ がない名前は unknown');
  assert.equal(roleOf(null), 'unknown');
});

test('postId は 4 桁 0 埋め', () => {
  assert.equal(postId(1), 'p_0001');
  assert.equal(postId(1234), 'p_1234');
  assert.equal(postId(12345), 'p_12345');
});

test('同梱の例は検証を通る（エラーも警告もゼロ）', () => {
  const r = validateBoard(readFileSync(EXAMPLE, 'utf8'));
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors, null, 2));
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings, null, 2));
  assert.equal(r.ok, true);
  assert.equal(r.stats.posts, 12);
  assert.equal(r.stats.verdicts.pass, 2);
  assert.equal(r.stats.verdicts.needs_changes, 1);
});

test('SEQ_CONTIGUOUS: seq に欠番があると落ちる', () => {
  const text = [
    JSON.stringify({ seq: 1, id: 'p_0001', ts: '2026-11-11T04:00:00.000Z', from: '@human', to: [], type: 'note', subject: 'a' }),
    JSON.stringify({ seq: 3, id: 'p_0003', ts: '2026-11-11T04:00:01.000Z', from: '@human', to: [], type: 'note', subject: 'b' }),
  ].join('\n');
  assert.ok(rules(validateBoard(text)).includes('SEQ_CONTIGUOUS'));
});

test('ID_MATCHES_SEQ: id と seq がずれていると落ちる', () => {
  const text = JSON.stringify({ seq: 1, id: 'p_0099', ts: '2026-11-11T04:00:00.000Z', from: '@human', to: [], type: 'note', subject: 'a' });
  assert.ok(rules(validateBoard(text)).includes('ID_MATCHES_SEQ'));
});

test('TS_MONOTONIC: 時刻が巻き戻ると落ちる', () => {
  const text = [
    JSON.stringify({ seq: 1, id: 'p_0001', ts: '2026-11-11T04:00:10.000Z', from: '@human', to: [], type: 'note', subject: 'a' }),
    JSON.stringify({ seq: 2, id: 'p_0002', ts: '2026-11-11T04:00:00.000Z', from: '@human', to: [], type: 'note', subject: 'b' }),
  ].join('\n');
  assert.ok(rules(validateBoard(text)).includes('TS_MONOTONIC'));
});

test('REF_EXISTS: 存在しない ref は落ちる', () => {
  const text = board(
    { from: '@human', to: [], type: 'note', subject: 'a' },
    { from: '@human', to: [], type: 'answer', subject: 'b', ref: 'p_9999' },
  );
  assert.ok(rules(validateBoard(text)).includes('REF_EXISTS'));
});

test('ASSIGN_BY_COORDINATOR: worker は assign を出せない', () => {
  const text = board({ from: '@worker-1', to: ['@worker-2'], type: 'assign', task_id: 'T1', subject: '勝手に割り当て' });
  assert.ok(rules(validateBoard(text)).includes('ASSIGN_BY_COORDINATOR'));
});

test('ASSIGN_NEEDS_TASK_ID: assign に task_id がないと落ちる', () => {
  const text = board({ from: '@coordinator', to: ['@worker-1'], type: 'assign', subject: '割り当て' });
  assert.ok(rules(validateBoard(text)).includes('ASSIGN_NEEDS_TASK_ID'));
});

test('VERDICT_BY_VERIFIER: worker は verify_result を出せない', () => {
  const text = board(
    { from: '@worker-1', to: ['@verifier'], type: 'done', subject: 'できた' },
    { from: '@worker-2', to: [], type: 'verify_result', verdict: 'pass', ref: 'p_0001', subject: '合格' },
  );
  assert.ok(rules(validateBoard(text)).includes('VERDICT_BY_VERIFIER'));
});

test('SELF_VERIFY_FORBIDDEN: 自分の Post を自分で合格にできない', () => {
  const text = board(
    { from: '@verifier', to: [], type: 'progress', subject: '自分でやってみた' },
    { from: '@verifier', to: [], type: 'verify_result', verdict: 'pass', ref: 'p_0001', subject: '自分で合格' },
  );
  assert.ok(rules(validateBoard(text)).includes('SELF_VERIFY_FORBIDDEN'));
});

test('DONE_GOES_TO_VERIFIER: worker の done は verifier 宛でないと落ちる', () => {
  const text = board({ from: '@worker-1', to: ['@coordinator'], type: 'done', subject: 'できた' });
  assert.ok(rules(validateBoard(text)).includes('DONE_GOES_TO_VERIFIER'));
});

test('DONE_GOES_TO_VERIFIER: coordinator の done には適用されない', () => {
  const text = board({ from: '@coordinator', to: [], type: 'done', subject: 'ミッション完了' });
  assert.ok(!rules(validateBoard(text)).includes('DONE_GOES_TO_VERIFIER'));
});

test('VERIFY_REQUEST_ANSWERED: 未応答の検証依頼は警告', () => {
  const text = board({ from: '@coordinator', to: ['@verifier'], type: 'verify_request', subject: '見てほしい' });
  const r = validateBoard(text);
  assert.equal(r.ok, true, '未応答は警告であってエラーではない');
  assert.ok(r.warnings.map((w) => w.rule).includes('VERIFY_REQUEST_ANSWERED'));
});

test('NO_SECRETS: 掲示板に秘密を書くとエラーになり、値は出力されない', () => {
  const leaked = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const text = board({ from: '@worker-1', to: [], type: 'progress', subject: '接続した', body: `AWS_ACCESS_KEY_ID=${leaked}` });
  const r = validateBoard(text);
  assert.ok(rules(r).includes('NO_SECRETS'));
  const joined = JSON.stringify(r.errors);
  assert.ok(!joined.includes(leaked), 'レポートに秘密の生値を含めてはいけない');
  assert.ok(joined.includes('len=20'));
});

test('NO_SECRETS: プレースホルダは誤検知しない', () => {
  const text = board({ from: '@worker-1', to: [], type: 'progress', subject: '設定', body: 'api_key = YOUR_API_KEY_HERE\npassword: ${DB_PASSWORD}' });
  assert.ok(!rules(validateBoard(text)).includes('NO_SECRETS'));
});

test('findSecrets は複数種別を位置つきで返す', () => {
  const hits = findSecrets('gh' + 'p_' + 'a'.repeat(40) + ' と -----BEGIN RSA PRIVATE KEY-----');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.id), ['github_token', 'private_key']);
  assert.ok(hits[0].index < hits[1].index, '位置順に並ぶ');
});

test('PARSE: 壊れた行は行番号つきで報告される', () => {
  const text = '{"seq":1,"id":"p_0001"\n';
  const r = validateBoard(text);
  assert.equal(r.errors[0].rule, 'PARSE');
  assert.equal(r.errors[0].line, 1);
});

test('SUBJECT_TOO_LONG: 120 文字を超える subject は落ちる', () => {
  const text = board({ from: '@human', to: [], type: 'note', subject: 'あ'.repeat(121) });
  assert.ok(rules(validateBoard(text)).includes('SUBJECT_TOO_LONG'));
});

test('summarize はエージェント・辺・コストを集計する', () => {
  const r = validateBoard(readFileSync(EXAMPLE, 'utf8'));
  const s = r.stats;
  assert.equal(s.agents.find((a) => a.name === '@coordinator').role, 'coordinator');
  assert.ok(s.cost.usd > 0);
  assert.ok(s.cost.input_tokens > 0);
  const edge = s.edges.find((e) => e.from === '@worker-1' && e.to === '@verifier');
  assert.equal(edge.count, 2, 'worker-1 は verifier に 2 回渡している');
  const total = s.edges.reduce((n, e) => n + e.count, 0);
  assert.ok(total > 0);
});

test('makePost は未知の type を拒否する', () => {
  assert.throws(() => makePost(1, { from: '@human', type: 'gossip' }), TypeError);
  assert.throws(() => makePost(0, { from: '@human', type: 'note' }), TypeError);
  assert.throws(() => makePost(1, { type: 'note' }), TypeError);
});

test('makePost と serializePost の往復でボードが組み立てられる', () => {
  const text = board(
    { from: '@human', to: [], type: 'note', subject: 'start' },
    { from: '@coordinator', to: ['@worker-1'], type: 'assign', task_id: 'T1', subject: 'やって', ref: 'p_0001' },
    { from: '@worker-1', to: ['@verifier'], type: 'done', task_id: 'T1', subject: 'やった', ref: 'p_0002' },
    { from: '@verifier', to: ['@coordinator'], type: 'verify_result', verdict: 'pass', ref: 'p_0003', subject: 'よい' },
  );
  const r = validateBoard(text);
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.posts, 4);
});

test('serializePost は内部用の __line を落とす', () => {
  const r = validateBoard(readFileSync(EXAMPLE, 'utf8'));
  assert.ok(r.posts[0].__line === 1);
  assert.ok(!serializePost(r.posts[0]).includes('__line'));
});

test('summarize は空のボードでも落ちない', () => {
  const s = summarize([]);
  assert.equal(s.posts, 0);
  assert.deepEqual(s.agents, []);
  assert.equal(s.cost.usd, 0);
});
