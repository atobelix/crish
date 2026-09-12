# review-detail-01 · 分维详案跨维冲突评审

> **战役**：performance-fix  
> **评审对象**：`detail-D0`…`detail-D11D12D13` 共 8 份分维详案  
> **对照权威**：`92-修复总方案.md`（效果锁 / CFL-01…16 / 文件域 / 依赖总序 / §8 契约闸门）+ `review-plans-01-冲突与重叠.md`（CFL/OVL 底账）  
> **性质**：只审计划，不改代码；不改 92  
> **创建**：2026-09-13  
> **方法**：①CFL 合规逐条核 ②文件域真互斥 ③依赖图断环/矛盾 ④T2 是否被当 T0 ⑤OVL 主责是否单票落地

---

## 0. 评审口径

| 术语 | 定义 |
| -- | ---- |
| 冲突 | 两份及以上详案对同一文件/脚本/概念给出不兼容的主责或可并行声明，若同时采纳会双改/踩踏 |
| 必须改 | 不裁决则并行派发必撞，或违反 92 效果锁/CFL，或制造假完成 |
| 建议改 | 非阻断，但任务书/派发前应显式钉死 |
| 可接受风险 | 登记即可，无并行物理冲突 |
| T2-as-T0 | 强契约（schema / PE-02 / Progress / 双发等）被标 T0 且无会签门控即实现 |

---

## 1. CFL 合规总表（对照 92 / review-plans-01）

| CFL | 92 裁决要点 | 详案落地情况 | 判定 |
| -- | ----------- | ------------ | ---- |
| **CFL-01** 预算单源 | Rust SoT + FE 镜像；禁长期独立 `perf-budgets.json`；启动 JSON 仅 D9 命名空间 | D0 全量落地 SoT/镜像/`check-perf-budgets`；D9 只消费+迁移；D12.3 `MAX_RELAY_PAYLOAD_BYTES` 进 perf_budget；D3 有「D0 未落则临时常量登记待迁」过渡 | **合规**（过渡见 S-X4） |
| **CFL-02** persist 拆票 | 票 A 出口切除可并行 D3；票 B dirty+CAS 后于 D3 | D3 §0 闸门声明拆票；D4D5 §1 票 A/B 硬拆 + 禁串味 | **合规** |
| **CFL-03** NoPersist 先于组提交 | U-NOPE 绿才合组提交 | D1 T-D1-A 硬序 `NOP-EFORE-COMMIT`；D3 U-NOPE 绿闸门 + N1 | **合规** |
| **CFL-04** 真缓冲 T0 / PE-02 T2 | 仅 flush 时机 = T0；token 合并 = T2 | D1 T-D1-E 只改 flush；D11.4 标 T2·PR-PE-02；D6 D8.2 PTY 合批明示无 PE-02 | **合规** |
| **CFL-05** Diff 接线 | 默认接线 `highlight.batch`；禁删通道冒充 | D8.3 铁律 + CFL-05 禁令原文 | **合规** |
| **CFL-06** 工具输出三票 | U-OUT-RS / U-OUT-FE / U-G8 拆分 | D1-D=D1；D5-HARD CAP=D5；D10-B=D10；边界表互引 | **合规** |
| **CFL-07** 启动门禁仅 D9 | check-startup-budget / ci.yml frontend-build 仅 04/D9 | D9 主责；D13.5 只读协调；D13.1 仅 ci-slow.yml | **合规** |
| **CFL-08** 索引单源归 D4 | 不挂 04 Layer7 | D4D5 §2.3 索引单源；D9 不碰 hydrate | **合规** |
| **CFL-09** Gatekeeper / DNS 拆 | U-GATE ∥ U-GATE-DNS | D2 强制拆票 | **合规** |
| **CFL-10** 传输分票 | 按 05 D1 粒度 | D6.1–D6.5 分票，禁 01-L4-A 大包 | **合规** |
| **CFL-11** 引擎克隆不与组提交同 PR | 后置 | D3 禁止反例 5 | **合规** |
| **CFL-12** Progress 三选一 | 会签 A/B/C | D11.5 完整三选一 | **合规** |
| **CFL-13** motion 复核后删 | knip 前置 | D9-C PR-MOTION 阻塞 | **合规** |
| **CFL-14** ToolStart PR-ORDER | 顺序契约可升 T2 | D11.6 T0 + PR-ORDER 门控 | **合规** |
| **CFL-15** moka 进 92 | builder 字节语义 | D1 T-D1-C 禁只改注释 | **合规** |
| **CFL-16** 双发 webview 回执 + 旁路完整 | 铁律 | D11.1 铁律原文 | **合规** |

