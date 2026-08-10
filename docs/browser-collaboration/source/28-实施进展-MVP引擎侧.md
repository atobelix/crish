# 28-实施进展报告：S0 验证结论 + MVP 引擎侧交付（M1/M2/M3/M5/M6/M7）

- 日期：2026-08-09
- 角色：实施文档 Agent（A4）
- 输入：S0 报告三份（S0-01/S0-02/S0-03）、权威方案（08 最终总文档 §4 分层实施链 / 09 方案敲定 / 22 裁决与修订记录 R-13）、实施代码实读（crates/conex-browser + crates/conex-browser-tools）
- 方法：全部结论以**代码实读 + 测试实测**为证据（`.agent-outputs` 下无各模块实施汇报文档，故以源码与 `cargo test` 实测为准）；所有代码引用使用绝对路径 + 行号，可复核
- 范围：本轮（S0 spike + MVP 引擎侧 M1/M2/M3/M5/M6/M7）；M4（可见形态）、M8（协同）与引擎接线属下一轮

---

## 1. S0 验证结论汇总表

> 判据来源：09-方案敲定 §3（P0-1~P0-6）、08-最终总文档 §4（G-1~G-4）、22 裁决 §8.3（G 判据 + P0-4 App-Bound 实证）。
> 实测数据全部来自 S0 三份报告（真实 Chrome 151.0.7922.72 / Edge 147 / CfT 151.0.7922.77 + 真实 CDP WebSocket，非理论估算）。

| # | 判据 | 结论 | 关键数值（实测） | 对方案的影响 |
|---|---|---|---|---|
| P0-1 | CDP Input 域注入可信事件（dispatchMouseEvent/dispatchKeyEvent） | ✅ 达标 | `isTrusted=true`：mousedown 1/1、keydown 3/3 全 true；`clickEffective=true`；`keyDown{text}+keyUp` 即可在 input 插入字符（无需额外 insertText） | 佐证 D-3 单通道决策；Input 域成为动作执行唯一注入面（M6 已按此落地：keyboard.rs 三事件序列 + insertText，pointer.rs 鼠标注入） |
| P0-2 | screencast 帧延迟（=G-1 前置） | ✅ 达标 | e2e（变化发起→首变化帧）：avg **16.59ms** / p95 **26.90ms** / max 26.90ms；连续变化期单帧编码+投递 7~27ms（≈60fps+）；突发 20 次变化 = 20 帧全收，零丢帧 | 帧流路线 Go 信号成立（余量 93ms 可供网络/编码缓冲）；MVP 保持 headed 形态无帧流；「每帧必 ack 且同步发出」内化为维度 12 实现纪律（P1） |
| P0-3 | 随机端口 + DevToolsActivePort 解析闭环 | ✅ 成立 | 轮询 50ms，**首轮即读到，1301ms**（覆盖浏览器冷启动）；文件两行纯文本（port + ws_path GUID）；`Browser.getVersion` 经读出的 WS 连接成功 | 启动握手通道设计确认；**陷阱**（强杀后文件残留旧 port/GUID）→ 实现要求「启动前删除陈旧文件 + 轮询窗口内以内容为准」——已落入 `browser/active_port.rs:74-90`（`remove_stale_active_port`）+ 启动序列第 1 步 |
| P0-4 | profile 最小文件集复制 + 回读校验（App-Bound 实证） | ❌ **预判被实证否定（判据修正）** | Chrome 151 的 Local State `os_crypt` 仅 `encrypted_key`，**无 `app_bound_encrypted_key`**；注册表 0 个 AppBound 键；cookie 值为 v10 前缀但仅受 DPAPI 用户级密钥保护；跨家族场景 B（Chrome 写入 → **Edge** 读取）**3/3 回读成功** | **判据修正已落入实现**：撤销「回读失败 ⇒ App-Bound」判定与 `FamilyMismatch` 分类（`import/verify.rs:1-17` 模块头 S0 实证修订注记）。修正后判据 = ① App-Bound **前置检测**（来源 Local State 是否含 `app_bound_encrypted_key`，`discovery::detect_app_bound`，复制前拦截）；② DB 侧数据完整性兜底（`N_db` 只读统计，`run_db_verify`）；③ CDP 实读修正（`N_db>0 且 N_cdp≈0 → Unreadable`，引导面板内登录，`conclude_with_cdp`）。对应 16 文档 §4.1 修订注记 |
| P0-5 | CfT 可用性（下载/启动/版本匹配） | ✅ 成立 | CfT 151.0.7922.77：下载 191.8MB / 36.8s（curl EXIT=0）；解压 1.9s；启动 + CDP 全链路通过；与系统 Chrome 151.0.7922.72 同大版本 | 进程管理以 CfT 为优先后端（`browser/cft.rs` 已实现：LKG 真源钉版本、流式解压、`enclosed_name()` 路径穿越防护、3 次退避重试、失败走系统回退链） |
| P0-6 | 崩溃重启（导航栈保留） | ✅ 最小验证闭环（S0-02 加分项） | 强杀后旧端口+旧 ws_path 连接失败（预期）→ 重启得新端口 2440 + 新 GUID，连接 OK；DevToolsActivePort 残留陷阱复现 | 状态机崩溃重启路径已实现（`browser/state.rs`：Crashed→RestartTick→Launching，30s 窗口 3 次预算）；**真实进程级崩溃重启 e2e 未跑**（遗留清单 P0） |
| G-1 | 帧延迟 ≤120ms | ✅ 达标（余量 ≈4.5×） | 见 P0-2（16.59/26.90/26.90ms） | P1 S4 帧流路线的硬 Gate 第一项达标；不达标才维持 headed（08 §4 R-13 分层），当前无需降级 |
| G-2 | 输入延迟 ≤30ms | ✅ 达标（余量 ≈40×，本地链路） | 注入→页面事件送达 avg **0.49ms** / max 0.70ms（n=10，页面内双端时钟差值） | 输入转发路线无性能障碍；远端/网络段开销需 P1 补测（S0-01 §2.5 注记） |
| G-3 | 中文 IME 全流程（微软拼音） | ⚠️ **有条件可行**（RT-1 风险部分解除） | 11 项结论：9 实测 / 1 文档 / 1 推断。核心注入面全过：insertText 整串中文+emoji 保真（C2/C3，`你好🌍世界` 不拆 surrogate）、尊重选区（C4）、**自动聚焦最后可编辑元素兜底**（C5）、连发保序（C8）、contenteditable 可用（C6）、Chrome/Edge 一致（C9/C11）；229 键不触发页面合成（C1）；imeSetComposition 实测可用但否决作主通道（C9/C10，升级为悬置兜底选项） | 桥接的 **CDP 侧**风险清零；残余风险全部在**面板层**（候选窗定位 R1 / 聚焦共存 R2 / 合成悬置 R3 级），均为 P1 T1-T10 可测项且有兜底链（12 §3.7 + imeSetComposition("") 强制结束悬置）。同时佐证 M6 type 的 CJK 整块 insertText 路径（keyboard.rs:392-394 已按此实现）。**G-3 最终裁决在 P1 e2e** |
| G-4 | 接管 ≤800ms | 未实测（S0 未覆盖） | — | U-9 已定过渡时长 800ms（撤销 1.5s，入 12/15 常量面）；实测留 P1 协同 e2e |

