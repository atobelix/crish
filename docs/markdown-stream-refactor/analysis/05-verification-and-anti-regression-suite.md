# 05. 全链路验证体系、反退避检查项与魔鬼测试用例套件

> **文件路径**：`docs/markdown-stream-refactor/analysis/05-verification-and-anti-regression-suite.md`
> **所属战役**：Markdown 真流式渲染与正文退化根治战役 (`docs/markdown-stream-refactor/`)
> **角色定位**：QA and Verification Specialist (全链路测试架构与质量保证专家)
> **权威纪律**：`AGENTS.md` / `.agents/LOGIC_PLAN_NO_RETREAT.md` / `FULL_CHECK_COMMANDS.md`
> **输入资产**：
> - `docs/markdown-stream-refactor/analysis/01-rust-stream-think-tag-state-machine.md`
> - `docs/markdown-stream-refactor/analysis/02-streaming-markdown-chunking-architecture.md`
> - `docs/markdown-stream-refactor/analysis/04-timeline-normalization-and-block-merge.md`
> - `docs/markdown-stream-refactor/independent-plans/02-progressive-chunk-render-plan.md`
> - `crates/agent-provider/src/parse/` & `crates/session-loop/src/`
> - `apps/crish-desktop/src/api/chat-bridge/handlers/` & `apps/crish-desktop/src/components/chat-message/`

---

## 1. 战役背景与全链路验证体系总纲

### 1.1 战役质量背景与四大核心质量防线

在 Conex / Crish 桌面端产品的核心对话与推理交互中，系统需要经历 **Rust 内核流式解析 ➔ 双轨事件分派 ➔ 前端渐进分块渲染 ➔ 本地 Store 与数据库持久化** 的完整全链路闭环。在此链路中，历史版本积累了四大顽固质量痛点：
1. **推理内容逃逸（Reasoning Escape）**：`<think>` 标签在跨 chunk 到达时无法被实时状态机剥离，导致大段思考逃逸到正文，污染排版。
2. **伪流式纯文本与完成态剧烈跳变（Layout Shift & FOUT）**：流式阶段为纯文本追加，流结束瞬间全量清空并挂载骨架屏替换为 Markdown，引发视口剧烈跳动与闪烁。
3. **多轮对话正文整段翻倍重复（Multi-turn Duplication）**：多轮会话（`turnIndex > 0`）与重试场景下，`message-end` 终态合并策略不当，导致正文重复叠加。
4. **时间线 Blocks 结构性丢失（Blocks Destruction）**：时间线规范化和更新操作时，破坏性 `filter` 抹杀了 `thought` 块与历史工具卡片。

为彻底根治上述问题，本验证体系在全链路构筑 **四道刚性质量防线**：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    全链路四道刚性质量防线拓扑图                                    │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│  [ 防线 1: Rust 内核流式层 ]                                                                      │
│  ├── 责任域：crates/agent-provider & crates/session-loop                                         │
│  └── 质量锁：StreamingTagExtractor 状态机 100% 剥离 <think>，零延迟滑动缓冲，O(1) 内存回滚           │
│                                                                                                  │
│  [ 防线 2: 前端事件桥与生命周期层 ]                                                                │
│  ├── 责任域：apps/crish-desktop/src/api/chat-bridge/handlers                                      │
│  └── 质量锁：message-delta 严格按 (sessionId, messageId) 分桶，message-end 依据 turnIndex 幂等合并 │
│                                                                                                  │
│  [ 防线 3: 前端渐进分块流式渲染层 ]                                                                │
│  ├── 责任域：apps/crish-desktop/src/components/chat-message-row & api/markdown-render             │
│  └── 质量锁：parseMarkdownIntoBlocks 封口编译，双缓冲无缝晋升，零骨架屏塌陷，历史块 0 re-render     │
│                                                                                                  │
│  [ 防线 4: 数据结构持久化与时间线保全层 ]                                                          │
│  ├── 责任域：apps/crish-desktop/src/api/tool-presentation & store                                │
│  └── 质量锁：reconcileAssistantMessageBlocks 多轮双向镜像保全，Markdown 代码块内标签免疫           │
│                                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 1.2 全链路验证分级金字塔

测试验证按照四层递进金字塔严格组织，层层锁死正确性：

```
                    ┌───────────────────────────────┐
                    │      第 4 级: Tauri MCP       │
                    │   端到端真机验收 (端口 4000)   │
                    ├───────────────────────────────┤
                    │    第 3 级: 渲染性能与 CLS    │
                    │    60 FPS / Re-render 探针    │
                    ├───────────────────────────────┤
                    │   第 2 级: 前端 Vitest 套件   │
                    │  多轮幂等 / Blocks / 分块解析 │
                    ├───────────────────────────────┤
                    │   第 1 级: Rust 极限单元测试  │
                    │    状态机 / 跨块切分 / 边界回滚 │
                    └───────────────────────────────┘
```

---

### 1.3 质量效果锁与验收指标矩阵