**小结**：16 条 CFL 在详案层面**均未被正面违反**；主要风险不在 CFL 本体，而在 **文件域主责分裂** 与 **package.json / 门禁脚本并发写**（见 §2–§3）。

---

## 2. 冲突表（跨维）

| 冲突ID | 涉及详案 | 冲突描述 | 对照 92/OVL | 严重度 |
| -- | -- | -- | -- | -- |
| **X-CFL-1 · check-store-islands 双主责** | D4D5（票 A）× D11D12D13 D13.4 | 两侧均写「新建 `scripts/check-store-islands.mjs`」并接入 `check:desktop`：D4 称「OVL-24 同票」随票 A 落地；D13.4 称「本维主责门禁脚本落地与 fail 化」 | OVL-24：与 OVL-13 **同票**（persist 切除）→ 主责应为 **D4 票 A**；92 §4 D13 观测维，非 store 切除实现维 | **必须改** |
| **X-CFL-2 · fanout/push meta-only 双主责** | D6D7D8 D6.5 × D11D12D13 D12.1 | 同一目标（EventMeta 一次构造 + fanout/push 零全量 parse）在两维各开完整任务；文件域同为 `fanout.rs` / `pusher.rs` / `core_event_bridge` | 92 §4 **D6 唯一文件域含 fanout/push meta**；D12 主责为 push pending / telemetry / relay。D11D12D13 自己也写「主控裁决唯一主责：建议 D6」——但仍保留 D12.1 完整实现票 | **必须改** |
| **X-CFL-3 · 根 `package.json` `check:desktop` 多点并发** | D0-E × D4D5（票 A 门禁）× D9-A ×（D13.4 若保留） | D0 追加 `check:perf-budgets`；D4 追加 `check-store-islands`；D9 追加 `check:startup-budget`；均改同一 `check:desktop` 串与可能同文件 diff | 92 §4 各维文件域摘要未声明 package.json 写权互斥；并行 Agent 改同一行链必 merge 冲突 | **必须改** |
| **X-CFL-4 · ToolCallOutput.tsx 重复删除义务** | D0-DEL-2 × D5-C2 | D0：机械迁 `LINE/BYTE_CAP` 并删组件本地定义；D5 hardCap：「改为从 budget re-export，删除组件本地定义（ToolCallOutput.tsx:9-10）」——同一文件、同一删除项 | CFL-01/D0 §4.3 已登记「D5 若改组件…独立小 PR 先合」，但两票正文仍各自完整声明删除，派发时易双改 | **必须改** |
| **X-CFL-5 · D1 内部 T-D1-B 与 T-D1-D 并行声明自相矛盾** | detail-D1 §4 互斥表 | T-D1-B 允许与「A、C」并行且**明确禁止**同轮碰 D 的 ToolBatchOptions 字段；T-D1-D 却写「允许并行 A、**B**、C」。两者主责文件均含 `run_launch.rs` | 92 §4 D1 单文件域内可再拆，但同一 `run_launch.rs` 上 B/D 不得宣称互为并行 | **必须改**（详案内订正） |
| **X-CFL-6 · `executing_tools.rs` 三票争用** | D1-D（Arc 出口）× D10-B（U-G8 接线）× D11.5/6（Progress/ToolStart） | 三票均写 `executing_tools` 为文件域；D10 有「禁止与 U-OUT-RS 同轮双改同一 Arc/预算装配行」；D11 有「出口文件区与 D1 串行」——但无**行级/函数级主责时刻表** | 92 §4：D1 出口、D10 G8 调用点、D11 Progress 框架——概念分层正确，物理同文件未钉死执行序 | **建议改**（派发前主控补时刻表） |
| **X-CFL-7 · `engine_channels.rs` 多票串行未进首轮禁止表** | D1-E（真缓冲）× D13.2（丢帧 warn 聚合）× D11.4（PE-02 窗）× D11.7（可见性背压） | D13.2 允许在会签期并行；D1-E 首轮可做；两者同文件。D13 自承「与 D1 flush 单测串行合并」但未禁止独立 PR 先合 | CFL-04 仅保护 PE-02/flush 概念拆分，不自动解决同文件并行写 | **建议改** |
| **X-CFL-8 · relay 帧上限契约级** | D12.3 vs 92 §8 | 92 T2 实例含「relay 帧上限**对端**」；D12.3 标 **T0（中继内部）**，仅在「移动端有独立约定」时升 T1 可选 | 若对端需感知上限，不得当纯内部 T0 静默落地 | **建议改**（任务书强制对端检查闸门） |
| **X-CFL-9 · pusher.rs 模块内多单元** | D6.5 / D12.1 / D12.6 / D12.8 | push 侧 meta、pending、文案共享同 crate 文件族；D6/D12 已分维，维内多单元仍同文件 | 文件级维互斥弱于单元级 | **建议改** |
| **X-CFL-10 · D3 迁移期临时常量** | D3 §1.1 PRAGMA/cache_size | 「若 D0 未落，本票用命名常量并登记待迁」——无负向断言强制迁回，存在第三真源芽风险 | CFL-01/INV-8 | **建议改** |

