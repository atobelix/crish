# 16 · 可观测性与既有 perf 资产审查素材

> 生成：2026-09-13 · 方向 16 静态走读素材
> 范围：`apps/agent-workbench/src-tauri/src/perf/`、bench/stress、tracing/telemetry、前端门禁、CI 接线

## 1. perf/ 模块接线现状（PE-03 · G11a）

### 1.1 文件与状态

| 文件 | 行数 | 命令状态 | 生产消费方 |
| ---- | ---- | -------- | ---------- |
| `diff.rs` | 374 | `perf_diff_parse` → 经 `core_parse_diff` 复用 | `core_commands.rs:438-448` spawn_blocking 包装；前端 `rustCore.ts:402` / `api-adapters.ts:199` |
| `encoding.rs` | 232 | `perf_encoding_detect/decode` → `core_detect_encoding/decode_text` | `core_commands.rs:410-434`；`perf_encoding_encode` dead（`core_text_encode` 接线，encoding.rs:116-118） |
| `fs.rs` | 219 | `perf_fs_*` 已删（G11a/PE-03） | **零生产消费**；`read_chunk`/`file_info` 仅测试（fs.rs:1-9,20-22） |
| `hash.rs` | 176 | `perf_hash_compute`/`base64_*` → core | `core_commands.rs:367-405` spawn_blocking；前端 `rustCore.ts:267-298` |
| `jsonl.rs` | 267 | `perf_jsonl_*` 已删 | `append_jsonl_lines` 保留；`read_jsonl`/`write_jsonl` 仅测试（jsonl.rs:1-5） |

### 1.2 命令注册（main.rs）

```
main.rs:386-394
  core_hash_compute / core_base64_encode / core_base64_decode /
  core_detect_encoding / core_decode_text / core_parse_diff /
  core_messages_to_jsonl
```

- 原 `perf_*` 别名不注册；PE-03 迁移后实现降内部 fn。
- `core_messages_to_jsonl`（core_commands.rs:453-467）**不复用** `perf::jsonl`，独立 serde_json 实现——重复点。

### 1.3 已识别重复轮子 / SSOT 风险

| # | 资产 | 重复面 | 位置 |
| - | ---- | ------ | ---- |
| D1 | unified diff 解析 | Rust `parse_unified_diff` vs JS `parseUnifiedDiffs` | perf/diff.rs:99-247 vs toolFeedbackDiff.ts:126-430（含目录列表拦截、400 行截断，语义不同） |
| D2 | JSONL 序列化 | `perf::jsonl::write_jsonl`（测试专用）vs `core_messages_to_jsonl`（生产，无文件落盘，仅字符串） | jsonl.rs:120-172 vs core_commands.rs:453-467 |
| D3 | BOM 检测 | 手写 BOM_SIGS 表（encoding.rs:41-56）vs encoding_rs 自身 BOM 处理 | encoding.rs:18-38 先手写再 chardetng；`decode` 再经 encoding_rs |
| D4 | SHA-256 | perf::hash::sha256_compute vs conex-fs/cas/telemetry-redact/relay 各自 Sha256::digest | hash.rs:8-11；crates 内散落（workspace-store/cas.rs:21、conex-fs/lib.rs:207 等）——crate 边界合理，非同进程重复调用面 |

### 1.4 PF01（06 报告交叉）

- 06 PF01：`perf/fs.rs` mmap 分块读未接线（06 报告:866-874）。
- `read_chunk` 对 ≥64KB 走 mmap（fs.rs:68-81），安全注释完整；无生产消费方。
- 预览/分页读（06 FS02/FE01）当前整包 IPC，**未复用** read_chunk。
- 结论：PF01 仍开放；接线决策归 06 批次 S 与 core_fs 域迁移。

## 2. bench / criterion / 压测覆盖

### 2.1 Rust criterion（crates/*/benches）

