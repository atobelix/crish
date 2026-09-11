# 34-MCP attach 验证（G-3：MCP attach 验证与接线，R-12）

> 任务：P1 收尾 Agent（G-3 / R-12）——验证「外部浏览器类 MCP（chrome-devtools-mcp 类）
> 经 `--browserUrl` 附加到受管实例 CDP 端点」的可行性，并完成只读能力集与会话级开关的
> 配置面接线。
> 日期：2026-08-10。验证等级：**实测**（本机真实 Chrome + npx 拉包 + 真实 MCP 握手）。

---

## 1. 验证结论（速览）

| 项 | 结论 |
|---|---|
| 受管实例启动（随机端口 + DevToolsActivePort） | ✅ 实测通过（Chrome 151.0.7922.77，headed，`--remote-debugging-port=0`） |
| 外部 MCP 经 `--browserUrl` attach 同一 CDP 端点 | ✅ 实测通过（initialize 2025-03-26 握手 + tools/list + tools/call 全通） |
| 只读面工具可用（快照/控制台/页面列表） | ✅ 实测通过（take_snapshot / list_console_messages / list_pages） |
| 既有 MCP 桥拉起该 server 并列出工具 | ✅ 实测通过（`register_plugin_server` + `McpServerConfig::new("browser-mcp", …)`，29 工具枚举、命名空间 `mcp_<server>__*` 隔离断言、只读工具经 adapter 执行成功） |
| 交互/求值类默认拒绝（R-12） | ⚠️ **接线登记**：MCP 自身不拒绝（实测 `evaluate_script` 可执行成功），拒绝面必须在**引擎侧 CDP 会话面能力集**实现（本任务只登记接线点，见 §5） |
| 会话级开关配置面 | ✅ 代码落地（`BrowserToolsConfig::mcp_attach_allowed`，默认 false）+ 2 个单测 |

**验证等级：实测**（非推断/受阻）。两次独立实测路径全绿：① Node 手写 MCP 客户端（temp 脚本，
与桥同构的 stdio JSON-RPC）；② Rust 既有桥 `register_plugin_server`（`tests/mcp_attach.rs`，
`#[ignore]` 集成测试，显式 `--ignored` 运行）。

---

## 2. 环境

| 项 | 值 |
|---|---|
| OS | Windows 11（win32，PowerShell 5.1） |
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe`，Chrome/151.0.7922.77，Protocol 1.3 |
| Node/npm | v24.11.0 / 11.6.2 |
| 外部 MCP | `chrome-devtools-mcp` 1.6.0（npx 拉取；server 自报 chrome_devtools 0.20.3） |
| 仓库参考 | `reference/chrome-devtools-mcp`（1.6.0 源码同版本，工具面一致，未走本地构建路径） |

> **包名发现**：任务书与 17 文档引用的 `npx @google/chrome-devtools-mcp` 在 npm registry 已
> **404**（2026-08-10 实测）。官方现包名 **`chrome-devtools-mcp`**（`npm view chrome-devtools-mcp`
> → latest 1.6.0，与 reference 版本一致）。**引擎侧接线须用新包名。**

---

## 3. 实测过程（可复核）

### 3.1 受管实例启动 + DevToolsActivePort（三次运行抽样）

```
chrome.exe --remote-debugging-port=0 --user-data-dir=<全新profile> --no-first-run ... about:blank
→ DevToolsActivePort 两行内容：
   41352
   /devtools/browser/ff54f1af-df6f-4b6f-af93-80ee9fc926fa
→ GET /json/version → Browser=Chrome/151.0.7922.77 Protocol=1.3
```

- 随机端口 + per-session UUID WS path（双层不透明 token，17 §5.3 语义）实测成立；
- 30s 轮询窗口内正常生成（实测 ~0.3-1s）；
- 必须使用全新 profile：已存在 profile 时 Chrome 复用既有进程（脚本与测试均以临时目录保证）。

### 3.2 外部 MCP attach（Node 手写客户端，temp 脚本）

`npx -y chrome-devtools-mcp --browserUrl http://127.0.0.1:<port>`，stdio JSON-RPC
（initialize → notifications/initialized → tools/list → tools/call），7 步全 PASS：

```
[PASS] initialize（941-1080ms）→ serverInfo: chrome_devtools 0.20.3，protocolVersion 2025-03-26
[PASS] initialized 通知
[PASS] tools/list（6-7ms）→ 29 个工具
[PASS] tools/call take_snapshot → "## Latest page snapshot\nuid=1_0 RootWebArea url=\"about:blank\""
[PASS] tools/call list_console_messages → "## Console messages\n<no console messages found>"
[PASS] tools/call list_pages → "## Pages\n1: about:blank [selected]"
[PASS] tools/call evaluate_script（可达性登记）→ 执行成功（见 §4.3）
```

- **协议兼容**：我们桥的 `MCP_PROTOCOL_VERSION = "2025-03-26"` 与 chrome-devtools-mcp 握手
  成功（server 回显 2025-03-26），无需协商降级——引擎侧桥接线无协议面阻碍。