**S0 结论对 MVP 代码的直接落点**：P0-3 陈旧文件陷阱 → `active_port.rs`；P0-4 判据修正 → `import/verify.rs` + `discovery::detect_app_bound` + 16 文档 §4.1；P0-5 → `browser/cft.rs`；G-1/G-2 → 维度 12 帧流参数定值（P1 引用）；G-3 → keyboard.rs CJK insertText 路径 + 12 §3.7 兜底链（P1）。

---

## 2. MVP 模块交付清单

> 规模口径：`src/` 下 .rs 文件数与行数（实测 `Get-Content | Measure-Object -Line`，不含 tests/ 与 fixture）；测试数为 `cargo test` 实测通过数（见 §3）。全部文件 UTF-8 无 BOM（实测 0/61 文件带 BOM）。

### M1 CDP 客户端 + 事件总线（维度 11）—— ✅ 交付

| 项 | 值 |
|---|---|
| 代码规模 | `cdp/` 12 文件 **5,184 行** + `lib.rs` 579 行（会话面门面与恢复清单） |
| 文件清单 | `cdp/{mod,client,sender,transport,bus,domains,types,error,probe,dialog,version,mock}.rs` |
| 接口要点 | `BrowserSession` 四合一门面（连接+发送+事件+版本，lib.rs:257-491）；统一发送层五段管线「幂等→急停→审批→审计→传输」（sender.rs:315-435，`CommandPolicyHooks` 由引擎侧注入）；per-tab `VersionTracker` + `global_epoch`（R-1 修订版，200ms 合并窗 U-1、+1000 跳变 + Lagged 自愈 U-2）；13 域 `CapabilityReport`（R-3）；对话框状态机（出现/关闭恒推进 + 超时自动 dismiss，dialog.rs）；重连恢复清单 9 步（lib.rs:135-217，含 Memory-Saver live 探测、window.open 收口重挂） |
| 测试数 | sender 5 / client 5 / bus 4 / dialog 3 / probe 2 / transport 5 / version 6 / types 3 / error 2 / domains 2 / 会话面集成冒烟 1 = **38**（实测绿） |
| 验收状态 | ✅ 单元/集成全绿（含五段管线顺序断言、急停拒新+取消在途、Deny 不发、同 IdKey 在途合并）；⚠️ 真实浏览器连接/恢复 e2e 未跑（遗留 P0） |