> CFL 本身（预算单源 / NoPersist 序 / persist 拆票 / Diff 接线 / D9 唯一门禁主责）**无正面违反**；上表为落地执行面冲突。

---

## 3. 文件域冲突表

| 路径 / 产物 | D0 | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | D9 | D10 | D11 | D12 | D13 | 冲突结论 |
| ----------- | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- | --- | --- | --- | --- | -------- |
| `conex-shared/perf_budget` / `perfBudgets.ts` / `check-perf-budgets` | **W** | R | R | R | R | R | R | R | R | R | R | R | R | R | D0 独占 ✓ |
| 根 `package.json` `check:desktop` | **W** | — | — | — | **W** | — | — | — | — | **W** | — | — | — | **W** | **X-CFL-3** |
| `scripts/check-store-islands.mjs` | — | — | — | — | **W**（票A） | — | — | — | — | — | — | — | — | **W**（D13.4） | **X-CFL-1** |
| `fanout.rs` / `pusher.rs` / meta 产出 | — | — | — | — | — | — | **W**（D6.5） | — | — | — | — | — | **W**（D12.1） | — | **X-CFL-2** |
| `orchestrator/events.rs`（NoPersist） | — | **W** | — | R | — | — | R | — | — | — | — | R | — | — | D1 独占 ✓ |
| `conex-db/**` + `session_commands` save | — | — | — | **W** | R | — | — | — | — | — | — | — | — | — | D3 独占 ✓ |
| `sessionStore` / partialize / islands 断言 | — | — | — | R | **W** | — | — | — | — | — | — | — | — | R | D4 票 A ✓（脚本归属仍 X1） |
| `sessionRustDbHydrate.ts` | — | — | — | R | **W**（票A/B/索引串行） | R | — | — | — | — | — | — | — | — | D4 维内串行已声明 ✓ |
| `streamCallbacksEvents.ts` + store hardCap | — | — | — | — | — | **W** | — | — | — | — | — | — | — | — | D5 ✓ |
| `ToolCallOutput.tsx` | **W**（机械迁） | — | — | — | — | **W**（C-2） | — | — | — | — | — | — | — | — | **X-CFL-4** |
| `run_launch.rs` | — | **W**（B审计 + D装配） | — | — | — | — | — | — | — | — | — | — | — | — | **X-CFL-5**（维内 B/D 并行声明矛盾） |
| `engine_channels.rs` | — | **W**（E flush） | — | — | — | — | R | — | — | — | — | W（11.4 T2） | — | W（13.2） | **X-CFL-7** 串行 |
| `executing_tools.rs` / tool end 点 | — | **W**（Arc） | — | — | — | — | — | — | — | — | **W**（G8） | **W**（Progress/Start） | — | — | **X-CFL-6** 时刻表 |
| `engine-events.json` / schema 链 | — | R | — | — | — | — | R | — | — | — | — | **W**（T2） | — | R | D11 独占 T2 ✓ |
| `check-startup-budget` / `ci.yml` frontend-build | — | — | — | — | — | — | — | — | — | **W** | — | — | — | R | D9 独占 ✓ |
| `ci-slow.yml` | — | — | — | — | — | — | — | — | — | — | — | — | — | **W** | 与 D9 异文件 ✓ |
| `conex-sandbox` / Gatekeeper / browser / computer | — | — | **W** | — | — | — | — | — | — | — | — | — | — | — | D2 ✓ |
| `conex-relay/**` | — | — | — | — | — | — | — | — | — | — | — | — | **W** | — | D12 ✓ |
| `streaming-animation.css` + 流式契约测试 | — | — | — | — | — | — | — | **W** | R | — | — | — | — | — | D7 独占 ✓ |
| DiffCard* / render-worker batch / 布局 will-change CSS | — | — | — | — | — | — | — | R | **W** | — | — | — | — | — | D8 独占 ✓ |