### 3.3 既有 MCP 桥拉起（Rust 集成测试，`tests/mcp_attach.rs`）

```
cargo test -p conex-browser-tools --test mcp_attach -- --ignored --nocapture
→ 2 passed（probe_windows_npx_spawn_behavior + mcp_attach_readonly_flow，2.27s）
```

- 接线形态：`McpServerConfig::new("browser-mcp", "cmd").with_args(["/c", "npx", "-y",
  "chrome-devtools-mcp", "--browserUrl", url])`（Windows 用 `cmd /c`，见 §4.2）；
- `register_plugin_server` 枚举 **29 个工具**，全部 `mcp_browser-mcp__*` 前缀（命名空间隔离断言）；
- 工具适配器（`McpToolAdapter`）执行 `mcp_browser-mcp__take_snapshot` /
  `mcp_browser-mcp__list_console_messages` 成功（只读面）。

### 3.4 验证脚本位置（temp，不入库）

| 文件 | 作用 |
|---|---|
| `%TEMP%\opencode\mcp-attach-verify\verify.ps1` | 主脚本：启动受管实例 → DevToolsActivePort → node 客户端 → 汇总 |
| `%TEMP%\opencode\mcp-attach-verify\mcp-client.mjs` | MCP stdio 客户端（手写 JSON-RPC，与桥同构）；`--use-local-build` 支持本地构建备选 |
| `%TEMP%\opencode\mcp-attach-verify\result.json` | 每次运行的完整结构化结果 |

> 可复用性：Node 路径已并入 Rust `#[ignore]` 集成测试（`tests/mcp_attach.rs`，仓库内），
> temp 脚本保留供手工复验；CI 默认不跑（需要本机 Chrome + npx + 网络）。

---

## 4. 关键发现

### 4.1 包名与工具面更新（17 文档引用需对齐）

- 包名：`@google/chrome-devtools-mcp` → **`chrome-devtools-mcp`**（1.6.0）；
- 工具面：1.6.0 重构后 **29 个工具**，名称无 `browser_` 前缀——`navigate_page`/
  `take_snapshot`/`list_console_messages`/`list_network_requests`/`evaluate_script`/
  `click`/`type_text`/`upload_file`/`lighthouse_audit`/`performance_*` 等（17 §5 引用的
  `browser_navigate` 等旧版工具名在 1.6.0 已不存在）；
- 对方案的影响：**命名空间隔离语义不变且更干净**——经桥适配后为 `mcp_<server>__*`，
  与自研 `browser_*` 无任何重名面（无需担心 `mcp_x__browser_navigate` 与 `browser_navigate`
  混淆以外的冲突——实际连这个前缀同名面都没有）；工具面更新不影响 R-12 能力集分类
  （只读：snapshot/screenshot/console/network 域；交互/求值：Input/evaluate）。

### 4.2 Windows spawn 形态（引擎侧接线硬约束）

`probe_windows_npx_spawn_behavior` 实测：

```
Command::new("npx") spawn → Err(NotFound)   ← Windows：npx 是 npx.cmd，非 PE 可执行
Command::new("cmd") /c npx  → Ok("11.6.2")
```

**接线点：Windows 上 `McpServerConfig` 的 command 必须为 `cmd` + args `["/c", "npx", …]`
（或显式 `npx.cmd`）**，否则桥 spawn 返回 `mcp.connection_failed`。非 Windows 直接用 `npx`。

### 4.3 R-12 安全语义实测确认（重要）

`evaluate_script`（求值类）在 attach 会话下**可执行成功**（实测 `document.title` 返回结果）——
**外部 MCP 自身不拒绝任何操作**，其子进程持有完整 CDP 权限（进程自治，17 §5.2 边界声明
实测背书）。因此：

> R-12「交互/求值类默认拒绝」**必须在引擎侧 CDP 会话面能力集实现**（attach 建立时为该
> 连接配置只读命令域），绝不能依赖 MCP 侧的自觉。本任务只登记接线点（§5.2），引擎侧
> 落地时按 17 §5.3「只读能力集接线」执行。

### 4.4 受管生命周期

attach 不影响受管实例生命周期：清理路径（杀 Chrome 进程 + 删临时 profile）实测无残留
（连接断开后 MCP 侧 `disconnect` 语义，reference browser.ts `closeBrowser` 已确认
connected 模式只断连不杀浏览器——**不会误杀受管实例**，与 17 §5.3「面板关闭即杀进程」
的受管语义无冲突面）。

---

## 5. 配置面接线（代码交付）

### 5.1 已落地（`crates/conex-browser-tools/src/lib.rs`）

- 新增 `BrowserToolsConfig::mcp_attach_allowed: bool`（**默认 false**，R-12 安全默认）；
  字段文档注释写明：开启后引擎才允许把受管端点注入外部浏览器类 MCP 启动参数/env
  （`McpServerConfig.args/env`）；未开启时引擎不向任何外部 MCP 暴露受管端点信息；
