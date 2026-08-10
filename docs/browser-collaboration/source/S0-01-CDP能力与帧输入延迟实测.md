# S0-01 CDP 能力与帧/输入延迟实测报告

- 日期：2026-08-09（实验于 2026-08-08 夜完成，报告同日补全）
- 角色：S0-A spike 验证 Agent
- 目的：为「帧流 + 输入转发」路线提供 Gate 数据（G-1 帧延迟 ≤120ms / G-2 输入延迟 ≤30ms）
- 方法：**真实浏览器 + 真实 CDP WebSocket 驱动**，所有数值来自实际执行，非理论估算

---

## 1. 环境

| 项 | 值 |
|---|---|
| 浏览器 | Chrome **151.0.7922.72**（64-bit，headed，`--remote-debugging-port=9333 --user-data-dir=...\s0-cdp\profile --no-first-run`，独立临时 profile） |
| CDP 协议 | 1.3；jsVersion 15.1.206.10（V8 15.1） |
| Node | v24.11.0（全局 WebSocket，未装任何 npm 包） |
| 实验脚本 | `C:\Users\orange\AppData\Local\Temp\opencode\s0-cdp\s0-cdp-test.mjs`（不入库，保留） |
| 原始输出证据 | `C:\Users\orange\AppData\Local\Temp\opencode\s0-cdp\run-output.txt`（含 `###RESULT###` 完整 JSON） |
| 连接方式 | GET `http://127.0.0.1:9333/json/version` 拿 browser 级 WS → `Target.createTarget` + `attachToTarget(flatten)` 拿 page 级 session |

---

## 2. 逐项实测结果

### 2.1 CDP 连通 ✅

- `GET /json/version` 返回 `Chrome/151.0.7922.72`、`webSocketDebuggerUrl: ws://127.0.0.1:9333/devtools/browser/...`。
- 全局 WebSocket 直连成功；`Browser.getVersion` 返回 `{protocolVersion: "1.3", product: "Chrome/151.0.7922.72", jsVersion: "15.1.206.10"}`。
- 链路：browser WS（Target 域）→ attach 后所有命令走 `sessionId`，事件按 sessionId 路由，正常。

### 2.2 Input 域能力 ✅

测试页：`data:text/html,<input id=i autofocus><button id=b>B</button>`，页面内注入监听器记录 `isTrusted` 与 `performance.now()`。

| 项 | 结果 |
|---|---|
| `Input.dispatchMouseEvent`（mousePressed/mouseReleased 点按钮） | **clickEffective=true**（`onclick` 标记置位） |
| mousedown 事件 `isTrusted` | `[true]`（全部 true） |
| `Input.dispatchKeyEvent`（keyDown+keyUp 带 text 输入 'abc'） | **typingOk=true**，`<input>.value === "abc"` |
| 3 个 keydown 事件 `isTrusted` | **全部 true** |
| 输入延迟（页面内 `performance.now()` 双端差值，n=10） | **min 0.40 / avg 0.49 / p95 0.70 / max 0.70 ms** |

关键证据：keydown/char 用 `keyDown{text}+keyUp` 即可在 input 中插入字符，无需额外 `Input.insertText`；事件均带 `isTrusted=true`。

### 2.3 快照相关域 ✅

| 项 | 结果 |
|---|---|
| `Page.enable` / `Runtime.enable` / `DOM.enable` / `Accessibility.enable` / `Network.enable` | 全部 **ok** |
| `Storage.enable` | **不存在该方法**（Storage 域无 enable，直接调用即 `'Storage.enable' wasn't found`——属预期，非故障） |
| `DOM.getDocument` | 成功，root nodeId=1，documentURL 正确（data: URL） |
| `Accessibility.getFullAXTree` | 成功，返回 **8 个节点** |

### 2.4 screencast 帧延迟 ✅

`Page.startScreencast(format=jpeg, quality=70, maxWidth=1280, maxHeight=800)`，每帧立即 `screencastFrameAck`，本侧记录到达时刻（`performance.now()`）与 JPEG base64 哈希。

**静态内容窗口（1500ms 无变化）：收到 1 帧后停流** → ack pacing 生效：内容不变时帧率≈0，空闲开销≈0。✔ 符合预期行为。

**端到端延迟**（`Runtime.evaluate` 改 body 背景色 → 收到首个哈希变化帧的到达时刻，n=12，misses=0）：

| 指标 | 值 (ms) |
|---|---|
| min | **10.34** |
| avg | **16.59** |
| p95 | **26.90** |
| max | **26.90** |

**帧间隔分布**（实验全程收到的 38 帧间隔，含静态期间隙，ms）：

