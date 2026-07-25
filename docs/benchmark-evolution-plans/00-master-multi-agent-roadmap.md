# Benchmark Evolution — 主多轮多 Agent 路线图

**日期**: 2026-07-22  
**上游**: `audits/00-master-findings.md`（10 路调研）  
**分册**: `plans/01` … `04`  
**用户硬约束**: 自然融入架构 · 禁止照抄 · 无 TUI · 不重做沙箱 · 安全轻量

---

## 1. 总目标

在 **不推倒** 现有 React + Rust crates + CQRS + TrustZone + softDeny 体系的前提下，系统补齐：

1. **LLM 编辑容错**（4-pass seek）  
2. **压缩/载荷健壮**（图 token + 413 + tool pair）  
3. **模型侧成本与缓存**（ephemeral wire + 4D 账单）  
4. **运行恢复与产品引导**（length escalate、denial 记忆、/doctor /init）  
5. **搜索产品化与轻密钥**（常驻索引 + quick-open；DPAPI sidecar）

---

## 2. Wave 编排（执行顺序）

| Wave | 主题 | Plan | Directions | 并行度 |
|------|------|------|------------|--------|
| **W1** | 正确性 P0 | 01 A 前半 + 02 B + 03 G/J-T | Seek 核心 · 图/413 · cache wire · length | ≥4 agents/round |
| **W2** | 健壮交互 P1 | 01 B 消费 + 02 C + 03 H + 04 I | apply/edit 接 seek · pair export · denial · 4D hydrate/pricing | ≥4 |
| **W3** | 体验 P1 | 01 D + 03 J-D + 04 E UI | 流式 Diff · /doctor /init · quick-open | ≥4 |
| **W4** | 轻安全 P2 | 04 F | multi-profile secret | ≥4 |

**波间闸门**: 该波 vitest/cargo 相关绿 + 文档 DoD 勾选；**禁止** 波内引入 TUI/沙箱大改。

---

## 3. 分册索引

| 文档 | 内容 |
|------|------|
| [audits/00-master-findings.md](./audits/00-master-findings.md) | 10 路审计汇总 |
| [plans/01-fuzzy-seek-and-streaming-patch.md](./plans/01-fuzzy-seek-and-streaming-patch.md) | A+D Seek + 流式 Patch |
| [plans/02-compaction-image-413-tool-pair.md](./plans/02-compaction-image-413-tool-pair.md) | B+C 图 token/413/成对 |
| [plans/03-cache-denial-maxtokens-slash.md](./plans/03-cache-denial-maxtokens-slash.md) | G+H+J Cache/Deny/Length/Slash |
| [plans/04-search-cost-keyring.md](./plans/04-search-cost-keyring.md) | E+I+F Search/Cost/Key |

每册均含：**≥3–5 Round × 每 Round ≥4 Agent**、文件所有权、闸门、DoD、风险。

---

## 4. 跨 Plan 依赖

```
W1: G family 注入 ──┬── 利于真实 cache hit（I 仍独立可做）
W1: Seek 纯函数 ────┼── W2 applyFileDiff / edit 消费
W1: length consumer ─┼── W1 escalate
W1: 413 scrub ───────┴── 与 softDeny 零交叉（02 契约）

W2: 4D hydrate ── W3 UI
W2: denylist ──── 不阻塞 W3 slash
W3: args-delta ── 依赖 W1 协议可选字段稳定
W4: secrets ──── 不阻塞 W1–W3 功能正确性
```

**session-loop 争用**: Plans 02/03 均可能改 `agent-session-loop.ts` → 执行时指定 **单 Owner** 或按 Wave 串行合入。

---

## 5. 全局非目标

| 非目标 | 原因 |
|--------|------|
| TUI / React Ink | 用户明确无计划 |
| TrustZone / 沙箱重写 | 现状可接受 |
| 默认 Levenshtein 静默 apply | 误改风险 |
| jcode DP 替换 100k 搜索 | 打爆 SLA |
| Daemon 磁盘密钥库 | 宿主持密即可 |
| 照抄 Claude/Opencode/jcode 文件结构 | 必须自然化 |

---

## 6. 执行纪律（反浅尝）

1. **先读本 Wave 对应 plan 全文 + master findings 相关节**，再改代码  
2. Round 内 Agent **文件互斥**；共享文件串行  
3. 禁止：假绿 skip、空实现 toast 成功、用展示 Myers 冒充 seek  
4. 验收：**单元 + 相关包 vitest/cargo**；涉及 UI/daemon 的条目写软件内冒烟步骤  
5. 合入后更新 `EXECUTION-PROGRESS.md`（本目录，执行轮创建）

---

## 7. 建议首刀（W1 开工清单）

按依赖可当日并行 4 组：

| 组 | 任务 | Plan |
|----|------|------|
| A | `seekSequence` 4-pass + 单测 | 01 Round A |
| B | `IMAGE_TOKEN_COST` + estimate | 02 R1 |
| C | Anthropic `cache_control` wire + family | 03 R1 |
| D | consumer 保留 `finishReason: length` | 03 R2-A |

随后：413 scrub（02 R2）、length escalate（03 R2）、edit/apply 接 seek（01 Round B）。

---

## 8. 与既有文档关系

| 已有 | 关系 |
|------|------|
| `docs/system-completion-plans/` | Provider/MCP/Goal 诚实能力 — **已落地主体**；本专题是下一演进层 |
| `docs/rust-architecture-redesign/` | 部分意图重叠（如 length recovery 文档）— 以本专题 **可执行 plan** 为准实现 |
| `reference/*` | **只读对照**；禁止整包 vendoring 进产品路径 |

---

## 9. 状态

| 项 | 状态 |
|----|------|
| 10 路调研 | ✅ 完成 |
| 4 册系统性方案 | ✅ 完成 |
| 本 Roadmap | ✅ 完成 |
| 代码执行 | ⏳ 下一会话按 W1 开工 |