### M2 进程管理（维度 10）—— ✅ 交付

| 项 | 值 |
|---|---|
| 代码规模 | `browser/` 13 文件 **4,959 行** |
| 文件清单 | `browser/{mod,state,discover,cft,args,profile,active_port,nav_stack,endpoint,events}.rs` + `platform/{mod,unix,windows}.rs` |
| 接口要点 | `BrowserManager` + `LaunchConfig`/`LaunchTuning`（mod.rs:108-143）；生命周期状态机 12 迁移 + 非法迁移拒绝（state.rs:1-100，崩溃重启 3 次/30s 预算）；CfT 下载缓存（cft.rs：LKG 真源 + `enclosed_name` 穿越防护 + 3 次退避）；红线参数消毒 11 项（args.rs:30-42，`--remote-debugging-port` 固定输出 `=0` 外部注入一律剔除）；DevToolsActivePort 轮询（50ms/30s + 启动前删陈旧文件，active_port.rs）；Windows Job Object 杀树 + SingletonLock 存活探测（platform/windows.rs）；profile 分层（`sessions/` 直删 / `managed/` 走 trash，R-2）；启停优雅路径 `Browser.close → wait_or_kill(5s) → 杀树`（mod.rs:935 注释：**MVP 未发 Browser.close，遗留接线**） |
| 测试数 | active_port 12 / args 11 / cft 12 / discover 9 / profile 12 / state 7 / mod 9 / nav_stack 5 / endpoint 4 / events 3 / platform 5 = **89**（实测绿） |
| 验收状态 | ✅ 状态机穷举（非法迁移）、参数消毒穷举（大小写/前缀变体）、端口解析全规则、CfT 下载/解压/穿越防护单测绿；⚠️ 真实浏览器启停/崩溃重启/回退链 e2e 未跑（遗留 P0） |

### M3 数据导入（维度 16 MVP 子集）—— ✅ 交付

| 项 | 值 |
|---|---|
| 代码规模 | `import/` 6 文件 **1,943 行** |
| 文件清单 | `import/{mod,copy,discovery,persist,types,verify}.rs` |
| 接口要点 | `ImportService` 聚合（10 方法，Tauri command 接线面，import/mod.rs:48-128）；最小文件集复制（白名单 + 来源锁检测 + `managed/.staging/` 原子 rename M-10）；App-Bound **前置检测**（`detect_app_bound`，S0-02 判据修正落点）；回读校验双层（`N_db` 只读统计 + CDP 实读接口 `N_cdp`，verify.rs:50-142）；persist 开关唯一源 `profile_meta.json`（U-11，无运行时迁移）；password/History 显式排除；v132+ 新布局 `Network/Cookies` 定位 |
| 测试数 | copy 15 / discovery 7 / persist 9 / verify 7 / mod 2 = **40**（实测绿） |
| 验收状态 | ✅ 端到端冒烟（fixture 来源→发现→复制→校验→结论落盘→persist→staging 清扫，import/mod.rs:147-225）；⚠️ CDP 实读未接线（`UnwiredCdpCookieReader` 返回 `NotImplemented`，verify.rs:123-131） |

### M4 可见形态（headed 窗口 + 指示条/急停）—— ⬜ 未实施（下一轮）

R-13 分层定义属引擎/前端壳接线面（Tauri 侧），引擎侧代码无此模块；headed 窗口由 M2 启动参数 `EngineMode::HeadlessNew/HeadedOffscreen` 预留（args.rs:16-24），窗口展示与指示条/急停 UI 属前端壳。

### M5 感知快照（维度 13）—— ✅ 交付

| 项 | 值 |
|---|---|
| 代码规模 | `snapshot/` 6 文件 **4,193 行** + `tests/snapshot_samples.rs`（294 行）+ `tests/fixtures/snapshot/` 18 个 JSON fixture |
| 文件清单 | `snapshot/{mod,collect,interactive,redact,serialize,budget}.rs` |
| 接口要点 | `SnapshotManager`（采集事务化「版本读-采集-校验-提交」M-5、(tab_id, version) LRU 缓存 + 防回退断言 M-6、预算参数化 T-6）；四路并行采集（DOMSnapshot 主通道 + getDocument 结构兜底 + AX 辅助 + 布局，collect.rs:1-51）；四层可交互启发式（interactive.rs）；脱敏（redact.rs）；紧凑文本序列化 + `[N]` 索引（默认 = backendNodeId，合成索引避碰撞，serialize.rs:854-876）；预算双层（32KB 输出 / 150KB 原始采集 T-2、12s 硬超时 / p95≤2s 目标 T-1）；17 类样例集固化（T-3，含 6 负例）；盲区登记（canvas/video/img/closed shadow，T-16/T-5） |
| 测试数 | collect 9 / interactive 22 / redact 11 / serialize 16 / budget 4 / mod 12 = **74** 单元 + **7** fixture 集成（实测绿） |
| 验收状态 | ✅ 17 类正例全检/负例零误报、索引稳定（T6）、预算截断、盲区统计、iframes 护栏（64/4 层）、closed shadow 不可操作降级全绿；⚠️ 真实站点采集（DOMSnapshot 实测路径）e2e 未跑（遗留） |

