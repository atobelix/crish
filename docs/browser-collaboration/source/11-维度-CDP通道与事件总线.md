# 维度 11：CDP 通道与事件总线（D-3/D-4）实施细节

> **修订注记（R1 轮，以 22-裁决与修订记录.md 为准）**：
> 1. snapshotVersion 架构对齐 R-1：**per-tab 版本** `snapshot_version(tab_id)` + 会话级 `global_epoch`；推进规则单一权威——对话框出现/关闭**恒推进**（撤销原「不推进」）、DOM 变更聚合 **200ms**（撤销 50ms）、用户输入注入 / AI 动作执行 +1、滚动**不推进**（撤销原滚动 bump）；接口统一 `validate_snapshot(tab_id, version)`；
> 2. 域/命令清单补齐 R-3：12→**13 域**（补 DOMSnapshot 及 pushNodesByBackendIdsToFrontend/scrollIntoViewIfNeeded/focus/Runtime.getProperties/Page.getLayoutMetrics/Page.fileChooserOpened/Storage.getCookies/setCookies），命令 59→约 72、事件 35→36；
> 3. 重连恢复清单补 startScreencast 重启（R-9-3/M-3：恢复后通知维度 12 重启帧通道）；
> 4. 恢复期工具面不可用（R-9-4：`browser.not_ready` + 前端指示条「恢复中」，写入恢复流程与 Tauri 接线段落）；
> 5. 低项落实：锁纪律声明（21-L2，§2.5）、能力探测逐域并行声明（20 11-6）、维度 10 §7.4 引用随其重编号改为 §6.4（21-L1）。
> **修订注记（F4 轮：编号体系统一）**：
> 1. 全文复查无「维度 1-9」旧编号引用残留，本轮无替换。

> 定位：软件内 AI 协同浏览器的「CDP 单通道 + 自研薄客户端 + 事件总线」维度实施文档。
> 承载决策：D-3（CDP 单通道，loopback 随机端口 + 会话 token）、D-4（自研薄客户端，长连接 WS + 事件总线，命令全过统一发送层）。
> 输入：08-最终总文档 §3.2/§4（S1）/§5；09-方案敲定 D-3/D-4；06-评审-乙 §2.3/§3.1（双层路由内建、事件总线前移、快照版本一期内置、mock WS 单测口径）；10-维度-渲染与进程管理（CdpEndpoint/SessionToken 契约、崩溃重启信号）。
> 参考实现：`reference/agent-browser/cli/src/native/cdp/client.rs`（ws_tx + AtomicU64 + pending oneshot + broadcast + PendingGuard + keepalive 骨架）、`cdp/types.rs`（消息信封）、`native/browser.rs`（enable_domains/对话框/订阅模式）；教训参考：`reference/browser-use/browser_use/dom/service.py:22-24`（每步重连 TODO 反例）。
> 产出：`crates/conex-browser` 的 cdp/ 子模块（client/transport/types/domains/sender/bus/version/probe/dialog/error），以及事件总线对维度 13/14/15/12 的全部契约。

---

## 1. 职责边界与本维度交付物

本维度负责「一条可靠长连接 + 一个有序事件面 + 一个全命令必经的发送闸门」；快照采集算法、输入注入语义、screencast 帧消费分别属维度 13/14/12，本维度只提供传输、分发与钩子，不做业务解释。

与维度 10 的衔接（两个入口契约）：

```
维度 10（进程管理）──CdpEndpoint{port, ws_path}──▶ 本维度 client::connect()
维度 10（崩溃重启）──◀─ CdpDisconnected / CdpReconnected 事件 ── 本维度
本维度（导航栈回写）──▶ Target/Page 事件流 ──▶ 维度 10 nav_stack
```

交付物（全部在 `crates/conex-browser` 内，本维度对应 `cdp/` 子模块）：

```
crates/conex-browser/src/
├── lib.rs                      # 对外门面：BrowserSession（连接+发送+事件+版本四合一）
└── cdp/
    ├── mod.rs
    ├── transport.rs            # WS 封装：握手/URL 拼接/心跳/断线检测/指数退避重连
    ├── client.rs               # 核心客户端：reader 循环/pending oneshot/事件扇出
    ├── types.rs                # JSON-RPC 信封 + 错误码映射 + 容错 deserializer
    ├── domains.rs              # 域子集类型化命令/事件包装（§3.3 清单）
    ├── sender.rs               # 统一发送层：审计/审批/急停/幂等/超时 五段管线
    ├── bus.rs                  # 事件总线：分类 router + typed 通道 + 帧专用通道
    ├── version.rs              # per-tab snapshotVersion 跟踪器 + global_epoch（§5.4 判定清单）
    ├── probe.rs                # 能力探测：CapabilityReport 生成与降级
    ├── dialog.rs               # 对话框/弹窗拦截状态机
    └── error.rs                # CdpErrorCode 映射 + BrowserError 分级
```

依赖红线（对齐维度 10 §1 与评审乙 §3.1「B9 评审面最小」）：仅 `tokio`（含 sync/net）、`tokio-tungstenite`、`futures-util`、`serde`、`serde_json`、`thiserror`、`tracing`、`socket2`（TCP keepalive）、`uuid`（重连标识）。**不依赖 agent-tools**（评审乙 §2.11 裁决：核心可单测，钩子 trait 化后由 conex-browser-tools 注入实现）。

---

## 2. 连接层（transport.rs + client.rs）

### 2.1 WS 建立：URL 拼接与身份校验

```
connect(endpoint: CdpEndpoint, expected: ExpectedBrowser) -> BrowserSession
  1. url = format!("ws://127.0.0.1:{}/{}", endpoint.port, endpoint.ws_path.trim_start_matches('/'))
     - 仅 loopback：port 来自 DevToolsActivePort（维度 10 §5.2），ws_path 为 Chrome 生成的
       per-session UUID 路径，全链路不落日志/事件（维度 10 §7.3 日志纪律）
  2. 握手：tokio_tungstenite::connect_async_with_config(url, max_message_size=None)
     - 不携带 Origin 头（Chromium 对 loopback + 无 Origin 放行；带陌生 Origin 反而可能 403）
     - WebSocketConfig{ max_message_size: None, max_frame_size: None }（大快照/帧不被截断）
  3. 身份校验三重（token 在 CDP 语境的落地，对齐维度 10 §7.2）：
     a. ws_path 即 bearer：无 path 无法建连（每会话随机，等效 token）
     b. Browser.getVersion 回包校验：产品名/版本与 ExpectedBrowser 一致 → 防错连遗留实例
     c. SessionToken 会话级绑定：profile 目录名 uuid 与引擎会话绑定（维度 10 §7.1）
  4. connect_with_headers 接口预留（agent-browser client.rs:78-96 同款）：仅供未来
     外部 CDP 代理端点（MCP 桥二期）需要自定义 header 时使用；主路径不用
```

CDP 握手原生不支持鉴权 header（Chrome 忽略非标准 header 且不校验），故「token 头」需求以上述三重校验落地而非自定义 header——这既是诚实表述也是安全面的实际收敛形态（维度 10 §7 已裁决）。

### 2.2 心跳与存活判定

