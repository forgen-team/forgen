<p align="center">
  <img src="https://raw.githubusercontent.com/wooo-jin/forgen/main/assets/banner.png" alt="Forgen" width="100%"/>
</p>

<p align="center">
  <strong>当 Claude 说"完成了", forgen 让它拿出证据。</strong><br/>
  按轮次的自我验证 + 个性化规则, <strong>额外 API 成本 $0</strong>。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@wooojin/forgen"><img src="https://img.shields.io/npm/v/@wooojin/forgen.svg" alt="npm version"/></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"/></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js >= 20"/></a>
</p>

<p align="center">
  <a href="#第一次拦截-30秒">第一次拦截</a> &middot;
  <a href="#快速开始">快速开始</a> &middot;
  <a href="#工作原理">工作原理</a> &middot;
  <a href="#4轴个性化">4轴</a> &middot;
  <a href="#这个-harness-装载的是你">愿景</a> &middot;
  <a href="#命令">命令</a> &middot;
  <a href="#架构">架构</a> &middot;
  <a href="#安全">安全</a>
</p>

<p align="center">
  <a href="README.md">English</a> &middot;
  <a href="README.ko.md">한국어</a> &middot;
  <a href="README.ja.md">日本語</a> &middot;
  简体中文
</p>

---

## 第一次拦截 (30秒)

你被骗过很多次了: Claude 说"测试通过, 实现完成" — 真正运行 — 却不工作。forgen 填补这个缺口。

```
You:     "实现登录 handler。"
Claude:  ...编辑文件...
Claude:  "구현 완료했습니다。"

[forgen:stop-guard/L1-e2e-before-done]
没有 Docker e2e 证据 (~/.forgen/state/e2e-result.json, 1小时内)。
立即执行后再回答。

Claude:  "撤回完成声明。证据文件不存在。先执行 e2e..."
         ...bash tests/e2e/docker/run-test.sh 执行...
         "63/63 通过。구현 완료했습니다。"

[forgen] ✓ approved
```

**刚刚发生了什么**: Claude 的 Stop hook 被你定义的规则 (`L1-e2e-before-done`) 拦截。Claude 读取了 block `reason`, 撤回过早的完成声明, 产生证据, 重新提交。**零额外 API 调用** — 全部发生在 Claude 本来就会产出的同一个 session turn 内。

这就是 **Mech-B 自检 prompt-inject**。它工作是因为 Claude Code 的 Stop hook 接受 `decision: "block"` + `reason`, 而 Claude 在下一轮把那个 reason 作为输入读取。我们用 10 个场景、$1.74 总成本端到端验证 ([A1 spike report](docs/spike/mech-b-a1-verification-report.md))。

🎬 **观看实际运行** (27秒):

```bash
# 现场观看完整循环 — 真实的 hook、真实的规则、真实的 block/approve 周期
bash docs/demo/mech-b-demo.sh

# 或重放预录制的 asciinema cast
asciinema play docs/demo/mech-b-block-unblock.cast
```

关于 demo 中"真实 vs 模拟"的详情见 [`docs/demo/README.md`](docs/demo/README.md)。

---

## 两个开发者。同一个 Claude。完全不同的行为。

上述 Trust Layer 是一根支柱。另一根是个性化 — 第一次拦截之后继续使用 forgen 的理由。

开发者 A 做事谨慎。他希望 Claude 运行所有测试、解释原因，在触碰当前文件以外的内容前先征求确认。

开发者 B 追求速度。他希望 Claude 自行假设、直接修复相关文件、用两行汇报结果。

没有 forgen，两个人得到的是同一个通用 Claude。有了 forgen，每个人都能得到按*自己方式*工作的 Claude。

```
开发者 A 的 Claude:                    开发者 B 的 Claude:
"我发现了3个相关问题。                   "已修复登录 + 2个关联文件。
在继续之前，要不要一起修复                 测试通过。风险1项: 会话超时
session handler? 以下是                  未覆盖。完毕。"
每个问题的分析..."
```

forgen 实现了这一切。它对你的工作风格进行画像、从你的纠正中学习、渲染个性化规则让 Claude 在每个会话中遵循。

---

## 这个 harness 装载的是你