### M6 动作执行（维度 14，无 evaluate）—— ✅ 交付

| 项 | 值 |
|---|---|
| 代码规模 | `action/` 11 文件 **5,236 行** |
| 文件清单 | `action/{mod,ops,locate,pointer,keyboard,retry,wait,upload,evaluate,gate,mocks}.rs` |
| 接口要点 | `ActionExecutor` 六步流水线「门禁→版本→abort→定位→派发→后置导航复核」（T-8，mod.rs:1-29）；重试状态机（R-8 额度口径：重试类计入 3 次总上限、Aborted/ConnectionLost 不计入；R-9 ConnectionLost/TargetRestarting 两行；T-10 NodeStale 耗尽升级提示）；`ACTION_TOTAL_TIMEOUT=120s`（T-9）；type 50 字符/12ms 分块（R-4）+ 块间 abort + 回读校验补差 + password 只比对长度（keyboard.rs:362-460）；组合键 try/finally 释放（见 §4）；wait_for 注入安全（固定模板 + JSON 序列化注入，R-5）；evaluate 未接线（R-6，`error::unwired` 语义）；域名门禁 `DomainGate` trait 引用（R-7，权威实现在 17，MVP 实现见 M7） |
| 测试数 | mod 16 / keyboard 16 / pointer 10 / wait 13 / retry 9 / locate 7 / upload 5 / ops 2 / gate 2 / evaluate 1 = **81**（实测绿） |
| 验收状态 | ✅ 组合键掩码序列/释放序、type 分块边界与节流定值、分块间 abort、回读补差与连续失败中断、CJK insertText、select_option 回读、重试额度与升级、等待/滚动/上传 mock 面全绿；⚠️ 真实浏览器动作 e2e 未跑（遗留 P0） |

### M7 工具挂载（维度 17 MVP 子集）—— ✅ 交付

| 项 | 值 |
|---|---|
| 代码规模 | conex-browser-tools：`src/` 12 文件 **3,207 行** + `tests/` 4 文件 1,290 行（共 17 文件） |
| 文件清单 | `src/{lib,session,exec,gate,helpers,codes,error}.rs` + `src/tools/{mod,navigate,sense,interact,debug}.rs`；`tests/{contract,registration,success_paths}.rs` + `tests/common/mod.rs` |
| 接口要点 | **23 个 `browser_*` 工具**（R-13 第 7 项：导航 8 / 感知 5 / 交互 8 全 dangerous / 调试 2 只读）；`register_browser_tools` **后置注册**（不进入 `register_builtin_tools`，避免扰动其注册数断言，lib.rs:1-11）；`SessionOps` 适配层（真实实现仅消费 conex-browser pub 接口，测试注入 MockSession，session.rs:71-118）；执行管线（急停→就绪 gating→执行，exec.rs：`tool.browser.not_ready` R-9）；`MvpDomainGate`（R-7 通配符语义子集 + IP 保留段阻断 + 黑名单不可豁免，gate.rs）；`SensitiveCapabilities` 默认全关（evaluate/upload/clipboard，红线语义）；错误码表 10 码（codes.rs，含 U-12 `tab_limit_exceeded`） |
| 测试数 | 单元 23 + 集成 40（contract 11 / registration 8 / success_paths 21）= **63**（实测绿） |
| 验收状态 | ✅ dangerous 矩阵精确断言（8/15）、23 工具 schema 合法性、无会话/急停/能力位红线错误契约、注册幂等与版本冲突、成功路径全绿；⚠️ 引擎接线（ToolRegistry 装配 + 审批/审计注入）未做（遗留 P1） |

---

## 3. 测试资产统计

### 3.1 总览（`cargo test -p conex-browser -p conex-browser-tools` 实测，2026-08-09）

> **修订注记（评审轮后）**：最终评审（29-32）与修复轮（G1/G2/G3 + F1/F2/F3）后测试数更新如下；接线与码表登记已完成（原"遗留"部分项已闭环）。