| 层 | 机制 | 参数 | 作用 |
|---|---|---|---|
| WebSocket Ping | reader 循环外独立 keepalive 任务（agent-browser client.rs:206-218） | 间隔 30s，`Message::Ping(Vec::new())`；发送失败即退出 | 防中间代理掐空闲连接；半开检测 |
| TCP keepalive | socket2 `TcpKeepalive{ time: 30s, interval: 10s }`（client.rs:415-435） | best-effort，失败忽略 | 系统层兜底 |
| 应用层断线判定 | reader 循环退出（Close 帧/Err/EOF）→ 置 `ConnectionState::Lost` → 广播事件 → 清空 pending | — | 唯一可信断线信号：ping 无 pong 不判定（WS 标准允许对端不答 pong），由 TCP/reader 兜底 |
| 连接级超时 | 建连握手 10s；`Browser.getVersion` 校验 5s | — | 超时视为连接失败进入重试 |

### 2.3 超时策略（命令级）

| 类别 | 默认超时 | 覆盖方式 |
|---|---|---|
| 常规命令 | 30s（agent-browser client.rs:271 同款） | `send_command_with_timeout(method, params, session, timeout)` |
| 快速探针（liveness） | 1.5s（`Runtime.evaluate("1")`，browser.rs:749-760 同款） | 固定，不可覆盖 |
| 域 enable | 5s | 固定（启动路径用短超时快速失败，进能力探测降级） |

超时语义：pending 项移除 + `CommandError::Timeout{method, elapsed}`；**cancel 中间态必须清理**——外层取消（abort 抢断）时 `PendingGuard` 在 Drop 中移除 pending 项（agent-browser client.rs:48-71，防 #1528 孤儿泄漏），测试断言 `pending_len()==0`（client.rs:377-380 同款）。

### 2.4 重连策略（禁止每步重连的反面：断线才重连）

browser-use `dom/service.py:22-24` 自认「each step 新建 WS」是技术债；本设计**单长连接常驻**，仅在断线时触发重连，且重连后必须恢复可服务状态。

```
on_connection_lost():
  1. 置 ConnectionState::Lost；广播 ConnectionLost { attempt: 0 }
  2. 关闭全部 pending（oneshot 以 channel-closed 错误即刻返回，不等 30s 超时）
  3. 指数退避重连：1s → 2s → 4s → … 上限 30s（加 ±20% 抖动防共振）
  4. 重连成功 → 执行状态恢复流程（下）→ 广播 ConnectionRestored
  5. 重连失败持续 3 次且浏览器进程存活 → 上报 CdpDisconnected（维度 10 崩溃重启次级信号）
```

**重连后状态恢复清单**（幂等、可重入，全部走同一套 `restore_session` 流程）：

| # | 恢复项 | 动作 |
|---|---|---|
| 1 | 浏览器级 | `Browser.getVersion` 校验仍指向预期实例（错连 → 断开重来） |
| 2 | Target 发现 | `Target.setDiscoverTargets(true)` + `Target.getTargets` 重扫 |
| 3 | 会话重建 | 对存活 page 目标 `Target.attachToTarget(flatten)` 重获 session_id；被销毁的目标删除 |
| 4 | 域重 enable | 逐会话执行 §3.2 的 enable 序列（先 live 探测，防 Memory-Saver 挂起，browser.rs:653-674 同款） |
| 5 | 拦截恢复 | `Page.setWindowOpenHandler` / `Network.setBlockedURLs` 重挂 |
| 6 | 版本跳变 | 全部标签 snapshotVersion 跳变（+1000 量级）+ `global_epoch`+1 + 广播 `VersionReset`：全部旧快照失效 |
| 7 | 事件补发 | 广播 `TargetsReconciled { tabs }` 供维度 10 导航栈与面板对齐 |
| 8 | 崩溃联动 | 若重连因进程死亡失败 → 交由维度 10 崩溃重启（P0-6） |
| 9 | screencast 恢复 | `Page.startScreencast` 重启（帧率/质量参数以维度 12 为权威），并通知维度 12 重启帧通道（帧泵订阅 `ConnectionRestored` 驱动，R-9-3/M-3） |

**恢复期门禁（R-9-4）**：恢复清单全部完成前（含崩溃重启等待窗口，维度 10 状态机 `Launching`/`Crashed`），工具面不可用——工具调用返回结构化 `browser.not_ready`（错误码登记于维度 17），前端指示条显示「恢复中」；恢复完成（`ConnectionRestored` / `TargetsReconciled` 广播）后才恢复工具面与帧流。

### 2.5 并发命令管理

| 机制 | 实现 | 要点 |
|---|---|---|
| request id | `AtomicU64::new(1)` + `fetch_add`（SeqCst） | 单调递增；u64 溢出无需处理 |
| pending 表 | `Arc<Mutex<HashMap<u64, oneshot::Sender<CdpMessage>>>>` | 响应按 id 路由（client.rs:15, 175-180） |
| 取消 | `PendingGuard` Drop 清理 + `abort_token` 穿透 | 急停/接管时逐 id 关闭 sender，await 方立即收到取消错误 |
| 顺序 | 发送经 `Mutex<SplitSink>` 串行化 | 同连接内命令写序即 Chrome 处理序；响应与事件在 reader 循环内按 WS 帧序分发 |
| 并发上限 | 不设硬限（CDP 天然支持并发）；liveness 探针与常规命令互不阻塞 | 高并发由 pending map + 锁保护 |

**锁纪律（对齐 31-security-baseline B8，评审 21 低项 L2）**：本维度新增锁（pending 表 `Mutex<HashMap<u64, …>>` 等）一律恢复式——不加 `expect`/`unwrap`；锁中毒（`PoisonError`）转为 `CdpError::Internal` 错误返回，锁内不 panic。

---

## 3. 协议层（types.rs + domains.rs）