- 模块级文档新增「MCP 并存规则（17 §5.2/§5.3，R-12 只读能力集）」：命名空间
  `mcp_<server>__*` 隔离、权限独立（外部 MCP 不继承浏览器分级）、只读能力集指引
  （snapshot/screenshot/console/network；交互/求值按既有矩阵审批且默认拒绝，外部 MCP
  默认视为只读、交互需用户显式配置时知晓）、快照索引不互通（MCP uid vs 自研
  snapshotVersion）；
- 注册函数不读取该字段（引擎侧会话装配消费），`register_browser_tools` 语义不变。

### 5.2 引擎侧接线点（仅登记，不碰 engine.rs）

| # | 接线点 | 内容 |
|---|---|---|
| E-1 | 会话装配处读取 `BrowserToolsConfig.mcp_attach_allowed`（面板开关 → 会话设置） | `false`（默认）时：外部浏览器类 MCP server 的 spawn 配置**不注入** `--browserUrl`（未开启时引擎不向外部 MCP 暴露受管端点信息）；`true` 且用户显式配置该 server 时：spawn 时把 `http://127.0.0.1:<port>` 写入 `McpServerConfig.args/env` |
| E-2 | 包名与 spawn 形态（§4.1/§4.2） | `command="cmd"`（Windows）+ args `["/c","npx","-y","chrome-devtools-mcp","--browserUrl",url]`；非 Windows `command="npx"`（建议引擎侧做平台分派，测试断言 `probe_windows_npx_spawn_behavior` 兜底回归） |
| E-3 | attach 建立时 CDP 会话面能力集（R-12 核心） | 为外部 MCP 的连接配置**只读命令域**：snapshot（DOMSnapshot/Runtime 只读）/screenshot（Page.captureScreenshot）/console（Runtime.consoleAPICalled）/network（Network 事件）；Input 注入、`Runtime.evaluate`、`Network.getAllCookies` 等不授予（按 17 §2 矩阵审批、默认拒绝）；**实测依据 §4.3：MCP 自身不拒绝，此面是唯一拦截点** |
| E-4 | 工具注册 | `register_plugin_server`（既有桥）照常并入，无需改动；命名空间 `mcp_<server>__*` 已实测与 `browser_*` 共存 |

---

## 6. 测试

| 测试 | 位置 | 数量 | 状态 |
|---|---|---|---|
| `mcp_attach_allowed_defaults_false`（R-12 安全默认断言 + 结构体更新语法回归） | lib.rs 单测 | 1 | ✅ |
| `mcp_attach_allowed_does_not_affect_registration`（开关不参与注册面，false/true 双态 24 工具） | lib.rs 单测 | 1 | ✅ |
| `probe_windows_npx_spawn_behavior`（npx spawn 形态探测，Windows 断言） | tests/mcp_attach.rs（`#[ignore]`） | 1 | ✅ 显式运行通过 |
| `mcp_attach_readonly_flow`（受管实例 + 桥拉起 + 枚举 29 + 命名空间断言 + 只读工具执行，T-12 口径） | tests/mcp_attach.rs（`#[ignore]`） | 1 | ✅ 显式运行通过 |

- `cargo test -p conex-browser-tools` 全绿：45 单测 + 11 contract + 6 multi_tab + 8 registration
  + 23 success_paths + 2 ignored（attach 测试默认跳过，CI 无干扰）；
- 新增测试合计：**2 个常驻单测 + 2 个 `#[ignore]` 集成测试**；
- 门禁：`cargo fmt --check` 对本任务两文件干净（crate 内既有文件存在历史 fmt 差异，
  非本次引入，未触碰）；CI workflows 无 fmt 门禁。

---

## 7. 受阻清单与手工复验清单

**无受阻项**（验证等级：实测）。若他机复验，手工清单：

1. `npm view chrome-devtools-mcp version` → 期望 ≥1.6.0；
2. `%TEMP%\opencode\mcp-attach-verify\verify.ps1`（Windows）/ 等价脚本 → 7 步全 PASS；
3. `cargo test -p conex-browser-tools --test mcp_attach -- --ignored --nocapture` →
   2 passed（需本机 Chrome；`CONEX_TEST_CHROME` 可覆盖路径）；
4. 无 Chrome/无网络环境 → 降级为推断：桥协议面（2025-03-26 握手）已由本报告实测背书，
   仅剩端点注入（E-1）与能力集（E-3）为引擎侧接线待验项。

---

## 8. 关联文档

- 17-维度-工具集权限与安全.md §5（MCP 并存：命名空间隔离、权限独立、R-12 只读能力集）
- 22-裁决与修订记录.md R-12（attach 型 MCP 权限收敛：只读能力集 + 会话级开关）
- 09-方案敲定.md D-8（工具集：MCP 并存补深）
- reference/chrome-devtools-mcp/src/browser.ts（`--browserUrl` attach 机制、
  DevToolsActivePort 自动发现——受管实例有 DevToolsActivePort，attach 方式完全兼容）