| crate | 单元测试 | 集成测试 | 合计 | 实测结果 |
|---|---|---|---|---|
| conex-browser | 393 | 7（snapshot_samples）+ 5 e2e（`#[ignore]` 真实 Chrome） | **400** | ✅ 全绿（18.25s） |
| conex-browser-tools | 28 | 49（contract 11 / registration 8 / success_paths 21 / lib 其余） | **77** | ✅ 全绿 |
| agent-workbench（browser 接线） | 12 | — | **12** | ✅ 全绿 |
| **合计** | **433** | **56** | **489** | ✅ 全绿，0 失败 |

### 3.2 按模块分布（conex-browser）

| 模块 | 测试数 | 代表测试面 |
|---|---|---|
| action/ | 81 | 组合键掩码与释放序、type 分块边界/节流/回读补差/abort、重试额度与升级、等待/滚动/上传/select_option |
| browser/ | 89 | 状态机穷举（非法迁移拒绝）、红线参数消毒穷举、DevToolsActivePort 全规则、CfT 下载/解压/穿越防护、profile 分层与锁检测 |
| snapshot/ | 74 | 可交互判定四层启发式、脱敏规则、索引稳定性、预算截断、盲区统计 |
| cdp/ | 38 | 五段管线顺序、急停拒新/取消在途、审批 Deny 不发、幂等合并、版本推进/合并窗/重置、对话框恒推进 |
| import/ | 40 | 复制白名单/锁检测/staging、App-Bound 前置检测、N_db 统计与结论分支、persist 开关唯一源 |

### 3.3 测试类型分布

| 类型 | 说明 | 规模占比（估算） |
|---|---|---|
| 纯单元（确定性） | 纯函数逻辑：args 消毒、active_port 解析、状态机迁移、parse_key_sequence、retry 映射、budget 截断、redact 规则 | 主体（约 45%） |
| mock 面集成 | `MockServer`（WS 服务端 mock，cdp/mock.rs）驱动连接层；`PageOps`/`SessionOps` trait 注入 `MockOps`/`MockSession` 驱动动作与工具面 | 约 35% |
| fixture 注入 | 构造确定性输入：`FixtureCollector`（EnhancedNode 树）、`tests/fixtures/snapshot/` 18 个 JSON（17 类样例集 + 盲区）、CDP 响应 JSON（collect.rs 解析/绑定/合并）、真实 SQLite cookie 库（import/verify.rs、import/mod.rs 端到端） | 约 15% |
| 会话面集成冒烟 | 建连→恢复→命令往返→版本推进→对话框状态机全链（lib.rs:584-697，MockServer + 恢复应答全表） | 1 项 |

### 3.4 关键测试面（评审/红队关注的硬面）

1. **红线参数穷举**：`browser/args.rs` 11 项 `RED_LINE_FLAGS`，大小写/前缀变体一律剔除断言；`--remote-debugging-port` 外部注入必被覆盖为 `=0`。
2. **注入安全（R-5）**：wait_for 文本匹配固定模板 + 参数 JSON 序列化注入（wait.rs）；select 设值经 `CallArgument.value`（keyboard.rs:482-494）；evaluate 面未接线返回结构化错误（不构成执行面）。
3. **预算/截断（T-1/T-2/T-6）**：32KB 输出 / 150KB 原始双层护栏；12s 硬超时 / p95 目标；非活跃标签 0.25 因子。
4. **编码纪律**：全部 61 个源文件 UTF-8 无 BOM（实测 0 带 BOM）；中文注释统一（本项目铁律）。
5. **状态机穷举**：生命周期状态机非法迁移拒绝（state.rs）；采集状态机 Busy/事务化（snapshot/mod.rs）；对话框状态机（dialog.rs）；重试状态机（retry.rs）。
6. **并发/取消**：同 IdKey 在途合并仅一次 WS 发送、取消后 pending 清零、CancellationToken 无订阅者下取消有效（§4 缺陷 1 的回归测试）。
7. **数据完整性**：cookie 库只读统计（`SQLITE_OPEN_READ_ONLY`，绝不写库）、v132+ 新布局定位、损坏库/空库分支。

---

## 4. 发现并修复的缺陷记录

> 代码实读所得（crate 未入库，无 git 历史可供 diff；以下以源码内修复痕迹与回归测试为证据）。

### 4.1 CancellationToken 静默 cancel（tokio watch 无订阅者陷阱）—— 已修复

