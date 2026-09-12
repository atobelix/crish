# 16 · 可观测性与既有 perf 资产审查报告

> **战役**：全面性能审查（performance-audit）
> **方向**：16 · 可观测性与既有 perf 资产（扩充方向，2026-09-12 中期评估）
> **状态**：静态审查完成（运行时 V 项见 §9）
> **方法约定**：静态代码走读 + `文件路径:行号` 证据 + 严重度分级 + 修复建议；不臆测；未实测项明确标注。
> **素材**：`materials/16-perf资产与门禁盘点.md`
> **总纲**：`00-性能审查总纲.md` 方向 16

---

## 一、范围与结论

### 1.a 审计对象（效果锁）

1. `apps/agent-workbench/src-tauri/src/perf/`（diff/encoding/fs/hash/jsonl）：接线、重复造轮子、与 06 PF01 交叉；
2. 既有 bench / criterion / 压测（含 EventBuffer 20 万条）覆盖盲区；
3. tracing/telemetry 自身开销、慢序列化告警、EmitReport；
4. 前端性能门禁：check-startup-budget、check:line-counts、store-writes、reRenderMonitoring——缺口与误报；
5. 缺失的性能回归门禁提案（不实现，只列）；
6. 与 07 A2 门禁失灵交叉深化。

### 1.b 一句话结论

**可观测性骨架（EmitReport / 慢序列化条件告警 / telemetry 双通道 / EventBuffer 压测）整体健康，但「有资产、弱接线」是本方向最大结构性问题——check-startup-budget 既不拦静态图（07 A2）也不进 CI，EventBuffer 20 万压测与 perf 域 criterion 均在 CI 外，门禁与基准资产对真实回归的拦截能力显著低于其存在感。**

### 1.c 发现计数

| 严重度 | 数量 | 代号 |
| ------ | ---- | ---- |
| 高 | 2 | P1, P2 |
| 中 | 6 | P3–P8 |
| 低 | 6 | P9–P14 |
| **合计** | **14** | |
| 正面发现 | 8 | B1–B8 |

**TOP3 高危**：

1. **P1** · check-startup-budget 静态图合计不 fail（07 A2 深化）——门禁失灵；
2. **P2** · check-startup-budget 完全未接入 CI / `check:desktop`——门禁孤岛；
3. **P3** · EventBuffer 20 万条压测与慢序列化路径均在默认 CI 外——性能回归不可见。

---

## 二、域 A：`src-tauri/src/perf/` 接线与重复轮子

### A.0 模块全景

| 文件 | 行数 | 生产接线 | 备注 |
| ---- | ---- | -------- | ---- |
| `diff.rs` | 374 | ✅ 经 `core_parse_diff` | 实现保留 `perf_diff_parse` |
| `encoding.rs` | 232 | ✅ detect/decode；encode dead | PE-03 后 `core_text_encode` 接线 |
| `fs.rs` | 219 | ❌ 零生产消费 | mmap 资产待接线（06 PF01） |
| `hash.rs` | 176 | ✅ hash/base64 | spawn_blocking 包装 |
| `jsonl.rs` | 267 | ❌ 命令已删 | 实现仅测试覆盖 |
| `mod.rs` | 5 | — | 纯模块声明 |

装配注册面：`main.rs:386-394`（7 个 `core_*` 命令）。前端消费面：`rustCore.ts:267-414`、`workers/api-adapters.ts:155-307`（优先 Rust、失败回退 JS/WebCrypto）。

---

#### P1.【高】`check-startup-budget` 静态图合计仅信息展示，不进入 warnings/errors（交叉 07 A2）

**位置**：`scripts/check-startup-budget.mjs:221-224,242-247,260-266`

**代码现场**：

```js
// 主预算锚定：isEntry 产物文件本身（对齐 check-dist 主入口）；静态图合计仅信息展示
const entryFileBytes = rows
  .filter((r) => r.isEntry && r.bytes != null)
  .reduce((s, r) => s + r.bytes, 0);
// …
console.log(
  `静态 import 图合计（信息）: ${totalBytes} B (${(totalBytes / 1024).toFixed(1)} KiB)`
);
// 主预算：entry 产物文件本身
if (entryFileBytes > budgetBytes) { /* warning / strict error */ }
// totalBytes 从未进入 warnings/errors
```

**调用链**：`collectEntryGraph`（:153-207）算出静态闭包与 `totalBytes` → 仅 `console.log` → 预算判定只读 `entryFileBytes`。

**根因**：脚本设计时（Wave A · TU7）刻意「仅 warning、未建基线前禁止 hard 一刀切」（:11-12 注释），但**从未把静态图列入 warning 列表**，与 entry 单文件双轨的补强停留在 07 报告文字（07:127-128,133-150）。

**影响量化**（07 方向 dist 实测，本方向交叉确认脚本行为一致）：

- entry ≈ 497.4 KiB ≤ 520 KiB → OK；
- 静态 import 图合计 ≈ 1709 KiB（含 catalog 550 KiB）——**门禁绿灯与真实首屏税脱节约 3.4×**；
- A1 类回归（再塞一个静态 vendor 进 entry 图）可无声合入。

**修复方案**：

1. `totalBytes` 进入 `warnings`（缺省软预算建议 900 KiB，env `STATIC_GRAPH_BUDGET_KB`）；`--strict` 下超限 `errors.push`；
2. 断边修复（07 A1）落地后**冻结静态图基线**再收紧；
3. 与 07 批次 S 联动，禁止只修脚本不修静态边。