| crate | bench 文件 | 覆盖域 |
| ----- | ---------- | ------ |
| session-loop | `tool_batch.rs` / `request_build.rs` | 工具批处理、请求构建 |
| orchestrator | `event_chain.rs` | 事件链（46 元素吞吐；注：criterion 计时失真 50× 备注 :174） |
| conex-db | `db_write.rs` | save_session_body 全量 100/1000/5000 |
| agent-provider | `sse_parse.rs` | SSE framing + parse |

- CI 接线：`ci-slow.yml:78-79` `cargo bench --workspace --locked`（存在 crates/*/benches 才跑）。
- **盲区**：`perf::diff` / `encoding` / `jsonl` / `hash` 无 criterion；EventBuffer 仅有 #[ignore] stress（见下）；无 telemetry/file-write bench。

### 2.2 EventBuffer 20 万条压测

- `buffer.rs:361-406` `stress_high_watermark_flood_drops_only_delta_and_keeps_terminal`（#[ignore]）
  - 20 万 Soft delta + 3 Critical；断言 message-end/run-terminal 必达、软水位 ≤64。
- `buffer.rs:411-456` `stress_delta_flood_across_flush_cycles_keeps_terminal`（#[ignore]）
  - 50 轮 × 3002 事件周期冲刷。
- 运行方式：`cargo test -p crish-agent-workbench --release -- --ignored stress_ --nocapture`（buffer.rs:351-352）——**默认不进 CI**。

### 2.3 前端 TS bench / stress

- `packages/shared-utils/src/bench/`：lru / bounded-map / jsonl-append / deep-equal / mutex / ring-buffer / object.clone / diff.parse.10k 等（bench-definitions.ts:78-312）。
- CI：`perf-test.yml` 跑 bench + mem + compare（threshold 0.2）+ generate-perf-report。
- 压测：`tests/stress/`（ai-stream / diff-load / session-switch / subagents）——手动 `npm run stress`。
- 启动：`tests/startup/measure-cold-start.ts` / warm——手动。
- **盲区**：无门禁级「首帧 TTI 回归」「流式 token 帧率」自动化；Rust EventBuffer stress 不在 perf-test.yml。

## 3. tracing / telemetry / EmitReport 开销

### 3.1 subscriber 装配

- `conex-telemetry::init_default`（subscriber.rs:47-106）：EnvFilter + compact stderr + 可选 DailyFileWriter。
- 装配点：`main.rs:671-684`（FileConfig + panic_hook）。
- 文件层失败降级仅 stderr 并返回 false（subscriber.rs:78-81）。

### 3.2 慢序列化告警

- `engine_channels.rs:537` `SLOW_EVENT_SERIALIZE_WARN_MS = 10`。
- `warn_slow_event_serialize`（:542-553）：仅 `elapsed_ms >= 10` 才 warn；常态零日志。
- 挂在 `BufferedRunEventBridge.emit`（:619-628）：**每信封 Instant::now() 计时**——µs 级常态开销，恒定路径。

### 3.3 EmitReport

- `core_event_bridge.rs:29-45`：emitted/buffered/dropped 三计数 + `add` 合并。
- `BufferedRunEventBridge.emit`（engine_channels.rs:618-658）：丢帧 `dropped > 0` 时 `tracing::warn!`（:649-655）。
- **风险**：高水位洪峰期间**每次 enqueue 丢帧都 warn**（非聚合/限速）——若 20 万 delta 灌入且持续超软水位，warn 频次可放大日志 IO（待运行时验证）。
- 毒化恢复计数 `POISON_RECOVERIES`（:643）有原子计数，正面。

### 3.4 前端 @crish/telemetry（TS 面）

- 未在本素材深扫；方向 15（多设备/Relay/telemetry 上传）覆盖上传频率。本方向聚焦 Rust subscriber 与 EmitReport。

## 4. 前端性能门禁

### 4.1 check-startup-budget

- 位置：`scripts/check-startup-budget.mjs`（281 行）。
- 语义：读 Vite manifest，entry 文件体积对 BUDGET_KB（缺省 520）warning；静态图 totalBytes **仅信息展示**（:221-247,260-266）。
- 与 07 A2 一致：门禁失灵——静态图 1709 KiB 不 fail。
- **未接线 CI / check:desktop**：package.json:56 有脚本，但 `check:desktop` 链与 `ci.yml` 均不调用；`ci.yml:132` 只跑 `check-dist --max-app-kb 500`。
- check-dist 锚 App/index chunk <500KB + vendor 拆分 + CSP，**同样不约束静态图**。

### 4.2 check-line-counts

- 位置：`scripts/check-line-counts.mjs`（319 行）。
- 三级：85% warning / 100% fail / >650 hard + per-file 基线。
- 接线：`check:desktop` + `ci.yml:75`。
- 正面：有效代码行（滤注释空行）；类型契约 800 放宽；基线 `--update` 显式维护。
- 潜在缺口：`__tests__` 目录整目录跳过（:140）；`.mjs`/`.cjs` 不计；hooks 目录归 Business Logic 正确但 UI 大 hooks 若落 .ts 可能误分类为 400 而非 500（分类规则:83-109）。

### 4.3 check:store-writes（check-no-raw-setstate）

- 位置：`scripts/check-no-raw-setstate.mjs`（109 行）。
- 扫描 `use\w*Store\.setState\s*\(`；白名单 store/ + api/store-access/ + bootstrapStores + dev-only + 测试。
- 接线：`check:store-writes` + **ci.yml:65**（不在 check:desktop 主链，CI 独立）。
- 正面：快照桥注入点断言（bindMessageSnapshotsOps，:89-98）。
- 误报/漏报面：
  - 仅扫**单行**匹配（:76-86）——跨行 `useXStore\n.setState(` 漏报（低概率）。
  - 白名单整目录豁免 store/——store 内任意 setState 放行（设计使然）。
  - dev-only 豁免只认行首 `if (import.meta.env.DEV`（:79-81），`if (import.meta.env?.DEV && …)` 单行匹配 OK，但多行 if 体不豁免（会误报）。

### 4.4 reRenderMonitoring

- 位置：`apps/crish-desktop/src/__tests__/reRenderMonitoring.test.tsx`（502 行）。
- 单测套件：渲染计数探针 + store 隔离断言（0 extra re-render）+ memo props 稳定性。
- 属**单元测试资产**，非运行时门禁/CI 性能计时器；随 vitest 跑，无帧率/长任务预算。

## 5. CI 接线速查

| 门禁/资产 | package.json | check:desktop | ci.yml 快层 | ci-slow / perf-test |
| --------- | ------------ | ------------- | ---------- | ------------------- |
| check-startup-budget | ✅ | ❌ | ❌ | ❌ |
| check-dist | 经 frontend-build | — | ✅ :132 | — |
| check-line-counts | ✅ | ✅ | ✅ :75 | — |
| check:store-writes | ✅ | ❌ | ✅ :65 | — |
| reRenderMonitoring | vitest | — | vitest-fast 间接 | — |
| cargo bench | — | — | — | ✅ ci-slow |
| EventBuffer stress | cargo test --ignored | — | ❌ | ❌ |
| TS bench + mem | bench:ci | — | — | ✅ perf-test.yml |

## 6. 缺失性能回归门禁候选（仅列不实现）

1. **静态图总和门禁**（07 A2 扩展）：check-startup-budget 纳入 CI + STATIC_GRAPH_BUDGET 阈值。
2. **EventBuffer 水位丢帧率**：release stress 输出落盘 + 回归阈值（事件/秒、Critical 必达）。
3. **序列化慢告警计数**：EmitReport.dropped 聚合计数器导出（避免每帧 warn）+ 单元断言。
4. **Rust hot-path criterion 基线**：diff.parse / encoding / jsonl append 入 ci-slow 与 basline 对比。
5. **首屏 TTI 冒烟**：tests/startup + 生产包 + 预算断言（V 项待 Tauri MCP）。
6. **流式 token 帧率**：stress-ai-stream 输出 p95 与阈值。
7. **store-writes 跨行 setState**：AST 或 multi-line 规则补漏。
8. **check-startup-budget 与 check-dist 真源合一**：避免双脚本口径漂移。