图例：W=写；R=只读/引用。

---

## 4. 依赖图 / 顺序矛盾

### 4.1 主依赖（与 92 §5 一致部分 · 通过）

```text
D0 ──► D1-A/B/C/D ∥ D2 全单元 ∥ D9-A ∥ D10
         │
         ├─ U-NOPE(D1-A) 绿 ──► D3 U-DB-COMMIT ──► U-DB-INC ──► D4 票 B
         │
         └─ D4 票 A（∥ D3） ──► 索引单源 / D5 驱逐 ──► D6 分票 ──► D7 ∥ D8
D11 会签 Layer0 立即开票；T2 实现在 D6 消费端稳定后
真缓冲(D1-E) ──► D11.4 PE-02 窗（串行 engine_channels）
```

与 92 §5「禁止顺序反例」逐条对照：NoPersist 先于组提交、partialize 先于宣称持久化完成、真缓冲≠PE-02、memo 前收窄注入、motion 复核后删——详案均显式复述。

### 4.2 发现的顺序/并行矛盾

| # | 矛盾点 | 详情 | 处置 |
| - | ------ | ---- | ---- |
| 1 | **D1-B ∥ D1-D 自相矛盾** | 见 X-CFL-5；`run_launch.rs` 双任务却互标并行 | **必须改**：B 与 D 同 PR 序列或行级拆分写入任务书；禁止「B∥D」文案 |
| 2 | **D6.5 ∥ D12.1 同目标双开** | 无共同前置「唯一产出点」派发单 | **必须改**：单票（建议 D6 主责）；另一侧只读 |
| 3 | **D13.2 与 D1-E 默认并行风险** | 会签期 Layer1 放 D13.2，首轮放 D1-E | **建议**：D13.2 改为「D1-E 合入后」或合 PR |
| 4 | **D5 驱逐依赖票 A** | 已写禁止 D5 先于票 A——无矛盾 | 通过 |
| 5 | **D10-B 与 U-OUT-RS** | 概念分票清晰；`executing_tools` 物理同文件需时刻表 | 建议 X-CFL-6 |
| 6 | **无环** | 全图无 D→D 回边；会签/实现分层正确 | 通过 |

---

## 5. T2 契约是否被当 T0

