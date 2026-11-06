# Tauri MCP 桥稳定性调查（只读分析，2026-11-06）

> 调查范围：2026-11-06 约 01:30 EST 直播应用上的「MCP 桥错误对话框」与两条 MCP 长连接 ≈190s BrokenPipe 断管。全程只读：未改任何代码/配置、未关对话框、未重启应用、未动 `MuseB1Vite`。证据来自本机工具源码、PC 仓库与 cargo 缓存源码、PC 应用日志、Windows 事件日志、GitHub 上游页面（2026-11-06 09:41 UTC 抓取）。

## 结论先行

1. **断管的直接原因不在桥、不在对话框，在我们自己的 VM 侧隧道脚本**：`~/workspace/tools/ts-proxy.py` 的主循环用 `select(..., timeout=30)` 等流量，**任一方向连续 30 秒无字节即 `break` 退出进程**，隧道随之关闭、SSH 进程死亡、PC 上的 MCP server 失去 stdio，driver 下一次写入即 BrokenPipe。任何 ≥30s 的静默等待（长 JS 执行、长 `wait_for`、步骤间停顿）都会触发，与应用状态无关。此机制同时解释了长期存在的「SSH 静默命令 ≳37s 断管」经验（30s + 调度抖动）。
2. **≈190s 不是任何组件的定时器**：driver 单次调用超时 120s、MCP server 单命令超时 30s、插件 socket 层**无空闲超时**、插件 execute_js 默认 5s（最大 300s）。190 ≈ 流量期（约 160s）+ 30s 静默杀。两条连接寿命近同，是因为动效批两轮用了同一提示词、同一探针脚本——在代理模型下这是必然，不需要巧合、更不需要对话框。
3. **「对话框阻塞桥事件循环/锁」的理论被源码否定**：插件 socket 服务器是每连接独立 tokio 任务、无全局锁；JS 往返命令各自带超时；且对话框挂着的时段里 DOM 级 MCP 操作照常完成（动效批记录）。桥没有被堵死过。
4. **对话框不是 MCP 插件弹的**：实际在用的插件是 **P3GLEG/tauri-plugin-mcp 0.3.1**（不是先前记录里写的 hypothesi `tauri-plugin-mcp-bridge`，名称需更正）。该插件 Rust 源码全树无任何原生对话框调用；它的 JS 对话框处理是**桩（stub）**：`window.alert/confirm/prompt` 被替换为自动应答并记入日志缓冲，**永不渲染 UI**，且本机配置 `stub_dialogs(true)` 明确开启。可见的原生对话框来源未定（候选见第三节），其文案未能从任何留存 artifact 中回收（截图未随报告副本留存）——这是本调查的主要证据缺口。
5. **「升级插件」选项不存在**：Cargo.lock 锁定的提交 `c7d271a` 就是上游仓库当前 HEAD（GitHub 实查，2026-11-06），0.3.1 是最新发布，其 changelog 无连接稳定性修复。且插件侧本就不是故障点。

---

## 一、现象复述（以证据为准）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 2026-11-06 约 01:30 EST，直播应用（crish-agent-workbench 调试版）窗口上方出现一个错误对话框，被观察者记为「tauri-plugin-mcp-bridge 错误对话框」，需手动关闭，不影响应用使用 | 动效统一封装报告 §7、协调记录（`~/memory/2026-11-06.md` L241）；截图原件未在 VM/PC 报告目录中留存，**文案不可回收** |
| 2 | 动效批前期两次长连接 MCP 驱动均在 ≈190s 处 BrokenPipe 断裂，与对话框「时间上相关」 | 同上。注意：原文只主张时间相关；后给用户的口径一度写成「它还让两次连接断开」（因果），本调查结论是**该因果不成立**（见第四节） |
| 3 | 对话框出现后，DOM 级 MCP 操作仍可执行，动效批改后量测是在对话框挂着的状态下完成的 | 动效统一封装报告 §7 |
| 4 | 当晚更早的 00:37:01 EST，插件日志记录了一次完整的「客户端消失→10 秒后新连接」周期（见第五节），当时对话框尚未被观察到 | PC 应用日志 `workbench.20261106.log` |
| 5 | 本调查期间（04:4x EST）桥健康：TCP 4000 处于监听，PID 54940，自 2026-11-05 23:02:42 EST 起 | `Get-NetTCPConnection -LocalPort 4000` + token 边车文件 mtime 同为 23:02:42 |

