# 26-联调报告-MVP真实链路

- 任务：A1 —— 软件内 AI 协同浏览器 MVP e2e 真实浏览器集成验证（Chrome/Edge，CfT 实测可用）
- 日期：2026-08-09
- 范围：`crates/conex-browser/`（src/ 与 tests/ 均属本 Agent 文件域）
- 测试资产：`crates/conex-browser/tests/e2e_browser.rs`（新增，`#[ignore]` + `--test-threads=1` 串行）
- 运行命令：
  ```text
  cargo test -p conex-browser --test e2e_browser -- --ignored --test-threads=1
  ```

---

## 1. 环境

| 项 | 值 |
|---|---|
| 浏览器 | 系统 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`） |
| 版本 | Chrome/151.0.7922.72（Browser.getVersion 实测） |
| 发现来源 | `BrowserManager.start` → `resolve_backend` Auto 回退链（本机无 CfT 缓存，落系统 Chrome；CfT 缓存目录优先逻辑未实测，属维度 10 e2e E2 范畴） |
| 启动模式 | headless=new（LaunchConfig 默认） |
| 测试页 | data: URL（UTF-8 百分号编码内联 HTML，含中文输入框占位/中文按钮/结果区；无 fixture server） |
| 平台 | Windows（Job Object 杀树 + taskkill 兜底） |

---

## 2. 逐用例结果

| # | 用例 | 结果 | 耗时 | 说明 |
|---|---|---|---|---|
| E1 | e2e_launch_and_connect | ✅ 通过 | 启动 ~1.1s / 连接 ~0.6s | start → connect_session → Browser.getVersion 身份校验 → current_session 就绪 |
| E2 | e2e_navigate_and_snapshot | ✅ 通过（修复后） | 快照 6ms | navigate 本地页 → capture → 快照含中文按钮/输入框、索引可解析 |
| E3 | e2e_click_and_type | ✅ 通过（修复后） | type 4ms / click 18ms | 中文+英文 type_text → Runtime.evaluate 回读断言 → 按索引 click → DOM 断言 |
| E4 | e2e_version_advance_on_action | ✅ 通过（修复后） | — | 动作后 snapshot_version +1、旧版本 Stale、重拍后有效 |
| E5 | e2e_clean_stop | ✅ 通过（修复后） | 停止 228ms | Browser.close → 进程自然退出 → Stopped、force_killed=false、profile 清理 |

**首轮实测 0/5 通过**（全部失败），经 5 处修复后 5/5 通过。每个失败均为真实浏览器暴露的架构/协议缺陷，mock 单测面全部未覆盖（详见 §3）。

---

## 3. 发现的问题与修复（含根因与回归测试）

### 问题 1（E1 失败根因）：恢复流程事件全部丢失 → 活动标签永不就绪

- **现象**：`BrowserSession::connect` 成功，但 `current_session()` 永远 `Err(NoActiveTab)`；raw 事件面确认 Chrome 确实发出了 `Target.attachedToTarget`（flatten attach 的协议契约）。
- **根因**：tokio `broadcast` 新订阅者**从写游标开始读，不补发订阅前消息**（源码 `new_receiver` 取 `tail.pos`）。原 `Transport::connect` 先执行恢复流程（attachToTarget/enable 序列，期间 Chrome 发出 attachedToTarget、frameNavigated 等事件），**之后**才 `spawn_forward` 订阅客户端事件面；事件泵、版本驱动、对话框、活动标签跟踪更是在 connect 返回后才订阅。restore 期间的全部事件在每一层订阅前即被发出，逐层静默丢失。mock 单测全部事后注入事件，天然掩盖。
- **修复**（两阶段建连，`src/cdp/transport.rs` + `src/lib.rs`）：
  - `Transport::connect` 不再执行恢复流程；客户端事件面在 connect 内**先订阅后启动 forward**；
  - 新增 `Transport::restore_now()`——由 `BrowserSession::connect` 在**全部消费方订阅就绪后**最后调用（事件泵 → 版本驱动 → 对话框 → 活动标签 → restore）；
  - 重连路径同步修复：先 `new_client.subscribe()` 再 `restore.restore()`。
- **回归测试**：`transport_restore_events_not_lost`（transport.rs）——restore 期间 mock 发出 attachedToTarget，断言 restore 前订阅的事件面必达；两个既有重连测试改为显式 `restore_now` 并保留原断言。

### 问题 2（E2 失败根因）：DOMSnapshot 响应解析失败（Chrome 151 协议漂移）

- **现象**：`DOMSnapshot 响应解析失败：invalid type: map, expected a sequence`。
- **根因**：`domains.rs` 的 DOMSnapshot 类型面按协议文档旧形态建模，与 Chrome 151 实测响应（逐字段抓取确认）不符：
  - `inputValue`/`optionSelected`/`shadowRootType` 等稀疏字段实测为 **`{index, value}` 映射**（RareStringData/RareBooleanData/RareIntegerData），旧声明为扁平数组；
  - `backendNodeId`（新字段名，旧文档为 `backendDOMNodeId`）——旧声明解析永远得到 None，backend 绑定全空；
  - `nodeCount`、`childNodeIndexes` 实测**不发送**，旧声明为必填；
  - `documentURL`/`title` 实测为**字符串池下标**（如 `documentURL: 0`），旧声明为直出字符串。
- **修复**（`src/cdp/domains.rs` + `src/snapshot/collect.rs`）：新增 `RareStringData`/`RareBooleanData`/`RareIntegerData` 映射类型（value 缺省容错）；`backendNodeId` 双名（alias 兼容旧名）；`node_count`/`child_node_indexes` 缺省；新增 `SnapshotString` 双形态（池下标/字面量）+ `resolve(&strings)` 池解析；collect 侧经池解析回填 url/title。
- **回归测试**：`capture_chrome151_real_shape_parses`（collect.rs）——使用真实浏览器抓取的响应原样断言解析、池解析、backend 绑定。

### 问题 3（E3 失败根因）：BrowserSnapshotStore 每次调用新建 SnapshotManager → 重快照索引解析永远落空

- **现象**：type 成功后 click 触发版本 Stale → 执行器自动重快照（R-1 契约正确工作）→ 但 `索引 [16] 在新快照（v3）中不存在（元素已消失，E2E-10）`。
- **根因**：`BrowserSnapshotStore::manager()` 每次调用 `session.snapshot_manager(budgets)` 新建独立 `SnapshotManager`——`take_snapshot` 的提交落在 A 管理器缓存，`element_by_index` 查询的是新建的 B 管理器**空缓存** → 重快照后的索引解析永远 None → InvalidInput。mock 面（MockSnapshotStore 自带元素表）掩盖。
- **修复**（`src/action/ops.rs`）：store 构造时创建**单一** `SnapshotManager` 实例，`take_snapshot` 与 `element_by_index` 共享同一缓存。
- **回归测试**：`browser_snapshot_store_take_then_resolve`（ops.rs）——mock WS 会话 + Chrome 151 形态采集应答，断言 take_snapshot 提交的快照可被 element_by_index 命中。

### 问题 4（E3 失败根因）：callFunctionOn 遮挡检测双缺陷——箭头函数 + 参数二次包装

- **现象**：click 定位阶段 `页面内函数执行抛异常（固定模板不应失败）`，且修复异常后参数注入错误。
- **根因**（两个叠加缺陷）：
  1. `OCCLUSION_TEMPLATE` 为**箭头函数** `(x, y) => {...}`——`Runtime.callFunctionOn` 仅对普通函数绑定 objectId 的 `this`，箭头函数取词法 `this`=window，`this.contains` 抛 TypeError；
  2. 调用方传 `json!({"value": point.x})` 预包装参数，而 `call_function_on` 内部再次包装 `CallArgument.value` → 页面收到**对象**而非数字 → elementFromPoint 入参 NaN。
- **修复**（`src/action/locate.rs` + `src/action/keyboard.rs`）：模板改普通函数 `function(x, y) {...}`；调用方传原始值，包装收敛到 `call_function_on` 单点（select_option 同型缺陷一并修复）。
- **回归测试**：`occlusion_template_is_regular_function` + `occlusion_passes_raw_coords`（locate.rs）；select_option 参数断言补充（keyboard.rs）。

### 问题 5（E5 失败根因）：优雅停止窗口内进程自然退出 → JoinHandle 二次 poll 崩溃

- **现象**：`stop` 返回 `Stopping { graceful: true }`（状态卡死），伴随 tokio worker panic `JoinHandle polled after completion`。
- **根因**：`stop_path` 中 `tokio::select!` 的 wait_task 分支**取走** JoinHandle 输出后，后续「收尸」块再次 `&mut *wait_task` poll 已完成的句柄 → tokio 硬 panic → 驱动任务崩溃 → `finish_stop` 未执行、状态卡 Stopping。假浏览器单测（永不自退）从未命中 wait_task 分支先到的路径；真实浏览器 + Browser.close 必然命中。
- **修复**（`src/browser/mod.rs`）：`exited` 标志贯通——进程已退出（自然退出或 wait_task 分支）时跳过收尸 poll；仅杀树兜底路径（进程未退）保留一次收尸等待。
- **回归测试**：`graceful_stop_waits_natural_exit_without_double_poll`（browser/mod.rs）——假浏览器写端口后 ~1s 自退 + wait_or_kill 放大 5s，断言 Stopped、force_killed=false（旧实现必崩溃）。

---

## 4. 关键指标（真实 Chrome/151，本机实测）

| 指标 | 值 | 说明 |
|---|---|---|
| 浏览器启动耗时（start → Running） | ~1.09–1.14s | BrowserManager.start 全链路 |
| 会话建连耗时（connect_session） | ~0.59–0.74s | WS 握手 + 身份校验 + 恢复流程 + 域 enable |
| 快照采集耗时（capture） | 4–6ms | 本地 data: 页（8 节点、2 可交互元素）；大页面耗时随 DOM 规模线性 |
| type_text 耗时（中文+英文） | 4–72ms | 中文走 Input.insertText、ASCII 走键事件 |
| click 耗时（含遮挡检测+派发） | 18–35ms（无重试） | 版本过期时自动重快照重试（首轮实测 349ms 含一次 retake） |
| 优雅停止耗时（Browser.close） | 228–367ms | force_killed=false、profile 已清理 |
| e2e 全链路 5 用例总耗时 | ~11s | 含 5 次浏览器启停 |

---

## 5. 遗留问题

| # | 遗留 | 影响面 | 建议 |
|---|---|---|---|
| 1 | 优雅停止路径未在 stop 内直接发 Browser.close（代码注释既有遗留：M1 会话接入后在此先 Browser.close 再等退出）；e2e 通过外部先发 Browser.close 达成干净退出 | 引擎接线后 stop() 语义 | 引擎侧接线时在 stop_path 优雅分支补 Browser.close 发送（维度 10 文档 §6.3 口径） |
| 2 | CfT 缓存优先链路本机未实测（无缓存，落系统 Chrome） | 维度 10 e2e E2 场景 | 由维度 10 的 `e2e_cft_priority_and_system_fallback` 覆盖 |
| 3 | `computedStyles` 采集未在 domains 类型面暴露（collect.rs 既有注释：styles 池跳过，e2e 实证）——交互判定四层启发式中样式层在真实链路暂缺输入 | 样式相关交互判定精度 | P1 补 styles 池解析（serialize 面已有 StyleInfo 消费位） |
| 4 | is_password 标记 MVP 恒 false（ops.rs 既有注释） | 密码输入审计脱敏 | 快照序列化面携带 password 标记后接线 |
| 5 | 多标签 MVP 单会话语义：current_session 取最新 SessionAttached，P1 恢复 per-tab 会话路由 | 多标签场景 | 维度 15 标签管理接线后按 tab_id 解析会话 |
| 6 | 测试资产入库：`crates/conex-browser/` 全目录目前处于 git 未跟踪状态（AGENTS.md 铁律要求测试入库） | 资产安全 | 由主 Agent 协调随本 crate 首次提交一并入库（本 Agent 未执行 git 提交） |

---

## 6. 结论

**MVP 核心链路已打通**：启动 → 连接 → 导航 → 快照（中文元素可识别、索引可解析）→ 动作（中文输入 + 点击 + DOM 断言）→ 版本推进（R-1 契约）→ 干净关闭，全链路真实 Chrome 5/5 用例通过（`#[ignore]` 串行，对齐 10/11 文档 e2e 口径）。

