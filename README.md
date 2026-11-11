# swarm-board-protocol

**AI エージェントの群れが、追記専用の掲示板 1 本だけで協調するためのプロトコル。**

Google Antigravity の `/swarm`（2026-11-11 プレビュー）が示した
「coordinator が worker と verifier を起動し、全員が共有の message board 越しに連絡を取り合う」構造を、
**モデル非依存・CLI 非依存・依存パッケージゼロ**で再現するための仕様と検証器。

- 仕様: [SPEC.md](SPEC.md)
- JSON Schema: [schema/post.schema.json](schema/post.schema.json)
- 動く例: [examples/board.jsonl](examples/board.jsonl)

## なぜ「掲示板」なのか

エージェント同士を直接つなぐと、組み合わせ爆発（N 体で N² 本の経路）と、
「誰が何を渡したか分からない」という不透明さが同時に起きる。

掲示板（blackboard）にすると、

- 経路は **N 本**（全員が同じファイルを読む）
- 状態は **1 ファイル**（`board.jsonl` を渡せば続きから再開できる）
- 履歴が **そのまま監査証跡**（追記専用なので改ざんが検出できる）
- 失敗が **完全にリプレイできる**（どの分解が悪かったかを後から学習できる）

## 30 秒で試す

```bash
npx github:hiroshi57/swarm-board-protocol examples/board.jsonl
```

```
PASS  examples/board.jsonl  (12 posts / 5 agents / $0.524)
  note=1 assign=3 handoff=1 done=4 verify_result=3
  verdicts: needs_changes=1 pass=2
```

壊れたボードを食わせると、行番号と規則名つきで理由が出る。

```
FAIL  bad.jsonl  (4 posts / 3 agents / $0)
  ERROR   L2 p_0002 [SELF_VERIFY_FORBIDDEN] 自分の Post を自分で検証しています（別人格の verifier が必要）
  ERROR   L3 p_0003 [DONE_GOES_TO_VERIFIER] worker の 'done' は verifier を宛先に含める必要があります
```

## ライブラリとして使う

```js
import { validateBoard, makePost, serializePost, summarize } from 'swarm-board-protocol';

const post = makePost(5, {
  from: '@worker-1',
  to: ['@verifier'],
  type: 'done',
  task_id: 'T1',
  ref: 'p_0002',
  subject: '7 集計を実装、テスト 12 件通過',
});
appendFileSync('board.jsonl', serializePost(post) + '\n');

const r = validateBoard(readFileSync('board.jsonl', 'utf8'));
if (!r.ok) throw new Error(r.errors[0].message);
console.log(r.stats.cost.usd, r.stats.edges);
```

## 検査する 10 の不変条件

| # | 規則 | 落とすもの |
|---|------|-----------|
| 1 | `SEQ_CONTIGUOUS` | seq の欠番・重複（＝ロストした投稿） |
| 2 | `ID_MATCHES_SEQ` | id と seq の不一致 |
| 3 | `TS_MONOTONIC` | 時刻の巻き戻り（＝並行書き込みの競合） |
| 4 | `REF_EXISTS` | 存在しない Post への参照 |
| 5 | `ASSIGN_BY_COORDINATOR` | worker が勝手に仕事を割り当てる |
| 6 | `VERDICT_BY_VERIFIER` | verifier 以外が合否を出す |
| 7 | `SELF_VERIFY_FORBIDDEN` | **自分の成果物を自分で合格にする** |
| 8 | `DONE_GOES_TO_VERIFIER` | 検証を通さず完了にする |
| 9 | `VERIFY_REQUEST_ANSWERED` | 投げっぱなしの検証依頼（警告） |
| 10 | `NO_SECRETS` | 掲示板への秘密情報の書き込み |

7 番と 10 番がこのプロトコルの肝。

**7 番**がないと、エージェントは自分の出力を褒めて終わる。記事の `@verifier` が別人格・別モデルで
起動されているのは偶然ではなく、これが成立条件になっている。

**10 番**は、掲示板が「全エージェントが読む面」だから必要になる。ここに API キーが 1 行載ると、
その後に起動したすべてのエージェントの文脈に入る。検出しても値そのものは報告に出さず、
種別・位置・長さだけを出す。

## 役割

| 接頭辞 | 権限 |
|--------|------|
| `@coordinator` | `assign` / `abort` を出せる唯一の存在（human を除く） |
| `@worker-N` | `done` を出せる。合否は出せない |
| `@verifier` / `@verifier-N` | `verify_result` を出せる唯一の存在 |
| `@human` | すべて可。`blocked` の解除役 |

## 開発

```bash
node --test "test/*.test.mjs"
```

依存パッケージはゼロ。Node.js 20 以上。

## 関連リポジトリ

| リポジトリ | 役割 |
|-----------|------|
| `swarm-board-protocol` | **（これ）** 掲示板の仕様と検証器 |
| `swarm-board-core` | coordinator / worker / verifier を実際に起動するランナー |
| `swarm-board-viewer` | 掲示板と関係グラフの 1 ファイル HTML ビューア |
| `swarm-cost-governor` | 台数 × トークンの予算ガード |
| `swarm-usecase-100` | 社会貢献・経済活動・案件創出の 100 ユースケース |

## ライセンス

MIT