## 二、版本与配置清单

**先纠正身份**：本机在用的桥是 **P3GLEG/tauri-plugin-mcp**（TCP 4000），不是 hypothesi 的 `tauri-plugin-mcp-bridge`（那套是 WebSocket 9223，仓库里根本没有）。先前报告中的「mcp-bridge」称呼为误名。

| 组件 | 版本/标识 | 出处 |
|---|---|---|
| Rust 插件 | `tauri-plugin-mcp` **0.3.1**，git 提交 `c7d271a06469bdf4744bfdeadca7458a1f3d02e5` | PC `C:\Software\conex\Cargo.lock` L7600-7602；插件缓存 `C:\Users\orange\.cargo\git\checkouts\tauri-plugin-mcp-2fd5dc058bb53a96\c7d271a\Cargo.toml` |
| 上游状态 | 该提交即上游 `main` 当前 HEAD（72 commits、4 releases）；0.3.1 发布于 2026-07-17，changelog 注明「No functional changes」 | GitHub 仓库页（2026-11-06 09:41 UTC 抓取）；插件 CHANGELOG.md |
| 依赖声明 | `tauri-plugin-mcp = { git = "https://github.com/P3GLEG/tauri-plugin-mcp" }`（TOML 未钉版，靠 lock 钉提交） | `apps/agent-workbench/src-tauri/Cargo.toml` L47-48（注释：「仅 debug 注册」） |
| MCP server（Node） | `tauri-plugin-mcp-server` **0.3.1**（与插件同仓同版） | PC npx 缓存 `C:\Users\orange\AppData\Local\npm-cache\_npx\292777bce978ab09\node_modules\tauri-plugin-mcp-server\package.json` |
| 插件注册 | `dev_mcp.rs`：`init_with_config(PluginConfig::new("crish-agent-workbench").start_socket_server(true).tcp_localhost(4000).stub_dialogs(true))`；`#[cfg(debug_assertions)]` 隔离；开关 env `CRISH_MCP_SOCKET`（默认开、精确 "0" 关）；token 未配置→插件自动生成随机 token 写 `%TEMP%\tauri-mcp-4000.token`，请求须带 `authToken` 握手 | `apps/agent-workbench/src-tauri/src/dev_mcp.rs` L81-90 及文件头决策注释 |
| 权限 | capabilities `default.json` 含 `"mcp:default"` | `apps/agent-workbench/src-tauri/capabilities/default.json` |
| 连接拓扑 | VM `mcp_drive.py`（Python）→ SSH（ProxyCommand=`ts-proxy.py` → HTTPS CONNECT 代理 :3130 → Tailscale）→ PC sshd → PowerShell → `npx -y tauri-plugin-mcp-server`（stdio JSON-RPC）→ TCP 127.0.0.1:4000（token 认证）→ 应用内插件 → Tauri events ↔ WebView2 guest JS | `~/workspace/tools/mcp_drive.py`、`ts-proxy.py`、插件 README 架构图 |

**超时清单（逐项亲查源码，190 不在其中任何一项）**：

| 位置 | 数值 | 出处 |
|---|---|---|
| **ts-proxy.py 主循环** | **select 超时 30s，无流量即 break 退出** | `~/workspace/tools/ts-proxy.py`：`select.select([s, stdin_fd], [], [], 30)`；`if not r: break` |
| driver 单次调用 | 120s（步骤可覆盖）；会话无总时长上限 | `mcp_drive.py`：`call(..., timeout=120)` |
| SSH 客户端保活 | **未配置**（无 `~/.ssh/config` 条目，命令行未带 ServerAliveInterval）→ SSH 层永不自发流量 | 本机实查 |
| MCP server 单命令 | 默认 30,000ms；execute_js 套接字超时 = max(30s, timeout_ms+5s)；app_bridge = max(30s, timeout_ms+5s) | 插件仓 `mcp-server-ts/src/client.ts` L233/L302-307、`tools/execute_js.ts` L33 |
| 插件 execute_js | JS 执行超时默认 5,000ms、调用方最大可设 300,000ms | `mcp-server-ts/src/tools/execute_js.ts` L13；插件 `src/tools/execute_js.rs` L38 |
| 插件 socket 服务器 | **无读超时、无空闲超时、无心跳**：`read_line().await` 无限等；每连接顺序处理（读一行→执行→回一行） | 插件 `src/socket_server.rs` `handle_client_async` |
| 插件其他工具内超时 | inspect_element 10s、dispatch_pointer 15s、local_storage 5s、app_bridge 为 timeout_ms+2s | 插件 `src/tools/*.rs` |