| 效果锁编号 | 指标名称 | 严格数学定义与验收标准 | 验证手段 | 门禁阈值 |
| :--- | :--- | :--- | :--- | :--- |
| **Lock-1** | **无推理逃逸** | `TextDelta` 与正文 DOM 中包含 `<think>` / `<thought>` 或内部字符的概率 $P(\text{leak}) = 0$ | Rust 单测 + 前端 Vitest + MCP DOM 检查 | **0 逃逸** |
| **Lock-2** | **真流式零跳变** | 累计布局偏移量 $\text{CLS} \le 0.01$；流式结束至完成态过渡期间骨架屏闪现帧数 $F_{\text{skeleton}} = 0$ | Playwright / Performance API / MCP 截图 | **CLS $\le 0.01$** |
| **Lock-3** | **多轮绝对幂等** | 任意多轮会话（$N$ 轮工具交互）下，最终 Markdown 正文重复字数 $\text{DupCount} = 0$ | Handler Vitest + E2E 会话回归 | **0 重复** |
| **Lock-4** | **Blocks 结构保全** | 多轮交互前后，所有已完成轮次的 `ThoughtBlock` 与 `ToolCallBlock` 留存率 $= 100\%$ | 时间线 Normalizer 单测 + Store 状态断言 | **100% 保全** |
| **Lock-5** | **渲染性能与隔离** | 流式纯文本追加期间，历史已封口块重渲染次数 $R_{\text{sealed}} = 0$；渲染帧率 $\ge 58\text{ FPS}$ | `reRenderMonitoring.test.tsx` 探针 | **0 额外重渲染** |

---

## 2. 维度一：Rust 侧极限单元测试套件设计

### 2.1 状态机极端切分与粘连魔鬼测试矩阵（15 组边界用例）

针对 `crates/agent-provider/src/parse/tag_extractor.rs` 中的 `StreamingTagExtractor` 状态机，设计覆盖所有图灵完备边界的魔鬼测试矩阵：

| 用例 ID | 测试场景描述 | 输入 Chunk 流序列 | 预期产出事件序列 | 验证核心机制 |
| :--- | :--- | :--- | :--- | :--- |
| **RS-01** | **单 Chunk 完整标签** | `["<think>Thinking content</think>Text content"]` | `[ThoughtDelta("Thinking content"), TextDelta("Text content")]` | 标准开闭标签与正文分离 |
| **RS-02** | **极限逐字切碎（开闭标签均切碎）** | `["<","t","h","i","n","k",">","A","B","<","/","t","h","i","n","k",">","C","D"]` | `[ThoughtDelta("AB"), TextDelta("CD")]` | 跨 Chunk 单字符状态转移 |
| **RS-03** | **虚假开标签回滚 (False Open Rollback)** | `["In math, 3 < thin", "kness of plate"]` | `[TextDelta("In math, 3 < thickness of plate")]` | `MatchingOpen` 不匹配时无损 Flush 正文 |
| **RS-04** | **思考态内虚假闭标签回滚** | `["<think>Check 1: 3 </", "div> is html</think>Final"]` | `[ThoughtDelta("Check 1: 3 </div> is html"), TextDelta("Final")]` | `MatchingClose` 不匹配时回滚为思考 |
| **RS-05** | **流在开标签前瞻中途中断 (EOF in MatchingOpen)** | `["Prefix text <thi"]` (随后 `finish()`) | `[TextDelta("Prefix text <thi")]` | 收口阶段清空 `lookahead_buf` 降级为正文 |
| **RS-06** | **流在闭标签前瞻中途中断 (EOF in MatchingClose)** | `["<think>Inside thought </th"]` (随后 `finish()`) | `[ThoughtDelta("Inside thought </th")]` | 收口阶段清空缓冲区降级为思考 |
| **RS-07** | **未闭合的流式思考（模型只开不闭）** | `["<think>Deep thought without end"]` (随后 `finish()`) | `[ThoughtDelta("Deep thought without end")]` | 异常截断下思考不逃逸至正文 |
| **RS-08** | **紧随标签后的首换行消除** | `["<think>\nLine 1\nLine 2</think>\nResult"]` | `[ThoughtDelta("Line 1\nLine 2"), TextDelta("Result")]` | 标签紧邻换行修剪（美化排版） |
| **RS-09** | **多重连续思考块（多轮 Thought 交错）** | `["<think>Plan 1</think>Act 1<thought>Plan 2</thought>Act 2"]` | `[ThoughtDelta("Plan 1"), TextDelta("Act 1"), ThoughtDelta("Plan 2"), TextDelta("Act 2")]` | `<think>` 与 `<thought>` 混用与多次交错 |
| **RS-10** | **CJK 多字节 UTF-8 边界在标签两侧** | `["<think>思考内容：你好</think>正文：世界"]` | `[ThoughtDelta("思考内容：你好"), TextDelta("正文：世界")]` | 中文多字节字符边界安全 |
| **RS-11** | **CJK 字符紧贴 `<` 符号切碎** | `["测试<","think>中","文</think>结","束"]` | `[TextDelta("测试"), ThoughtDelta("中文"), TextDelta("结束")]` | 非 ASCII 字符与标签粘连切分 |
| **RS-12** | **数学公式小于号与标签混淆** | `["if a < b and c < think_val:\n  pass"]` | `[TextDelta("if a < b and c < think_val:\n  pass")]` | 编程语言代码中的 `<` 符号免疫 |
| **RS-13** | **空思考标签** | `["<think></think>Direct text"]` | `[TextDelta("Direct text")]` (零空 ThoughtDelta) | 空内容思考块静默丢弃 |
| **RS-14** | **显式 reasoning 字段与内联标签同时存在** | JSON delta 携带 `reasoning_content="r1"` 且 `content="<think>t1</think>p1"` | `[ThoughtDelta("r1"), ThoughtDelta("t1"), TextDelta("p1")]` | 解析器双通道事件分流 |
| **RS-15** | **超长思考文本流（100KB+ 压力测试）** | 分 1000 个 100 字节的 Chunk 持续推送思考与正文 | 1000 个 Delta 事件无一丢字，内存平稳 | 压力场景下无缓冲溢出与内存泄漏 |

