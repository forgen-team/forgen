<p align="center">
  <img src="https://raw.githubusercontent.com/wooo-jin/forgen/main/assets/banner.png" alt="Forgen" width="100%"/>
</p>

<p align="center">
  <strong>Claude が「完了しました」と言ったら、forgen がそれを証明させる。</strong><br/>
  ターンレベルの自己検証 + パーソナライズドルール、<strong>追加 API コスト $0</strong>。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@wooojin/forgen"><img src="https://img.shields.io/npm/v/@wooojin/forgen.svg" alt="npm version"/></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"/></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js >= 20"/></a>
</p>

<p align="center">
  <a href="#最初のブロック-30秒">最初のブロック</a> &middot;
  <a href="#ハーネスがあなたを運ぶ">ビジョン</a> &middot;
  <a href="#クイックスタート">クイックスタート</a> &middot;
  <a href="#仕組み">仕組み</a> &middot;
  <a href="#4軸パーソナライゼーション">4軸</a> &middot;
  <a href="#コマンド">コマンド</a> &middot;
  <a href="#アーキテクチャ">アーキテクチャ</a> &middot;
  <a href="#セーフティ">セーフティ</a>
</p>

<p align="center">
  <a href="README.md">English</a> &middot;
  <a href="README.ko.md">한국어</a> &middot;
  日本語 &middot;
  <a href="README.zh.md">简体中文</a>
</p>

---

## 最初のブロック (30秒)

あなたは何度も騙されてきました。Claude は「テスト通過、実装完了」と言う — 実際に動かすと — 動かない。forgen はそのギャップを塞ぎます。

```
You:     「ログインハンドラを実装してください。」
Claude:  ...編集中...
Claude:  "구현 완료했습니다。"

[forgen:stop-guard/L1-e2e-before-done]
Docker e2e 証拠 (~/.forgen/state/e2e-result.json, 1時間以内) がありません。
実行してから再応答してください。

Claude:  「完了宣言を取り消します。証拠ファイルがありません。e2e を先に実行します...」
         ...bash tests/e2e/docker/run-test.sh 実行...
         「63/63 通過。구현 완료했습니다。」

[forgen] ✓ approved
```

**何が起きたか**: Claude の Stop フックが、あなたが定義したルール (`L1-e2e-before-done`) によってブロックされました。Claude はブロック `reason` を読み、早すぎた完了宣言を撤回し、証拠を生成して再提出しました。**追加 API コール 0** — Claude が元々生成する予定だった同じセッションのターン内で全て起きました。

これが **Mech-B セルフチェックプロンプトインジェクト** です。Claude Code の Stop フックが `decision: "block"` + `reason` を受け入れ、Claude が次のターンでその reason を入力として読むから成り立ちます。10 シナリオ $1.74 で end-to-end 検証済み ([A1 spike report](docs/spike/mech-b-a1-verification-report.md))。

🎬 **動作を見る** (27秒):

```bash
# 実際のフック・実際のルール・実際の block/approve サイクルをライブで
bash docs/demo/mech-b-demo.sh

# または録画済み asciinema キャストを再生
asciinema play docs/demo/mech-b-block-unblock.cast
```

デモの「本物/シミュレーション」の区別は [`docs/demo/README.md`](docs/demo/README.md) を参照。

---

## 2人の開発者。同じ Claude。まったく異なる振る舞い。

上記の Trust Layer は柱の1つです。もう1つはパーソナライゼーション — 最初のブロック後に forgen を使い続ける理由です。

---

## ハーネスがあなたを運ぶ

パーソナライゼーションは表面です。より深いアイデア: **すべてのセッションが痕跡を残し、その痕跡が蓄積されてあなたのように判断するハーネスになります。** 修正、規約、トレードオフの好み — 会話から抽出され、`~/.forgen/me/` に保存され、次のセッションで Claude に再注入されます。

```
会話          ──►  抽出: solution / rule / behavior / profile 更新
                    ────────────────────────────────────────────
                                       │
                                       ▼
次のセッション  ◄──  注入: UserPromptSubmit コンテキスト + レンダリングされた
                    ルール + あなたの基準に合わせた Stop-hook ガード
```

