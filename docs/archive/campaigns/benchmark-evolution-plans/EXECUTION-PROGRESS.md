# Benchmark Evolution — 执行进度

**模式**: 多轮 × 每轮 ≥4 Agent 并行；闸门通过再进下一轮
**约束**: 不照抄 · 无 TUI · 不重做沙箱 · 不放宽测试 · 不作弊

---

## 执行纠偏说明

| 时间 | 事件 |
|------|------|
| 首轮失误 | 主会话串行改代码，**未按方案多 Agent 并行** |
| 纠正 | 改回 **W1-R1 五 Agent → 闸门 → W1-R2/W2 五 Agent → W3/W4 四 Agent → 严格审计 Agent** |
| 审计后 | 主会话修补 P0：QuickOpen 空态诚实、搜索常驻索引 rebuild、Rust IMAGE_TOKEN 1600 + safe drop |

---

## Wave 状态

| Wave | 状态 | 说明 |
|------|------|------|
| W1 正确性 | ✅ 主体 | Seek Rust+TS、图 token/413/scrub、Anthropic cache、length 保真+续写、apply/edit 消费 seek |
| W2 健壮 | ✅ 主体 | denial denylist、4D hydrate/pricing、tool-pair export |
| W3 体验 | ✅ 主体 | /doctor /init、Ctrl+P QuickOpen、args-delta sink（provider emit 未全开） |
| W4 轻密钥 | ✅ 主体 | multi-profile DPAPI sidecar + 诚实 LS 回退 |
| 严格审计 | ✅ | `audits/01-post-execution-strict-audit.md` |
| 审计 P0 修补 | ✅ 部分 | 索引 rebuild + 空态诚实 + Rust 1600/safe drop |

---

## 闸门实测（主会话）

| 套件 | 结果 |
|------|------|
| `cargo test -p conex-diff` | 24 passed |
| W1-R1 vitest 包 | 148 passed |
| R2 相关（session/deny/edit/4D…） | 61+ passed |
| applyFileDiff | 55 passed |
| 综合回归包 | 208 passed（一轮） |
| R3 doctor/quickopen/consumer | 44 passed |

---

## 已知残余（审计 + 诚实记录）

| 项 | 级别 | 说明 |
|----|------|------|
| Length **maxTokens 阶梯抬升** | P1 | 当前为 continue-nudge 续写，非请求参数 escalate |
| Provider **args-delta 出站** | P1 | Consumer sink 就绪；Anthropic 仍只 end yield |
| 流式 Diff UI | P1 | 未做渐进 FileDiff 面板 |
| 密钥无 Tauri 时仍 LS | 诚实 | 代码注释 + 无假安全 toast |
| QuickOpen 需 rebuild | 已接线 | `core_rebuild_search_index` + 打开面板时 rebuild |

---

## N 轮（审计残余 · 多 Agent 并行中）

| Agent | 职责 | 独占 |
|-------|------|------|
| N1 | maxTokens 真 escalate | session-loop + provider maxTokens path |
| N2 | Anthropic tool-args-delta 出站 + consumer 接线 | anthropic-stream-parse + session-loop 局部 / gateway |
| N3 | 渐进 Diff 极简 UI（provisional，Accept 禁用） | desktop bridge + Diff 预览入口 |
| N4 | 搜索索引闭环验证 + 桌面 rebuild 接线补全 | rustCore / QuickOpen / core_commands 若需 |
| N5 | 4D 设置价表精简 + seek fixture 双语对齐检查 | pricing UI 轻量 / 测试 |

**N 轮闸门**: vitest 相关全绿；审计更新；不放宽测试。

### N 轮结果（2026-07-22）

| Agent | 结果 |
|-------|------|
| N1 maxTokens escalate | ✅ 双倍抬升至 32768 + 续写 fallback |
| N2 args-delta emit | ✅ Anthropic yield + session-loop tool-update |
| N2b bridge contract | ✅ 生产态 tool-update 解析（修假绿） |
| N2c emit shape test | ✅ session-loop 形状钉死 |
| N3 partialArgs UI | ✅ 运行中折叠预览，无 Accept |
| N4 search index | ✅ rebuild + 诚实空态 + registry |
| N5 polish | ✅ 高级定价折叠 + seek golden 双语 |
| 再审计 | `audits/02-n-round-re-audit.md` |

主会话闸门：见下方「N 轮闸门实测」。

### N 轮闸门实测

| 套件 | 结果 |
|------|------|
| N 轮综合 vitest（session-loop / anthropic / bridge / seek / deny / edit / apply…） | **238 passed** |
| `cargo test -p conex-diff seek_sequence` | **14 passed**（含 golden fixture） |
| 契约修复 | bridge 消费生产态 `tool-update` + `kind: tool-args-delta` |