---

### 2.2 Rust 单元测试套件实现代码

以下为落地于 `crates/agent-provider/src/parse/tag_extractor_tests.rs` 的完整代码：

```rust
//! crates/agent-provider/src/parse/tag_extractor_tests.rs
//!
//! 实时流式标签剥离状态机极限与魔鬼测试套件（RS-01 至 RS-15）

use super::tag_extractor::{ExtractorState, StreamingTagExtractor, DEFAULT_TAGS};
use crate::events::ProviderStreamEvent;

fn extract_stream(chunks: &[&str]) -> Vec<ProviderStreamEvent> {
    let mut extractor = StreamingTagExtractor::new(DEFAULT_TAGS);
    let mut events = Vec::new();
    for chunk in chunks {
        events.extend(extractor.push_text(chunk));
    }
    events.extend(extractor.finish());
    events
}

fn collect_thoughts(events: &[ProviderStreamEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn collect_texts(events: &[ProviderStreamEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn test_rs01_standard_single_chunk() {
    let events = extract_stream(&["<think>Thinking content</think>Text content"]);
    assert_eq!(collect_thoughts(&events), "Thinking content");
    assert_eq!(collect_texts(&events), "Text content");
}

#[test]
fn test_rs02_extreme_token_fragmentation() {
    let chunks = &[
        "<", "t", "h", "i", "n", "k", ">", "A", "B", "<", "/", "t", "h", "i", "n", "k", ">", "C", "D",
    ];
    let events = extract_stream(chunks);
    assert_eq!(collect_thoughts(&events), "AB");
    assert_eq!(collect_texts(&events), "CD");
}

#[test]
fn test_rs03_false_open_rollback() {
    let chunks = &["In math, 3 < thin", "kness of plate"];
    let events = extract_stream(chunks);
    assert_eq!(collect_thoughts(&events), "");
    assert_eq!(collect_texts(&events), "In math, 3 < thickness of plate");
}

#[test]
fn test_rs04_false_close_rollback_in_thinking() {
    let chunks = &["<think>Check 1: 3 </", "div> is html</think>Final"];
    let events = extract_stream(chunks);
    assert_eq!(collect_thoughts(&events), "Check 1: 3 </div> is html");
    assert_eq!(collect_texts(&events), "Final");
}

#[test]
fn test_rs05_eof_in_matching_open() {
    let events = extract_stream(&["Prefix text <thi"]);
    assert_eq!(collect_thoughts(&events), "");
    assert_eq!(collect_texts(&events), "Prefix text <thi");
}

#[test]
fn test_rs06_eof_in_matching_close() {
    let events = extract_stream(&["<think>Inside thought </th"]);
    assert_eq!(collect_thoughts(&events), "Inside thought </th");
    assert_eq!(collect_texts(&events), "");
}

#[test]
fn test_rs07_unclosed_thinking_stream() {
    let events = extract_stream(&["<think>Deep thought without end"]);
    assert_eq!(collect_thoughts(&events), "Deep thought without end");
    assert_eq!(collect_texts(&events), "");
}

#[test]
fn test_rs08_trim_leading_newline() {
    let events = extract_stream(&["<think>\nLine 1\nLine 2</think>\nResult"]);
    assert_eq!(collect_thoughts(&events), "Line 1\nLine 2");
    assert_eq!(collect_texts(&events), "Result");
}

#[test]
fn test_rs09_multiple_alternating_thinking_blocks() {
    let chunks = &["<think>Plan 1</think>Act 1<thought>Plan 2</thought>Act 2"];
    let events = extract_stream(chunks);
    assert_eq!(collect_thoughts(&events), "Plan 1Plan 2");
    assert_eq!(collect_texts(&events), "Act 1Act 2");
}

#[test]
fn test_rs10_cjk_boundary_safety() {
    let events = extract_stream(&["<think>思考内容：你好</think>正文：世界"]);
    assert_eq!(collect_thoughts(&events), "思考内容：你好");
    assert_eq!(collect_texts(&events), "正文：世界");
}

#[test]
fn test_rs11_cjk_fragmentation_sticking() {
    let chunks = &["测试<", "think>中", "文</think>结", "束"];
    let events = extract_stream(chunks);
    assert_eq!(collect_thoughts(&events), "中文");
    assert_eq!(collect_texts(&events), "测试结束");
}

#[test]
fn test_rs12_code_comparator_immunity() {
    let code = "if a < b and c < think_val:\n  pass";
    let events = extract_stream(&[code]);
    assert_eq!(collect_thoughts(&events), "");
    assert_eq!(collect_texts(&events), code);
}

#[test]
fn test_rs13_empty_thinking_tag() {
    let events = extract_stream(&["<think></think>Direct text"]);
    assert_eq!(collect_thoughts(&events), "");
    assert_eq!(collect_texts(&events), "Direct text");
}

#[test]
fn test_rs15_large_payload_stress() {
    let mut chunks = Vec::new();
    chunks.push("<think>");
    for _ in 0..500 {
        chunks.push("Reasoning step...\n");
    }
    chunks.push("</think>");
    for _ in 0..500 {
        chunks.push("Final markdown output line...\n");
    }
    let events = extract_stream(&chunks);
    assert!(collect_thoughts(&events).contains("Reasoning step..."));
    assert!(collect_texts(&events).contains("Final markdown output line..."));
    assert!(!collect_texts(&events).contains("<think>"));
    assert!(!collect_texts(&events).contains("</think>"));
}
```