数週間経つと、このハーネスは「ルールを強制するツール」ではなく、**あなたが仕事を判断する方法が詰まった持ち運べるバンドル** になります。一行で export:

```bash
forgen compound export    # → forgen-knowledge-YYYY-MM-DD.tar.gz
                          #   (rules + solutions + behavior — あなたの哲学)
forgen compound import <path>   # 別のマシンで再現
```

これが北極星: *ノートパソコン上で、あなたのように判断する Claude と、持ち運べる tarball.*

開発者 A は慎重派です。Claude にすべてのテストを実行させ、理由を説明させ、現在のファイル以外を変更する前に必ず確認を求めます。

開発者 B はスピード重視です。Claude に前提を置いて判断させ、関連ファイルも直接修正させ、結果を2行で報告させます。

forgen なしでは、両者とも同じ汎用的な Claude を使うことになります。forgen を使えば、それぞれが自分のやり方に合った Claude を手に入れます。

```
開発者 A の Claude:                     開発者 B の Claude:
「関連する問題を3件発見しました。           「ログイン + 関連ファイル2件を修正。
進める前にセッションハンドラも               テスト通過。リスク1件: セッション
修正しますか? 各問題の分析は               タイムアウト未カバー。完了。」
以下の通りです...」
```

forgen がこれを実現します。作業スタイルをプロファイリングし、修正から学習し、Claude が毎セッション従うパーソナライズされたルールをレンダリングします。

---

## forgen を使うと起こること

### 初回実行（1回のみ、約1分）

```bash
npm install -g @wooojin/forgen
forgen
```

初回実行を検出すると、4問のオンボーディングが始まります。各質問は具体的なシナリオです:

```
  Q1: Ambiguous implementation request

  You receive "improve the login feature." Requirements are
  unclear and adjacent modules may be affected.

  A) Clarify requirements/scope first. Ask if scope expansion is possible.
  B) Proceed if within same flow. Check when major scope expansion appears.
  C) Make reasonable assumptions and fix adjacent files directly.

  Choice (A/B/C):
```

4つの質問。4つの軸を測定。各軸にパックときめ細かなファセットを含むプロファイルが作成されます。パーソナライズされたルールファイルがレンダリングされ、Claude が読み取る場所に配置されます。

### 毎セッション（日常使用）

```bash
forgen                    # `claude` の代わりに使用
```

内部の動作:

1. ハーネスが `~/.forgen/me/forge-profile.json` からプロファイルをロード
2. プリセットマネージャがセッションを合成: グローバル安全ルール + パック基本ルール + 個人オーバーレイ + セッションオーバーレイ
3. ルールレンダラがすべてを自然言語に変換し、`~/.claude/rules/v1-rules.md` に書き込み
4. Claude Code が起動し、それらのルールを行動指針として読み取る
5. セーフティフックが有効化: 危険なコマンドのブロック、シークレットのフィルタリング、プロンプトインジェクションの検出

### Claude を修正するとき

あなたが言います: 「頼んでいないファイルをリファクタリングしないで。」

Claude が `correction-record` MCP ツールを呼び出します。修正は、軸分類（`judgment_philosophy`）、種類（`avoid-this`）、信頼度スコアを含む構造化されたエビデンスとして保存されます。現在のセッションに即座に効果を持つ一時ルールが作成されます。

### セッション間（自動）

セッション終了時に auto-compound が抽出します:
- ソリューション（コンテキスト付きの再利用可能なパターン）
- 行動観察（あなたの作業の仕方）
- セッション学習サマリー

蓄積されたエビデンスに基づいてファセットが微調整されます。修正が継続的に現在のパックと異なる方向を指している場合、3セッション後にミスマッチ検出がトリガーされ、パック変更を提案します。

### 次のセッション

修正が反映された更新ルールがレンダリングされます。Compound 知識が MCP 経由で検索可能になります。Claude が「あなたの」Claude になっていきます。