**回归锚点**：

- 脚本输出含「静态 import 图合计」且超阈值时 `check:startup-budget` exit 1（`--strict`）；
- 单测/快照：构造假 manifest（entry 小 + 静态 import 大 chunk）断言 fail；
- 交叉：07 报告 A1 修复后静态图 < 基线。

**严重度判定**：**高**——与 07 A2 同源同位置；门禁存在感强、实际拦截力为零，是最典型的「可观测性资产失灵」。

---

#### P2.【高】`check-startup-budget` 孤岛：不在 `ci.yml`、不在 `check:desktop` 主链

**位置**：

- `package.json`：`"check:startup-budget": "node scripts/check-startup-budget.mjs"`（根 scripts 第 56 行附近）；
- `package.json` `check:desktop` 链：包含 `check:line-counts` / `check:input-guard` / …，**不含** `check:startup-budget`；
- `.github/workflows/ci.yml:120-135` `frontend-build` job：`build:desktop` → `check-dist --max-app-kb 500 --csp-enforce` → `check:chunk-cycles`，**无** `check:startup-budget`。

**代码现场**（ci.yml frontend-build）：

```yaml
- run: npm run build:desktop
- run: node scripts/check-dist.mjs --max-app-kb 500 --csp-enforce
- run: npm run check:chunk-cycles
```

**调用链**：开发者本地可手跑；CI 生产构建路径只经 check-dist；check-dist 只锚 App/index 单 chunk <500KB + vendor 存在 + CSP（`check-dist.mjs:7-14,74-80`），**同样不约束静态图总和**。

**根因**：

1. check-startup-budget 诞生于 startup-performance-audit 战役（TU7 软门禁），原计划接 `check:desktop` 与 CI（见 `docs/startup-performance-audit/audits/04-…` :725-776 方案），但**落地脚本未接线**；
2. 与 check-dist 职责重叠未合并：check-dist 挡「单文件超大」，startup-budget 本应补「图谱级」，结果后者谁也不跑。

**影响量化**：

- 快层 `frontend-build` 是 PR 级唯一产物断言点；静态图从 1.7MB 再涨到 3MB 只要 entry 单文件不破 500KB，**CI 仍全绿**；
- 软门禁（非 strict）即便本地跑，超预算也只 warn——双保险皆无。

**修复方案**：

1. **最小接线**：`ci.yml` frontend-build 在 `check-dist` 后追加 `node scripts/check-startup-budget.mjs --strict`（或先不加 strict、以 warning 进日志并设 14 天硬切计划）；
2. `check:desktop` 链追加 `check:startup-budget`（与 A2 静态图阈值一并）；
3. 长期：check-dist 与 startup-budget **真源合一**（避免双脚本口径漂移，见 P14）。

**回归锚点**：

- `ci.yml` 出现 `check:startup-budget` 步骤；
- 人为把静态 import 体积抬超阈值 → CI 红；
- package.json `check:desktop` 字符串包含 `check:startup-budget`。

**严重度判定**：**高**——门禁存在但永不执行，等价于不存在；与 P1 叠加构成「双失灵」。

---

#### P3.【中】EventBuffer 20 万条压测 `#[ignore]`，默认不进任何 CI

**位置**：`apps/agent-workbench/src-tauri/src/buffer.rs:349-456`

**代码现场**：

```rust
/// 桥吞吐压力测试（PE-11 T11.6.3，验证 buffer.rs:41-58 丢帧语义不丢终态）
///
/// 运行方式（release，显式跑；默认不进常规 CI）：
///   cargo test -p crish-agent-workbench --release -- --ignored stress_ --nocapture
#[cfg(test)]
mod stress_tests {
    #[test]
    #[ignore]
    fn stress_high_watermark_flood_drops_only_delta_and_keeps_terminal() {
        // 0..200_000u64 Soft delta + Critical message-end/run-terminal
        // 断言：Critical 必达、软存活 ≤64、打印事件/秒
    }
    #[test]
    #[ignore]
    fn stress_delta_flood_across_flush_cycles_keeps_terminal() { /* 50×3002 */ }
}
```

**调用链**：仅手动 `cargo test --release -- --ignored`；`ci.yml` / `ci-mid.yml` / `ci-slow.yml` 均不跑 `--ignored`；`perf-test.yml` 只跑 TS bench。

**根因**：设计意图是「高水位洪峰 + release 才有意义、避免拖慢快层」——合理，但**从未**在 ci-slow 或 perf-test.yml 以「手动/夜间 job」形式挂上，资产处于休眠。

**影响量化**：

- 丢帧语义（Critical 必达 / Soft 旧帧可丢）是 03/04 方向背压模型的不变量；一旦重构 buffer 水位或 DropClass，**无自动回归**；
- 20 万条吞吐数字（入队→drain 的事件/秒）无基线文件，性能退化只能靠人肉跑。

**修复方案**：

1. `ci-slow.yml` 增加 job：`cargo test -p crish-agent-workbench --release -- --ignored stress_ --nocapture`（允许 fail-warn 或 artifact 保存 stdout）；
2. 把 println 的事件/秒解析进 `perf-report/`（与 TS `generate-perf-report` 并列）或至少 `::notice` 输出；
3. 可选：软水位/丢帧计数导出为单元可断言的纯函数指标（不依赖 wall-clock）。

**回归锚点**：

- ci-slow 存在 `stress_` 步骤；
- 破坏 Critical 必达的改动 → job 红；
- 事件/秒出现在 workflow summary。