---

### 2.3 `session-loop` 双轨集成测试设计

在 `crates/session-loop` 中，验证 `LiveSink`（实时轨）与 `ConsumeBuilder`（聚合收口轨）的事件一致性：
1. **实时轨断言**：`delta_to_message_event` 逐帧发射 `AgentEvent::MessageDelta`，且 `block` 严格与 `Thought` / `Text` 分离。
2. **收口轨断言**：`commit_message_with_deltas` 产出的 `AgentMessage.blocks` 严格包含 `[ThoughtBlock, TextBlock, ToolCallBlock]` 三段式，且 `blocks` 内思考文本与 `metadata.thought` 严格相同。
3. **Turn 隔离断言**：`MessageEnd` 事件中 `turnIndex` 与循环内部上下文精确对齐。

---

### 2.4 Rust 门禁与执行命令清单

```powershell
# 1. 运行 agent-provider 专项测试套件
cargo test -p agent-provider --lib -- parse::tag_extractor_tests

# 2. 运行 chat_core 与 gemini_core 解析回归
cargo test -p agent-provider --lib -- parse::chat_tests
cargo test -p agent-provider --lib -- parse::gemini_tests

# 3. 运行 session-loop 完整生命周期与流式测试
cargo test -p session-loop

# 4. 全 Workspace Rust 编译与测试门禁
cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml
cargo test --workspace
```

---

## 3. 维度二：前端侧 Vitest 单元测试套件设计

### 3.1 前端测试覆盖矩阵与场景定义

| 领域模块 | 测试文件路径 | 关键测试场景 | 断言标准 |
| :--- | :--- | :--- | :--- |
| **多轮幂等合并** | `apps/crish-desktop/src/api/chat-bridge/handlers/__tests__/messageHandlers.turn.test.ts` | 1. 同 `turnIndex` 多次 `message-end` 幂等合并<br>2. 跨 `turnIndex`（0 ➔ 1 ➔ 2）有序文本分段追加<br>3. 缺失 `turnIndex` 的老版本载荷回退为单段模式<br>4. 重试抖动场景下的重复帧拦截 | `assistantText` 长度与内容完全等于终态，绝不发生 `\n\n` 重复拼接同一段文本 |
| **Blocks 保全合并** | `apps/crish-desktop/src/api/tool-presentation/__tests__/timelineNormalizer.reconcile.test.ts` | 1. 多轮工具调用时 `reconcileAssistantMessageBlocks` 完整保全前序思考块<br>2. `updateMessageText` 仅清理 `text` 块，绝不抹除 `thought` 块<br>3. DB 水合历史消息时根据 `thinkingTurns` 自动恢复 `blocks` | `blocks.filter(b => b.type === 'thought')` 数量严格等于轮次数，工具卡片按 turn 归位 |
| **Markdown 词法分块** | `apps/crish-desktop/src/api/markdown-render/__tests__/progressiveChunkParser.test.ts` | 1. HTML 嵌套标签跨 Token 栈式追踪合并<br>2. LaTeX `$$` 跨行数学公式与 Setext 标题冲突隔离<br>3. 未闭合 ` ``` ` 代码围栏识别为未封口活跃块<br>4. GFM 表格分隔行 `\|---\|` 到达后封口 | 独立 Block 数组边界完整，无断裂 HTML，无公式断块 |
| **代码块标签免疫** | `apps/crish-desktop/src/api/tool-presentation/__tests__/parseInlineThought.security.test.ts` | 1. ```` ```xml\n<think>...</think>\n``` ```` 代码块内标签免疫<br>2. 行内代码 `` `<think>` `` 免疫<br>3. 流式末尾未闭合 `<think>` 安全切分为活跃思考项 | 处于代码块内的 `<think>` 绝不被抽离，代码完整性 100% |

---

### 3.2 Vitest 关键测试代码实现清单

#### A. 多轮 `message-end` 幂等合并测试套件 (`messageHandlers.turn.test.ts`)

```typescript
// apps/crish-desktop/src/api/chat-bridge/handlers/__tests__/messageHandlers.turn.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onMessageEnd, onMessageDelta } from '../messageHandlers';
import type { HandlerEnv } from '../handlerEnv';
import type { EngineEnvelope } from '../eventParser';