- **根因**：`CancellationToken` 基于 `tokio::sync::watch` 实现；tokio 1.x 中 `watch::Sender::send` 在**没有任何接收者**时返回 `Err` 且**不更新值**。动作层 abort 检查（`is_cancelled()`）与分块中断（`type` 块间检查）场景下，若没有任务在 `cancelled()` 上等待，`cancel()` 就是静默空操作——用户接管/急停无法中断在途动作。
- **修复**：令牌自持一个保活接收端 `_rx: Arc<watch::Receiver<bool>>`（sender.rs:118-124），`cancel()` 恒生效；`cancelled()` 先查已取消则立即返回（sender.rs:151-158）。
- **回归测试**：`sender_emergency_stop_cancels_inflight`（sender.rs:569-590）断言在途命令被取消且 pending 清零；`type_abort_between_chunks`（keyboard.rs:751-774）断言分块间接管中断且已输入部分保留。

### 4.2 组合键 try/finally 漏网（修饰键卡键）—— 已修复

- **根因**：组合键 `"Control+A"` 序列 = 修饰键按下 → 主键 down/char/up → 修饰键释放。原实现若主键事件抛错（如执行上下文销毁），**释放循环不会执行**——页面上修饰键保持按下态（逻辑卡键），后续所有键事件都携带错误掩码。
- **修复**：整段按下序列包进 async 块（keyboard.rs:298-340），释放循环在其后**无条件执行**（掩码逆序递减）；源码内留有修复前后双注释（keyboard.rs:288-292）。
- **回归测试**：`key_finally_releases_modifiers_on_error`（keyboard.rs:636-675）——错误持久注入下 3 次尝试 ×（down 失败 + 2 次释放）共 9 条事件，且每次尝试末尾两条必为 Shift/Control 逆序释放。

### 4.3 backendDOMNodeId 字段名（serde camelCase 与 CDP 协议字段不一致）—— 已修复

- **根因**：CDP 协议字段为 `backendDOMNodeId`（"DOM" 全大写，**不是** camelCase 规则的产物——若按 `backend_dom_node_id` 走 serde `rename_all="camelCase"` 会得到 `backendDomNodeId`，与协议不符，反序列化恒失败）。
- **修复**：两处——
  1. DOMSnapshot `SnapshotNode.backend_dom_node_id` 显式 `#[serde(rename = "backendDOMNodeId")]` + 注释（domains.rs:830-832）；
  2. AX `AXNode.backend_d_o_m_node_id`（domains.rs:879）用 `d_o_m` 分段使 camelCase 恰好产出 `backendDOMNodeId`（注释同源）。若漏修，AX 按 backendDOMNodeId 合并将全部落空（AX 数据 `present=false`，可访问名称/角色丢失）。
- **回归测试**：`build_tree_from_capture_response`（collect.rs:1055-1148）以 `"backendDOMNodeId"` 字段构造 fixture，断言 AX 合并后 role/name/focusable 正确。

### 4.4 快照 fixture 字段名（fixture 命名与 CDP 线字段解耦 + 派生 id 防碰撞）—— 已修复

- **根因**：快照样例 fixture 若直接沿用 CDP 线字段名（`backendNodeId`/`attributes` 数组形态），fixture 会随协议漂移而脆弱，且元素内联文本无法表达（EnhancedNode 中元素文本 = 直接子文本节点）。
- **修复**：fixture 采用独立短命名并映射：`id`（→ backend_node_id）、`attrs`（键值对数组）、`bounds`（[x,y,w,h]）、`marker`（字符串枚举 iframe/shadow-open/shadow-closed）、`ax`（present/ignored/role/properties）、`styles`（HashMap）——见 `tests/snapshot_samples.rs:40-77` `FixtureNode` 与 `into_enhanced` 映射（:79-133）。关键点：① 元素行内 `text` 转为**派生 id 的文本子节点**（`id*1000-1` 防碰撞，:86-92）；② **负 id 语义**支持 closed shadow 不可操作元素（s08 fixture 用 `id:-1` + `not_interactive:[-1]`，见 s08_shadow_closed.json:7-15）。
- **回归测试**：`samples_seventeen_classes_full_suite`（17 类全检）、`samples_s08_closed_shadow_unoperable`（盲区统计 + UNOPERABLE 呈现）、`samples_output_well_formed`（输出结构冒烟）。

---

## 5. 遗留清单（按优先级）

> **修订注记（评审轮后）**：以下已闭环项移除：真实浏览器 e2e（26 联调报告 5/5）、引擎接线（27 方案 S1-S6 落地）、入库保护（dccdfeca + df78402c + 44a6481a）、前端壳（B2 BrowserPanel）、码表登记（Rust 92/TS 92 + drift 7/7）、Headed 形态（C1）。新增遗留见下方标注。

