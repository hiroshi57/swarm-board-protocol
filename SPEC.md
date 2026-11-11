# Swarm Board Protocol v0.1

AI エージェントの群れ（swarm）が、**追記専用の掲示板（blackboard）1 本だけ**で協調するための仕様。

Google Antigravity の `/swarm` が示した「coordinator が worker と verifier を起動し、
全員が共有の message board 越しに連絡を取り合う」構造を、モデル非依存・CLI 非依存で再現する。

## 0. 設計原則

| 原則 | 理由 |
|------|------|
| **追記専用 (append-only)** | 行を書き換えないので、途中状態がそのまま監査証跡になる。完全リプレイできる |
| **1 ファイル 1 ミッション** | `board.jsonl` を渡すだけで状態が引き継げる。DB 不要 |
| **宛先は論理名** | `@worker-1` のような論理名。プロセス ID に依存しないので再起動に強い |
| **検証は別人格** | 作った本人は合格判定を出せない。`verify_result` は verifier だけが書ける |
| **秘密はボードに載せない** | 掲示板は全エージェントが読む = 最も漏洩しやすい面。lint で機械的に止める |

## 1. ボード

- ファイル形式: **JSON Lines** (`board.jsonl`)。1 行 1 Post、UTF-8、末尾改行あり
- 書き込みは **append のみ**。既存行の変更・削除は仕様違反
- 訂正したい場合は `type: "note"` に `ref` を付けて追記する（履歴は消さない）

## 2. Post

```json
{
  "seq": 3,
  "id": "p_0003",
  "ts": "2026-11-11T04:12:30.115Z",
  "from": "@worker-1",
  "to": ["@verifier"],
  "type": "done",
  "task_id": "T1",
  "ref": "p_0001",
  "subject": "ログ集計スクリプトを実装",
  "body": "7 集計を実装。テストは 12 件すべて通過。",
  "artifacts": [{ "path": "src/aggregate.mjs", "kind": "file" }],
  "cost": { "model": "claude-opus-5", "input_tokens": 12044, "output_tokens": 2310, "usd": 0.21 }
}
```

### フィールド

| 名前 | 必須 | 型 | 説明 |
|------|:---:|----|------|
| `seq` | ✓ | int | 1 から始まり **1 ずつ増える**。欠番・重複は違反 |
| `id` | ✓ | string | `p_` + seq を 4 桁 0 埋め。ボード内で一意 |
| `ts` | ✓ | string | ISO 8601 (UTC, ミリ秒)。`seq` 順に単調非減少 |
| `from` | ✓ | string | `@` で始まる論理エージェント名 |
| `to` | ✓ | string[] | 宛先。**空配列 = 全員宛（broadcast）** |
| `type` | ✓ | enum | 下表 |
| `task_id` |  | string | タスク識別子。`assign` では必須 |
| `ref` |  | string | 参照する Post の `id` |
| `subject` | ✓ | string | 1 行要約（120 文字以内） |
| `body` |  | string | 本文（Markdown 可） |
| `artifacts` |  | object[] | `{path, kind, sha256?}` |
| `verdict` |  | enum | `pass` / `fail` / `needs_changes`。`verify_result` でのみ必須 |
| `cost` |  | object | `{model, input_tokens, output_tokens, usd}` |
| `meta` |  | object | 任意の拡張 |

### type 一覧

| type | 誰が出せるか | 意味 |
|------|-------------|------|
| `assign` | coordinator | 作業を割り当てる。`task_id` 必須 |
| `progress` | 全員 | 途中経過 |
| `question` | 全員 | 質問 |
| `answer` | 全員 | 回答。`ref` 必須 |
| `handoff` | 全員 | 別エージェントへ作業を渡す |
| `done` | worker | 作業完了報告。**宛先に verifier を含めること** |
| `verify_request` | coordinator / worker | 検証依頼 |
| `verify_result` | verifier | 検証結果。`verdict` 必須、`ref` 必須 |
| `blocked` | 全員 | 進めない。人間介入待ち |
| `abort` | coordinator / human | ミッション中断 |
| `note` | 全員 | 訂正・補足・メモ |

## 3. 役割

論理名の **接頭辞**で役割が決まる。

| 接頭辞 | 役割 | 権限 |
|--------|------|------|
| `@coordinator` | 全体監督。分解・割当・最終集約 | `assign` / `abort` を出せる唯一の存在（human を除く） |
| `@worker-N` | 実作業 | `done` を出せる。`verify_result` は出せない |
| `@verifier` / `@verifier-N` | 検証 | `verify_result` を出せる唯一の存在 |
| `@human` | 人間 | すべて可。`blocked` の解除役 |

## 4. 不変条件（validator が検査する）

1. **SEQ_CONTIGUOUS** — `seq` は 1 から連番
2. **ID_MATCHES_SEQ** — `id` は `p_` + 4 桁 0 埋め `seq`
3. **TS_MONOTONIC** — `ts` は単調非減少
4. **REF_EXISTS** — `ref` は自分より前の `id` を指す
5. **ASSIGN_BY_COORDINATOR** — `assign` / `abort` は coordinator か human のみ
6. **VERDICT_BY_VERIFIER** — `verify_result` は verifier のみ、`verdict` と `ref` 必須
7. **SELF_VERIFY_FORBIDDEN** — `verify_result` の `ref` が指す Post の `from` が自分自身なら違反（自画自賛の禁止）
8. **DONE_GOES_TO_VERIFIER** — `done` の `to` に verifier が 1 人以上いること
9. **VERIFY_REQUEST_ANSWERED** — すべての `verify_request` に対応する `verify_result` があること（警告）
10. **NO_SECRETS** — `body` / `subject` に秘密情報パターンがないこと

## 5. 秘密検出（NO_SECRETS）

掲示板は全エージェントが読むため、ここに秘密が載ると全員の文脈に入る。
以下のパターンを機械的に弾く。

- AWS アクセスキー `AKIA[0-9A-Z]{16}`
- GitHub トークン `gh[pousr]_[A-Za-z0-9]{36,}`
- OpenAI / Anthropic 風キー `sk-[A-Za-z0-9_-]{20,}`
- Google API キー `AIza[0-9A-Za-z_-]{35}`
- Slack トークン `xox[baprs]-[A-Za-z0-9-]{10,}`
- 秘密鍵ヘッダ `-----BEGIN ... PRIVATE KEY-----`
- `password` / `passwd` / `secret` / `api_key` に続く代入値
- JWT `eyJ...` 形式

検出時は **ERROR**。値そのものはレポートに出さず、位置と種別だけを報告する。

## 6. 終了条件

ミッションは次のいずれかで終わる。

- coordinator が `to: []`（broadcast）の `done` を出す → **成功**
- coordinator か human が `abort` を出す → **中断**
- 外部のコストガバナが上限超過で打ち切る → **予算中断**

## 7. リプレイ

`board.jsonl` を `seq` 順に読むだけで、どのエージェントがいつ何を渡したか完全に再現できる。
失敗の再現、原因分析、そして「どの分解が良かったか」の学習データとして使う。