## 三、对话框溯源

**插件侧排除（三条独立证据）**：
1. 插件 Rust 源码全树检索：无 `dialog`/`MessageDialog`/`rfd` 等任何原生对话框调用；`error.rs` 的错误类型只走 socket 响应与日志。
2. 插件唯一的「对话框」功能是 JS 桩：`src/listener_patch.js` L171-213 在页面加载时把 `window.alert/confirm/prompt` 替换为非阻塞桩——自动应答（confirm→false、prompt→默认值）并把对话框内容记入日志缓冲（target `"dialog"`，可用 `query_logs` 查），**不产生任何可见 UI**。`lib.rs` L100-110 的文档注释明言原生对话框会阻塞 JS 线程、故默认桩掉。
3. 本机配置双保险：`PluginConfig` 默认 `stub_dialogs: true`，且 `dev_mcp.rs` 显式传 `.stub_dialogs(true)`。主 webview 里的 JS `alert()` 在此配置下不可能变成原生对话框。

**候选来源（按可能性排序，均未坐实）**：
1. **应用自身的 `tauri-plugin-dialog` v2**：应用确实装了这条原生对话框通道（`src-tauri/Cargo.toml` L23 `tauri-plugin-dialog = "2"`；`apps/crish-desktop/package.json` `@tauri-apps/plugin-dialog ^2.7.2`）。某个应用代码路径（如错误上报面）弹出的消息框，正文若提到 MCP 桥，即可解释观察者为何记成「MCP 桥的错误对话框」。桩只覆盖 `window.alert` 族，覆盖不了插件对话框 API。
2. 桩未覆盖的 webview/页面里发生的 JS 对话框（桩按 webview 在 PageLoad 时注入；次要 webview 或注入前弹出的对话框不在覆盖内）。
3. WebView2/Windows 系统对话框——Windows 事件日志在该时段无记录（见第五节），可能性最低。