| 项 | 详案标注 | 92 §8 / 效果锁 | 判定 |
| -- | -------- | -------------- | ---- |
| PE-02 同 block 合并 | D11.4 **T2·PR-PE-02**；D1 明确不做 | T2 强契约 | **合规** |
| 双发消除 / 收口回执 | D11.1 **T2·PR-SCHEMA** | T2 | **合规** |
| message-start 瘦身 | D11.2 **T2·PR-SCHEMA** | T2 | **合规** |
| tool-batch persist→NoPersist | D11.3 **T2·PR-SCHEMA** | schema 变更（92 T2 实例延伸） | **合规** |
| Progress | D11.5 三选一会签；A/C=T2 | T2 / 会签 | **合规** |
| ToolStart 实时 | D11.6 T0 + **PR-ORDER** 门控 | CFL-14 | **合规** |
| 真缓冲 flush | D1-E T0，禁 N 合 1 | CFL-04 T0 | **合规** |
| PTY 合批 | D8.2 T0，明示无 PE-02 | 独立通道 | **合规** |
| relay 帧上限 | D12.3 **T0 内部**；对端约定才可选 T1 | 92 写「relay 帧上限**对端**」 | **部分不对齐** → S-X8（建议改：对端检查前禁纯 T0 收口） |
| save batch_version | D3 扩签名真消费（92 T1） | T1 弱契约 | **合规** |
| FE `truncated` 前端字段 | D5 允许 T0 可选扩展；跨端字段则 PR-SCHEMA | 与 PR-SCHEMA 挂接 | **合规** |

**结论**：未发现「PE-02 / 双发 / start 瘦身 / Progress」被静默当 T0 实现；唯一契约级松动为 relay 帧上限对端语义（S-X8）。

---

## 6. 必须改 / 建议改 / 可接受风险

### 6.1 必须改（合并/派发前）

| # | 项 | 动作 |
| -- | -- | ---- |
| **M1** | X-CFL-1 check-store-islands | **主责=D4 票 A**（OVL-24）；D13.4 改为「引用 D4 验收 / 只读协调」，**删除** D13 侧「新建脚本」完整实现票；若主控仍想让 D13 做脚本，则 D4 票 A 改为「断言清单提供方」且脚本文件写权唯一归 D13——二选一写死，禁止双建 |
| **M2** | X-CFL-2 fanout/push meta-only | **主责=D6.5**（92 §4）；D12.1 整段降为 D6 副票/移交，或改标题为「D12 消费 EventMeta（只读）」；禁止两维各开完整实现 |
| **M3** | X-CFL-3 根 package.json `check:desktop` | 主控规定：**单点协调追加**（建议顺序 D0 → D4 → D9 → 其它），或统一「一个包装脚本 `check:desktop-parts`」；禁止多 Agent 并行 Edit 同文件同链 |
| **M4** | X-CFL-4 ToolCallOutput.tsx | **机械迁常量+删本地定义 = D0-DEL-2 唯一义务**；D5-C2 改为「校验 D0 已迁 / 不得再改该文件」；hardCap 写入仅 `streamCallbacksEvents.ts` |
| **M5** | X-CFL-5 D1-B/D 并行矛盾 | 修订 detail-D1 §4：**T-D1-B 与 T-D1-D 禁止宣称并行**（同 `run_launch.rs`）；改为串行或行级白名单表 |

### 6.2 建议改

| # | 项 | 动作 |
| -- | -- | ---- |
| **S1** | X-CFL-6 executing_tools | 主控在实现轮附「D1-Arc → D10-G8 → D11-Progress/Start」写权串行表 |
| **S2** | X-CFL-7 engine_channels | D13.2 / D11.7 排入 D1-E 之后或合 PR；写进首轮禁止表 |
| **S3** | X-CFL-8 relay 帧上限 | D12.3 增加强制检查：「对端是否需感知上限」→ 需要则升 T1 会签，对齐 92「对端」措辞 |
| **S4** | X-CFL-9 pusher.rs | D12 维内单元 PR 串行表（meta 已移交 D6 后风险下降） |
| **S5** | X-CFL-10 D3 临时常量 | 临时常量必须带「D0 合入后 0 本地定义」负向断言与迁回清单 |
| **S6** | D9 package.json `apps/crish-desktop/package.json` 删 motion | 与 D0/D4 根 package.json 区分已清晰；保持 PR-MOTION 前置即可（已是 D9-C） |
| **S7** | D4 票 A 与 D13 `check:desktop` 顺序 | 若 M1 采纳「D4 建脚本」，则 check:desktop 追加 islands 与 D9 追加 startup 仍受 M3 约束 |

### 6.3 可接受风险