联调暴露 5 处真实链路缺陷（订阅时序、协议漂移 ×2、缓存生命周期、模板/参数注入、JoinHandle 生命周期），全部修复并携带最小单元级回归测试；修复后 `cargo test -p conex-browser`（不含 ignored）326 通过、e2e 5 通过、snapshot_samples 7 通过、clippy 0 警告。

---

## 7. 文件校验

| 文件 | 状态 | 说明 |
|---|---|---|
| `crates/conex-browser/tests/e2e_browser.rs` | 新增 | e2e 5 用例（E1–E5），UTF-8 无 BOM |
| `crates/conex-browser/src/cdp/transport.rs` | 修改 | 两阶段建连 + restore_now + 重连订阅先行 + 回归测试 |
| `crates/conex-browser/src/lib.rs` | 修改 | BrowserSession::connect 订阅面先行 + 恢复最后执行 |
| `crates/conex-browser/src/cdp/domains.rs` | 修改 | DOMSnapshot 真实形态（Rare*Data/backendNodeId/SnapshotString）+ LayoutViewport 新字段双形态 |
| `crates/conex-browser/src/snapshot/collect.rs` | 修改 | 池解析回填 url/title、视口新字段、真实形态回归测试 |
| `crates/conex-browser/src/action/ops.rs` | 修改 | BrowserSnapshotStore 单一管理器 + 视口解析 + 缓存回归测试 |
| `crates/conex-browser/src/action/locate.rs` | 修改 | 遮挡模板普通函数化 + 原始参数 + 回归测试 ×2 |
| `crates/conex-browser/src/action/keyboard.rs` | 修改 | select_option 原始参数 + 断言补充 |
| `crates/conex-browser/src/browser/mod.rs` | 修改 | stop_path 禁止 JoinHandle 二次 poll + 回归测试 |
| 其余文件 | 未触碰 | 无工作区外改动（临时诊断探针已删除） |