describe('messageHandlers 多轮与幂等合并防退化套件', () => {
  let env: HandlerEnv;
  let emittedChunks: string[];
  let emittedThoughts: string[];

  beforeEach(() => {
    emittedChunks = [];
    emittedThoughts = [];
    env = {
      sessionId: 'sess-test-turn',
      state: {
        assistantText: '',
        assistantThought: '',
        messageEndTurnSegments: [],
      } as any,
      callbacks: {
        onChunk: (c: string) => emittedChunks.push(c),
        onThought: (t: string) => emittedThoughts.push(t),
      } as any,
    };
  });

  it('TS-01: 同一 turnIndex 多次收到 message-end 时，实行权威幂等覆盖而非重复拼接', () => {
    const envelope1: EngineEnvelope<'message-end'> = {
      event: {
        turnIndex: 0,
        message: {
          id: 'msg-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: '你好，我是助手。' }],
        },
      } as any,
      raw: {},
    };

    onMessageEnd(env, envelope1);
    expect(env.state.assistantText).toBe('你好，我是助手。');

    // 模拟重试或重复事件到达
    onMessageEnd(env, envelope1);
    expect(env.state.assistantText).toBe('你好，我是助手。');
    expect(env.state.assistantText).not.toBe('你好，我是助手。\n\n你好，我是助手。');
  });

  it('TS-02: 跨轮次 (Turn 0 -> Turn 1) 按段落追加，并精准补发差额 Delta', () => {
    // Turn 0: 阶段汇报
    onMessageEnd(env, {
      event: {
        turnIndex: 0,
        message: {
          id: 'msg-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: '第一阶段已完成。' }],
        },
      } as any,
      raw: {},
    });
    expect(env.state.assistantText).toBe('第一阶段已完成。');

    // Turn 1: 最终总结
    onMessageEnd(env, {
      event: {
        turnIndex: 1,
        message: {
          id: 'msg-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: '全部任务执行完毕！' }],
        },
      } as any,
      raw: {},
    });

    expect(env.state.assistantText).toBe('第一阶段已完成。\n\n全部任务执行完毕！');
    // 差额补发 delta
    expect(emittedChunks[emittedChunks.length - 1]).toBe('\n\n全部任务执行完毕！');
  });
});
```

#### B. 词法分块与代码块内标签免疫测试套件 (`progressiveChunkParser.test.ts`)

```typescript
// apps/crish-desktop/src/api/markdown-render/__tests__/progressiveChunkParser.test.ts
import { describe, it, expect } from 'vitest';
import { parseMarkdownIntoBlocks } from '../progressiveChunkParser';
import { parseInlineThoughtAndTextSafely } from '../../../tool-presentation/timelineNormalizer';

