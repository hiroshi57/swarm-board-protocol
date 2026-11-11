import { findSecrets } from './secrets.mjs';

export { findSecrets, mask } from './secrets.mjs';

export const POST_TYPES = [
  'assign', 'progress', 'question', 'answer', 'handoff',
  'done', 'verify_request', 'verify_result', 'blocked', 'abort', 'note',
];

export const VERDICTS = ['pass', 'fail', 'needs_changes'];

/** 論理名から役割を判定する */
export function roleOf(name) {
  if (typeof name !== 'string' || !name.startsWith('@')) return 'unknown';
  const n = name.slice(1).toLowerCase();
  if (n === 'coordinator' || n.startsWith('coordinator-')) return 'coordinator';
  if (n === 'verifier' || n.startsWith('verifier-')) return 'verifier';
  if (n === 'worker' || n.startsWith('worker-')) return 'worker';
  if (n === 'human') return 'human';
  return 'unknown';
}

export function postId(seq) {
  return `p_${String(seq).padStart(4, '0')}`;
}

function issue(rule, line, id, message, severity = 'error') {
  return { rule, line, id, message, severity };
}

/** JSONL 文字列を Post 配列に変換する。パース不能行は issue として返す */
export function parseBoard(text) {
  const posts = [];
  const issues = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    try {
      const obj = JSON.parse(trimmed);
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        issues.push(issue('PARSE', i + 1, null, '行が JSON オブジェクトではありません'));
        return;
      }
      posts.push({ ...obj, __line: i + 1 });
    } catch (e) {
      issues.push(issue('PARSE', i + 1, null, `JSON として読めません: ${e.message}`));
    }
  });
  return { posts, issues };
}

/**
 * ボードを検証する。
 * @param {string} text board.jsonl の中身
 * @returns {{ok:boolean, errors:object[], warnings:object[], posts:object[], stats:object}}
 */
export function validateBoard(text) {
  const { posts, issues } = parseBoard(text);
  const errors = issues.filter((x) => x.severity === 'error');
  const warnings = issues.filter((x) => x.severity === 'warning');
  const err = (rule, p, msg) => errors.push(issue(rule, p?.__line ?? 0, p?.id ?? null, msg));
  const warn = (rule, p, msg) => warnings.push(issue(rule, p?.__line ?? 0, p?.id ?? null, msg, 'warning'));

  const byId = new Map();
  let prevTs = null;

  posts.forEach((p, i) => {
    const expectedSeq = i + 1;

    for (const f of ['seq', 'id', 'ts', 'from', 'to', 'type', 'subject']) {
      if (p[f] === undefined || p[f] === null) err('REQUIRED_FIELD', p, `必須フィールド '${f}' がありません`);
    }
    if (p.type !== undefined && !POST_TYPES.includes(p.type)) err('UNKNOWN_TYPE', p, `未知の type '${p.type}'`);
    if (p.to !== undefined && !Array.isArray(p.to)) err('TO_NOT_ARRAY', p, "'to' は配列である必要があります（空配列 = 全員宛）");
    if (typeof p.subject === 'string' && p.subject.length > 120) {
      err('SUBJECT_TOO_LONG', p, `subject が 120 文字を超えています (${p.subject.length})`);
    }

    // 1. SEQ_CONTIGUOUS
    if (p.seq !== expectedSeq) err('SEQ_CONTIGUOUS', p, `seq は ${expectedSeq} であるべきですが ${p.seq} でした`);

    // 2. ID_MATCHES_SEQ
    if (typeof p.seq === 'number' && p.id !== postId(p.seq)) {
      err('ID_MATCHES_SEQ', p, `id は '${postId(p.seq)}' であるべきですが '${p.id}' でした`);
    }
    if (byId.has(p.id)) err('ID_DUPLICATE', p, `id '${p.id}' が重複しています`);

    // 3. TS_MONOTONIC
    const t = Date.parse(p.ts);
    if (Number.isNaN(t)) {
      err('TS_INVALID', p, `ts が ISO 8601 として読めません: '${p.ts}'`);
    } else {
      if (prevTs !== null && t < prevTs) err('TS_MONOTONIC', p, 'ts が前の Post より過去になっています');
      prevTs = t;
    }

    // 4. REF_EXISTS
    if (p.ref !== undefined && !byId.has(p.ref)) {
      err('REF_EXISTS', p, `ref '${p.ref}' が自分より前に存在しません`);
    }

    const fromRole = roleOf(p.from);
    if (fromRole === 'unknown') err('UNKNOWN_SENDER', p, `from '${p.from}' の役割を判定できません`);

    // 5. ASSIGN_BY_COORDINATOR
    if ((p.type === 'assign' || p.type === 'abort') && !['coordinator', 'human'].includes(fromRole)) {
      err('ASSIGN_BY_COORDINATOR', p, `'${p.type}' は coordinator か human だけが出せます（from=${p.from}）`);
    }
    if (p.type === 'assign' && !p.task_id) err('ASSIGN_NEEDS_TASK_ID', p, "'assign' には task_id が必要です");

    // 6. VERDICT_BY_VERIFIER / 7. SELF_VERIFY_FORBIDDEN
    if (p.type === 'verify_result') {
      if (fromRole !== 'verifier') err('VERDICT_BY_VERIFIER', p, `'verify_result' は verifier だけが出せます（from=${p.from}）`);
      if (!VERDICTS.includes(p.verdict)) err('VERDICT_REQUIRED', p, `verdict は ${VERDICTS.join(' / ')} のいずれかが必要です`);
      if (!p.ref) err('VERDICT_NEEDS_REF', p, "'verify_result' には検証対象を指す ref が必要です");
      const target = byId.get(p.ref);
      if (target && target.from === p.from) {
        err('SELF_VERIFY_FORBIDDEN', p, '自分の Post を自分で検証しています（別人格の verifier が必要）');
      }
    } else if (p.verdict !== undefined) {
      warn('VERDICT_MISPLACED', p, `type='${p.type}' に verdict が付いています（verify_result 以外では無視されます）`);
    }

    // 8. DONE_GOES_TO_VERIFIER
    if (p.type === 'done' && fromRole === 'worker') {
      const tos = Array.isArray(p.to) ? p.to : [];
      if (!tos.some((x) => roleOf(x) === 'verifier')) {
        err('DONE_GOES_TO_VERIFIER', p, "worker の 'done' は verifier を宛先に含める必要があります");
      }
    }

    // 10. NO_SECRETS
    for (const field of ['subject', 'body']) {
      for (const hit of findSecrets(p[field])) {
        err('NO_SECRETS', p, `${field} に ${hit.label} らしき値があります (offset=${hit.index}, ${hit.preview})`);
      }
    }

    byId.set(p.id, p);
  });

  // 9. VERIFY_REQUEST_ANSWERED（警告）
  const answered = new Set(posts.filter((p) => p.type === 'verify_result' && p.ref).map((p) => p.ref));
  for (const p of posts) {
    if (p.type === 'verify_request' && !answered.has(p.id)) {
      warn('VERIFY_REQUEST_ANSWERED', p, 'この verify_request に対応する verify_result がありません');
    }
  }

  return { ok: errors.length === 0, errors, warnings, posts, stats: summarize(posts) };
}