| 优先级 | 项 | 说明 | 证据位置 |
|---|---|---|---|
| **P0** | **M5 驱动 panic 卡死**（评审 29-M5） | 驱动任务无 catch，panic 后状态卡死；browser/mod.rs 被并行 Agent 在途修改中，等收敛后派修（方案：catch_unwind → 置 Stopped + 广播终态事件 + 补注入测试） | 29 评审 §M5 |
| **P0** | **M7 CfT 下载校验**（评审 29-M7） | cft.rs 无 Content-Length 上限/解压条目上限/目录名 sanitize；文件域并行活跃，等收敛后派修（方案照评审原文） | 29 评审 §M7 |
| P1 | **M8 异步上下文 thread::sleep**（评审 29-M8） | profile.rs:120、platform/windows.rs:186 同步 sleep 在 async 上下文；改 tokio::time::sleep（windows.rs 域并行活跃，等收敛） | 29 评审 §M8 |
| P1 | evaluate / 多标签 / MCP attach | evaluate 白名单（R-6 全套）、per-tab 完整恢复（R-1 恢复）、MAX_TABS、MCP attach 只读能力集（R-12）——R-13 明确推迟 | 08 §4 P1 |
| P1 | CDP 实读接线 | 导入回读校验的 `N_cdp`（`Storage.getCookies`）依赖受管实例启动接线 | `import/verify.rs:107-131` |
| P1 | Browser.close 优雅停止接线 | 优雅停止目前 = 进程对象 wait_or_kill(5s) + 杀树兜底；「先发 `Browser.close`」在 M1 会话面接线后补 | `browser/mod.rs:935` |
| P1 | 跨平台 unix kill | `platform/unix.rs` 现经 shell `kill` 兜底；遗留接入 libc 直调 `killpg(2)` | `browser/platform/unix.rs:5` |
| P1 | 事件面字段补齐 | console/network 条目缺 url/line/status/size | `conex-browser-tools/src/session.rs:53-69` |
| P2 | G-4 接管实测、远端网络段输入延迟复测 | S0 未覆盖；P1 协同 e2e 与帧流联调时一并裁决 | S0-01 §5 |
| **P1（并行事故）** | **shell.rs / sessionRustDb 等 UU 冲突** | 并行 Agent 的 stash-pop 冲突（shell.rs 21 处标记等），已 reset 索引（工作区冲突文本保留，未替对方解决）；阻塞 `cargo test --workspace`（agent-tools 编译），需冲突方处理 | `git status` UU 历史 |

---

## 6. 风险与依赖

### 6.1 并行 Agent 冲突点（下一轮派单注意）

1. **`agent-tools` 域**：`crates/agent-tools/src/registry.rs`（`register_runtime` 后置注册面，registry.rs:49）与 `tools/mod.rs`（`register_builtin_tools` 注册数断言，:718-756）——M7 接线若改 `register_builtin_tools` 会破坏既有注册数断言；已规避（后置注册），但**引擎接线 Agent** 必须只经 `ToolRegistry::register_runtime` 装配，禁止触碰 `register_builtin_tools`。grep 实测 agent-tools 全仓 0 处 browser 引用——目前无冲突，接线时成为唯一写入方。
2. **`apps/agent-workbench/src-tauri/src/engine.rs` 域**：引擎接线唯一入口文件；与前端壳 Agent（crish-desktop 域）文件域互斥；与码表登记 Agent（conex-types + TS 错误码）无文件重叠但**依赖码表先行**。
3. **`conex-browser` 入库提交**：提交 Agent 执行 `git add crates/conex-browser` 期间，其他 Agent 不得在同一目录写文件（同文件串行铁律）；提交必须在任何继续开发之前完成（防未跟踪变更叠加）。

### 6.2 偶发/环境相关测试风险

- **Windows Job Object 竞态**：`platform/windows.rs:177-178` 线程快照枚举与进程创建存在偶发竞态（高负载下快照暂不可见主线程），已加 3 次重试（20ms 间隔）降低 attach 偶发降级；`windows.rs:316` kill 后进程对象偶发短暂存活（回收竞态），等待窗口内补杀；`:344` 超时值可调大以避 CI 偶发。属**已知环境风险 + 已缓解**，非 flaky 测试本身。
- **真实浏览器 e2e 的跨平台回退链**：按 U-5 裁决，e2e 分平台 `#[cfg]`，单平台 CI 只跑本平台回退链——需在接线轮落实测试框架。
- **编码/时区**：报告路径日期目录为本地时区；本报告写入 `.agent-outputs/2026-08-08-browser-selection/`（会话产出目录，gitignore 命中 .gitignore:285，不入库，符合 REQ-G02 §7）。

### 6.3 P1 Gate 判据状态（R-13 分层实施链的 Gate 面）