**严重度判定**：**中**——资产质量高（断言正确），缺的只是调度；修复成本低、防回归价值高。

---

#### P4.【中】`BufferedRunEventBridge.emit` 每信封恒定 `Instant::now` + 慢序列化路径；丢帧 `tracing::warn` 无聚合限速

**位置**：`apps/agent-workbench/src-tauri/src/engine_channels.rs:537-553,618-656`

**代码现场**：

```rust
const SLOW_EVENT_SERIALIZE_WARN_MS: u64 = 10;

pub(crate) fn warn_slow_event_serialize(run_id: &str, event_type: &str, elapsed: Duration) {
    let elapsed_ms = elapsed.as_millis() as u64;
    if elapsed_ms >= SLOW_EVENT_SERIALIZE_WARN_MS {
        tracing::warn!(target: "event_bridge", /* … */, "事件序列化慢于阈值（S3 慢序列化热点）");
    }
}

pub(crate) fn emit(&self, envelope: &AgentEventEnvelope) -> EmitReport {
    let serialize_started = std::time::Instant::now(); // 每信封恒定计时
    let payload = /* serialize */;
    let serialize_elapsed = serialize_started.elapsed();
    warn_slow_event_serialize(&self.run_id, envelope.type_name(), serialize_elapsed);
    // …
    if outcome.dropped > 0 {
        tracing::warn!(target: "event_bridge", run_id = %self.run_id,
            dropped = outcome.dropped, "事件缓冲丢帧（Delta 类目可丢，message-end 必达）");
    }
    report
}
```

**调用链**：引擎事件面 → `BufferedRunEventBridge::emit` → serialize → `EventBuffer::enqueue` → 丢帧计数 →（可选）flush → `EventBridge::emit_payload`。

**根因**：

1. **计时**：S3 埋点选择「每事件 Instant」——常态序列化为 µs 级，Instant 本身亦 µs 内，**属可接受观测开销**（与 04 方向「异常才 warn」样板一致）；风险不在 10ms 告警分支，而在**高事件率下恒定计时税**与将来若有人把阈值分支改成无条件 debug 日志；
2. **丢帧 warn 无聚合**：洪峰时若每 tick flush 前有多批 Soft 丢弃，**每次 enqueue 丢帧都可能 warn**（：649-655 在 emit 内，不在 flush 聚合点）。对照 P3 的 20 万 delta 场景：若调用方持续灌入且不过 flush，warn 次数与丢帧次数同阶 → 日志 IO 放大，与「常态零日志」意图相悖。

**影响量化**：

- 静态分析：高丢帧场景下 warn 频次 = O(丢帧次数) 而非 O(1)/O(轮次)；
- 计时税：每信封多 2 次时钟读；token 逐条 emit（03 R1）被修复前，万级 delta 的 run 会付万级计时——量级仍小于 JSON 序列化本身（序列化才是热路径主体）。

**修复方案**：

1. 丢帧 warn **移到 flush 聚合点**（与 EmitReport.dropped 汇总一致），或按 run_id 做「首次 + 每 N 条 + 终态汇总」限速；
2. 计时可保留；若将来上 `trace` 级字段，用 `#[cfg(feature = "perf-instrumentation")]` 或采样（1/1000）避免无条件 Instant；
3. EmitReport 已有 `add` 合并（`core_event_bridge.rs:38-45`）——flush 侧 `report.dropped > 0` 单次 warn 即可。

**回归锚点**：

- 单测：洪峰 enqueue 丢帧时 **warn 次数上限**（tracing-test cap）≤ 每 flush 1 次；
- `EmitReport.dropped` 合并语义测试已有（`core_event_bridge.rs:332-346`）——扩展覆盖 flush 路径。

**严重度判定**：**中**——慢序列化告警本身设计正确（正面 B3）；丢帧 warn 放大是可观测性自身的性能风险，值得收紧。

---

#### P5.【中】unified diff 双实现：Rust `parse_unified_diff` 与 JS `parseUnifiedDiffs` 语义漂移风险

**位置**：

- Rust：`perf/diff.rs:99-247`（`parse_unified_diff`）、`parse_diff_truncated`（:270-289）；
- 壳接线：`core_commands.rs:438-448` `core_parse_diff`；
- JS：`toolFeedbackDiff.ts:126-430` `parseUnifiedDiffs`；
- 前端选择：`api-adapters.ts:199+` 优先 `core_parse_diff`，失败回退 JS；`rustCore.ts:250` 注明「parseDiff 返回 shape 对齐 Rust 标准，与 JS 旧 shape 不兼容」。

**调用链**：

- Diff 卡片 / 工具反馈：`toolUtils.ts:147` / `gitApi.diff.ts:32` **仍直调 JS** `parseUnifiedDiffs`；
- Worker 路径：`compute-worker.ts:9` → Rust。

即：**同一产品内两条 diff 解析路径并存**，且 UI 主路径未必走 Rust。

**根因**：PE-03 把解析下沉 Rust（spawn_blocking、防主线程卡顿），但 chat-bridge / gitApi 历史 JS 解析未强制迁移；Rust 侧还有 `max_lines` 截断与 hunk 行号语义，JS 侧有目录列表拦截 + changes 截 400 行——**功能面本就不对齐**。

**影响量化**：

- 重复维护：bugfix 可能只落一侧（例如 NoNewline、rename 状态）；
- 性能：JS 主路径大 diff 仍在渲染线程风险面（01/02 方向已覆盖重渲染，本方向记交叉）；
- 前端 bench `diff.parse.10k`（bench-definitions.ts:216+）测的是 JS StreamingDiffParser，**不覆盖** Rust `parse_unified_diff`。

