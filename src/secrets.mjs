// 秘密情報の検出。値そのものは返さず、種別と位置だけを返す。
// 掲示板は全エージェントが読むため、ここに秘密が載ると swarm 全体に伝播する。

export const SECRET_PATTERNS = [
  { id: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS アクセスキー' },
  { id: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, label: 'GitHub トークン' },
  { id: 'sk_key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, label: 'sk- 形式の API キー' },
  { id: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: 'Google API キー' },
  { id: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'Slack トークン' },
  { id: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, label: '秘密鍵' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'JWT' },
  {
    id: 'assigned_secret',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([^\s"',}]{8,})/gi,
    label: '秘密らしき代入値',
  },
];

// プレースホルダは誤検知なので除外する
const PLACEHOLDER = /^(?:\*+|x+|\.{3,}|<[^>]+>|\$\{?[A-Z_]+\}?|REDACTED|DUMMY|EXAMPLE|CHANGEME|YOUR_[A-Z_]+|TODO)$/i;

/**
 * @param {string} text
 * @returns {{id:string,label:string,index:number,preview:string}[]}
 */
export function findSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  for (const { id, re, label } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const captured = m[1] ?? m[0];
      if (PLACEHOLDER.test(captured)) continue;
      hits.push({ id, label, index: m.index, preview: mask(captured) });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** 値を復元できない形に落とす（先頭 2 文字 + 長さのみ） */
export function mask(value) {
  const head = value.slice(0, 2);
  return `${head}***(len=${value.length})`;
}
