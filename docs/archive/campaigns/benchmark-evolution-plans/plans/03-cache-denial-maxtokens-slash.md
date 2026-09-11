# 03 — Anthropic Cache Wire · Denial Intent · max_tokens · /doctor /init

**Directions**: G + H + J
**来源**: `docs/benchmark-evolution-plans/audits/00-master-findings.md`
**日期**: 2026-07-22
**硬约束**: 无 TUI；OpenAI 永不注入 `cache_control`；人类 Deny ≠ Claude 分类器 denialTracking

---

## 0. 问题一句话 + 硬证据

**一句话**：Anthropic 缓存只在 plan 层；人类拒绝可重复弹窗；length 被 consumer 抹成 stop；slash 无 doctor/init。

| 方向 | 硬证据 |
|------|--------|
| G | `provider-cache-hints.ts` 有 plan；`anthropic-request-build.ts` 无 wire；session-loop 未传 `providerFamily` |
| H | `DaemonApprovalHandler` 仅 allowlist；user deny 文案弱；softDeny 计入 tool-error 环 |
| J | `provider-response-consumer.ts` stopReason 无 length；`resolveSlashCommand` 无 doctor/init；CONEX.md 只读 |

---

## 1. 目标架构

```
assemblePromptForProvider(providerFamily: anthropic)
  → createProviderCacheHintPlan
  → AnthropicProvider: applyAnthropicEphemeralCacheControl
       system 末块 + last tool: cache_control ephemeral
  → OpenAI withCacheHint: 仅 prompt_cache_key

DaemonApprovalHandler
  runIntentAllowlist (exist)
  runIntentDenylist (NEW, human deny only; timeout 不入)

ProviderResponseConsumer
  stopReason: error > tool-call > length > stop

AgentSessionLoop
  length + budget → escalate maxTokens / 续写
  deny → denylist + softDeny envelope retryable:false

Desktop slash
  /doctor sessionless → status + capabilities 诊断卡
  /init conversation → 引导写 CONEX.md
```

---

## 2. 非目标

- TUI doctor、classifier denialTracking 照搬
- always 永久 denylist、OpenAI cache_control
- 静默写 CONEX.md 绕过 agent/权限

---

## 3. 多轮多 Agent 计划

### Round 0 — 契约冻结（≥4 Agent，只读+测标题）

| Agent | 产出 |
|-------|------|
| R0-Cache | 断点算法 + OpenAI 禁止句 |
| R0-Denial | 真值表：user deny 入 denylist；timeout 不入 |
| R0-Length | escalate 阶梯常量草稿 |
| R0-Slash | doctor sessionless / init conversation |

**闸门**: 四方契约无冲突。

### Round 1 — G Cache wire（≥4 Agent）

| Agent | 文件 |
|-------|------|
| R1-A Body | `anthropic-request-build.ts` apply ephemeral |
| R1-B Provider | `provider-anthropic.ts` 消费 plan |
| R1-C Family | `agent-session-loop` 传入 providerFamily |
| R1-D OpenAI 隔离测 | `provider-openai-compatible` 断言无 cache_control |

**闸门 G1**: Anthropic fixture 有 ephemeral；OpenAI 无。

### Round 2 — J length 保真 + escalate（≥4 Agent）

| Agent | 文件 |
|-------|------|
| R2-A Consumer | 保留 finishReason length |
| R2-B Session | escalate / 续写预算 |
| R2-C Constants | max recoveries / steps |
| R2-D Stream 对齐测 | anthropic/openai/gemini length 链路 |

**闸门 G2**: length 单测 + escalate 预算耗尽干净 stop。

### Round 3 — H Denial（≥4 Agent）

| Agent | 文件 |
|-------|------|
| R3-A Daemon denylist | `daemon-approval-handler.ts` |
| R3-B Envelope | `runtime-helpers` retryable:false 文案 |
| R3-C Session 透传 | metadata 完整 |
| R3-D Recovery 豁免 | softDeny user 不计入 tool-errors 环 |

**闸门 G3**: 二次同 intent 不弹窗；timeout 仍可弹。

### Round 4 — J slash（≥4 Agent）

| Agent | 文件 |
|-------|------|
| R4-A 解析 | `resolveSlashCommand.ts` |
| R4-B 菜单 | ChatCard BASE_SLASH |
| R4-C /doctor 执行 | 聚合 status/capabilities |
| R4-D /init 执行 | conversation 引导 CONEX.md |

**闸门 G4**: 解析测 + sessionless 纪律。

### Round 5 — 收口（≥4 Agent）

Runtime / daemon / desktop 回归 + 冒烟清单 + 勾 DoD。

---

## 4. DoD

- [ ] Anthropic body 有 ephemeral；OpenAI 永不出现 cache_control
- [ ] 人类 deny 同 intent 抑制重弹 + 信封可行动
- [ ] length 保真 + 有限 escalate
- [ ] `/doctor` `/init` 可发现
- [ ] 命名用 `humanIntentDenylist` 而非抄 Claude `denialTracking`

### 冒烟

1. Anthropic 请求体 spot
2. Deny ×2
3. 小 max_tokens length
4. `/doctor` `/init`

---

## 关键路径

- `anthropic-request-build.ts` / `provider-anthropic.ts`
- `provider-response-consumer.ts` / `agent-session-loop.ts`
- `daemon-approval-handler.ts` / `runtime-helpers.ts`
- `resolveSlashCommand.ts`