### 3.1 消息编解码（JSON-RPC 信封，照 agent-browser types.rs:53-97）

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpCommand {
    pub id: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,        // 双层路由：Some(session) → 目标会话，None → browser 级
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpMessage {                    // 响应与事件共用信封
    pub id: Option<u64>,                   // 有 id = 命令响应；有 method = 事件；二者必居其一
    pub result: Option<Value>,
    pub error: Option<CdpError>,
    pub method: Option<String>,
    pub params: Option<Value>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CdpError { pub code: Option<i64>, pub message: String, pub data: Option<String> }
```

**宽容解析铁律**（协议版本漂移的第一道防线，评审乙 §3.1/风险 4）：
- 信封字段全部 Option，未知字段不报错（serde 默认忽略）；
- 类型容错：`string_or_int` / `opt_vec_string_or_int` 自定义 deserializer（types.rs:7-47，Lightpanda 与 Chrome 类型不一致的既有先例）；
- 事件 params 解析失败 → 记 warning 丢弃该事件，不炸 reader 循环（**reader 永不 panic 退出**是防断连死循环的前提）；
- Binary 帧按 UTF-8 兜底解析（client.rs:129-134 同款，代理端点兼容）。

### 3.2 错误码映射（error.rs）

| CDP 错误码 | 名称 | 引擎映射 |
|---|---|---|
| -32700 | ParseError | `CdpError::Protocol`（不应出现，记审计） |
| -32600 | InvalidRequest | `CdpError::Protocol` |
| -32601 | MethodNotFound | `CdpError::DomainUnavailable{method}` → 能力探测记 unsupported（§6 降级） |
| -32602 | InvalidParams | `CdpError::BadParams{method}` |
| -32603 | InternalError | `CdpError::Internal{method}` |
| -32000 | ServerError | `CdpError::Server{code:-32000,message}`；对 `"Target closed"`/`"Cannot find context"` 特判为 `CdpError::ContextGone`（维度 14 导航竞态分类） |
| 无 error | — | result 缺省 `Value::Null` 返回 |
| 超时/断连 | — | `CdpError::Timeout` / `CdpError::ConnectionLost` / `CdpError::Cancelled`（abort） |

`CdpError` 实现 `Display` 输出 message（types.rs:82-86），**响应错误文本不嵌入敏感参数**（agent-browser commands.rs:190 先例）。

### 3.3 域子集命令/事件清单（domains.rs 类型化包装）

覆盖敲定清单 12 域并经 R-3 补齐后共 **13 域**；`▸` = 命令，`◂` = 订阅事件。总计 **约 72 命令 / 36 事件**（R-3 补齐口径，命令 59→约 72、事件 35→36）。

**Browser 域**（browser 级，无 session_id）
- ▸ `Browser.getVersion`｜连接校验与能力探测
- ▸ `Browser.close`｜优雅停止（维度 10 §6.3）
- ▸ `Browser.setDownloadBehavior`｜下载落盘（维度 17）
- ▸ `Browser.grantPermissions` / `resetPermissions`｜媒体/通知等权限显式授予（维度 17/12）
- ◂ `Browser.downloadWillBegin` / `downloadProgress`（可选订阅，维度 17 消费）

**Target 域**（browser 级）
- ▸ `Target.setDiscoverTargets`｜标签发现（重连恢复第 2 步）
- ▸ `Target.getTargets`｜全量目标枚举
- ▸ `Target.attachToTarget{flatten:true}`｜目标→会话绑定（**双层路由建立点**）
- ▸ `Target.detachFromTarget`｜会话释放
- ▸ `Target.createTarget` / `Target.closeTarget`｜新建/关闭标签
- ▸ `Target.activateTarget`｜激活/复活标签（liveness 兜底）
- ▸ `Target.setAutoAttach{flatten:true}`｜iframe 自动会话（跨域 iframe 独立 session，browser.rs:726-742）
- ◂ `Target.targetCreated` / `targetDestroyed` / `targetInfoChanged` / `attachedToTarget` / `detachedFromTarget`

**Page 域**（会话级）
- ▸ `Page.enable` / `setLifecycleEventsEnabled`
- ▸ `Page.navigate` / `reload` / `getNavigationHistory` / `navigateToHistoryEntry`
- ▸ `Page.getFrameTree`｜iframe 会话解析（维度 13 跨域采集）
- ▸ `Page.captureScreenshot`｜按需截图（维度 13 回显）
- ▸ `Page.getLayoutMetrics`｜视口/滚动尺寸采集（维度 13，R-3 补齐）
- ▸ `Page.startScreencast` / `stopScreencast`｜帧流开关（维度 12 消费，参数在维度 12 定）
- ▸ `Page.setWindowOpenHandler`｜window.open 收口（§7.2）
- ▸ `Page.handleJavaScriptDialog`｜对话框应答（§7.1）
- ▸ `Page.addScriptToEvaluateOnNewDocument`（受限白名单 + 审批，维度 14 用）
- ◂ `Page.frameStartedNavigating` / `frameNavigated` / `navigatedWithinDocument` / `frameAttached` / `frameDetached` / `frameStoppedLoading` / `domContentEventFired` / `loadEventFired` / `javascriptDialogOpening` / `javascriptDialogClosed` / `pageError` / `screencastFrame` / `screencastVisibilityChanged` / `fileChooserOpened`（维度 14 上传触发，R-3 补齐）

**Runtime 域**（会话级）
- ▸ `Runtime.enable` / `runIfWaitingForDebugger`（attach 后恢复，browser.rs:852-860）
- ▸ `Runtime.evaluate`（受限白名单 + 审批，维度 17 红线）
- ▸ `Runtime.callFunctionOn`（resolveNode 后节点操作，维度 14 定位链）
- ▸ `Runtime.getProperties`｜RemoteObject 属性展开（维度 13 监听器/对象探测，R-3 补齐）
- ▸ `Runtime.releaseObject`（object group 清理，防 RemoteObject 泄漏）
- ◂ `Runtime.executionContextCreated` / `executionContextDestroyed` / `executionContextsCleared` / `consoleAPICalled` / `exceptionThrown`

**DOM 域**（会话级）
- ▸ `DOM.enable`｜DOM 变更事件开关（snapshotVersion 推进的数据源之一）
- ▸ `DOM.getDocument` / `describeNode` / `resolveNode` / `getBoxModel` / `getContentQuads`｜定位链（维度 14）
- ▸ `DOM.pushNodesByBackendIdsToFrontend`｜backendNodeId → 前端节点（维度 14 定位链，R-3 补齐）
- ▸ `DOM.scrollIntoViewIfNeeded`｜滚动到可视（维度 14 滚动定位，R-3 补齐）
- ▸ `DOM.focus`｜节点聚焦（维度 14 聚焦，R-3 补齐）
- ▸ `DOM.querySelector` / `querySelectorAll`｜data-* 标记执行前校验（维度 14）
- ▸ `DOM.setFileInputFiles`｜上传（维度 14）
- ◂ `DOM.documentUpdated` / `childNodeInserted` / `childNodeRemoved` / `characterDataModified` / `attributeModified` / `attributeRemoved` / `setChildNodes`

**DOMSnapshot 域**（会话级，R-3 补齐）
- ▸ `DOMSnapshot.captureSnapshot`｜主采集通道（维度 13：DOM 快照树）
- ◂ 无订阅

**Accessibility 域**（会话级）
- ▸ `Accessibility.getFullAXTree` / `getPartialAXTree`（可选）｜AX 补充通道（维度 13）
- ◂ 无常驻事件（协议中 `loadComplete` 存在但 Chrome 不活跃推送，不订阅；AX 域无 enable 命令，探测用 getFullAXTree 冒烟）

**Network 域**（会话级）
- ▸ `Network.enable`
- ▸ `Network.getAllCookies` / `getCookies` / `setCookies` / `clearBrowserCookies`｜登录态读写（维度 16，App-Bound 回读校验）
- ▸ `Network.getResponseBody`（调试，维度 17 限权）
- ▸ `Network.setBlockedURLs`｜IP 直连阻断（维度 17 门禁三检查点之传输层）
- ◂ `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` / `loadingFailed` / `requestFailed`

**Input 域**（会话级）
- ▸ `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`（IME 安全兜底）/ `dispatchTouchEvent`（可选）｜统一注入管线（维度 12/14 共用）
- ◂ 无事件（用户物理输入不可见——协同检测走面板转发层，06 评审 §2.2 裁决）

**Emulation 域**（会话级）
- ▸ `Emulation.setDeviceMetricsOverride`（面板 resize） / `setUserAgentOverride` / `setEmulatedMedia` / `setGeolocationOverride`
- ◂ 无订阅（`visibleSizeChanged` 可选，不启用）

**Storage 域**（会话级）
- ▸ `Storage.clearDataForOrigin` / `getUsageAndQuota`（维度 16 登录态/配额）
- ▸ `Storage.getCookies` / `setCookies`（R-3 补齐，维度 16 cookie 回读/导出）
- ◂ 无订阅

**SystemInfo 域**（browser 级）
- ▸ `SystemInfo.getInfo` / `getProcessInfo`｜能力探测与诊断
- ◂ 无订阅

**Console 能力说明**：CDP 无独立 Console 域——控制台面由 `Runtime.consoleAPICalled`/`exceptionThrown`/`Page.pageError` 组合承载；敲定清单的「Console」即指该组合。浏览器级系统日志如需补充，可选 `Log.enable` + `Log.entryAdded`（默认不启用，调试场景开）。

**screencast 帧走专用通道不进 typed 总线**（§5.2）——`Page.screencastFrame` 仅扇出到帧流通道，事件计数不含它。

---

## 4. 统一发送层（sender.rs）

### 4.1 管线（五段，全命令必经）

```
send(cmd, ctx) ──▶ ① 幂等  ② 急停  ③ 审批  ④ 审计(before)  ⑤ 传输+超时  ⑥ 审计(after)
                     │       │       │        │              │             │
                     │       │       │        │              └─ pending oneshot
                     │       │       │        └─ 审计事件（脱敏，before 含目标摘要，after 含结果摘要）
                     │       │       └─ 审批回调（dangerous 命令等待；Deny → 不发送）
                     │       └─ 急停旗 AtomicBool + abort_token：置位即拒；在途命令被取消
                     └─ 幂等键去重：同 session+method+params hash 在途合并，重复调用共享同一 pending
```

| 段 | 触发条件 | 行为 |
|---|---|---|
| 幂等 | 工具层幂等键命中在途命令 | 不重复发送，共享同一 oneshot 结果（复用 agent-tools idempotency 语义，钩子面见下） |
| 急停 | `emergency_stop` 置位（急停按钮/全局快捷键） | 新命令直接拒绝 `CdpError::Cancelled(EmergencyStop)`；在途命令经 abort_token 逐 id 取消 |
| 审批 | `cmd.dangerous == true`（输入/上传/evaluate 等） | 挂起等待 `AskCallback`（引擎侧接 agent-tools `decide_command`）；Deny → 审计 + 拒绝 |
| 审计 | 全命令 | before：method/session/目标摘要（参数脱敏）；after：结果摘要（截断）+ 耗时 + 版本号 |
| 传输 | 全部通过 | §2.5 并发管理 + §2.3 超时 |

**审计事件复用 agent-tools 既有面**：`SecurityAuditSink::emit(&AgentEvent)`（audit.rs:23-26）与 `security_audit_event(...)`（audit.rs:109-127）；`operation = SecurityAuditOperation` 新增 `BrowserCommand` 变体（维度 17 接线时在 conex-types 扩展）。敏感事件独立类型：`NavigationBlocked` / `ApprovalDenied` / `EmergencyStop` / `Evaluate` / `CookiesRead`（04 文档 §10.2 清单）。

### 4.2 钩子 trait（conex-browser 定义，conex-browser-tools 注入实现）

```rust
/// 发送层策略钩子。conex-browser 不依赖 agent-tools：本 trait 在核心侧定义，
/// 引擎侧（conex-browser-tools）用 agent-tools 的审批/审计设施实现并注入。
#[async_trait]
pub trait CommandPolicyHooks: Send + Sync {
    /// 幂等判定：返回已有 in-flight 结果则短路（None = 继续发送）
    async fn idempotent(&self, key: &IdKey) -> Option<Result<Value, CdpError>>;
    /// 审批：Ok(())=放行；Err(Deny{reason})=拒绝（审计已由实现方发）
    async fn approve(&self, cmd: &CdpCommandView) -> Result<(), ApprovalDenied>;
    /// 审计发射（before/after 两相）
    fn audit(&self, event: BrowserAuditEvent);
    /// 急停旗（共享 AtomicBool，全局急停按钮置位）
    fn emergency_stop(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool>;
    /// abort 令牌（用户接管/急停时触发；取消全部在途命令）
    fn abort_token(&self) -> CancellationToken;
}

pub struct IdKey { pub session: Option<String>, pub method: String, pub params_hash: u64 }

pub struct CdpCommandView<'a> {          // 审计/审批视图：参数已脱敏
    pub method: &'a str, pub session: &'a str,
    pub target_summary: String,          // url/节点摘要，敏感字段 [REDACTED]
    pub dangerous: bool,
}

pub struct BrowserAuditEvent {
    pub phase: AuditPhase,               // Before / After / Denied / Blocked
    pub cmd: CdpCommandView,
    pub ok: bool,
    pub duration_ms: Option<u64>,
    pub snapshot_version: u64,           // 动作基于的页面版本（事后还原，13 文档 §4）
}
```

`CancellationToken`：`tokio_util::sync::CancellationToken` 若 workspace 已有则复用；否则自研 30 行 `watch<bool>` 实现（零新增依赖）。插桩点=唯一函数 `CommandSender::execute`，无旁路（`send_raw`/`send_command_no_wait` 也走本管线，仅跳审批的语义在视图层标注）。

---

## 5. 事件总线（bus.rs + version.rs）

### 5.1 事件类型（typed 枚举）

CDP 原始事件（`CdpEvent{method,params,session_id}`）经分类 router 转译为强类型 `BrowserEvent`，消费者不直接碰 `serde_json::Value`：

```rust
#[derive(Debug, Clone)]
pub enum BrowserEvent {
    // —— 连接面 ——
    ConnectionLost { attempt: u32 },
    ConnectionRestored { elapsed_ms: u64, epoch: u64 },         // epoch = global_epoch（R-1：跨标签失效语义）；维度 12 据此重启帧通道（R-9-3）
    // —— 导航面 ——
    NavigationStarted { session: String, frame: String, url: String },          // frameStartedNavigating
    Navigated { session: String, frame: String, url: String, main: bool },      // frameNavigated
    NavigatedWithinDocument { session: String, frame: String, url: String },    // SPA pushState/hash
    Lifecycle { session: String, frame: String, kind: LifecycleKind },          // domContent/loadEventFired
    // —— 目标/会话面 ——
    TargetCreated(TargetInfo), TargetDestroyed { target_id: String },
    TargetInfoChanged(TargetInfo),
    SessionAttached { target_id: String, session: String },
    // —— 内容变更面 ——
    DomChanged { session: String, kind: DomChangeKind },                        // §5.4 合并推进的输入
    // —— 对话框/弹窗面 ——
    DialogOpened(DialogInfo), DialogClosed { session: String, accepted: bool },
    WindowOpenRequested { url: String, session: String },                       // §7.2
    // —— 脚本/控制台面 ——
    Console { session: String, level: ConsoleLevel, text: String },
    PageError { session: String, text: String },
    // —— 网络面（维度 17 门禁/审计消费）——
    NetworkRequest { request_id: String, url: String, method: String },
    NetworkDone { request_id: String, ok: bool },
    // —— 版本面 ——
    VersionAdvanced { tab_id: String, from: u64, to: u64, reason: VersionReason },   // per-tab（R-1）
    VersionReset { epoch: u64, reason: VersionReason },          // 重连/崩溃重启：global_epoch+1，全部标签版本失效（R-1）
    // —— 标签页列表（重连对账）——
    TargetsReconciled { tabs: Vec<TabSummary> },
}
```

分类 router：`CdpEvent → Result<BrowserEvent, Ignored>`；未知 method 记 debug 忽略（宽容解析）；`Page.screencastFrame` 与 `screencastVisibilityChanged` 直接走帧通道不分类（§5.2）。

### 5.2 订阅/分发模型

| 通道 | 类型 | 容量 | 消费者 |
|---|---|---|---|
| typed 事件通道 | `tokio::sync::broadcast::Sender<BrowserEvent>` | 4096（agent-browser client.rs:115 同款） | 快照（版本）、导航栈（维度 10）、面板桥（Tauri emit）、工具层、审计 |
| 帧流通道 | `tokio::sync::mpsc::Sender<FrameChunk>` | 60 | 仅维度 12（独立消费，环形覆盖策略由维度 12 定） |

- **大消息隔离**：截图/快照等命令响应走 oneshot 直传（§2.5），不过总线；screencast 帧（JPEG base64 大消息）走专用 mpsc，不占 typed 广播容量、不拖慢事件顺序。
- **慢消费者**：broadcast 满 → `RecvError::Lagged(n)`；消费者按类型处置——版本跟踪器强制全量重对齐（广播 `VersionReset` 语义由引擎侧重快照兜底），导航栈重建。**broadcast 发送永不阻塞**（send 对 lagged 直接丢，由接收端自愈），杜绝消费者互相拖死。
- **订阅时序铁律**（agent-browser navigate 模式，browser.rs:887-889 同款）：**先 subscribe 后发送可能产生事件的命令**，再 await 目标事件——消除「事件先于订阅到达」的漏事件窗口；subscribe 返回 `Receiver<BrowserEvent>`（同步取历史：`try_recv` 直到当前游标）。

### 5.3 事件顺序保证

- 单一 reader 任务按 WS 帧序解析 → 逐条路由：命令响应经 pending oneshot（直传），事件经 broadcast 顺序 send。同通道内顺序 = 帧序（broadcast 保序语义）；**响应与事件分属两通道，不做跨通道排序承诺**——跨通道一致性一律用「订阅后等待事件」模式（上）。
- 提交顺序：reader 循环内「先响应后事件」的帧间顺序即 Chrome 发送顺序；对导航竞态判定（维度 14），以 `NavigationStarted` 事件为信号而非命令返回。

### 5.4 snapshotVersion 推进规则（version.rs）

版本号**按标签页独立**（R-1 裁决：多标签是产品能力，会话级单值会使非活跃标签的版本互相污染）：`snapshot_version(tab_id) -> u64`，每标签 `u64` 单调递增、只增不减，由 `VersionTracker`（`HashMap<TabId, u64>` + watch 通道）维护；会话级辅助 `global_epoch`（AtomicU64）用于跨标签事件（重连/崩溃重启）——跳变时全部标签版本失效。校验接口 `validate_snapshot(tab_id, version) -> Result<(), Stale>`（维度 13/14/15 共用契约，13 文档 §4）。

**推进判定清单**（分类 router 之后、VersionTracker 之前的一道纯函数 `should_bump(&BrowserEvent) -> Option<(TabId, VersionReason)>`，事件内 session/target 映射到 TabId；跨标签事件走 `global_epoch`）：

| # | 事件 | 推进 | 说明 |
|---|---|---|---|
| 1 | `Navigated{main:true}`（frameNavigated 主 frame） | ✅ 即时 +1 | 全量导航；语义「页面整体换代」 |
| 2 | `NavigatedWithinDocument` | ✅ 即时 +1 | SPA pushState/hash，DOM 常变但 URL 必变 |
| 3 | `DomChanged` 任意子类（childNodeInserted/Removed/characterDataModified/attributeModified/documentUpdated） | ✅ 合并窗口 +1 | **合并**：**200ms**（`VERSION_BUMP_COALESCE`，R-1 撤销 50ms）窗口内任意次 DOM 变更只推进一次（防事件风暴刷版本）；窗口结束提交 |
| 4 | `frameAttached`/`frameDetached`（iframe 增删） | ✅ 合并窗口 +1 | 归入 DOM 合并窗口 |
| 5 | `Lifecycle{loadEventFired}` | ✅ 合并窗口 +1 | 首载完成（通常已被 1 覆盖；重连恢复场景兜底「页面就绪」） |
| 6 | 用户输入注入（面板转发） | ✅ 即时 +1 | 引擎侧显式 `bump(tab_id, InputInjected)`（维度 12 §4.2 契约，R-1 新增行） |
| 7 | AI 动作执行成功 | ✅ 即时 +1 | 引擎侧显式 `bump(tab_id, ActionDone)`（维度 14 动作管线，R-1 新增行） |
| 8 | `TargetDestroyed`（活动标签关闭） | ✅ 即时 +1 | 页面消失即旧快照失效 |
| 9 | 重连恢复 / 崩溃重启 | ✅ 跳变 +1000 并广播 `VersionReset` | 全部标签 +1000 + `global_epoch`+1（维度 10 §6.4 契约，R-1 per-tab）；全部旧版本作废（旧版本 < 跳变后） |
| 10 | `Navigated{main:false}`（iframe 导航） | ✅ 合并窗口 +1 | 内容变更，归入 DOM 窗口 |
| 11 | `DialogOpened` / `DialogClosed` | ✅ 恒推进（即时 +1） | 对话框出现/关闭恒推进（**宁多勿漏**，R-1 撤销原「不推进」；关闭后的 DOM 变化由事件 3 兜底） |
| 12 | `Console` / `PageError` / `NetworkRequest` / `NetworkDone` | ❌ 不推进 | 脚本/网络活动不改变已渲染文档结构 |
| 13 | 滚动动作 | ❌ 不推进 | R-1 撤销原「滚动 bump」：滚动不推进版本（AI 滚动动作由事件 7 动作执行推进；滚动后的 DOM 变化由事件 3 兜底） |
| 14 | 心跳 / `ConnectionLost` | ❌ 不推进 | 连接面不影响页面内容 |
| 15 | `Runtime.executionContext*` | ❌ 不推进 | 执行环境变更不代表 DOM 变更 |

**合并窗口实现**：VersionTracker 内 `pending_bump: Option<VersionReason>` + `tokio::time::interval(200ms)` 常驻 flush 任务；导航类事件写入时若已有 pending 窗口 → 以导航语义立即提交并清窗口（导航优先于内容合并）。提交动作：原子 +1 → watch send → 广播 `VersionAdvanced{tab_id, from, to, reason}`。**提交时快照**：`capture_snapshot(tab_id)` 起始读版本、结束再读，不一致 → `StaleSnapshot`（13 文档 §4 契约）。

---

## 6. 能力探测（probe.rs）

### 6.1 探测流程（连接成功后一次性 + 重连后重跑）

```
probe() -> CapabilityReport
  1. Browser.getVersion           → protocolVersion / product / revision / userAgent / jsVersion
  2. SystemInfo.getInfo（失败可容忍）→ os/arch/model 等诊断字段
  3. 逐域 enable 冒烟（§3.2 顺序）：
     - Page/Runtime/DOM/Network：enable 后立即取消订阅测试不发（成功即 supported）
     - Accessibility：无 enable 命令 → getFullAXTree 空树冒烟（成功即 supported）
     - Input/Emulation/Storage/SystemInfo/DOMSnapshot：无 enable 语义 → 以「浏览器版本 ≥ 最低线」+ 命令依赖链推理（DOMSnapshot 另以 captureSnapshot 空页冒烟判定，R-3）
     - 失败分类：-32601 → unsupported；超时 → degraded（可能对话框阻塞，留待对话框状态机裁决）；
       其他错误 → error（记入报告）
  4. 汇总特征推断（§6.2）→ 生成 CapabilityReport
```

探测本身走 §4 发送层（全命令过闸门），单条 5s 超时，总耗时预算 ≤ 10s；**逐域并行**（受发送层并发管理约束，§2.5），保证 13 域冒烟收敛在预算内（评审 20 11-6）；探测结果缓存于会话，重连恢复流程（§2.4 第 4 步）后重跑。

### 6.2 能力报告结构

```rust
pub struct CapabilityReport {
    pub browser: BrowserVersion,              // 产品名/版本/协议版本/UA
    pub os_info: Option<SystemInfo>,          // SystemInfo.getInfo 原文或 None
    pub domains: Vec<DomainStatus>,           // 13 域逐项（R-3 补齐后）
    pub features: FeatureFlags,               // 由 domains 推断的功能旗标
    pub detected_at_ms: u64,
}

pub enum DomainStatus { Supported, Unsupported{ reason: String }, Degraded{ reason: String } }

#[derive(Default)]
pub struct FeatureFlags {
    pub screencast: bool,                     // Page 域支持
    pub snapshot_dom: bool,                   // DOMSnapshot + DOM + Runtime 域支持（R-3）
    pub snapshot_ax: bool,                    // Accessibility 域支持
    pub input_injection: bool,                // Input 域支持（P0-1 判定）
    pub cookie_readwrite: bool,               // Network + Storage 域支持（维度 16 依赖）
    pub iframe_sessions: bool,                // Target.setAutoAttach 支持（跨域采集依赖）
    pub emulation: bool,                      // Emulation 域支持（视口模拟）
}
```

### 6.3 降级策略（报告 → 行为）

| 探测结果 | 降级 |
|---|---|
| `screencast=false` | 维度 12 切「静态帧 + 事件提示」模式（08 文档风险 1 预案） |
| `snapshot_ax=false` | 维度 13 只用 DOM 主通道（AX 为可选增强，非致命） |
| `snapshot_dom=false` | 浏览器不可用 → 面板错误引导重装/回退（属致命） |
| `input_injection=false` | 禁用全部交互类工具，只读浏览 |
| `cookie_readwrite=false` | 维度 16 禁用复制/导入路径，仅面板登录 |
| `iframe_sessions=false` | 跨域 iframe 采集跳过（main frame 单会话，agent-browser 已容忍） |
| `emulation=false` | 固定初始视口，面板 resize 无效（提示） |
| 浏览器版本 < 最低线（如 Chromium 120） | 提示安装 CfT（维度 10 引导），能力按已探测子集运行 |

`CapabilityReport` 随 `browser://state-changed` 同批上抛（不含端点，维度 10 §7.3），并进入审计（报告本身无敏感字段）。

---

## 7. 对话框/导航拦截处理（dialog.rs）

### 7.1 JS 对话框（alert/confirm/prompt/beforeunload）

状态机（每会话一份）：

```
DialogState::None ──javascriptDialogOpening──▶ Open{ info: DialogInfo, opened_at }
   Open ──handleJavaScriptDialog 成功──▶ None（广播 DialogClosed）
   Open ──超时 30s 无应答──▶ 自动 dismiss(false) → None（广播 DialogClosed{accepted:false, auto:true}）
```

| 项 | 设计 |
|---|---|
| 上抛 | `DialogOpened(DialogInfo{ session, dialog_type, message, url, default_prompt })` 进 typed 总线 → 面板提示 + 工具层可应答 |
| 应答原语 | `handle_dialog(accept: bool, prompt_text: Option<&str>)` → `Page.handleJavaScriptDialog`（browser.rs:1647-1665 同款） |
| 阻塞识别 | 对话框打开期间渲染器命令必然超时——liveness 探针超时 + `DialogState::Open` → 判定 `DialogBlocked`（browser.rs:105-112 `RendererState::DialogBlocked` 同款），**不再误判为标签卡死**，不触发 activateTarget 复活 |
| 默认策略 | 上抛等待应答（协同语义：AI 触发对话框须用户可见）；**30s 超时自动 dismiss** 防动作链挂死（beforeunload 类常被页面用于拦截，超时语义可配置） |
| 并发安全 | 仅活动标签可 handle（页面暂停态天然串行）；切标签时保持各自 DialogState 独立 |

### 7.2 window.open 弹窗收口（维度 10 §3.2 第 15 行契约）

- 启动/重连时挂 `Page.setWindowOpenHandler`（`awaitingDebugger` 不启用，走同步 deny/allow 语义）：
  - 引擎默认策略 = **转为标签页**：收到 `WindowOpenRequested{url}` → `Target.createTarget(url)` 后允许页面继续（`window.open` 返回的新窗口句柄由页面自行处置，无碍）；
  - 域名门禁命中（维度 17）→ 拒绝打开 + 审计 `NavigationBlocked`；
  - 事件 `WindowOpenRequested` 上抛供面板指示。
- `--disable-popup-blocking` 已由维度 10 注入（10 文档 §3.2 第 15 行），保证登录/SSO 弹窗流不被浏览器原生拦截，全部改由我方 handler 裁决。

### 7.3 目标关闭/崩溃的特殊事件

| 事件 | 处理 |
|---|---|
| `Target.targetDestroyed`（活动标签） | 清理会话 → 广播 `TargetDestroyed` → 维度 10 导航栈移除 + snapshotVersion 推进（§5.4 #8）；切到剩余活动标签并重 enable（若全部关闭 → 新建 about:blank） |
| `Target.targetCrashed`（协议外扩展，非标准） | 若出现则广播 `TargetDestroyed` + 审计；Chrome 实际由 targetDestroyed 表达 |
| 进程死亡 → WS 断连 | §2.4 重连失败 → `CdpDisconnected` 上报维度 10 崩溃重启（P0-6） |
| 对话框未决时崩溃 | DialogState 随会话清理归 None；崩溃重启后重挂拦截（§2.4 第 5 步） |

---

## 8. 关键接口（lib.rs 对外门面）

```rust
pub struct BrowserSession {
    client: Arc<CdpClient>,           // 传输核心（client.rs）
    sender: CommandSender,            // §4 统一发送层
    bus: BusHandle,                   // typed 广播 + 帧 mpsc
    version: Arc<VersionTracker>,     // §5.4
    probe: OnceCell<CapabilityReport>,// §6
    dialogs: DialogRegistry,          // §7
    policy: Arc<dyn CommandPolicyHooks>,  // 引擎侧注入（conex-browser-tools）
}

impl BrowserSession {
    pub async fn connect(endpoint: CdpEndpoint, expected: ExpectedBrowser,
                         policy: Arc<dyn CommandPolicyHooks>) -> Result<Self, CdpError>;

    // —— 命令面（全过发送层）——
    pub async fn send<T: DeserializeOwned>(&self, cmd: Command) -> Result<T, CdpError>;
    pub async fn send_page<T>(&self, session: &str, method: &str,
                              params: impl Serialize) -> Result<T, CdpError>;   // 会话级快捷
    pub async fn send_browser<T>(&self, method: &str,
                                 params: impl Serialize) -> Result<T, CdpError>; // browser 级
    pub fn current_session(&self) -> Result<SessionRef, CdpError>;              // 活动标签会话

    // —— 事件面 ——
    pub fn subscribe(&self) -> broadcast::Receiver<BrowserEvent>;
    pub fn subscribe_frames(&self) -> mpsc::Receiver<FrameChunk>;               // 仅维度 12 调

    // —— 版本面（维度 13/14/15 契约，R-1 per-tab）——
    pub fn snapshot_version(&self, tab_id: &TabId) -> u64;
    pub fn validate_snapshot(&self, tab_id: &TabId, version: u64) -> Result<(), Stale>;
    pub fn bump(&self, tab_id: &TabId, reason: VersionReason);  // 用户输入注入 / AI 动作执行显式推进（R-1）

    // —— 探测/对话框 ——
    pub fn capability(&self) -> &CapabilityReport;
    pub async fn handle_dialog(&self, accept: bool, prompt_text: Option<&str>) -> Result<(), CdpError>;

    // —— 生命周期 ——
    pub async fn shutdown(&self);                                               // 急停/关闭：取消在途 + 断开 WS
}
```

**Tauri 接线**（S1 验收面）：事件经引擎 emit 桥以 `browser://*` 前缀出面板（ConnectionRestored/DialogOpened/NavigationStarted 等，与维度 10 的 `browser://state-changed` 命名空间合并）；**CDP 端点字符串永不进前端**（维度 10 §7.3 契约）；**恢复期（重连/崩溃重启完成前）前端指示条显示「恢复中」且工具面不可用**（工具调用返回 `browser.not_ready`，R-9-4）。

**与相邻维度接口**：

| 对接方 | 契约 |
|---|---|
| 维度 10（进程管理） | 收 `CdpEndpoint` 建连；发 `CdpDisconnected`/`ConnectionRestored`；收 `TargetsReconciled` 回写导航栈 |
| 维度 12（帧渲染） | `subscribe_frames()` 帧流 + `Page.startScreencast` 参数（帧率/质量在维度 12 定）；重连/崩溃重启后重启帧通道（`ConnectionRestored` 通知，R-9-3/M-3） |
| 维度 13（快照） | `snapshot_version(tab_id)` + `validate_snapshot(tab_id, version)` + `VersionAdvanced/Reset` 事件；采集前后版本一致性（Stale 判定） |
| 维度 14（动作） | `send_page` 原语 + `NavigationStarted` 竞态信号 + `ContextGone` 错误分类 |
| 维度 16（导入） | `Network.getAllCookies` + `Storage.getCookies`/`setCookies`（R-3）回读校验/导出 + `Storage.getUsageAndQuota` |
| 维度 17（安全） | `CommandPolicyHooks` 实现注入；`Network.setBlockedURLs`/`setWindowOpenHandler` 门禁接线；审计事件面 |

---

## 9. 验收标准（自测清单）

对齐 08 文档 §5 S1（命令/事件 e2e 通过；事件有序可断言）与评审乙 §3.1（mock WS 单测、对齐 agent-browser 320 单测量级、e2e `#[ignore]` 串行）。全部在 `crates/conex-browser` 内。

### 9.1 单测（fast，mock WS 服务端 `127.0.0.1:0`，agent-browser browser.rs:2627 先例）

| # | 测试名 | 断言要点 |
|---|---|---|
| 1 | `types::envelope_roundtrip` | 命令序列化/响应反序列化双向一致（含 sessionId 省略规则） |
| 2 | `types::tolerant_parse_unknown_fields` | 未知字段/类型漂移 → 宽容解析不报错 |
| 3 | `types::error_map_domain_not_implemented` | -32601 → DomainUnavailable；-32000+Context gone → ContextGone |
| 4 | `client::id_monotonic` | 并发 100 命令 id 严格递增无重复 |
| 5 | `client::cancel_cleans_pending` | await 中途 abort → `pending_len()==0`（#1528 回归断言） |
| 6 | `client::timeout_cleans_pending` | mock 不回包 + 短超时 → Timeout 且 pending 清空 |
| 7 | `client::response_routed_by_session` | 同 id 不同 session 响应路由正确 |
| 8 | `client::connection_close_flushes_pending` | 服务端关闭 → 全部 pending 立即 channel-closed（不等 30s） |
| 9 | `transport::heartbeat_sent_on_interval` | mock 端收到 Ping（间隔可注入） |
| 10 | `transport::backoff_sequence` | 1s→2s→4s 序列 + 抖动区间断言 |
| 11 | `transport::reconnect_restores_session` | 断线重连 → enable 序列重跑 → `VersionReset` 广播 → 全部标签 snapshot_version 跳变（+1000）+ global_epoch+1 |
| 12 | `bus::events_in_order` | 注入 N 事件 → 订阅者按序收到（顺序断言） |
| 13 | `bus::lagged_recovery` | 慢消费者 Lagged → 自愈路径（版本跟踪器重对齐） |
| 14 | `bus::screencast_isolated` | 帧事件不进 typed 通道 |
| 15 | `version::nav_bumps_immediately` | frameNavigated 主 frame → 即时 +1 且 VersionAdvanced 广播（per-tab，带 tab_id） |
| 16 | `version::dom_storm_merged` | 200ms 窗口内 50 次 DomChanged → 仅 +1 |
| 17 | `version::nav_preempts_window` | 窗口内导航事件 → 导航语义即时提交 |
| 18 | `version::console_not_bump` | console/network/滚动/心跳 → 版本不变 |
| 19 | `version::inject_and_dialog_bump` | 用户输入注入 / AI 动作 bump → 即时 +1；DialogOpened/Closed → 恒推进（撤销滚动 bump 回归，R-1） |
| 20 | `sender::pipeline_hooks_order` | 幂等→急停→审批→审计(before)→传输→审计(after) 顺序断言（RecordingHooks 实现） |
| 21 | `sender::emergency_stop_blocks_new` | 急停旗置位 → 新命令 Cancelled(EmergencyStop) |
| 22 | `sender::emergency_stop_cancels_inflight` | 在途命令经 abort_token 取消、pending 清零 |
| 23 | `sender::approval_denied_no_send` | Deny → 未发送 + 审计 Denied 事件 |
| 24 | `sender::idempotent_merges_inflight` | 同 IdKey 在途合并，仅一次 WS 发送 |
| 25 | `probe::unsupported_domain_reported` | mock enable 返回 -32601 → DomainStatus::Unsupported → FeatureFlags 关 |
| 26 | `probe::report_structure` | 13 域（R-3 补齐后）+ 特征旗标全部产出；耗时 ≤ 10s 预算断言（mock 快路径） |
| 27 | `dialog::state_transitions` | None→Open→Closed；超时自动 dismiss(false) |
| 28 | `dialog::blocked_not_misjudged` | DialogState::Open 下探针超时 → DialogBlocked 而非 revivable |
| 29 | `windowopen::deny_on_blocklist` | handler 命中门禁 → deny + NavigationBlocked 审计 |
| 30 | `reconnect::targets_reconciled_after_restore` | 重连后 TargetsReconciled 携带全部标签 |

### 9.2 e2e（`#[ignore]`，串行，需真实浏览器）

| # | 测试名 | 对应验收 | 场景 |
|---|---|---|---|
| E1 | `e2e_command_roundtrip` | S1 命令往返 | Browser.getVersion → Page.navigate → getNavigationHistory 回读 URL 一致 |
| E2 | `e2e_event_order_asserted` | S1 事件有序 | 导航后按序收到 NavigationStarted→Navigated→Lifecycle(load)；顺序断言 |
| E3 | `e2e_reconnect_recovers_state` | S1 断线重连 | 连接重建（模拟掉线重连）→ enable 恢复 → 版本跳变 → 导航仍可用 |
| E4 | `e2e_version_advance_on_nav` | S1 版本推进 | SPA 站点点击 pushState 链接 → VersionAdvanced 事件 + snapshot_version(tab_id) 递增 |
| E5 | `e2e_dialog_roundtrip` | 对话框 | alert() 页面 → DialogOpened → handle_dialog(true) → 页面继续 + DialogClosed |
| E6 | `e2e_dialog_timeout_dismiss` | 对话框 | 不应答 → 30s 自动 dismiss(false)（超时可注入缩短） |
| E7 | `e2e_window_open_rerouted` | 弹窗收口 | 点击 target=_blank → 新标签页出现且无独立窗口（targetCreated 断言） |
| E8 | `e2e_big_message_no_backpressure` | 大消息 | captureScreenshot 大响应经 oneshot 直传成功；typed 通道无 Lagged |
| E9 | `e2e_capability_report_real` | 能力探测 | 真实浏览器 13 域全 Supported；features 全 true |
| E10 | `e2e_connected_once_no_reconnect_per_step` | 禁每步重连 | 10 步命令序列内 WS 建连次数 == 1（counter 断言，反 per-step 回归） |

门禁口径：新增单测/e2e 后 `cargo test --workspace` 全绿（快层基线不回退）+ 前端门禁不受影响（本维度无前端改动）。

---

## 10. 风险与预案

| 风险 | 等级 | 预案 |
|---|---|---|
| 协议版本漂移（域/命令增减、字段类型变化） | 中 | CfT 版本钉死（维度 10 §2.2）+ 宽容解析（§3.1 容错 deserializer）+ `Browser.getVersion` 上报 + 能力探测降级（§6.3）；只跟进用到的 13 域（R-3 补齐后，评审乙风险 4） |
| 大消息背压（快照/截图/帧） | 中 | 响应 oneshot 直传不过总线 + screencast 帧专用 mpsc + broadcast Lagged 自愈 + `max_message_size=None` |
| 事件风暴（SPA 高频 DOM 变更） | 中 | 版本合并窗口（§5.4 #3）+ 帧流隔离（§5.2）+ 订阅按需 |
| 断线重连风暴（浏览器反复崩） | 中 | 指数退避（上限 30s）+ 3 次失败上报维度 10 崩溃重启；与维度 10 的 30s/3 次重启上限联动防循环 |
| 对话框挂死动作链 | 中 | 30s 自动 dismiss + DialogBlocked 诊断（不误判 revivable）+ beforeunload 语义可配置 |
| 半开连接（代理只吞不发） | 低 | WS Ping 30s + TCP keepalive + reader 退出即断线判定；不依赖 pong 应答 |
| 慢消费者拖死总线 | 低 | broadcast 发送永不阻塞 + Lagged 自愈语义 |
| 多客户端 enable 竞争（二期 MCP 共享端口） | 低 | 独立 target session + 先到先得 + 失败重试（评审乙风险 9；一期无此场景） |
| 响应 id 碰撞（负 id 调试代理流量） | 低 | pending map 只认自产正 id；未知 id 响应忽略（agent-browser 同款，client.rs:175-180） |
| 命令参数泄漏敏感值（审计/日志） | 中 | `CdpCommandView` 脱敏 + 响应错误不回显 secret（§4.2/§3.2） |

---

## 11. 参考实现对照（移植溯源）

| 本维度组件 | 参考实现 | 移植要点 |
|---|---|---|
| 客户端骨架（ws_tx/AtomicU64/pending/broadcast） | agent-browser cdp/client.rs:29-46, 125-199 | reader 循环分发响应/事件；连接关闭清空 pending |
| PendingGuard 取消清理 | client.rs:48-71, 256-284 | Drop 移除 pending；超时/取消不留孤儿（#1528） |
| keepalive（Ping 30s） | client.rs:17-19, 206-218 | 独立任务 + cancel watch |
| TCP keepalive | client.rs:415-435 | socket2 30s/10s |
| 消息信封/容错解析 | cdp/types.rs:53-97, 7-47 | string_or_int / 未知字段忽略 |
| 域 enable 序列 | native/browser.rs:710-744, 852-860 | Page/Runtime/Network/Target.setAutoAttach + runIfWaitingForDebugger |
| live 探测防挂起 | browser.rs:749-760, 827-850 | Runtime.evaluate("1") 1.5s 探针；Memory-Saver 标签复活 |
| 对话框处理 | browser.rs:1647-1665 + 105-112 | handleJavaScriptDialog；DialogBlocked 状态 |
| navigate 订阅模式 | browser.rs:887-889 | 先 subscribe 后发送 |
| mock WS 单测 | browser.rs:2627 | 127.0.0.1:0 listener |
| 每步重连反例 | browser-use dom/service.py:22-24 | 单长连接 + 断线才重连（本设计核心立场） |
| 双层路由（session 嵌套） | browser-use CDPSession 模型（06 评审 §3.1） | flatten attach + session_id 信封路由 |

---

## 12. 实施顺序建议（对齐 08 §4 S1）

1. **types.rs + error.rs + domains.rs 纯类型层**（单测 1-3 先行，无 I/O）；
2. **client.rs + transport.rs 传输核心**（单测 4-11：mock WS 服务端，含 PendingGuard 回归）；
3. **bus.rs + version.rs**（单测 12-19：事件顺序、版本推进判定清单全表）；
4. **sender.rs 统一发送层 + CommandPolicyHooks**（单测 20-24：管线顺序断言）；
5. **probe.rs + dialog.rs**（单测 25-30）；
6. **e2e E1-E10** 按序跑通（串行）；P0-1（Input 域实测）结论关联到 FeatureFlags.input_injection；
7. 引擎接线：Tauri emit 桥 `browser://*` + 维度 13/14/15 的 `snapshot_version(tab_id)`/`validate_snapshot` 契约冻结（R-1，S1 验收：命令/事件 e2e + 事件有序断言全绿）。