describe('ProgressiveChunkParser & Code Immunity 极限分块测试套件', () => {
  it('TS-03: HTML 嵌套标签跨段落保持完整合并，不发生断块', () => {
    const htmlMarkdown = `<div class="container">\n\n<p>段落内容 1</p>\n\n<p>段落内容 2</p>\n\n</div>`;
    const blocks = parseMarkdownIntoBlocks(htmlMarkdown);

    // 断言整个 div 容器被聚合为一个单独的 Block，避免外层 HTML 断开
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('<div class="container">');
    expect(blocks[0]).toContain('</div>');
  });

  it('TS-04: LaTeX $$ 跨行公式包含 = 号时，绝不被误判为 Setext Heading', () => {
    const mathMarkdown = `$$\n\\begin{aligned}\na &= b \\\\\n&= c\n\\end{aligned}\n$$\n\n正文后续段落。`;
    const blocks = parseMarkdownIntoBlocks(mathMarkdown);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('\\begin{aligned}');
    expect(blocks[0]).toContain('$$');
    expect(blocks[1]).toBe('正文后续段落。');
  });

  it('TS-05: Markdown 代码块内部包含的 <think> 标签绝对免疫，严禁被剥离', () => {
    const codeSnippet = '以下是规则示例：\n```xml\n<think>\n这是配置项\n</think>\n```\n结束说明。';
    const items = parseInlineThoughtAndTextSafely(codeSnippet, 0, false);

    // 必须判定为单项 text，绝对不产生 thought 项
    expect(items.some((i) => i.kind === 'thought')).toBe(false);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('text');
    expect(items[0].content).toBe(codeSnippet);
  });

  it('TS-06: 流式未闭合的前导 <think> 标签安全切分为流式思考项', () => {
    const streamRaw = '前置说明文本：\n<think>正在思考系统重构逻辑...';
    const items = parseInlineThoughtAndTextSafely(streamRaw, 0, true);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'text', content: '前置说明文本：\n' });
    expect(items[1]).toMatchObject({
      kind: 'thought',
      content: '正在思考系统重构逻辑...',
      isStreaming: true,
    });
  });
});
```

---

### 3.3 Vitest 执行与覆盖率门禁清单

```powershell
# 1. 运行 chat-bridge 消息处理全部单测
npx vitest run apps/crish-desktop/src/api/chat-bridge/handlers/

# 2. 运行 markdown 渲染与分块全部单测
npx vitest run apps/crish-desktop/src/api/markdown-render/

# 3. 运行 tool-presentation 与 timeline 规范化单测
npx vitest run apps/crish-desktop/src/api/tool-presentation/

# 4. 执行前端全量单测与覆盖率校验 (门禁要求 45/70/65/45)
npm run test:coverage -- --project=unit
```

---

## 4. 维度三：渲染性能、DOM 稳定性与视觉跳变验证方案

### 4.1 核心性能预算指标

```
┌────────────────────────┬─────────────────────┬────────────────────────┐
│ 性能测量维度           │ 性能指标预算        │ 测量方法与断言途径     │
├────────────────────────┼─────────────────────┼────────────────────────┤
│ 渲染帧率 (Frame Rate)  │ 恒定 60 FPS (≥58)   │ requestAnimationFrame  │
│ 帧计算耗时 (Frame Time)│ ≤ 16.6 ms           │ performance.now()      │
│ 累计布局偏移量 (CLS)   │ ≤ 0.01              │ LayoutShift Observer   │
│ 已封口块重渲染次数     │ 0 次 (React.memo)   │ vitest vi.spyOn 探针   │
│ 骨架屏闪烁帧数         │ 0 帧 (双缓冲垫片)   │ DOM MutationObserver   │
│ 内存泄漏防护           │ 5000 帧流式后 0 增长 │ 堆快照 / Map.size 上限 │
└────────────────────────┴─────────────────────┴────────────────────────┘
```

---

### 4.2 重渲染监控（`reRenderMonitoring`）测试方案

使用 Vitest 探针组件锁定组件树的渲染隔离性，确保流式增量追加时历史块 **0 次重渲染**：

```tsx
// apps/crish-desktop/src/__tests__/streamRenderPerformance.test.tsx
// @vitest-environment jsdom
import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingMarkdownView } from '../components/chat-message-row/StreamingMarkdownView';

const blockRenderCounts: Record<string, number> = {};

vi.mock('../components/chat-message-row/SealedMarkdownBlock', () => ({
  SealedMarkdownBlock: React.memo(({ block }: any) => {
    blockRenderCounts[block.id] = (blockRenderCounts[block.id] || 0) + 1;
    return <div data-testid={block.id} className="sealed-block">{block.raw}</div>;
  }),
}));