/** ボードの要約統計（ビューアのグラフ描画にもそのまま使える） */
export function summarize(posts) {
  const agents = new Map();
  const byType = {};
  const edges = new Map();
  let usd = 0, inTok = 0, outTok = 0;

  const touch = (name) => {
    if (!agents.has(name)) agents.set(name, { name, role: roleOf(name), sent: 0, received: 0, usd: 0 });
    return agents.get(name);
  };

  for (const p of posts) {
    byType[p.type] = (byType[p.type] ?? 0) + 1;
    const a = touch(p.from);
    a.sent++;
    if (p.cost) {
      usd += Number(p.cost.usd) || 0;
      inTok += Number(p.cost.input_tokens) || 0;
      outTok += Number(p.cost.output_tokens) || 0;
      a.usd += Number(p.cost.usd) || 0;
    }
    for (const to of Array.isArray(p.to) ? p.to : []) {
      touch(to).received++;
      const key = `${p.from}\u0000${to}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }

  const verdicts = {};
  for (const p of posts) if (p.type === 'verify_result') verdicts[p.verdict] = (verdicts[p.verdict] ?? 0) + 1;

  return {
    posts: posts.length,
    agents: [...agents.values()].sort((a, b) => b.sent - a.sent),
    byType,
    verdicts,
    cost: { usd: Number(usd.toFixed(4)), input_tokens: inTok, output_tokens: outTok },
    edges: [...edges.entries()].map(([k, count]) => {
      const [from, to] = k.split('\u0000');
      return { from, to, count };
    }),
  };
}

/** 新しい Post を組み立てる（seq / id / ts を自動で埋める） */
export function makePost(seq, fields) {
  if (!Number.isInteger(seq) || seq < 1) throw new TypeError('seq は 1 以上の整数が必要です');
  if (!fields || typeof fields.from !== 'string') throw new TypeError('from は必須です');
  if (!POST_TYPES.includes(fields.type)) throw new TypeError(`未知の type: ${fields.type}`);
  return {
    seq,
    id: postId(seq),
    ts: fields.ts ?? new Date().toISOString(),
    from: fields.from,
    to: fields.to ?? [],
    type: fields.type,
    subject: fields.subject ?? '',
    ...(fields.task_id ? { task_id: fields.task_id } : {}),
    ...(fields.ref ? { ref: fields.ref } : {}),
    ...(fields.body ? { body: fields.body } : {}),
    ...(fields.artifacts ? { artifacts: fields.artifacts } : {}),
    ...(fields.verdict ? { verdict: fields.verdict } : {}),
    ...(fields.cost ? { cost: fields.cost } : {}),
    ...(fields.meta ? { meta: fields.meta } : {}),
  };
}

/** Post を JSONL の 1 行に直す（内部用フィールドを落とす） */
export function serializePost(post) {
  const { __line, ...rest } = post;
  return JSON.stringify(rest);
}