**修复方案**：

1. 产品裁决「结构化 diff 真源 = Rust」：chat-bridge / gitApi 迁 `parseDiffWorker`，JS 仅保留无 IPC 环境的降级；
2. 共享 fixture（同一输入 → 双端输出 diff 测试）钉住语义；
3. Rust 侧补 criterion `diff.parse.10k`（对齐现有 bench 名）。

**回归锚点**：

- 契约测试：`core_parse_diff` 与 `parseUnifiedDiffs` 在固定 corpus 上 files/hunks/stats 一致（或显式登记差异表）；
- 禁止新增对 JS 解析的静态 import（lint 或 knip）。

**严重度判定**：**中**——正确性与性能双风险；不阻塞启动，但腐蚀「perf 资产一次建设、全链复用」的价值。

---

#### P6.【中】`perf::jsonl` 死资产 vs `core_messages_to_jsonl` 独立实现（重复轮子）

**位置**：

- `perf/jsonl.rs:1-5,14-16`：`perf_jsonl_*` 命令已删，`read_jsonl`/`write_jsonl` 仅测试；
- `core_commands.rs:451-467`：`core_messages_to_jsonl` 自建 serde 循环，**不调用** `perf::jsonl`；
- `core_commands.rs:475+`：`core_jsonl_to_messages` 同样自建。

**代码现场**（生产路径）：

```rust
// core_messages_to_jsonl：不落盘、不复用 perf::jsonl
let mut buf = String::with_capacity(messages.len() * 256);
for msg in &messages {
    let line = serde_json::to_string(msg)…;
    buf.push_str(&line);
    buf.push('\n');
}
```

**根因**：PE-03 将 perf_jsonl 命令删除时，生产需要的是「内存字符串 JSONL」（替代 io-worker），与 perf::jsonl「文件读写」目标不同——**复制合理但未在文件头记「已分流」**；perf::jsonl 变成纯测试资产占 267 行。

**影响量化**：

- 无运行时重复调用（生产不走双份）；
- 维护成本：两套 JSONL 语义（注释行/空行跳过、parse_errors）只在测试路径存在，生产 `core_jsonl_to_messages` 是否同语义需对照（core_commands.rs:475+ 内联实现）；
- 若未来 core 面需要「读大 jsonl 文件」，会再抄第三份或复活 perf::jsonl——SSOT 风险。

**修复方案**：

1. 短期：文件头注释改为「已由 core_* 分流；本模块仅当 core 需要落盘 IO 时复用」；对齐生产与测试的坏行策略；
2. 中期：`core_jsonl_to_messages` 改为委托 `perf::jsonl::read_jsonl`（或抽 crate 级 util），消灭第三分叉；
3. 长期：若确认永不落盘，删除 jsonl.rs 测试面或迁 `conex-fs` 命名（避免 `perf/` 误导）。

**回归锚点**：

- `cargo test -p crish-agent-workbench jsonl` 与 core 单测坏行用例一致；
- 若委托：字节级 roundtrip 测试。

**严重度判定**：**中**（偏低）——无热路径放大，但是「perf 资产目录」治理与 06/10 IO 域交叉的明确债。

---

#### P7.【中】`perf/fs.rs` mmap `read_chunk` 零消费（交叉 06 PF01）

**位置**：`perf/fs.rs:1-10,48-97`；06 报告 PF01（`06-文件IO与搜索审查报告.md:866-874`）

**代码现场**：

```rust
//! 性能工具 - 文件系统：分块读取 / 文件信息。
//! …
//! - `read_chunk` / `file_info` 保留为测试直接覆盖的核心实现…
//!   等待 core_* 命令面迁移时复用。
if read_size >= 65536 {
    // SAFETY: Mmap::map … 只读映射
    let mmap = unsafe { Mmap::map(&file)… };
    data.copy_from_slice(&mmap[offset as usize..end]);
}
```

**调用链**：测试 `read_chunk_large_uses_mmap`（:187-198）覆盖 ≥64KB 分支；生产无 `core_fs_read_chunk` 注册（main.rs 命令面无此名）。

**根因**：PE-03 删 perf_fs_* 后等待「core_fs 域迁移」；06 方向 FS02/FE01（预览 20000 行整包 IPC）**未**把分块读列为已落地路径——两方向都在等对方。

**影响量化**：

- 大文件预览仍整包：IPC 体积与二次分配（06 FS02）无解；
- mmap 资产（含 SAFETY 注释与测试）维护中但零收益；
- 与 10 工具 `read_file` 整文件读入（10 T2）同构问题——三处「大文件读」都未吃到该资产。

**修复方案**：

1. 06 批次 S / core_fs：注册 `core_fs_read_chunk`（spawn_blocking）+ 预览协议改 offset/size 分页；
2. 预览默认从 20000 行整包改为窗口读，显式「加载更多」；
3. 接线后保留 mmap 阈值 64KB；补充非 mmap 小文件路径测试已有。

**回归锚点**：

- 命令清单测试含 `core_fs_read_chunk`；
- 预览 IPC 契约测试：默认响应含 `isEof`/`size` 字段；
- 06 PF01 状态改「已评估并接线/已裁决不接线+删除」。

**严重度判定**：**中**——正确性无虞，资产闲置与大文件路径税交叉；决策权在 06/core_fs，本方向负责钉死「未接线」事实。