个性化只是表面。更深层的想法:**每次会话都留下痕迹,这些痕迹累积起来成为一个像你一样判断的 harness。** 你的修正、你的规范、你的权衡偏好 — 从对话中提取,存储在 `~/.forgen/me/` 下,并在每次后续会话中回放给 Claude。

```
对话          ──►  提取: solution / rule / behavior / profile 更新
                    ────────────────────────────────────────────
                                       │
                                       ▼
下一次会话    ◄──  注入: UserPromptSubmit 上下文 + 渲染的规则
                    + 校准到你标准的 Stop-hook 守卫
```

几周之后,这个 harness 不再是"强制执行规则的工具",而是 **承载你如何判断工作的可携带包裹**。一条命令导出:

```bash
forgen compound export    # → forgen-knowledge-YYYY-MM-DD.tar.gz
                          #   (rules + solutions + behavior — 你的哲学)
forgen compound import <path>   # 在另一台机器上重放
```

这就是北极星:*你的笔记本上,一个像你一样判断的 Claude,还有你能随身携带的 tarball。*

---

## 使用 forgen 会发生什么

### 首次运行（仅一次，约1分钟）

```bash
npm install -g @wooojin/forgen
forgen
```

forgen 检测到这是首次运行，启动4题引导问卷。每个问题都是一个具体场景:

```
  Q1: Ambiguous implementation request

  You receive "improve the login feature." Requirements are
  unclear and adjacent modules may be affected.

  A) Clarify requirements/scope first. Ask if scope expansion is possible.
  B) Proceed if within same flow. Check when major scope expansion appears.
  C) Make reasonable assumptions and fix adjacent files directly.

  Choice (A/B/C):
```

4个问题。测量4个轴。为每个轴创建包含 pack 和精细 facet 的档案。个性化规则文件被渲染并放置在 Claude 读取的位置。

### 每次会话（日常使用）

```bash
forgen                    # 用它代替 `claude`
```

内部发生的事:

1. 引擎从 `~/.forgen/me/forge-profile.json` 加载你的档案
2. 预设管理器合成会话: 全局安全规则 + pack 基础规则 + 个人覆盖层 + 会话覆盖层
3. 规则渲染器将一切转换为自然语言，写入 `~/.claude/rules/v1-rules.md`
4. Claude Code 启动，将这些规则作为行为指令读取
5. 安全钩子激活: 拦截危险命令、过滤密钥、检测 prompt 注入

### 当你纠正 Claude 时

你说: "不要重构我没要求你动的文件。"

Claude 调用 `correction-record` MCP 工具。纠正作为结构化证据存储，包含轴分类（`judgment_philosophy`）、种类（`avoid-this`）和置信度分数。为当前会话创建一条临时规则以立即生效。

### 会话之间（自动）

会话结束时，auto-compound 提取:
- 解决方案（带上下文的可复用模式）
- 行为观察（你的工作方式）
- 会话学习摘要

基于累积的证据对 facet 进行微调。如果你的纠正持续指向与当前 pack 不同的方向，3个会话后触发不匹配检测，推荐更换 pack。

### 下一个会话

包含纠正的更新规则被渲染。Compound 知识可通过 MCP 搜索。Claude 变得越来越像*你的* Claude。

---

## 快速开始

```bash
# 1. 安装 (必须 -g — forgen 是全局 CLI)
npm install -g @wooojin/forgen

# 2. 注册主机 — Claude Code / Codex / 两者
forgen install both          # 三选交互: claude / codex / both
# 或非交互:
forgen install claude
forgen install codex

# 3. 首次运行 — 4题引导问卷 (英语/韩语选择)
forgen                        # 默认: Claude
forgen --runtime codex        # 使用 Codex
forgen config default-host codex   # 设置持久默认主机
```

### 前提条件