describe('StreamingMarkdownView 性能隔离与零重渲染验证', () => {
  beforeEach(() => {
    for (const k in blockRenderCounts) delete blockRenderCounts[k];
  });

  it('PERF-01: 随着流式正文持续增长，已封口的 Block 0 渲染次数严格恒等于 1（初始挂载后 0 重绘）', () => {
    const { rerender } = render(
      <StreamingMarkdownView
        text="## 标题已封口\n\n"
        isStreaming={true}
        messageId="msg-perf-1"
      />
    );

    // 初始挂载 Block 0
    expect(blockRenderCounts['chunk-block-0']).toBe(1);

    // 模拟后续涌入 50 帧末尾增量字符
    let currentText = "## 标题已封口\n\n";
    for (let i = 1; i <= 50; i++) {
      currentText += `正在输入第 ${i} 个字符... `;
      rerender(
        <StreamingMarkdownView
          text={currentText}
          isStreaming={true}
          messageId="msg-perf-1"
        />
      );
    }

    // 核心断言：即使父级更新了 50 次，已封口的 Block 0 渲染次数依然严格等于 1！
    expect(blockRenderCounts['chunk-block-0']).toBe(1);
  });
});
```

---

### 4.3 零视觉跳变（Zero CLS）与双缓冲无缝晋升验证

#### CLS 与骨架屏消除判定准则
1. **双缓冲 DOM 保持**：当块从 `ActiveTail` 晋升为 `Sealed` 时，在 Rust HTML 返回前的微秒级异步间隙中，组件必须通过 `useLayoutEffect` 将上一帧的文本 DOM 内容作为垫片驻留，**严禁渲染 `<div class="skeletonLine" />`**。
2. **盒模型尺寸预对齐**：流式代码块容器 `.md-code-fence-streaming` 与 Rust Syntect 渲染后的 `.md-code-block` 具有完全一致的 `padding: 12px`、`line-height: 1.6` 与 `border-radius: 6px`，使得语法高亮注入时元素高度形变 $\Delta h \le 0.5\text{px}$。

---

## 5. 维度四：基于 Tauri MCP（端口 4000）的端到端真实验收用例

### 5.1 桌面端真实验收通道规范与前置条件

> **权威指令依据**：`AGENTS.md` §15、§16 与附录 C。
> - **唯一合法调试通道**：Tauri MCP TCP Socket (`127.0.0.1:4000`)。
> - **严格禁止项**：禁止使用 9222 CDP，禁止打开浏览器单独访问 `localhost:5174`，禁止在临时 Mock 沙箱状态上做验收。
> - **真实数据门禁**：所有 DOM 检查、截图审查与 Store 状态必须依托真实运行的 Tauri 宿主。

```powershell
# 启动真机应用（debug 构建自动开启 4000 MCP）
npm run dev:workbench
```

---

### 5.2 MCP 验收场景 1：DeepSeek-R1 / Qwen 思考流实机验收

```json
{
  "testCaseId": "MCP-TC-01",
  "name": "思考流实时剥离与折叠面板验收",
  "steps": [
    {
      "action": "tauri-mcp:manage_ipc",
      "command": "send_user_message",
      "payload": {
        "sessionId": "real-test-session-1",
        "text": "请分析快速排序算法的稳定性并给出 Rust 实现"
      }
    },
    {
      "action": "tauri-mcp:wait_for",
      "selector": "[data-streaming='true']",
      "timeoutMs": 5000
    },
    {
      "action": "tauri-mcp:query_page",
      "query": "document.querySelectorAll('.timeline-thought-section').length"
    },
    {
      "action": "tauri-mcp:query_page",
      "query": "document.querySelector('.assistant-text').textContent.includes('<think>')"
    },
    {
      "action": "tauri-mcp:take_screenshot",
      "saveAs": "artifacts/mcp-verify-thought-stream.png"
    }
  ],
  "assertions": [
    {
      "metric": "thoughtSectionCount",
      "operator": ">=",
      "expected": 1,
      "description": "思考链必须在独立的折叠面板中渲染"
    },
    {
      "metric": "rawTagInText",
      "operator": "===",
      "expected": false,
      "description": "正文区 0 思考标签逃逸"
    }
  ]
}
```

---

### 5.3 MCP 验收场景 2：多轮复杂工具调用交错时间线实机验收

```json
{
  "testCaseId": "MCP-TC-02",
  "name": "多轮工具调用交错与 Blocks 结构保全验收",
  "steps": [
    {
      "action": "tauri-mcp:manage_ipc",
      "command": "send_multi_turn_task",
      "payload": { "task": "搜索文件并替换内容" }
    },
    {
      "action": "tauri-mcp:wait_for",
      "selector": "[data-session-status='idle']",
      "timeoutMs": 30000
    },
    {
      "action": "tauri-mcp:query_page",
      "query": "Array.from(document.querySelectorAll('[data-timeline-item]')).map(el => el.getAttribute('data-timeline-item'))"
    }
  ],
  "assertions": [
    {
      "metric": "timelineSequence",
      "operator": "deepEqual",
      "expected": ["thought", "tools", "thought", "tools", "text"],
      "description": "多轮思考、工具调用与最终文本严格按时序交错，无前序思考丢失"
    }
  ]
}
```

---

### 5.4 MCP 验收场景 3：真流式 Markdown 代码与表格无跳变实机验收

```json
{
  "testCaseId": "MCP-TC-03",
  "name": "真流式分块渐进封口与零跳变实机验收",
  "steps": [
    {
      "action": "tauri-mcp:manage_ipc",
      "command": "send_user_message",
      "payload": { "text": "输出一个 5 行 3 列的 Markdown 表格与一段 TypeScript 代码" }
    },
    {
      "action": "tauri-mcp:wait_for",
      "selector": ".md-table-wrap",
      "timeoutMs": 10000
    },
    {
      "action": "tauri-mcp:query_page",
      "query": "document.querySelectorAll('.skeletonLine').length"
    },
    {
      "action": "tauri-mcp:take_screenshot",
      "saveAs": "artifacts/mcp-verify-markdown-stream.png"
    }
  ],
  "assertions": [
    {
      "metric": "skeletonCountDuringStream",
      "operator": "===",
      "expected": 0,
      "description": "流式分块晋升期间骨架屏闪现次数严格为 0"
    }
  ]
}
```

---

## 6. 制定《反退避与零破坏验收清单》（Anti-Regression & Zero-Damage Checklist）

依据 `.agents/LOGIC_PLAN_NO_RETREAT.md` 与 `AGENTS.md`，制定本战役全体 Agent 必须恪守的铁律清单。**任何违反下列红线的行为一律视为构建破坏，打回重做！**

### 6.1 任何 Agent 严禁做出的 12 大降级/偷懒行为（硬性红线）

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 12 大严禁降级与偷懒红线清单 (强制一票否决)                         │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. 严禁使用一次性正则匹配代替 Rust 流式状态机：不得试图在前端用 replace(/<think>.../) 掩盖逃逸。   │
│ 2. 严禁全量 innerHTML 暴力替换：流式过程中严禁对整篇消息执行全量 innerHTML 重置。                  │
│ 3. 严禁在 message-end 瞬间闪现骨架屏：禁止在晋升过渡期挂载 skeletonLine 造成高度坍塌。          │
│ 4. 严禁破坏性 filter 抹除 Blocks：禁止通过 blocks.filter(b => b.type === 'tool_call') 抹除思考。  │
│ 5. 严禁绕过流水线门禁：绝对禁止使用 --no-verify 或注释测试跳过 CI 报错。                         │
│ 6. 严禁使用 9222/CDP 或独立浏览器调试：所有实机验收必须经 127.0.0.1:4000 Tauri MCP 完成。        │
│ 7. 严禁在 Mock/沙箱会话中宣称通过：必须在水合真实会话 Store 状态下进行断言和截图。              │
│ 8. 严禁在多轮会话中盲目 += 拼接正文：必须基于 messageEndTurnSegments 与 turnIndex 权威幂等合并。  │
│ 9. 严禁单方面 MVP 缩水砍功能：不得以“太难”、“业界都做不到”为由放弃真流式分块或思考隔离。         │
│ 10. 严禁删除或弱化存量测试资产：主仓库与 reference/ 下的所有测试用例必须 100% 保持通过。         │
│ 11. 严禁魔术数字与坐标硬编码：UI 对齐与分块必须基于原生 AST/Lexer 边界，禁止用 setTimeout 延迟。 │
│ 12. 严禁非主控 Agent 提交 Git：子 Agent 必须将改动留在工作区，禁止 reset --hard 或并行 commit。  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 6.2 选型与实现反退避自检 Checklist

- [ ] **效果对齐自检**：是否 100% 达成“正文 0 推理逃逸”、“真流式 Markdown 渐进封口”、“多轮 0 重复”、“Blocks 0 丢失”四大效果锁？（若有任何未达标项，禁止提交）。
- [ ] **代码结构自检**：Rust 状态机是否具备 $O(1)$ 内存前瞻与无损回滚能力？前端分块是否对 HTML 嵌套与 LaTeX 公式进行了保护？
- [ ] **性能预算自检**：在 60 FPS 流式高频推送下，已封口历史块重渲染次数是否严格为 0？CLS 是否 $\le 0.01$？
- [ ] **测试绿灯自检**：是否已在本地完整跑通全量门禁（`FULL_CHECK_COMMANDS.md` 包含的所有 12 道关卡）？

---

### 6.3 门禁检查一键执行总命令集 (Powershell One-Liner)

在宣称战役任务完成前，必须在根目录完整执行并通过以下地毯式门禁组合命令：

```powershell
npm run check:core; if ($LASTEXITCODE -eq 0) { cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml }; if ($LASTEXITCODE -eq 0) { npm run check:store-types }; if ($LASTEXITCODE -eq 0) { npm run lint:depcruise }; if ($LASTEXITCODE -eq 0) { npx turbo run build }; if ($LASTEXITCODE -eq 0) { npx vitest run }; if ($LASTEXITCODE -eq 0) { cargo test --workspace }; if ($LASTEXITCODE -eq 0) { npm run test:integration }; if ($LASTEXITCODE -eq 0) { npm run test:fuzz }; if ($LASTEXITCODE -eq 0) { node -e "const fs=require('fs'),path=require('path');function walk(d){let r=[];for(let f of fs.readdirSync(d)){if(['node_modules','.git','dist','target','build'].includes(f))continue;f=path.join(d,f);if(fs.statSync(f).isDirectory())r=r.concat(walk(f));else if(!/\.(png|jpg|ico|webp|zst|tar|exe)$/i.test(f))r.push(f)}return r}let errs=walk('.').filter(f=>fs.readFileSync(f,'utf8').includes('\uFFFD'));if(errs.length){console.error('Found FFFD in:',errs);process.exit(1)}else{console.log('Zero FFFD verified!')}" }
```

---
*本文档为 Conex / Crish 战役核心质量与测试规范资产，严格遵循 UTF-8 编码，包含完整的测试用例矩阵、自动化代码、性能指标与反退避 Checklist，作为后续实施与验收的唯一终极标准。*