---

#### P8.【中】criterion 集群不覆盖 perf/ 域；EventBuffer 亦无 criterion 仅有 ignore stress

**位置**：现有 criterion：

| crate | benches | 文件 |
| ----- | ------- | ---- |
| session-loop | tool_batch, request_build | `crates/session-loop/benches/` |
| orchestrator | event_chain | `crates/orchestrator/benches/event_chain.rs` |
| conex-db | db_write | `crates/conex-db/benches/db_write.rs` |
| agent-provider | sse_parse | `crates/agent-provider/benches/sse_parse.rs` |

**盲区**（本方向直接对象）：

- `perf::diff::parse_unified_diff`（纯函数，理想 bench 对象）；
- `perf::encoding::detect_encoding` / `decode_to_utf8`（大 buffer + chardetng）；
- `perf::hash::sha256_compute`（已有大数组单测 2MB，无吞吐 bench）；
- `perf::jsonl` / `core_messages_to_jsonl`（10k messages 序列化）；
- `EventBuffer::enqueue/drain`（相对 criterion，与 P3 二选一或互补）。

**根因**：PE-09 T09.7 落地 crates/*/benches 时，src-tauri 的 perf 模块被当作「工具库」而非「热路径库」；实际 `core_parse_diff`/`core_hash_compute` 在 UI 大 diff/大文件场景会被调用。

**影响量化**：

- perf 域回归（如 diff 行号计算 O(n²) 回潮——见 `count_additions` 对 `&hunk.lines` 每行 O(n) 扫描，`diff.rs:191,199,212,249-268`）**无基线**；
- 注意：diff.rs 内 `count_additions` 每 push 一次全量 filter——**O(n²) 行号计算**（中危性能债，登记为 P9 关联发现，见下）。

**修复方案**：

1. 新增 `apps/agent-workbench` 或抽 `conex-perf` crate 后：`benches/diff_parse.rs`、`benches/jsonl.rs`；
2. ci-slow 已跑 `cargo bench --workspace`——新 bench 自动生效；
3. 优先修 P9 O(n²) 后再冻基线。

**回归锚点**：

- `cargo bench --workspace` 出现 diff/jsonl 分组；
- `ci-slow.yml:78-79` 无改动即可纳入。

**严重度判定**：**中**——覆盖盲区；与 P9 合并看则优先修算法再补 bench。

---

#### P9.【低】`perf/diff.rs` 行号计算 O(n²)：每行 push 全量 `filter().count()`

**位置**：`perf/diff.rs:186-218,249-268`

**代码现场**：

```rust
hunk.lines.push(DiffLine {
    // …
    new_lineno: Some(hunk.new_start + count_additions(&hunk.lines)),
});
// …
fn count_additions(lines: &[DiffLine]) -> u64 {
    lines.iter().filter(|l| matches!(l.kind, DiffLineKind::Addition)).count() as u64
}
```

**调用链**：hunk 内每行 → O(当前行数) 扫描 → O(hunk²)；大 diff 有 `max_lines` 默认 10000（:271）→ 最坏 ~10^8 量级操作（仍在 spawn_blocking，不卡 UI，但占 CPU）。

**根因**：实现取「随时可数」的简单正确性，未维护 running counter。

**影响量化**：

- 10k 行单 hunk：~10k²/2 次 filter → 明显 CPU；
- 有 `max_lines` 截断，实际产物通常多文件多 hunk，单 hunk 行数有限——**非致命**，但属可 O(1) 修正。

**修复方案**：维护 `additions_so_far` / `deletions_so_far` / `context_so_far` 三计数器，push 时 O(1)。

**回归锚点**：现有单测（:303-373）行号断言保持绿；新增大 hunk 单测（1k 行）时间上界（debug 可选）。

**严重度判定**：**低**——受截断保护；修完再上 criterion 基线（P8）。

---

#### P10.【低】`encoding::detect_encoding` 对整段 `data` 无采样上限；`decode` 整段 into_owned

**位置**：`perf/encoding.rs:18-38,72-83,90-105`

**代码现场**：

```rust
let mut detector = EncodingDetector::new();
detector.feed(data, true); // 全量 feed
// …
let (cow, _encoding_used, _had_errors) = encoding.decode(data);
Ok(cow.into_owned()) // 无条件拥有拷贝
```

**调用链**：`core_detect_encoding(data: Vec<u8>)` / `core_decode_text`（core_commands.rs:410-434，spawn_blocking）——调用方若传整文件字节，探测与解码均 O(n) 全量。

**根因**：正确性优先（chardetng 建议足够前缀）；未做「前 64KB 探测 + 全量解码」策略。

**影响量化**：

- 静态：chardetng 对超长输入成本随 n 增长；解码 `into_owned` 额外一份 String；
- 与 06 FE01 大文件预览交叉：若预览路径先 detect 整文件再截断行，会白付全量探测。

**修复方案**：

1. detect：`&data[..data.len().min(64 * 1024)]`（或 chardetng 推荐窗口）；
2. decode：Cow 保留 `Borrowed` 避免无条件 `into_owned`（需命令边界 `String` 时再 to_owned，仅 borrowed 原样零拷贝场景除外——命令返回 String 仍可能拷一次，至少 detect 采样值得做）。

**回归锚点**：编码单测（:127-231）全绿；新增 1MB ASCII detect 测试（正确性 + 可选时间上界）。

**严重度判定**：**低**——有 spawn_blocking；大文件路径依赖 06 预览是否整包喂入。

---

#### P11.【低】BOM 表手写 14 条与 encoding_rs 能力重叠

**位置**：`perf/encoding.rs:41-65`

**调用链**：`detect_encoding` 先查 BOM_SIGS，未命中才 chardetng；`decode` 再用 `Encoding::for_label` + `encoding.decode`（库内亦处理 BOM）。

**根因**：显式 `has_bom` 字段产品需求 + 罕见 BOM（UTF-7/BOCU-1 等）覆盖。

**影响量化**：

- 逻辑重复面小：库内 decode 与手写 detect 分工不同（一个出标签/置信度，一个出文本）；
- 风险：表维护漂移（新增 BOM 只改一侧）——概率低。

**修复方案**：保留手写 detect（产品字段需要）；表项加测试向量即可，不必强行删。可在注释交叉引用 encoding_rs BOM 文档。

**回归锚点**：现有 BOM 单测（:132-146）。

**严重度判定**：**低**——更偏代码卫生。

---

#### P12.【低】check:store-writes 单行正则的跨行漏报与 dev-only 误报

**位置**：`scripts/check-no-raw-setstate.mjs:27-29,76-86`

**代码现场**：

```js
const STORE_SETSTATE_RE = /use\w*Store\.setState\s*\(/g;
// 逐行：
if (!STORE_SETSTATE_RE.test(line)) continue;
if (trimmed.startsWith('if (import.meta.env?.DEV') || trimmed.startsWith('if (import.meta.env.DEV')) continue;
```

**根因**：文本级门禁（非 AST）成本低；跨行 setState 与多行 dev 守卫不在语法分析范围。

**影响量化**：

- 漏报：`useLayoutStore\n  .setState(` 极低频风格；
- 误报：`if (import.meta.env.DEV\n  && cond) useXStore.setState(` 会 FAIL——**误报打断 CI**，属可用性缺陷；
- 白名单整目录 `store/` 豁免：设计使然，store 内 setState 不计——与「单一写入通道」目标一致。

**修复方案**：

1. 误报：对「上一行以 `if (` 且含 `import.meta.env` 开头」的下一行也豁免（行窥）；或要求 DEV 包裹写在同一行（文档化）；
2. 漏报：strip 空白后用「文件全文」正则一次匹配 + 行号回溯（避免 g 状态与跨行）。

**回归锚点**：夹具文件：跨行 setState 应 FAIL；多行 DEV 守卫应 PASS。

**严重度判定**：**低**——现行主路径单行 `setState(` 已被清零（ci 绿），属加固。

---

#### P13.【低】check-line-counts 跳过整个 `__tests__` 目录；`.mjs` 门禁脚本不计入

**位置**：`scripts/check-line-counts.mjs:128-151`

```js
if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === '__tests__') continue;
```

**根因**：测试不算生产行数——合理；但 `__tests__` 大型 harness（如 reRenderMonitoring 502 行）与 `*.test.tsx` 并列时，**vitest 文件后缀会排除、`__tests__` 目录整棵不扫**——一致。

**影响量化**：对生产 UI/业务上限无直接影响；测试债不进 ratchet。

**修复方案**：可选「测试文件 >800 行」软警告（非本方向必做）；.mjs 保持不计。

**回归锚点**：`--update` 基线文件与 `--all` 行为文档一致。

**严重度判定**：**低**。

---

#### P14.【低】check-dist 与 check-startup-budget 体积真源重叠，口径漂移风险

**位置**：

- `check-dist.mjs:8,74-80`：主入口 < `--max-app-kb`（CI 固定 500）；
- `check-startup-budget.mjs:43-44,221-266`：entry 软预算 520 KiB warning。

**调用链**：CI 只跑 check-dist；startup-budget 手跑——当前不冲突，但一旦 P2 接线，将出现 **同一 entry 两套阈值（500 hard vs 520 soft）** 与两套清单输出。

**修复方案**：接线时明确：CI hard 以 check-dist 500 为准；startup-budget 专注**静态图**与多入口；或合并为单脚本 `--entry-kb --static-kb`。

**回归锚点**：文档 + CI 注释写明真源；避免「两脚本都绿但用户仍慢」。

**严重度判定**：**低**（接线后升为中，纳入 P2 批次一并处理）。

---

## 三、域 B：正面发现（禁止回潮）

#### B1. PE-03 命令降级路径完整

`core_*` 统一 `spawn_blocking` + `CoreError`（core_commands.rs:361-448）；前端 api-adapters 显式「Rust 优先、JS 回退」并带测试（api-adapters.test.ts mockMissing 路径）。**回潮禁令**：禁止再注册同步 `perf_*` 大包命令到主线程。

#### B2. 慢序列化条件告警样板正确

`SLOW_EVENT_SERIALIZE_WARN_MS=10` 仅超阈值 warn（engine_channels.rs:537-553）；测试覆盖超阈/低于阈值（engine_tests.rs:3677-3792）。**回潮禁令**：禁止无条件 `tracing::debug` 逐 token 事件。

#### B3. EmitReport 三计数 + add 合并 + 毒化恢复

`core_event_bridge.rs:29-45`；buffer 锁中毒 `into_inner` 恢复且丢帧语义不变（engine_channels.rs:636-644）+ `POISON_RECOVERIES` 原子计数。**回潮禁令**：禁止丢帧静默。

#### B4. EventBuffer 压测断言质量高

Critical 必达 / Soft 软水位 / 跨 flush 终态（buffer.rs:361-456）——语义与 03/04 背压模型一致。补接线（P3）后成为一等回归资产。

#### B5. telemetry 双通道降级安全

文件层失败 → 仅 stderr 并返回 false，不阻启动（subscriber.rs:64-81,98-106）；panic_hook 结构化 + stderr 兜底（conex-telemetry/src/panic_hook.rs）。**回潮禁令**：禁止日志 IO 失败 abort 应用。

#### B6. 行数门禁三级 + 基线 ratchet 成熟

check-line-counts 85%/100%/650 硬阻断 + per-file 基线 + `--update` 显式维护（check-line-counts.mjs:1-16,160-168）；已进 ci.yml:75。

#### B7. store-writes 与快照桥注入点双防线

raw setState 清零 + `bindMessageSnapshotsOps` 存在性断言（check-no-raw-setstate.mjs:89-98）；CI lint job 接线（ci.yml:63-66）。

#### B8. reRenderMonitoring 隔离断言资产

`reRenderMonitoring.test.tsx`：无关 store 更新 0 extra re-render、流式稳定块 0 重渲染探针（:1-99）——防 01/02 方向 memo 击穿回潮的单测锚点。

#### B9. criterion 已进 ci-slow 且带吞吐/备注

`ci-slow.yml:74-79`；event_chain 注明 criterion 计时失真 50×（event_chain.rs:174）——有方法论自觉。

---

## 四、域 C：与既有方向交叉引用

| 本方向发现 | 交叉方向 | 关系 |
| ---------- | -------- | ---- |
| P1, P2, P14 | **07 A1/A2** | A2 门禁失灵的脚本级深化 + CI 接线缺口；A1 静态边修复后需 P1 阈值冻结 |
| P7 | **06 PF01, FS02, FE01** | mmap read_chunk 未接线；预览整包 IPC 三处同构 |
| P9, P10 | **06 SR02, 10 T2** | 大文件读/解码全量成本 |
| P5 | **02 Diff 卡片, 03 IPC** | JS 主路径大 diff；Rust 路径未统一 |
| P4 | **03 R1 token 逐条 emit, 04 S 流收口** | 高事件率放大计时/日志税；丢帧语义本身 04 已审 |
| P3, P8 | **03/04 背压与热路径** | 压测/基线对修复批次 K–S 的回归保护 |
| B2, B3 | **04 审计通道/丢帧可观测** | 同一套 EmitReport 样板 |
| B6, B7 | **门禁治理（附录 B）** | 与 store-facade/input-guard 同类资产 |
| P6 | **10 工具输出 JSONL, 06 IO** | jsonl SSOT |

---

## 五、缺失的性能回归门禁提案（不实现，只列）

> 与素材 §6 一致；按「接线成本 × 拦截力」逻辑排序（非业务优先级）。

| # | 提案 | 依赖 | 断言形态 |
| - | ---- | ---- | -------- |
| G1 | 静态图总和进 check-startup-budget + CI | 07 A1 进度 / 基线 | soft 900 / hard 1200 KiB（待冻） |
| G2 | check-startup-budget 纳入 ci.yml frontend-build | G1 同 PR | exit code |
| G3 | EventBuffer stress 进 ci-slow | P3 | Critical 必达 + 可选吞吐 notice |
| G4 | flush 丢帧 warn 聚合限速的 cap 断言 | P4 | tracing-test warn 次数 |
| G5 | Rust diff/jsonl/encoding criterion 基线 | P9 修后 | ci-slow + baseline compare（仿 compare-benchmarks.ts） |
| G6 | 双 diff 解析器 corpus 一致性 | P5 产品裁决 | fixture 快照 |
| G7 | store-writes 多行 DEV 豁免 + 全文跨行检测 | P12 | 夹具单测 |
| G8 | 生产包 TTI 冒烟（startup runner + 阈值） | 运行时 V 项 | 测量脚本 exit |
| G9 | 流式 p95 帧间隔（stress-ai-stream） | 01 修复批次 | 阈值 |
| G10 | EmitReport.dropped 计数器导出到 core_get_status/诊断 | 03/15 | 单元 + IPC 契约 |
| G11 | check-dist ↔ startup-budget 真源合并 | P2 | 单脚本多模式 |
| G12 | `perf/` 目录 dead 代码门禁（cfg(test) 外 allow(dead_code) 与「待迁移」注释一致性） | PE-03 收尾 | 注释/属性扫描（可选，防第三分叉） |

---

## 六、修复路线图（逻辑依赖，不谈工期）

### 批次 W · 门禁止血（依赖少，先做）

| 项 | 内容 | 对应发现 |
| -- | ---- | -------- |
| W1 | startup-budget：totalBytes 进 warning/strict errors | P1 |
| W2 | ci.yml + check:desktop 接线 startup-budget | P2 |
| W3 | 与 check-dist 真源注释/合并策略 | P14 |
| W4 | store-writes 多行 DEV/跨行加固 | P12 |

### 批次 X · 观测自身降税

| 项 | 内容 | 对应发现 |
| -- | ---- | -------- |
| X1 | 丢帧 warn 迁 flush 聚合或限速 | P4 |
| X2 | diff 行号 O(1) 计数器 | P9 |
| X3 | encoding detect 采样上限 | P10 |

### 批次 Y · 资产接线

| 项 | 内容 | 对应发现 |
| -- | ---- | -------- |
| Y1 | EventBuffer stress → ci-slow | P3 |
| Y2 | diff/jsonl criterion + 基线 | P8, P9 |
| Y3 | read_chunk / 预览分页（联动 06 批次 S） | P7 |
| Y4 | JS/Rust diff 收敛裁决 | P5 |
| Y5 | jsonl SSOT（core 委托或删测试面） | P6 |

### 批次 Z · 运行时验证回填

| 项 | 内容 |
| -- | ---- |
| Z1 | 生产包冷启动 TTI（07 V 项同轨） |
| Z2 | 洪峰下 tracing 文件体积 / warn 频次（P4 实证） |
| Z3 | stress_ 事件/秒基线数值冻结 |

**性价比最高**：**批次 W**（纯门禁接线，立即恢复 07 A2 类回归的拦截力）；次为 **X2+Y2**（低风险算法修正 + 基线）。

---

## 七、运行时验证建议（静态结论，待实测）

| ID | 项 | 方法 |
| -- | ---- | ---- |
| V1 | 静态图合计真实值 | 生产 `build` + `node scripts/check-startup-budget.mjs` |
| V2 | 丢帧 warn 频次 | release 下 replay P3 洪峰，计 `event_bridge` warn 行数 |
| V3 | 每信封 Instant 税占比 | criterion 对比「计时开关」分支（临时 feature） |
| V4 | diff 10k 行 hunk 修复前后耗时 | `cargo bench` 临时 bin 或 #[ignore] test |
| V5 | chardetng 1MB detect 耗时 | 同上 |
| V6 | EventBuffer 20 万事件/秒 | 已有 stress stdout |
| V7 | Tauri MCP 生产包 TTI | 与 07 V1–V7 同轨 |

---

## 八、八要素对照表（发现汇总）

| 代号 | 标题 | 位置 | 严重度 |
| ---- | ---- | ---- | ------ |
| P1 | 静态图不 fail | check-startup-budget.mjs:221-266 | 高 |
| P2 | 门禁未接 CI/desktop | package.json + ci.yml:120-135 | 高 |
| P3 | 20 万 stress 不进 CI | buffer.rs:349-456 | 中 |
| P4 | 每信封计时 + 丢帧 warn 无聚合 | engine_channels.rs:537-656 | 中 |
| P5 | 双 diff 解析器 | perf/diff.rs vs toolFeedbackDiff.ts | 中 |
| P6 | jsonl 重复/死资产 | perf/jsonl.rs vs core_commands.rs:451+ | 中 |
| P7 | mmap read_chunk 零消费 | perf/fs.rs:1-97 · 06 PF01 | 中 |
| P8 | criterion 未盖 perf 域 | crates/*/benches | 中 |
| P9 | diff 行号 O(n²) | perf/diff.rs:186-268 | 低 |
| P10 | detect 全量 feed/decode 拷贝 | perf/encoding.rs:18-83 | 低 |
| P11 | BOM 表重叠 | perf/encoding.rs:41-65 | 低 |
| P12 | store-writes 行正则缺陷 | check-no-raw-setstate.mjs:27-86 | 低 |
| P13 | line-counts 目录跳过 | check-line-counts.mjs:140 | 低 |
| P14 | 双体积脚本漂移 | check-dist vs startup-budget | 低 |