**证据缺口**：对话框的确切标题与正文未能回收。动效批的 01:30 截图未随其报告进入 PC `docs/chat-motion-20261106\`（该目录只有报告 .md），VM 侧按时间窗（01:15-01:45）检索图片文件无果。若该对话框至今仍挂着，最快的定性办法是请用户读一眼正文（或下次复现按第六节清单先截图存字、再关）。

## 四、断管机理判定

**判定：BrokenPipe 的近因是 ts-proxy.py 的 30 秒无流量自杀（源码级确定，充分条件成立）；对话框至多是间接促因之一且未证实；「同龄巧合」不需要——两条连接寿命相同是同一脚本的确定性结果。**

逐环论证：

1. **死的是哪一跳**：BrokenPipe 发生在 driver 的 SSH 子进程 stdin 上，即 VM↔PC 的 SSH 隧道先死；PC 上的 Node server 随 stdio 关闭而退出，整条 MCP 会话才终止。应用内插件↔server 的 TCP 是 PC 本机回环，不经过隧道，不受对话框/网络影响。
2. **隧道为何死**：`ts-proxy.py` 是所有 SSH 的 ProxyCommand。它在 CONNECT 建好隧道后进入转发循环，`select` 超时设为 30s、超时即 `break` 落出循环、脚本结束、socket 关闭。SSH 默认无保活（本机无 ServerAliveInterval 配置），所以**只要一对方向连续 30 秒没有字节流动，隧道必死**——与命令长短无关，只与「静默」有关。这与既有经验完全吻合：普通 SSH 命令只要 ≳37s 无输出就断管（30s 阈值 + 抖动与收尾）。
3. **≈190s 的构成**：连接寿命 = 最后一次有字节流动的时刻 + 30s。动效批探针脚本含轮询调用（calls 文件中 sleep 步为 1-12s 不等），流量期把死亡推后；当某个长等待出现（长 timeout 的 execute_js 等慢 promise、或执行间隙），静默满 30s 即断。两轮探针是同一脚本、同一提示词（动效批自述），流量期近同 → 寿命都 ≈190s。**若存在某个「190s 固定定时器」，它必须以常数形式存在于某个组件中——已逐项查完（第二节超时清单），不存在。**
4. **对话框的角色**：设想链「原生模态对话框阻塞 webview JS 线程 → 某个大 timeout 的 execute_js 长时间等不到结果 → 全链静默 ≥30s → 代理断管」在机理上**成立但非唯一**：任何 ≥30s 的无流量等待都同样致命（慢 promise、长 `wait_for`、应用忙）。且有两个反证压低对话框的必要性：①00:37 那次断开+重连发生在对话框被观察到之前约 53 分钟，同样的事情没有对话框也发生了；②对话框挂着的时段里短连接 MCP 操作一直可用（动效批在此状态下完成全部改后量测）——桥本身始终健康，死的只有「长静默连接」。
5. **「对话框阻塞桥的锁/事件循环」——否定**：插件 socket 服务器每连接一个 tokio 任务、连接内顺序处理、命令间无全局锁（`socket_server.rs` 全文）；JS 往返类命令各有超时兜底（execute_js 默认 5s），单个命令卡死不会锁住监听器；插件日志实证它在客户端消失后 10 秒即接受了新连接（第五节）。对话框（即便模态）最多卡住它自己那条命令的 JS 往返，卡不住桥。

**还差什么才能把对话框的间接贡献从「可能」升为「是/否」**：两条死亡连接的 calls 脚本原文（含每个 execute_js 的 timeout_ms 与 sleep 步）与死亡的秒级时间戳——前者动效批未留存完整件，后者无记录。下次按第六节清单取证，一次即可定案；但注意：**无论对话框贡献与否，修法不变**（第五节选项 1/2 掐断的是静默杀本身）。

## 五、PC 侧日志核查

| 来源 | 结果 |
|---|---|
| 应用磁盘日志 `C:\Software\conex\apps\agent-workbench\logs\workbench.20261106.log` | 日志内时间戳为 UTC；**最后一条 2026-11-06T05:37:36Z = 00:37:36 EST**，文件恰达 10MB 上限后轮转，后继 `workbench.20261106.1.log` 为 0 字节——**磁盘日志不覆盖 01:30 窗口**，对对话框无任何记录可查（轮转后继文件为空的原因本调查未定性，附带登记） |
| 同日志内 [TAURI_MCP] 条目 | 共 1,614 行（插件日志进应用日志）。末段三行是关键旁证：`05:37:01.130Z` 发送响应成功 → `05:37:01.829Z` `Client disconnected during read (pipe error)` → `05:37:11.481Z` `Accepted new TCP connection from: 127.0.0.1:5093`。即 00:37 EST 有一次 server 侧连接整体消失、10 秒后新 server 连入——插件把客户端消失当常规事件，服务不中断 |
| Windows 事件日志（Application，Level 1-3，2026-11-06 01:15-01:45 本地时） | **无任何事件**（`NO_EVENTS_IN_WINDOW`）→ 该时段无应用崩溃/Windows 错误报告记录，与「对话框是模态提示而非崩溃」相容 |
| 插件内存日志缓冲（`query_logs`，含 target `"dialog"` 的对话框记录） | 环形缓冲容量 5,000 条（`src/log_buffer.rs` L19 `DEFAULT_CAPACITY: usize = 5000`）；以本应用的日志量，01:30 的条目在调查时（04:4x）必然已被滚出。按只读/不扰动纪律未发起实时查询，且预期收益为零。**下次必须在对话框出现后分钟级内抓**（见第六节） |
| 桥当前状态 | TCP 4000 监听中，PID 54940，监听创建与 token 文件 mtime 均为 2026-11-05 23:02:42 EST——桥自昨夜起同一进程持续在役 |

## 六、修复选项排序（仅方案，未施工）

| 序 | 选项 | 证据强度/预期效果 | 代价与风险 |
|---|---|---|---|
| 1 | **给 SSH 加保活**：`mcp_drive.py`（及 `rps.py`）的 ssh 命令加 `-o ServerAliveInterval=15 -o ServerAliveCountMax=3`。SSH 协议层保活包每 15s 产生隧道流量，30s 静默杀永不触发；同时能及时发现真断 | 直击已证实的近因；改动只在本机自有工具脚本，零触碰应用/插件；完全可逆 | 极低。保活流量微小；注意保活只解决「静默被杀」，PC 睡眠等真断仍会断（那是另一回事，且 CountMax 会让死亡判定更快、更干净） |
| 2 | **修 ts-proxy.py 本体**：去掉/改造 30s 超时退出（如改为无限等待对端 EOF，或超时先探活再决定）。覆盖所有走此代理的长静默场景，不止 MCP | 同样治本，且惠及普通长 SSH 命令（≳37s 断管的经验问题一并消失） | 中低：该脚本是全部 PC 通道的共用件，改动需回归短命令与异常退出路径；当初加超时退出可能意在回收僵尸会话，改造时应保留「对端已死能退出」的语义（socket 出错/EOF 本就会退出，超时 break 并非必需） |
| 3 | **driver 断线自愈**：`mcp_drive.py` 检测子进程死亡后自动重拉 server，对声明为只读幂等的步骤自动重放 | 对选项 1/2 未覆盖的断因（PC 睡眠、网络切换、≈720s 出口节拍器切断）提供韧性 | 中：必须区分步骤幂等性，非幂等步骤（点击/输入类）绝不可盲目重放；选项 1 落地后优先级下降 |
| 4 | ~~升级插件~~ | **关闭此选项**：锁定提交即上游 HEAD（2026-11-06 实查），0.3.1 为最新版、无相关修复；且插件 socket 层无空闲超时、客户端断开自愈（日志实证），不是故障点。若未来上游出新版可再评估，但与本次问题无关 | — |
| 5 | **接受短连接现状**（分段取数绕行） | 已被各批验证可行，仅效率损失 | 零改动。作为选项 1 落地前的临时口径可以，不建议长期接受——选项 1 的成本比长期绕行的累计成本低得多 |

**对先前口径的更正建议**：此前给用户的说法「对话框让两次长连接在约 190 秒处断开」应更正为：断管由本机隧道脚本的 30 秒无流量退出造成，与对话框仅时间相关；对话框本身来源未定（插件已排除），仍需手动关闭或等下次取证定性。

## 七、待复现取证清单

1. **决定性实验（可预先做，约 2 分钟）**：起一个 driver 会话，发一次 `ping` 后保持静默，秒级记录断开时刻——代理模型预测「最后一次响应后 ≈30s 断」；若改为定点 ≈190s 断则推翻代理模型。随后给 ssh 加 `ServerAliveInterval=15` 重跑同一实验，预测不断线。此实验同时是修复选项 1 的验收。
2. **对话框再现时，第一时间（分钟级内）**：
   - 截图并逐字抄录标题与正文再关闭（文案是定性的决定性证据）；
   - 立即短连接 `query_logs` 抓 target=`"dialog"` 与含 `mcp` 的条目（环形缓冲仅 5,000 条，迟了即滚出）；
   - 记下秒级时间戳。
3. **三侧时间戳对齐**：VM 侧 driver 进程死亡/BrokenPipe 出现的时刻、PC 应用日志里对应连接的 `Client disconnected` 行、该会话 calls 脚本中各步的 sleep/timeout_ms——三者拼出「静默期从哪一步开始」，即可判定每次断管的静默来源（含对话框是否在场）。
4. **PC 侧状态三查**：`tauri-mcp-4000.token` 与 4000 监听是否仍在（区分应用死/桥死/隧道死）；Windows 事件日志 Application+System 同窗口；应用磁盘日志是否又停在轮转点（若复现「轮转后继为空」，单独开日志轮转调查项）。
5. **留存件纪律**：每次长连接会话把 calls.json 原文与起止时间戳一并存入当批工作目录——本次调查最大的两个缺口（脚本原文、死亡时间戳）都是留存缺失造成的。

---

### 附：本调查亲查过的源文件

- 本机：`~/workspace/tools/ts-proxy.py`、`~/workspace/tools/mcp_drive.py`、`~/workspace/tools/rps.py`、`~/.ssh/config`（无保活配置）
- PC 仓库：`Cargo.lock`、`apps/agent-workbench/src-tauri/Cargo.toml`、`apps/agent-workbench/src-tauri/src/dev_mcp.rs`、`apps/agent-workbench/src-tauri/capabilities/default.json`
- 插件源码（cargo git 缓存 c7d271a）：`src/lib.rs`、`src/socket_server.rs`、`src/error.rs`、`src/listener_patch.js`、`src/log_buffer.rs`、`mcp-server-ts/src/client.ts` 等、`CHANGELOG.md`、`Cargo.toml`
- PC 运行态：npx 缓存中 `tauri-plugin-mcp-server/package.json`、应用日志 `workbench.20261106.log`、Windows 事件日志、`Get-NetTCPConnection` 与 token 文件 mtime
- 上游：https://github.com/P3GLEG/tauri-plugin-mcp （当前 HEAD 即 c7d271a，2026-11-06 抓取）
