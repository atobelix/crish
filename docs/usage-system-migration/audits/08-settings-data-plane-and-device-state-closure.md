# 设置 · 用量与多端互通数据面闭环审计（2026-10-27）

> **性质**：事故复核 + 系统性修复记录（非一次性补丁清单）
> **触发**：用户反馈「设置界面的用量和多端互通现在有问题」
> **验证口径**：真实 Tauri 宿主（4000 MCP）现场复现 → 修复 → 再验收；单测与门禁为防回潮

---

## 一、现场复现与根因

### 1.1 用量页整页崩溃（错误边界接管）

- 现场：打开 `设置 · 用量` 立即显示错误卡片：
  `You have rendered a 'motion' component within a 'LazyMotion' component...`
- 栈顶组件：`<ForwardRef(motion.span)>`（`SlotText`）。
- 根因：全局 `AppMotionProvider` 使用 `<LazyMotion features={domAnimation} strict>`，但生产代码仍有 8 个文件使用 `motion.*` JSX（SlotText / AnimatedCounter / ToastCard / ColorPicker 系列 / TextMorph）。strict 模式下 Motion 直接抛错。

### 1.2 多端互通：开服务打崩整个应用

- 现场：`多端互通 → 开启服务` 成功后弹 Toast → 整个应用白屏（`body.innerText` 为空）。
- 根因：`ToastCard` 使用 `motion.*`，与 1.1 同一根因；Toast 由全局 Provider 渲染，错误冒泡到根错误边界。
- 次生问题：`serviceEnabled` 只保存在组件本地 state；切到「账户」再切回「多端互通」后，服务仍在监听（8765 实测）但页面显示「服务未开启」。后端 `PairStatus` 未暴露服务开关真值。

### 1.3 用量数据永远为空（双轨账本）

- 现场：30 日范围仪表盘全 0；DB `usage_records` 无记录。
- 根因链：
  1. 前端遥测只把历史流水写入 localStorage（`crish_usage_history_v1`），**从不写 DB**；
  2. Rust 设计文档 §3.2 的「主轨：内核收口直写」**从未实现**（`save_run_usage` 只写 runs 表 v5，不写 `usage_records`）；
  3. 设置页只读 DB → 永远为空；
  4. 旧账本迁移器（`usage_import_legacy_snapshot`）**无任何调用点**。
- 影响面：不仅桌面 US，手机端 / 定时任务发起的 run 也不会有历史流水。

---

## 二、系统性修复

### 2.1 动效 single-track（8 文件）

`motion.*` → `m.*`：`ToastCard` / `AnimatedCounter` / `SlotText` / `ColorPicker` / `ColorPickerArea` / `ColorPickerContrast` / `ColorPickerSlider` / `TextMorph`。

### 2.2 用量主轨落地（Rust 内核）

- `conex-run::write_back_cache_stats`（run 收口）新增 `usage_records` 写入：
  - model / provider 取引擎生效配置；pricing 经 `live_model_pricing` 唯一算费入口；
  - 费用：CNY 原值，USD 按 7.25 折算 CNY（与 legacy 导入口径一致，仪表盘只汇总 `cost_cny`）；
  - project_name = cwd 末段（`ActiveRun.project_name`，构造时计算）；
  - **run 级幂等**：`usage_record_exists_for_run` 守卫，收口重入不重复计费。
- 前端遥测回归「只维护 settings 当前值」，不再写 localStorage / IPC（旧 `usageStore` 物理删除）。
- 旧账本迁移：`api/usage/legacyUsageMigration.ts` 启动期 idle 执行，幂等（后端 `session_meta.legacy_usage_migrated_v10` + 前端标记），成功后删除旧键。

### 2.3 多端服务状态真值

- `PairStatus` 新增 `service_enabled`，由 `multi_device_pair_status` 命令从 `MultiDeviceService` 回填；
- 前端 reducer 在 `setStatus` 时同步 `serviceEnabled`（乐观更新仍保留，下一次轮询被真值覆盖）。

---

## 三、防回潮门禁

| 门禁 | 覆盖 | 接线 |
| :--- | :--- | :--- |
| `npm run check:motion-strict` | 禁 `motion.*` / `motion.create` / `framer-motion` | `check:desktop` + CI desktop-guards |
| `npm run check:usage-ssot` | 禁旧 localStorage 账本与 `usageStore` 复活（迁移模块白名单） | `check:desktop` + CI desktop-guards |
| `AppMotionStrictUsageSurfaces.test.tsx` | 运行时：用量概览 + ToastCard 在 strict Provider 下可渲染 | vitest unit |
| `legacyUsageMigration.test.ts` | 迁移幂等 / 失败重试 / 损坏数据 | vitest unit |
| `write_back_cache_stats_persists_run_usage_to_local_db` | 主轨落库 + project/费用 + 重入幂等 | cargo test |

两条门禁均做过注入自检（夹具注入 → 期望 exit 1）。

---

## 四、真机验收记录（4000 Tauri MCP）

1. 用量页：修复前整页错误边界；修复后正常渲染。迁移执行后 30 日范围显示 `18 tokens / legacy-aggregated / 1 条消息`（旧账本 18 tokens 已入库且旧键删除）。
2. 多端互通：开启服务 → Toast 正常、UI 显示「服务运行中」、`127.0.0.1:8765` 监听；切到「账户」再返回 → 仍显示「服务运行中」（后端真值）；开启局域网配对 → 二维码 + 倒计时 + 网络环境卡片正常；关闭配对 → 回到未配对；关闭服务 → 无监听、UI 回到未开启。全程无白屏。

---

## 五、附带修复（阻塞验证的基础设施债务）

`cargo test -p conex-run --lib` 测试目标此前 **215 个编译错误**（`Duration` 缺失、`now_millis` 改名、`SubagentRunConfig.permission_mode`、`RunOutcome.yield_payload`、`ApprovalGateImpl.pending`、私有 `RunStatus`、测试辅助函数改名等），内核测试整体无法运行。本次按机械语义逐项修复至 0 error，主轨单测因此可执行。

测试跑通后又暴露 4 个此前不可见的失败，其中 3 个已修：

1. **子代理提示词缺「权限申请指引」段**（生产回归）：`run_launch.rs` 注入器漏挂 `permission_relay_injection`——子代理将不知道需要发起权限申请。已补挂，`run_subagent_end_to_end…` 恢复通过。
2. **死锁防护测试断言过严**：生产对「转用户」显式标注 `arbiter="user"`，测试只接受字段缺省。已把断言改为「不得为 main-agent」（对齐 DTO 契约）。
3. **空转护栏 off-by-one**：`run_core` 文档写「**超** `IDLE_RESUME_MAX_EMPTY_ROUNDS` 停止」，实现用 `>=`（少允许一轮）。已改为 `>`，与验收测试一致。

**仍红（已登记，非本战役域）**：`run::tests::watcher_wakes_sleeping_ai_after_timer_expiry_e2e` —— 唤醒链实际触发 4 轮（期望 3），且收束耗时在 3s~22s 间抖动，指向 watcher tick 与 idle-resume 收口之间的竞态；需独立任务从 watcher 周期与队列 drain 时序入手，本轮不掩盖（未 `#[ignore]`）。

---

*关联：AGENTS.md §22（动效 strict 与数据面单一真源铁律）；`docs/usage-system-migration/00-…` §3.2 实现状态。*