- **Node.js** >= 20 (SQLite 会话搜索推荐 >= 22)
- **至少安装一个主机** 并认证:
  - **Claude Code** — `npm i -g @anthropic-ai/claude-code`
  - **Codex CLI** — 参考 [Codex docs](https://github.com/openai/codex)
  - 也可同时使用 — `forgen install both` 对两者对称注册 hook/MCP

> **厂商依赖:** forgen 对称包装 Claude Code 与 Codex CLI (Claude 为行为基准, Codex 以等价性扩展)。上游 API/CLI 变更可能影响行为。已在 Claude Code 1.0.x / 2.1.x、Codex 0.x 下测试。

---

## 为什么选择 forgen

|                        | Generic Claude Code | oh-my-claudecode | forgen          |
|------------------------|:-------------------:|:----------------:|:---------------:|
| 对所有人相同           | Yes                 | Yes              | **No**          |
| 从纠正中学习           | No                  | No               | **Yes**         |
| 基于证据的生命周期     | No                  | No               | **Yes**         |
| 自动淘汰不良模式       | No                  | No               | **Yes**         |
| 个性化规则             | No                  | No               | **Yes**         |
| 运行时依赖             | -                   | many             | **3**           |

### 适用场景

**适合使用:**
- Claude 可以在数周内学习你的模式的长期项目
- 对 AI 行为方式有强烈偏好的开发者
- 有重复模式、能从 Compound 知识中获益的代码库

**不适合使用:**
- 一次性脚本或临时原型
- 没有 Claude Code 的环境
- 需要所有成员 AI 行为完全一致的团队（forgen 是个人化的，不面向团队）

**forgen + oh-my-claudecode:** 可以一起使用。OMC 负责编排（智能体、工作流）; forgen 负责个性化（档案、学习）。详情请参阅 [共存指南](docs/guides/with-omc.md)。

---

## 工作原理

### 学习循环

```
                          +-------------------+
                          |     引导问卷       |
                          |    （4个问题）      |
                          +--------+----------+
                                   |
                                   v
                   +-------------------------------+
                   |         档案创建               |
                   |  4轴 x pack + facet + trust     |
                   +-------------------------------+
                                   |
           +-----------------------+------------------------+
           |                                                |
           v                                                |
  +------------------+                                      |
  |   规则渲染        |   ~/.claude/rules/v1-rules.md        |
  |  转换为 Claude 格式|                                      |
  +--------+---------+                                      |
           |                                                |
           v                                                |
  +------------------+                                      |
  |   会话运行        |   Claude 遵循个性化规则               |
  |    你纠正时      | ---> correction-record MCP            |
  |    Claude 学习   |      证据存储                         |
  +--------+---------+      临时规则创建                      |
           |                                                |
           v                                                |
  +------------------+                                      |
  |   会话结束        |   auto-compound 提取:                 |
  |                  |   解决方案 + 观察 + 摘要                |
  +--------+---------+                                      |
           |                                                |
           v                                                |
  +------------------+                                      |
  |   Facet 调整      |   档案微调                            |
  |   不匹配检查      |   最近3个会话 rolling 分析             |
  +--------+---------+                                      |
           |                                                |
           +------------------------------------------------+
                    （下一个会话: 更新后的规则）
```

### Compound 知识

知识跨会话累积，遵循基于信任度的生命周期:

```
experiment (0.30) → candidate (0.55) → verified (0.75) → mature (0.90)
```

每个解决方案从 `experiment` 开始。随着它在多个会话中被反映到你的代码里，会自动晋升。负面证据触发熔断机制（自动退役）。这意味着只有真正适合你的模式才能留存。

| 类型 | 来源 | Claude 如何使用 |
|------|------|----------------|
| **解决方案** | 从会话中提取 | 与提示相关时自动注入（TF-IDF + BM25 + bigram 集成） |
| **技能** | 21个内置 + 从已验证解决方案晋升 | 关键词激活（`specify`、`deep-interview`、`tdd` 等） |
| **行为模式** | 3次以上观察时自动检测 | 应用到 `forge-behavioral.md` |
| **证据** | 纠正 + 观察 | 驱动 facet 调整 + 规则创建 |

### 解决方案自动注入

你输入的每个提示都会与你积累的解决方案进行匹配。相关的解决方案会自动注入 Claude 的上下文 — 无需手动查找。

```
你输入: "修复 API 中的错误处理"
                    ↓
solution-injector 匹配: starter-error-handling-patterns (0.70)
                    ↓
Claude 看到: "Matched solutions: error-handling-patterns [pattern|0.70]
             Use try/catch with specific error types. Always log original error..."
                    ↓
Claude 参考你积累的模式，写出更好的错误处理代码。
```

### 21个内置技能

在提示中包含关键词即可激活:

| 技能 | 触发词 | 功能 |
|------|--------|------|
| `specify` | "specify", "명세" | 将需求整理为 Resolved/Provisional/Unresolved，附就绪度 % |
| `deep-interview` | "deep-interview" | 深度需求访谈，每个主题附 Ambiguity Score (0-10) |
| `code-review` | "code review 해줘" | 附严重度评级的20条清单审查 |
| `tdd` | "tdd 해줘" | Red-Green-Refactor 测试驱动开发 |
| `debug-detective` | "debug-detective" | 复现 → 隔离 → 修复 → 验证循环 |
| `refactor` | "refactor 시작" | 测试优先的安全重构 |
| `git-master` | "git-master" | 原子提交 + 清晰历史管理 |
| `security-review` | "security review" | OWASP Top 10 漏洞检查 |
| `ecomode` | "ecomode", "에코 모드" | Token 节省模式 |
| `migrate` | "migrate 해줘", "마이그레이션 시작" | 5阶段安全迁移工作流 |
| ... | | 另外11个（api-design, architecture-decision, ci-cd, database, docker, documentation, frontend, incident-response, performance, testing-strategy, compound） |

### 会话管理

| 功能 | 发生了什么 |
|------|-----------|
| **会话摘要** | 上下文压缩前保存结构化摘要，在下一个会话中恢复 |
| **漂移检测** | 基于 EWMA 的编辑速率追踪 → 15次编辑警告，30次危急，50次硬停止 |
| **智能体输出验证** | 当 Claude 生成子智能体时，自动验证其输出质量 |
| **自动压缩** | 累积12万字符时，指示 Claude 压缩上下文 |
| **待处理 compound** | 超过20个提示会话后，下一个会话自动触发 compound 提取 |

---

## 4轴个性化

每个轴有3个 pack。每个 pack 包含精细的 facet（0-1 数值），随着你的纠正逐步微调。

### 质量/安全

| Pack | Claude 的行为 |
|------|--------------|
| **稳健型** | 完成报告前运行所有测试。类型检查。边界用例验证。所有检查通过前不说"完成"。 |
| **平衡型** | 运行关键检查，总结剩余风险。在彻底和速度之间取得平衡。 |
| **速度型** | 快速冒烟测试。立即报告结果和风险。优先交付。 |

### 自主性

| Pack | Claude 的行为 |
|------|--------------|
| **确认优先型** | 修改相邻文件前先确认。澄清模糊需求。范围扩展需获得批准。 |
| **平衡型** | 在同一流程内继续推进。出现重大范围扩展时进行确认。 |
| **自主执行型** | 做出合理假设。直接修复相关文件。事后报告所做的内容。 |

### 判断哲学

| Pack | Claude 的行为 |
|------|--------------|
| **最小变更型** | 保持现有结构。不重构正常运行的代码。将修改范围保持在最小。 |
| **平衡型** | 专注于当前任务。看到明确的改进机会时提出建议。 |
| **结构化型** | 发现重复模式或技术债务时主动建议结构改进。倾向抽象化和可复用设计。保持架构一致性。 |

### 沟通风格

| Pack | Claude 的行为 |
|------|--------------|
| **简洁型** | 只给代码和结果。不主动展开说明。只在被问到时补充。 |
| **平衡型** | 总结关键变更和原因。必要时引导追问。 |
| **详尽型** | 解释改了什么、为什么、影响范围以及考虑过的替代方案。提供教育性上下文。用分节结构组织报告。 |

---

## 渲染后的规则实际长什么样

forgen 合成会话时，会渲染一个 Claude 读取的 `v1-rules.md` 文件。以下是两个真实示例，展示不同档案如何产生完全不同的 Claude 行为。

### 示例1: 稳健型 + 确认优先型 + 结构化型 + 详尽型

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

### 示例2: 速度型 + 自主执行型 + 最小变更型 + 简洁型

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

同一个 Claude。同一个代码库。完全不同的工作风格。1分钟的引导问卷带来的差异。

---

## 命令

### 核心

```bash
forgen                          # 启动个性化的 Claude Code
forgen "修复登录 bug"            # 带提示启动
forgen --resume                 # 恢复上一个会话
```

### 个性化

```bash
forgen onboarding               # 运行4题引导问卷
forgen forge --profile          # 查看当前档案
forgen forge --reset soft       # 重置档案 (soft / learning / full)
forgen forge --export           # 导出档案
```

### 状态查看

```bash
forgen stats                    # 单屏 Trust Layer 仪表盘 (规则·纠正·block 7天)
forgen last-block               # 最近一次拦截事件详情
forgen inspect profile          # 4轴档案 + pack + facet
forgen inspect rules            # 活跃/抑制的规则
forgen inspect corrections      # 纠正历史 (alias: evidence)
forgen inspect session          # 当前会话状态
forgen inspect violations       # 最近的拦截记录 (--last N)
forgen me                       # 个人仪表盘（inspect profile 的快捷方式）
```

### 规则管理

```bash
forgen rule list                # 列出活跃 + suppressed 规则
forgen rule suppress <id>       # 禁用规则 (hard 规则拒绝)
forgen rule activate <id>       # 重新激活 suppressed 规则
forgen rule scan [--apply]      # 运行生命周期触发器 (晋升/降级/退役)
forgen rule health-scan         # 扫描 drift → Mech 降级候选
forgen rule classify            # 为旧规则自动提议 enforce_via
```

### 知识管理

```bash
forgen compound                 # 预览累积的知识
forgen compound --save          # 保存自动分析的模式
forgen compound list            # 列出所有解决方案及状态
forgen compound inspect <名称>  # 查看解决方案完整详情
forgen compound --lifecycle     # 运行晋升/降级检查
forgen compound --verify <名称> # 手动晋升为 verified
forgen compound export          # 将知识导出为 tar.gz
forgen compound import <路径>   # 导入知识归档
forgen skill promote <名称>     # 将已验证的解决方案晋升为技能
forgen skill list               # 列出已晋升的技能
```

### 系统

```bash
forgen init                     # 初始化项目
forgen doctor                   # 系统诊断（10个类别 + 引擎成熟度）
forgen dashboard                # 知识概览（6个板块）
forgen config hooks             # 查看钩子状态 + 上下文预算
forgen config hooks --regenerate # 重新生成钩子
forgen mcp list                 # 列出已安装的 MCP 服务器
forgen mcp add <名称>           # 从模板添加 MCP 服务器
forgen mcp templates            # 显示可用模板
forgen notepad show             # 查看会话记事本
forgen uninstall                # 干净地卸载 forgen
```

### MCP 工具（会话中 Claude 可使用）

| 工具 | 用途 |
|------|------|
| `compound-search` | 按查询搜索累积的知识（TF-IDF + BM25 + bigram 集成） |
| `compound-read` | 读取解决方案全文（Progressive Disclosure Tier 3） |
| `compound-list` | 带状态/类型/范围过滤器的解决方案列表 |
| `compound-stats` | 按状态、类型、范围的概览统计 |
| `session-search` | 搜索过去的会话对话（SQLite FTS5，Node.js 22+） |
| `correction-record` | 将用户纠正记录为结构化证据 |
| `profile-read` | 读取当前个性化档案 |
| `rule-list` | 按类别列出活跃的个性化规则 |

---

## 架构

```
~/.forgen/                           个性化主目录
|-- me/
|   |-- forge-profile.json           4轴档案 (pack + facet + trust)
|   |-- rules/                       规则存储 (每条规则一个 JSON 文件)
|   |-- behavior/                    证据存储 (纠正 + 观察)
|   |-- recommendations/             Pack 推荐 (引导问卷 + 不匹配)
|   +-- solutions/                   Compound 知识
|-- state/
|   |-- sessions/                    会话状态快照
|   +-- raw-logs/                    原始会话日志 (7天 TTL 自动清理)
+-- config.json                      全局配置 (locale, trust, packs)

~/.claude/
|-- settings.json                    钩子 + 环境变量 (引擎注入)
|-- rules/
|   |-- forge-behavioral.md          学习到的行为模式 (自动生成)
|   +-- v1-rules.md                  渲染的个性化规则 (每会话)
|-- commands/forgen/                 斜杠命令 (晋升的技能)
+-- .claude.json                     MCP 服务器注册

~/.compound/                         旧版 compound 主目录 (钩子/MCP 仍在引用)
|-- me/
|   |-- solutions/                   累积的 compound 知识
|   |-- behavior/                    行为模式
|   +-- skills/                      晋升的技能
+-- sessions.db                      SQLite 会话历史 (Node.js 22+)
```

### 数据流

```
forge-profile.json                   个性化的唯一真相来源
        |
        v
preset-manager.ts                    合成会话状态:
  全局安全规则                           hard constraint (始终活跃)
  + 基础 pack 规则                       来自档案 pack
  + 个人覆盖层                           来自纠正生成的规则
  + 会话覆盖层                           当前会话的临时规则
  + 运行时能力检测                        trust 策略调整
        |
        v
rule-renderer.ts                     将 Rule[] 转换为自然语言:
  过滤 (仅 active)                     管道: filter -> dedupe -> group ->
  dedupe (render_key)                  order -> template -> budget (4000字符)
  按类别分组
  顺序: Must Not -> Working Defaults -> When To Ask -> How To Validate -> How To Report
        |
        v
~/.claude/rules/v1-rules.md         Claude 实际读取的文件
```

---

## 安全

安全钩子自动注册到 `settings.json`，在 Claude 每次工具调用时执行。

| 钩子 | 触发条件 | 功能 |
|------|---------|------|
| **pre-tool-use** | 所有工具执行前 | 拦截 `rm -rf`、`curl\|sh`、`--force` push、危险模式 |
| **db-guard** | SQL 操作 | 拦截 `DROP TABLE`、无 `WHERE` 的 `DELETE`、`TRUNCATE` |
| **secret-filter** | 文件写入和输出 | API 密钥、令牌、凭据即将暴露时发出警告 |
| **slop-detector** | 代码生成后 | 检测 TODO 残留、`eslint-disable`、`as any`、`@ts-ignore`、空 catch 块 |
| **prompt-injection-filter** | 所有输入 | 基于模式 + 启发式的 prompt 注入拦截 |
| **context-guard** | 会话中 | 50个提示/20万字符时警告，12万字符自动压缩，会话交接 |
| **rate-limiter** | MCP 工具调用 | 防止过度的 MCP 工具调用 |
| **drift-detector** | 文件编辑 | 基于 EWMA 的漂移评分: 警告 → 危急 → 50次编辑硬停止 |
| **agent-validator** | 智能体工具输出 | 对空/失败/截断的子智能体输出发出警告 |

安全规则是**硬约束** -- 不能被 pack 选择或纠正覆盖。渲染规则中的 "Must Not" 部分无论档案如何始终存在。

---

## 核心设计决策

- **4轴档案，而非偏好开关。** 每个轴有 pack（大类）和 facet（0-1 数值的精细调整）。Pack 提供稳定的行为; facet 允许无需完全重新分类即可微调。

- **基于证据的学习，而非正则匹配。** 纠正是结构化数据（`CorrectionRequest`: kind, axis_hint, message）。Claude 进行分类; 算法负责应用。不对用户输入做模式匹配。

- **Pack + 覆盖层模型。** 基础 pack 提供稳定的默认值。纠正生成的个人覆盖层叠加在上面。会话覆盖层用于临时规则。冲突解决: 会话 > 个人 > pack（全局安全始终是硬约束）。

- **以自然语言渲染的规则。** `v1-rules.md` 文件包含的是英语（或韩语）句子，而非配置项。Claude 读到的指令是"不要不必要地重构正常运行的代码" -- 与人类导师给出指导的方式相同。

- **不匹配检测。** 最近3个会话的滚动分析检查你的纠正是否持续偏离当前 pack 的方向。检测到时，forgen 不会悄悄漂移，而是提出 pack 重新推荐。

- **运行时 trust 计算。** 你期望的 trust 策略与 Claude Code 的实际运行时权限模式进行协调。如果 Claude Code 以 `--dangerously-skip-permissions` 运行，forgen 会相应调整有效 trust 级别。

- **国际化。** 完全支持英语和韩语。在引导问卷中选择语言后，应用于整个流程（引导问题、渲染规则、CLI 输出）。

---

## 共存

forgen 在安装时检测其他 Claude Code 插件（oh-my-claudecode、superpowers、claude-mem），并自动将上下文注入量减少 50%（"让步原则"）。核心安全钩子和 compound 钩子始终保持活跃。当其他插件已提供相同技能时，forgen 会跳过该技能以避免冲突。

详情请参阅 [共存指南](docs/guides/with-omc.md)。

---

## 许可证

MIT