| # | 项 | 说明 |
| -- | -- | ---- |
| **A1** | D6 逻辑上排在 D5 后 | 文件域与 D5 不相交；偏保守无害 |
| **A2** | D0 与 D9 对 startup 数字并行路径 | D9 只接 fail 语义、数字迁 SoT 命名空间，符合 CFL-01 |
| **A3** | 测试内 `CommandGatekeeper::new()` 保留 | 与生产=0 不矛盾 |
| **A4** | D11 Layer1 与会签并行 | 符合 92「评审票立即启动」 |
| **A5** | D7∥D8 除 MessageContent 边界 | 详案已声明 Diff 子树写权 D8、父级 props D7 |
| **A6** | PR-LS-BODY / PR-MOTION / PR-ORDER 挂接 | 完成定义=纪要，实现门控正确 |

---

## 7. 给主控合并建议（派发前清单）

1. **先落 M1–M5 修订**（可改详案正文或写「评审修订追加节」）；未修订前禁止并行派发涉及 check-store-islands / fanout-meta / package.json / ToolCallOutput / D1-B+D 的单元。  
2. **首轮并行白名单（修订后）**：  
   - U-BUDGET（D0 全套，含根 package.json **一次**加 script）  
   - U-NOPE（D1-A，纯 events.rs）  
   - U-BLOCK / U-GATE / U-GATE-DNS / U-MEM（D2，文件不交）  
   - U-START-GATE（D9-A，**check:desktop 追加按 M3 序列化**）  
   - U-RELAY（D12.2–4）  
   - U-SUMMARY（D10-A）  
   - U-PERSIST-CUT（票 A）——脚本按 M1 唯一写权  
   - **不做首轮**：D6.5/D12.1 meta（等 M2 单票）、D13.2（等 D1-E）、D1-B∥D1-D 同开  
3. **契约闸**：会签票立即开；T2 实现单必须带「纪要通过」勾选；D12.3 按 S3 加对端检查。  
4. **OVL 回归**：check-store-islands 与 fanout-meta 修订后，同步勾选 review-plans-01 OVL-24 / OVL-17 的「已归 D4 / D6」状态（主控可选）。  
5. **负向断言不降**：各详案 §负向断言保留；本评审不放松任何 CFL 效果锁。  

### 7.1 修订后建议的「谁碰 package.json」速查

| 文件 | 唯一写权（建议） | 追加内容 |
| ---- | ---------------- | -------- |
| 根 `package.json` scripts `check:perf-budgets` + `check:desktop` 的 D0 段 | **D0** | `check:perf-budgets` |
| 根 `package.json` `check:desktop` 的 islands 段 | **D4 票 A**（若 M1） | `check-store-islands` |
| 根 `package.json` `check:desktop` 的 startup 段 | **D9** | `check:startup-budget` |
| `apps/crish-desktop/package.json` deps | **D9-C** | motion 删除（PR-MOTION 后） |

同文件多段追加仍须 **串行合入或单 Agent 多段一次改**（M3）。

---

## 8. 汇总数据

| 指标 | 值 |
| ---- | -- |
| CFL 合规（92 16 条） | **16/16 正面合规** |
| 跨维冲突条目（X） | **10** |
| 其中必须改（M） | **5** |
| 建议改（S） | **7** |
| 可接受风险（A） | **6** |
| T2-as-T0 硬违规 | **0**（1 项契约级松动 → S3） |
| 文件域硬冲突（表内红灯） | **4**（islands / meta / package.json / ToolCallOutput）+ D1 维内矛盾 1 |

---

## 9. 一句话评审结论

**八份分维详案在 CFL 合规（预算单源、NoPersist 先于组提交、persist 拆票、Diff 接线、D9 唯一门禁、T2 会签）上总体扎实，未发现把 PE-02/双发/Progress 当 T0 做；但 check-store-islands 与 fanout-meta 双主责、根 package.json check:desktop 多点并发、ToolCallOutput 双删义务、以及 D1 内 B/D 并行文案矛盾五处必须在派发前钉死唯一写权，否则并行实现必撞且 OVL 归并失效。**

---

_分维详案评审 Agent 产出 · 只审计划 · 未 git commit · 未改 92 / 未改生产代码 · 详案源文件保持原样_