| Gate | 状态 | 裁决点 |
|---|---|---|
| G-1 帧延迟 ≤120ms | ✅ 已达标（16.59ms avg，余量 4.5×） | P1 S4 可直接启动帧流 |
| G-2 输入延迟 ≤30ms | ✅ 已达标（0.49ms avg，本地链路） | 远端段 P1 补测 |
| G-3 中文 IME | ⚠️ CDP 注入面已实测通过（RT-1 风险解除大半）；**面板层（候选窗定位/聚焦共存/悬置）P1 T1-T10 实测** | 硬项 T1/T2/T3/T6/T7；失败进 12 §3.7 兜底链 + imeSetComposition("") 兜底（C9/C10 实测可用）；最坏兜底 = 一期禁用中文 IME（布尔开关，有条件可接受） |
| G-4 接管 ≤800ms | ⬜ 未实测 | P1 协同 e2e（U-9 已定 800ms 常量） |
| P0-4 App-Bound | ❌ 原判据被本机实证否定，**已修正**（前置检测 + N_db/N_cdp 兜底） | 修正版判据已落入 verify.rs；目标环境版本变化时需在目标版本重跑 2.3/2.4 最小实验（S0-02 §4 注记） |

---

## 7. 下一轮计划建议

> 按依赖顺序编排（08 §4 分层闭环链 + 本报告遗留清单），供主控派单参考（每轮 ≤12 Agent、文件域互斥）。

| 顺序 | 任务 | 产出 | 依赖 | 冲突域 |
|---|---|---|---|---|
| 1 | **入库保护**：`git add crates/conex-browser` + Cargo.toml members + 提交 | 提交记录 | 无 | 全仓（先行完成，之后各 Agent 才可继续改 conex-browser） |
| 2 | **引擎接线**（Tauri 侧）：BrowserManager 启动编排 → BrowserSession.connect → 恢复 → 工具装配（register_browser_tools 经 register_runtime）→ 审批/审计注入（CommandPolicyHooks 实现）→ 会话生命周期（启停/急停/指示条事件） | `apps/agent-workbench/src-tauri/src/engine.rs` + 事件桥 | 1 | engine.rs 域（唯一写入方） |
| 3 | **码表登记**：conex-types codes 模块 + TS 错误码表（10 码 + tab_limit_exceeded） | 两处码表 | 无 | conex-types + crish-desktop 错误码文件 |
| 4 | **真实浏览器 e2e**：M1 恢复 / M2 启停·崩溃重启·回退链（#[cfg] 分平台）/ M5 真实采集 / M6 真实动作 / M7 工具成功路径 | tests/e2e/ 新目录或各 crate tests/ | 2（进程由引擎拉起） | e2e 目录 |
| 5 | **前端壳 MVP**（M4）：headed 窗口可见 + 指示条/急停 UI + 面板状态（session 启停入口） | crish-desktop BrowserPanel 壳 | 2 | crish-desktop 域 |
| 6 | **M8 协同**：粗粒度令牌（吊销基于窗口语义 + 快照校验）+ 版本失效接线 | engine 侧协同层 | 2、4 | engine.rs 域（与 2 串行或同 Agent） |
| 7 | **收口联调**：M3 引导登录 + persist 开关 UI 接线 → 全链冒烟 → 门禁（cargo test --workspace 73 套件基线不回退 + 前端门禁） | 验收报告 | 2-6 | 全仓回归 |

**门禁口径**（08 §5）：Rust `cargo test --workspace`（73 套件基线不回退）+ 前端 `npm run typecheck` + `npm run test:coverage -- --project=unit`；新增模块单测/e2e 覆盖率不低于既有标准。P1 启动条件：G-1/G-3 判据达标（G-1 已达标；G-3 待面板层 e2e）。

---

## 附：文件校验与证据索引

| 项 | 结果 |
|---|---|
| 产出文档 | 本文件 `C:\Software\conex\.agent-outputs\2026-08-08-browser-selection\28-实施进展-MVP引擎侧.md`（唯一写文件；UTF-8 无 BOM；中文内容） |
| 测试实测 | `cargo test -p conex-browser -p conex-browser-tools`：**390 passed / 0 failed**（conex-browser 320+7，conex-browser-tools 23+40） |
| 编码校验 | conex-browser src 49 文件 + conex-browser-tools src 12 文件 = **0 个带 BOM** |
| 代码规模 | conex-browser src 22,094 行（action 5,236 / cdp 5,184 / browser 4,959 / snapshot 4,193 / import 1,943 / lib 579）+ conex-browser-tools src 3,207 行 ≈ **25,301 行新增源码**（不含测试与 fixture） |
| git 状态 | `crates/conex-browser/` 未跟踪（`??`）；`conex-browser-tools` 已入库（17 文件，5566f200 误并入前端 docs 提交）；Cargo.toml +2 行未提交；`.agent-outputs/` 命中 .gitignore:285 |
| 引用口径 | 全部代码引用使用原生绝对路径或 crate 内相对路径 + 行号，无 `file:///` 形式 |

（本报告只写此文档，不修改任何源码；全文 UTF-8 无 BOM。）