| min | avg | p95 | max |
|---|---|---|---|
| 7.41 | 80.72 | 180.24 | 349.79 |

说明：avg/p95/max 被「静态期无帧」间隙拉高；**连续变化期间单帧编码+投递节奏为 7~27ms**（e2e 样本同源佐证，avg 16.6ms），即帧能力上限 ≈ 60fps+，远高于 120ms 门限。

**突发压力**：20 次连续改背景色 → **20 帧全收齐**（809ms 内，含每次 20ms 节流与 300ms 收尾），无丢帧。

### 2.5 输入延迟 ✅

页面内 `keydown` 监听器打 `performance.now()`，与注入前（页面内）时间戳做差，n=10：**avg 0.49ms，max 0.70ms**。

语义说明：该值 = CDP 命令到达浏览器渲染进程后，事件分发进页面的最小链路延迟；本地 WS 下命令传输往返另计约 1ms 量级（evaluate 往返实测同量级）。远端转发场景需补测网络段。

### 2.6 Network / Storage 域 ✅（cookie 读写回路）

本地 http server（`http://127.0.0.1:9444`，`Set-Cookie: s0test=abc123`）下实测：

| 项 | 结果 |
|---|---|
| `Network.getAllCookies` | 共 3 条，**s0test=abc123 命中** |
| `Storage.getCookies` | 读到 s0test ✔ |
| `Storage.setCookies` → `Storage.getCookies` 回路 | **s0set=xyz 写入后读回一致** ✔ |
| 写入后 `Network.getCookies` 可见性 | Network 域也能看到 s0set=xyz ✔ |

结论：cookie 读取/写入在「Network.getAllCookies + Storage.setCookies/getCookies」双域回路成立，为 S0-B cookie 能力背书。

---

## 3. G 判据结论

| 判据 | 指标 | 实测 | 结论 |
|---|---|---|---|
| **G-1 帧延迟 ≤120ms** | 端到端（变化发起→收到变化帧）avg / p95 / max | 16.59 / 26.90 / 26.90 ms | **✅ 达标**（余量 ≈ 4.5×） |
| **G-2 输入延迟 ≤30ms** | 注入→页面事件送达 avg / max | 0.49 / 0.70 ms | **✅ 达标**（余量 ≈ 40×，本地链路） |

两个判据均达标，且余量充足（帧延迟余量最大 93ms 可用于网络传输与编码缓冲；输入延迟余量 29ms）。**Go 信号成立**，建议下一步在真实网络链路（或 tauri 内嵌转发层）复测确认传输段开销。

## 4. isTrusted 结论

**CDP Input 域注入的输入事件是受信事件（isTrusted=true）。** 实测证据：mousedown 1/1、keydown 3/3 全部 `isTrusted === true`。含义：页面侧无法通过 `isTrusted` 区分「CDP 注入」与「真实用户操作」，输入转发路线在信任模型上无阻碍；反之，若方案需要拦截/模拟也须走 Input 域而非 JS dispatchEvent（后者 isTrusted=false）。

## 5. 其他发现与建议

1. **每帧必 ack**：screencast 依赖 ack 推进，实测静置后首帧到达约 0~2ms（`firstFrameInMs=2`），说明「变化→编码→推送」链路响应快；实现时 ack 必须在接收线程同步发出，不要入队列延迟。
2. **`Storage.enable` 不存在**：实现代码中不要对 Storage 域做 enable 断言（会得到 `'Storage.enable' wasn't found`），直接调 `Storage.getCookies/setCookies` 即可。
3. **每次 DOM 变化恰产生 1 帧**：突发 20 次变化 = 20 帧，无合并、无丢帧——帧流按「变更驱动」工作，符合按需渲染假设。
4. **Node 全局 WebSocket 足够**（v24 无需 ws 包）；注意 WS 保持连接会阻止进程退出，实验脚本结尾需显式 `ws.close()`/`process.exit()`。
5. **cookie 回路需 http(s) 页面**：data: URL 下 cookie 不可用，S0-B 的 cookie 能力验证须在真实 http 页面执行（本次已用本地 server 验证通过）。
6. **测量方法学**：帧到达时刻与注入时刻均用本侧 `performance.now()`，输入延迟用页面内时钟双端差值，规避跨时钟源问题——后续复测沿用此口径。

## 附：可复现命令

```powershell
# 1. 启动浏览器（独立 profile）
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --user-data-dir="C:\Users\orange\AppData\Local\Temp\opencode\s0-cdp\profile" --no-first-run --no-default-browser-check --window-size=1024,768
# 2. 运行实验
node C:\Users\orange\AppData\Local\Temp\opencode\s0-cdp\s0-cdp-test.mjs
```