---

## クイックスタート

```bash
# 1. インストール (グローバル CLI なので必ず -g)
npm install -g @wooojin/forgen

# 2. ホスト登録 — Claude Code / Codex / 両方
forgen install both          # 3択インタラクティブ: claude / codex / both
# または非対話:
forgen install claude
forgen install codex

# 3. 初回実行 — 4問オンボーディング (英語/韓国語選択)
forgen                        # デフォルト: Claude
forgen --runtime codex        # Codex で実行
forgen config default-host codex   # 永続デフォルトホスト設定
```

### 前提条件

- **Node.js** >= 20 (SQLite セッション検索には >= 22 を推奨)
- **少なくとも 1 つのホスト** インストール・認証済み:
  - **Claude Code** — `npm i -g @anthropic-ai/claude-code`
  - **Codex CLI** — [Codex docs](https://github.com/openai/codex) を参照
  - 両方利用可 — `forgen install both` が両方に hook/MCP を対称登録

> **ベンダー依存:** forgen は Claude Code と Codex CLI を対称ラップします (Claude が動作基準、Codex が同等性拡張)。上流 API/CLI の変更が動作に影響する可能性があります。Claude Code 1.0.x / 2.1.x、Codex 0.x でテスト済み。

### 隔離 / CI / Docker での利用

forgen のホームはデフォルト `~/.forgen` ですが、プロセス毎に上書き可能:

```bash
# クリーンな隔離ホーム — 実 ~/.forgen は触らない
FORGEN_HOME=/tmp/forgen-clean forgen init    # starter-pack 15件を自動配置
FORGEN_HOME=/tmp/forgen-clean forgen stats   # 隔離ホームの統計のみ表示
FORGEN_HOME=/tmp/forgen-clean claude -p "…"  # フックが env を継承 → ログ隔離
```

Claude Code のフックプロセスは親 env を継承するため、`FORGEN_HOME=...` プレ
フィックス一つで全状態 (rules/solutions/behavior/enforcement) がそのディレ
クトリに隔離されます。用途:

- CI パイプラインで固定シードに対する forgen 検証
- 実ホーム汚染なしの「新規ユーザー初日体験」再現
- 1 台のマシンで複数ペルソナ運用

**Docker / リモートサーバー (OAuth 制約):** Claude Code は OAuth セッションを
**OS キーチェーン** (macOS Keychain / libsecret / Windows Credential Manager)
に保存するため、新規 Linux コンテナで `~/.claude.json` のみマウントしても
refresh トークンが無く認証できません。コンテナ環境では `ANTHROPIC_API_KEY`
env を使ってください。ホスト環境 (macOS/Linux ワークステーション) は通常の
`claude login` フローで動作 — API キー不要。

### マイグレーション

`forgen migrate implicit-feedback` — pre-v0.4.1 ログの `category` フィールド
バックフィル。冪等 (idempotent) — 複数回実行しても安全。

---

## なぜ forgen か

|                        | Generic Claude Code | oh-my-claudecode | forgen          |
|------------------------|:-------------------:|:----------------:|:---------------:|
| 全員に同じ             | Yes                 | Yes              | **No**          |
| 修正から学習           | No                  | No               | **Yes**         |
| エビデンスベースのライフサイクル| No          | No               | **Yes**         |
| 悪いパターンを自動リタイア| No              | No               | **Yes**         |
| パーソナライズされたルール| No               | No               | **Yes**         |
| ランタイム依存関係     | -                   | many             | **3**           |

### forgen が向いているケース

**向いている場合:**
- 数週間かけて Claude があなたのパターンを学習する長期プロジェクト
- AI の振る舞いに強いこだわりがある開発者
- Compound 知識の恩恵を受ける繰り返しパターンがあるコードベース

**向いていない場合:**
- 使い捨てのスクリプトや一時的なプロトタイプ
- Claude Code がない環境
- すべてのメンバーに同じ AI 動作が必要なチーム（forgen は個人用であり、チーム向けではありません）

**forgen + oh-my-claudecode:** 一緒に使えます。OMC はオーケストレーション（エージェント、ワークフロー）を、forgen はパーソナライゼーション（プロファイル、学習）を担当します。[共存ガイド](docs/guides/with-omc.md) を参照してください。

---

## 仕組み

### 学習ループ

```
                          +-------------------+
                          | オンボーディング    |
                          |   （4問）          |
                          +--------+----------+
                                   |
                                   v
                   +-------------------------------+
                   |      プロファイル作成           |
                   |  4軸 x パック + ファセット + trust |
                   +-------------------------------+
                                   |
           +-----------------------+------------------------+
           |                                                |
           v                                                |
  +------------------+                                      |
  | ルールレンダリング |   ~/.claude/rules/v1-rules.md        |
  | Claude 形式に変換 |                                      |
  +--------+---------+                                      |
           |                                                |
           v                                                |
  +------------------+                                      |
  | セッション実行    |   Claude がパーソナライズルールに従う    |
  |   修正すると     | ---> correction-record MCP            |
  |   Claude が学習  |      エビデンス保存                    |
  +--------+---------+      一時ルール作成                    |
           |                                                |
           v                                                |
  +------------------+                                      |
  | セッション終了    |   auto-compound 抽出:                 |
  |                  |   ソリューション + 観察 + サマリー       |
  +--------+---------+                                      |
           |                                                |
           v                                                |
  +------------------+                                      |
  | ファセット調整    |   プロファイル微調整                    |
  | ミスマッチ確認    |   直近3セッション rolling 分析          |
  +--------+---------+                                      |
           |                                                |
           +------------------------------------------------+
                    （次のセッション: 更新されたルール）
```

### Compound 知識

知識はセッションを跨いで、信頼度ベースのライフサイクルで蓄積されます:

```
experiment (0.30) → candidate (0.55) → verified (0.75) → mature (0.90)
```

各ソリューションは `experiment` として始まります。セッションをまたいでコードに反映されるにつれ、自動的に昇格されます。ネガティブなエビデンスはサーキットブレーカーを発動させ（自動リタイア）、実際に機能するパターンだけが残ります。

| 種類 | ソース | Claude の活用方法 |
|------|--------|------------------|
| **ソリューション** | セッションから抽出 | プロンプトに関連するものを自動注入（TF-IDF + BM25 + bigram アンサンブル） |
| **スキル** | 21個の組み込み + 検証済みソリューションから昇格 | キーワードで有効化（`specify`、`deep-interview`、`tdd` など） |
| **行動パターン** | 3回以上の観察で自動検出 | `forge-behavioral.md` に適用 |
| **エビデンス** | 修正 + 観察 | ファセット調整 + ルール作成を促進 |

### ソリューション自動注入

入力したプロンプトはすべて、蓄積されたソリューションと照合されます。関連するものはClaudeのコンテキストに自動注入されます — 手動検索は不要です。

```
入力: "API のエラーハンドリングを修正して"
                    ↓
solution-injector がマッチ: starter-error-handling-patterns (0.70)
                    ↓
Claude が見るもの: "Matched solutions: error-handling-patterns [pattern|0.70]
             Use try/catch with specific error types. Always log original error..."
                    ↓
Claude が蓄積されたパターンを参照して、より良いエラーハンドリングコードを書く。
```

### 21個の組み込みスキル

プロンプトにキーワードを含めることで有効化:

| スキル | トリガー | 機能 |
|-------|---------|------|
| `specify` | "specify", "명세" | 要件を Resolved/Provisional/Unresolved で整理、準備度 % 付き |
| `deep-interview` | "deep-interview" | Ambiguity Score (0-10) 付きの深い要件インタビュー |
| `code-review` | "code review 해줘" | 重大度評価付き20項目チェックリストレビュー |
| `tdd` | "tdd 해줘" | Red-Green-Refactor テスト駆動開発 |
| `debug-detective` | "debug-detective" | 再現 → 分離 → 修正 → 検証のループ |
| `refactor` | "refactor 시작" | テストファーストの安全なリファクタリング |
| `git-master` | "git-master" | アトミックコミット + クリーンな履歴管理 |
| `security-review` | "security review" | OWASP Top 10 脆弱性チェック |
| `ecomode` | "ecomode", "에코 모드" | トークン節約モード |
| `migrate` | "migrate 해줘", "마이그레이션 시작" | 5フェーズの安全なマイグレーションワークフロー |
| ... | | 残り11個（api-design, architecture-decision, ci-cd, database, docker, documentation, frontend, incident-response, performance, testing-strategy, compound） |

### セッション管理

| 機能 | 動作 |
|------|------|
| **セッションブリーフ** | コンテキスト圧縮前に構造化されたブリーフを保存し、次のセッションで復元 |
| **ドリフト検出** | EWMA ベースの編集レート追跡 → 15編集で警告、30で危機的、50でハードストップ |
| **エージェント出力検証** | Claude がサブエージェントを生成すると、その出力品質が自動検証される |
| **自動コンパクト** | 累積12万文字でコンテキスト圧縮の指示 |
| **ペンディング compound** | 20回以上のプロンプトセッション後、次のセッションで compound 抽出が自動トリガー |

---

## 4軸パーソナライゼーション

各軸には3つのパックがあります。各パックにはきめ細かなファセット（0-1の数値）が含まれ、修正に応じて時間とともに微調整されます。

### 品質/安全性

| パック | Claude の振る舞い |
|--------|-----------------|
| **堅実型** | 完了報告前にすべてのテストを実行。型チェック。エッジケース検証。すべてのチェックが通過するまで「完了」と言わない。 |
| **バランス型** | 主要な検証を実行し、残りのリスクを要約。徹底さと速度のバランス。 |
| **スピード型** | クイックスモークテスト。結果とリスクを即座に報告。納品を優先。 |

### 自律性

| パック | Claude の振る舞い |
|--------|-----------------|
| **確認優先型** | 隣接ファイルの変更前に確認。あいまいな要件を明確化。スコープ拡大に承認を要求。 |
| **バランス型** | 同じフロー内なら進行。大きなスコープ拡大が見えたら確認。 |
| **自律実行型** | 合理的に仮定。関連ファイルを直接修正。完了後に何をしたか報告。 |

### 判断哲学

| パック | Claude の振る舞い |
|--------|-----------------|
| **最小変更型** | 既存構造を維持。動作するコードをリファクタリングしない。修正範囲を最小限に保つ。 |
| **バランス型** | 現在のタスクに集中。明確な改善機会が見えたら提案。 |
| **構造的アプローチ型** | 繰り返しパターンや技術的負債を発見したら積極的に構造改善を提案。抽象化と再利用設計を好む。アーキテクチャの一貫性を維持。 |

### コミュニケーション

| パック | Claude の振る舞い |
|--------|-----------------|
| **簡潔型** | コードと結果のみ。先回りして説明しない。聞かれた時だけ補足。 |
| **バランス型** | 主要な変更と理由を要約。必要に応じてフォローアップを促す。 |
| **詳細型** | 何を、なぜ、影響範囲、代替案まで説明。教育的コンテキストを提供。レポートをセクション構造で整理。 |

---

## レンダリングされたルールの実際の様子

forgen がセッションを合成すると、Claude が読む `v1-rules.md` ファイルをレンダリングします。異なるプロファイルがまったく異なる Claude の振る舞いを生み出す2つの実例です。

### 例1: 堅実型 + 確認優先型 + 構造的アプローチ型 + 詳細型

```markdown
[Conservative quality / Confirm-first autonomy / Structural judgment / Detailed communication]

## Must Not
- Never commit or expose .env, credentials, or API keys.
- Never execute destructive commands (rm -rf, DROP, force-push) without user confirmation.

## Working Defaults
- Trust: Dangerous bypass disabled. Always confirm before destructive commands or sensitive path access.
- Proactively suggest structural improvements when you spot repeated patterns or tech debt.
- Prefer abstraction and reusable design, but avoid over-abstraction.
- Maintain architectural consistency across changes.

## When To Ask
- Clarify requirements before starting ambiguous tasks.
- Ask before modifying files outside the explicitly requested scope.

## How To Validate
- Run all related tests, type checks, and key verifications before reporting completion.
- Do not say "done" until all checks pass.

## How To Report
- Explain what changed, why, impact scope, and alternatives considered.
- Provide educational context — why this approach is better, compare with alternatives.
- Structure reports: changes, reasoning, impact, next steps.

## Evidence Collection
- When the user corrects your behavior ("don't do that", "always do X", "stop doing Y"), call the correction-record MCP tool to record it as evidence.
- kind: fix-now (immediate fix), prefer-from-now (going forward), avoid-this (never do this)
- axis_hint: quality_safety, autonomy, judgment_philosophy, communication_style
- Do not record general feedback — only explicit behavioral corrections.
```

### 例2: スピード型 + 自律実行型 + 最小変更型 + 簡潔型

```markdown
[Speed-first quality / Autonomous autonomy / Minimal-change judgment / Concise communication]

## Must Not
- Never commit or expose .env, credentials, or API keys.
- Never execute destructive commands (rm -rf, DROP, force-push) without user confirmation.

## Working Defaults
- Trust: Minimal runtime friction. Free execution except explicit bans and destructive commands.
- Preserve existing code structure. Do not refactor working code unnecessarily.
- Keep modification scope minimal. Change adjacent files only when strictly necessary.
- Secure evidence (tests, error logs) before making changes.

## How To Validate
- Quick smoke test. Report results and risks immediately.

## How To Report
- Keep responses short and to the point. Focus on code and results.
- Only elaborate when asked. Do not proactively write long explanations.

## Evidence Collection
- When the user corrects your behavior ("don't do that", "always do X", "stop doing Y"), call the correction-record MCP tool to record it as evidence.
- kind: fix-now (immediate fix), prefer-from-now (going forward), avoid-this (never do this)
- axis_hint: quality_safety, autonomy, judgment_philosophy, communication_style
- Do not record general feedback — only explicit behavioral corrections.
```

同じ Claude。同じコードベース。まったく異なる作業スタイル。1分間のオンボーディングが生み出す違いです。

---

## コマンド

### コア

```bash
forgen                          # パーソナライズされた Claude Code を起動
forgen "ログインのバグを修正して"  # プロンプト付きで起動
forgen --resume                 # 前回のセッションを再開
```

### パーソナライゼーション

```bash
forgen onboarding               # 4問オンボーディングを実行
forgen forge --profile          # 現在のプロファイルを表示
forgen forge --reset soft       # プロファイルをリセット (soft / learning / full)
forgen forge --export           # プロファイルをエクスポート
```

### 状態確認

```bash
forgen stats                    # 1画面 Trust Layer ダッシュボード (ルール・修正・block 7日)
forgen last-block               # 直近のブロックイベント詳細
forgen inspect profile          # 4軸プロファイル + パック + ファセット
forgen inspect rules            # アクティブ/抑制されたルール
forgen inspect corrections      # 修正履歴 (alias: evidence)
forgen inspect session          # 現在のセッション状態
forgen inspect violations       # 最近のブロック記録 (--last N)
forgen me                       # パーソナルダッシュボード（inspect profile のショートカット）
```

### ルール管理

```bash
forgen rule list                # アクティブ + suppressed ルール一覧
forgen rule suppress <id>       # ルールを無効化 (hard ルールは拒否)
forgen rule activate <id>       # suppressed ルールを再アクティブ化
forgen rule scan [--apply]      # ライフサイクルトリガー実行 (昇格/降格/引退)
forgen rule health-scan         # drift → Mech 降格候補をスキャン
forgen rule classify            # 既存ルールに enforce_via を自動提案
```

### 知識管理

```bash
forgen compound                 # 蓄積された知識をプレビュー
forgen compound --save          # 自動分析されたパターンを保存
forgen compound list            # ステータス付きで全ソリューションを一覧表示
forgen compound inspect <名前>  # ソリューションの詳細を表示
forgen compound --lifecycle     # 昇格/降格チェックを実行
forgen compound --verify <名前> # 手動で verified に昇格
forgen compound export          # 知識を tar.gz でエクスポート
forgen compound import <パス>   # 知識アーカイブをインポート
forgen skill promote <名前>     # 検証済みソリューションをスキルに昇格
forgen skill list               # 昇格されたスキルの一覧
```

### システム

```bash
forgen init                     # プロジェクトを初期化
forgen doctor                   # システム診断（10カテゴリ + ハーネス成熟度）
forgen dashboard                # 知識概要（6セクション）
forgen config hooks             # フック状態 + コンテキストバジェットを確認
forgen config hooks --regenerate # フックを再生成
forgen mcp list                 # インストール済み MCP サーバーを一覧
forgen mcp add <名前>           # テンプレートから MCP サーバーを追加
forgen mcp templates            # 利用可能なテンプレートを表示
forgen notepad show             # セッションノートパッドを表示
forgen uninstall                # forgen をきれいに削除
```

### MCP ツール（セッション中に Claude が使用可能）

| ツール | 目的 |
|--------|------|
| `compound-search` | クエリで蓄積された知識を検索（TF-IDF + BM25 + bigram アンサンブル） |
| `compound-read` | ソリューション全文を読む（Progressive Disclosure Tier 3） |
| `compound-list` | ステータス/タイプ/スコープフィルタ付きソリューション一覧 |
| `compound-stats` | ステータス・タイプ・スコープ別の概要統計 |
| `session-search` | 過去のセッション会話を検索（SQLite FTS5、Node.js 22+） |
| `correction-record` | ユーザー修正を構造化されたエビデンスとして記録 |
| `profile-read` | 現在のパーソナライゼーションプロファイルを読む |
| `rule-list` | カテゴリ別のアクティブなパーソナライゼーションルールを一覧 |

---

## アーキテクチャ

```
~/.forgen/                           パーソナライゼーションホーム
|-- me/
|   |-- forge-profile.json           4軸プロファイル (パック + ファセット + trust)
|   |-- rules/                       ルールストア (ルールごとの JSON ファイル)
|   |-- behavior/                    エビデンスストア (修正 + 観察)
|   |-- recommendations/             パック推薦 (オンボーディング + ミスマッチ)
|   +-- solutions/                   Compound 知識
|-- state/
|   |-- sessions/                    セッション状態スナップショット
|   +-- raw-logs/                    Raw セッションログ (7日 TTL 自動クリーンアップ)
+-- config.json                      グローバル設定 (locale, trust, packs)

~/.claude/
|-- settings.json                    フック + 環境変数 (ハーネスが注入)
|-- rules/
|   |-- forge-behavioral.md          学習された行動パターン (自動生成)
|   +-- v1-rules.md                  レンダリングされたパーソナライゼーションルール (セッションごと)
|-- commands/forgen/                 スラッシュコマンド (昇格されたスキル)
+-- .claude.json                     MCP サーバー登録

~/.compound/                         レガシー compound ホーム (フック/MCP がまだ参照)
|-- me/
|   |-- solutions/                   蓄積された compound 知識
|   |-- behavior/                    行動パターン
|   +-- skills/                      昇格されたスキル
+-- sessions.db                      SQLite セッション履歴 (Node.js 22+)
```

### データフロー

```
forge-profile.json                   パーソナライゼーションの単一真実源
        |
        v
preset-manager.ts                    セッション状態を合成:
  グローバル安全ルール                    hard constraint (常にアクティブ)
  + ベースパックルール                    プロファイルパックから
  + 個人オーバーレイ                     修正生成ルールから
  + セッションオーバーレイ                現在セッションの一時ルール
  + ランタイム能力検出                    trust ポリシー調整
        |
        v
rule-renderer.ts                     Rule[] を自然言語に変換:
  フィルタ (active のみ)                パイプライン: filter -> dedupe -> group ->
  dedupe (render_key)                  order -> template -> budget (4000文字)
  カテゴリ別グループ
  順序: Must Not -> Working Defaults -> When To Ask -> How To Validate -> How To Report
        |
        v
~/.claude/rules/v1-rules.md         Claude が実際に読むファイル
```

---

## セーフティ

セーフティフックは `settings.json` に自動登録され、Claude のすべてのツール呼び出し時に実行されます。

| フック | トリガー | 機能 |
|--------|---------|------|
| **pre-tool-use** | すべてのツール実行前 | `rm -rf`、`curl\|sh`、`--force` push、危険なパターンをブロック |
| **db-guard** | SQL 操作 | `DROP TABLE`、`WHERE` なし `DELETE`、`TRUNCATE` をブロック |
| **secret-filter** | ファイル書き込み、出力 | API キー、トークン、認証情報の露出時に警告 |
| **slop-detector** | コード生成後 | TODO 残骸、`eslint-disable`、`as any`、`@ts-ignore`、空の catch を検出 |
| **prompt-injection-filter** | すべての入力 | パターン + ヒューリスティックによるプロンプトインジェクションのブロック |
| **context-guard** | セッション中 | 50プロンプト/20万文字で警告、12万文字で自動コンパクト、セッションハンドオフ |
| **rate-limiter** | MCP ツール呼び出し | 過度な MCP ツール呼び出しを防止 |
| **drift-detector** | ファイル編集 | EWMA ベースのドリフトスコア: 警告 → 危機的 → 50編集でハードストップ |
| **agent-validator** | エージェントツール出力 | 空/失敗/切り捨てられたサブエージェント出力を警告 |

安全ルールは**ハード制約**です -- パック選択や修正で上書きできません。レンダリングされたルールの「Must Not」セクションは、プロファイルに関係なく常に存在します。

---

## 主要な設計判断

- **4軸プロファイル、設定トグルではない。** 各軸にはパック（大分類）とファセット（0-1の数値によるきめ細かな調整）があります。パックは安定した振る舞いを提供し、ファセットは完全な再分類なしで微調整を可能にします。

- **エビデンスベースの学習、正規表現マッチングではない。** 修正は構造化されたデータ（`CorrectionRequest`: kind, axis_hint, message）です。Claude が分類し、アルゴリズムが適用します。ユーザー入力に対するパターンマッチングはありません。

- **パック + オーバーレイモデル。** ベースパックが安定したデフォルトを提供。修正から生成された個人オーバーレイがその上に重なります。セッションオーバーレイは一時ルール用。競合解決: セッション > 個人 > パック（グローバル安全は常にハード制約）。

- **自然言語でレンダリングされたルール。** `v1-rules.md` ファイルには設定ではなく英語（または韓国語）の文章が含まれます。Claude は「動作するコードを不必要にリファクタリングするな」のような指示を読みます -- 人間のメンターがガイダンスを与えるのと同じ方法です。

- **ミスマッチ検出。** 直近3セッションのローリング分析で、修正が継続的に現在のパックと異なる方向を指しているかを確認します。検出された場合、静かにドリフトするのではなく、パックの再推薦を提案します。

- **ランタイム trust 計算。** 希望する trust ポリシーが Claude Code の実際のランタイム権限モードと調整されます。Claude Code が `--dangerously-skip-permissions` で実行される場合、forgen は effective trust レベルをそれに応じて調整します。

- **国際化。** 英語と韓国語を完全サポート。オンボーディング時に言語を選択すると、オンボーディングの質問、レンダリングされたルール、CLI 出力全体に適用されます。

---

## 共存

forgen はインストール時に他の Claude Code プラグイン（oh-my-claudecode、superpowers、claude-mem）を検出し、コンテキスト注入を自動的に50%削減します（「譲歩原則」）。コアのセーフティフックと compound フックは常にアクティブを維持します。他のプラグインがすでに提供しているスキルは競合を避けるためスキップされます。

詳細は [共存ガイド](docs/guides/with-omc.md) を参照してください。

---

## ライセンス

MIT
