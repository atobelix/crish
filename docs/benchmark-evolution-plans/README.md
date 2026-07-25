# Benchmark Evolution Plans

对标 Opencode / jcode / Codex CLI / Claude Code 等 **reference/** 源码后，面向 **Conex/Crish 自然融入** 的系统性演进方案（非照抄、无 TUI、不重做沙箱）。

## 阅读顺序

1. [`audits/00-master-findings.md`](./audits/00-master-findings.md) — **10 路** 专项审计汇总  
2. [`00-master-multi-agent-roadmap.md`](./00-master-multi-agent-roadmap.md) — Wave 编排与首刀  
3. 分册：
   - [`plans/01-fuzzy-seek-and-streaming-patch.md`](./plans/01-fuzzy-seek-and-streaming-patch.md) — 模糊 Seek + 流式 Diff  
   - [`plans/02-compaction-image-413-tool-pair.md`](./plans/02-compaction-image-413-tool-pair.md) — 图 Token / 413 / Tool 成对  
   - [`plans/03-cache-denial-maxtokens-slash.md`](./plans/03-cache-denial-maxtokens-slash.md) — Cache / Denial / max_tokens / slash  
   - [`plans/04-search-cost-keyring.md`](./plans/04-search-cost-keyring.md) — 搜索 / 4D 成本 / 轻密钥  

## 用户约束（全文适用）

| 约束 | 含义 |
|------|------|
| 自然融入 | 挂现有 crates / agent-runtime / daemon / desktop 接缝 |
| 禁止照抄 | reference 只读；不搬文件树/TUI |
| 无 TUI | 不做终端 Ink 产品 |
| 沙箱维持 | TrustZone 策略不大改 |
| 安全轻量 | 密钥 sidecar 即可，非企业合规大工程优先 |

## 调研 Agent 清单（≥8，实际 10）

| ID | 方向 |
|----|------|
| A | Fuzzy patch / 4-pass seek |
| B | Image token + HTTP 413 |
| C | Tool pairing compaction |
| D | Streaming patch FSM |
| E | Search score-only / 0-heap |
| F | Keyring light |
| G | Anthropic ephemeral cache |
| H | Denial tracking (human) |
| I | 4D cost telemetry |
| J | /doctor /init + max_tokens |

## 方案 Agent 清单（≥4）

| Plan | 方向 |
|------|------|
| 01 | A + D |
| 02 | B + C |
| 03 | G + H + J |
| 04 | E + I + F |

## 执行

按 `00-master-multi-agent-roadmap.md` **W1 → W4** 推进；每波多 Agent 并行，闸门通过后再开下一波。