---

## 九、验收与总纲回写建议

- 本方向静态完成；**总纲**方向 16 状态建议改「✅ 静态完成（V 项待回填）」；
- 发现编号 P* 供 90-发现清单索引合并；
- 与 07 协同：P1/P2 修复后回写 07 A2 交叉栏；
- 与 06 协同：PF01 状态在 Y3 落地时更新。

### 9.a 交叉验证记录

- 本报告不执行 `git commit`（任务约束）；
- 未跑运行时 Tauri/生产构建实测（V 项）；
- 脚本行号以 2026-09-13 工作区为准；
- 07 报告 dist 实测数字（entry 497.4 / 静态图 1709 KiB）为交叉引用，非本方向复测。

---

## 附录 · 关键路径速查

| 资产 | 路径 |
| ---- | ---- |
| perf 模块 | `apps/agent-workbench/src-tauri/src/perf/` |
| core 接线 | `apps/agent-workbench/src-tauri/src/core_commands.rs` |
| 命令注册 | `apps/agent-workbench/src-tauri/src/main.rs:386-394` |
| EventBuffer stress | `apps/agent-workbench/src-tauri/src/buffer.rs:349-456` |
| EmitReport | `apps/agent-workbench/src-tauri/src/core_event_bridge.rs:29-45` |
| 慢序列化告警 | `apps/agent-workbench/src-tauri/src/engine_channels.rs:537-553` |
| telemetry subscriber | `crates/conex-telemetry/src/subscriber.rs` |
| startup-budget | `scripts/check-startup-budget.mjs` |
| check-dist | `scripts/check-dist.mjs` |
| line-counts | `scripts/check-line-counts.mjs` |
| store-writes | `scripts/check-no-raw-setstate.mjs` |
| reRenderMonitoring | `apps/crish-desktop/src/__tests__/reRenderMonitoring.test.tsx` |
| TS bench | `packages/shared-utils/src/bench/` |
| CI 快层 | `.github/workflows/ci.yml` |
| CI 慢层 bench | `.github/workflows/ci-slow.yml:68-81` |
| perf-test | `.github/workflows/perf-test.yml` |
| 07 报告 A2 | `docs/performance-audit/07-启动链路性能审查报告.md:133-150` |
| 06 报告 PF01 | `docs/performance-audit/06-文件IO与搜索审查报告.md:866-874` |
