# Rust 自动化工具与桌面/浏览器感知系统全盘审计报告

> **审计执行人**：全盘代码与测试审计师 05  
> **审计基准**：`docs/system-audit-and-redesign/00-战役通则与协同执行规范.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`AGENTS.md`  
> **审查范围**：`crates/conex-browser/`、`crates/conex-browser-tools/`、`crates/conex-computer/`、`crates/conex-computer-tools/`、`crates/conex-doc-collab/`  
> **审计原则**：只找问题、零废话、清理无用冗余、严禁打补丁与伪验证、问题同权。

---

## 目录

1. [审计概述与范围界定](#一审计概述与范围界定)
2. [第一维度：浏览器与 CDP 交互全盘审计](#二第一维度浏览器与-cdp-交互全盘审计)
   - [2.1 对话框状态机 Generation ABA 竞态与误判关闭](#21-对话框状态机-generation-aba-竞态与误判关闭)
   - [2.2 帧通道订阅一次性破坏与重连死锁/停滞风险](#22-帧通道订阅一次性破坏与重连死锁停滞风险)
   - [2.3 快照采集巨型 JSON 字符串化与内存颠簸](#23-快照采集巨型-json-字符串化与内存颠簸)
   - [2.4 恢复重连域 Enable 阻塞与未托管后台协程泄漏](#24-恢复重连域-enable-阻塞与未托管后台协程泄漏)
3. [第三维度：系统感知与 Computer Use 全盘审计](#三第二维度系统感知与-computer-use-全盘审计)
   - [3.1 UIA 焦点树上溯越界至 Desktop 根节点导致全桌面遍历雪崩](#31-uia-焦点树上溯越界至-desktop-根节点导致全桌面遍历雪崩)
   - [3.2 共享层 InputBackend 接口完全穿透并绕过急停（E-Stop）检查](#32-共享层-inputbackend-接口完全穿透并绕过急停e-stop检查)
   - [3.3 坐标系边界校验（Validate & Clamp）越界 1px 缺陷](#33-坐标系边界校验validate--clamp越界-1px-缺陷)
   - [3.4 屏幕捕获双重枚举开销与多显示器混合 DPI 拼接畸变](#34-屏幕捕获双重枚举开销与多显示器混合-dpi-拼接畸变)
4. [第四维度：死代码、过度设计与多余补丁全盘排查](#四第三维度死代码过度设计与多余补丁全盘排查)
   - [4.1 违背反过度设计铁律的预请求 DNS A/AAAA 解析器与双重 Gate 冗余](#41-违背反过度设计铁律的预请求-dns-aaaa-解析器与双重-gate-冗余)
   - [4.2 仓库遗留未清理的 `tmp_*` 临时探针测试文件](#42-仓库遗留未清理的-tmp_-临时探针测试文件)
   - [4.3 `conex-doc-collab` 历史战役残留的 Skeleton 仪式性假断言与包锚代码](#43-conex-doc-collab-历史战役残留的-skeleton-仪式性假断言与包锚代码)
5. [第五维度：测试资产有效性与 Mock 质量审查](#五第四维度测试资产有效性与-mock-质量审查)
   - [5.1 形式主义假断言与纯字符串包含测试](#51-形式主义假断言与纯字符串包含测试)
   - [5.2 未接线 Unwired Mock 与无故障注入能力的 MockSession](#52-未接线-unwired-mock-与无故障注入能力的-mocksession)
   - [5.3 缺乏真实并发与死锁验证的感知测试](#53-缺乏真实并发与死锁验证的感知测试)
6. [综合问题清单与重构整改建议矩阵](#六综合问题清单与重构整改建议矩阵)

---

## 一、审计概述与范围界定

本报告对 Conex 系统的自动化工具、桌面与浏览器感知基础设施进行全盘代码审查。涉及 5 个核心 Crates：

| Crate 名称                                                                             | 定位与核心职责                                            | 代码量（行） | 核心依赖                                            |
| :------------------------------------------------------------------------------------- | :-------------------------------------------------------- | :----------- | :-------------------------------------------------- |
| [`crates/conex-browser`](file:///c:/Software/conex/crates/conex-browser)               | 内置浏览器 CDP 传输、事件总线、快照、动作执行、Screencast | ~19,200      | `tokio-tungstenite`, `futures-util`, `serde_json`   |
| [`crates/conex-browser-tools`](file:///c:/Software/conex/crates/conex-browser-tools)   | AI 浏览器工具族（`browser_*` 导航/交互/感知/调试）        | ~5,600       | `agent-tools`, `conex-browser`                      |
| [`crates/conex-computer`](file:///c:/Software/conex/crates/conex-computer)             | 桌面键鼠模拟（Enigo/Win32）、屏幕捕获（xcap）、UIA 感知   | ~6,800       | `enigo`, `xcap`, `windows (UIA/COM)`, `windows-sys` |
| [`crates/conex-computer-tools`](file:///c:/Software/conex/crates/conex-computer-tools) | AI 电脑操作工具族（`computer_*` 动作/截屏/UIA 快照/急停） | ~4,200       | `agent-tools`, `conex-computer`                     |
| [`crates/conex-doc-collab`](file:///c:/Software/conex/crates/conex-doc-collab)         | 块树操作、文本 CRDT 引擎封装与协同基础设施                | ~8,400       | `yrs`, `loro (dev)`                                 |

---

## 二、第一维度：浏览器与 CDP 交互全盘审计

### 2.1 对话框状态机 Generation ABA 竞态与误判关闭

- **缺陷位置**：[`crates/conex-browser/src/cdp/dialog.rs:165-188`](file:///c:/Software/conex/crates/conex-browser/src/cdp/dialog.rs#L165-L188)
- **根因分析**：
  在 `DialogRegistry::spawn_timeout` 中，代码虽然在 `on_event` 时递增并传递了代次标识 `gen: u64`，但在异步休眠唤醒后的判断逻辑中，将 `gen` 变量显式丢弃（`let _ = gen;`），仅通过 `matches!(states.get(&session), Some(DialogState::Open { .. }))` 判断状态。
  ```rust
  // crates/conex-browser/src/cdp/dialog.rs:170-187
  tokio::spawn(async move {
      tokio::time::sleep(timeout).await;
      let still_open = matches!(
          states.lock().unwrap_or_else(|p| p.into_inner()).get(&session),
          Some(DialogState::Open { .. })
      );
      if !still_open {
          return;
      }
      let _ = gen; // ❌ 严重隐患：代数检查被完全忽略！
      tracing::info!("对话框超时自动 dismiss：session={session}");
      auto_dismiss(&session);
      let mut guard = states.lock().unwrap_or_else(|p| p.into_inner());
      guard.insert(session, DialogState::None);
  });
  ```
- **危害与故障场景**：
  若在同一会话中，对话框 A 在 t=0 触发（超时 30s），用户在 t=29s 处理了对话框 A，紧接着页面在 t=29.5s 弹出了新的对话框 B。在 t=30s 时，对话框 A 的超时协程唤醒，发现当前状态仍然是 `Open`（实际是对话框 B），于是立即触发 `auto_dismiss` 并清空状态。这导致新弹出的对话框 B 仅存在 0.5 秒就被强行关闭，引发不可预期的交互丢失。

---

### 2.2 帧通道订阅一次性破坏与重连死锁/停滞风险

- **缺陷位置**：[`crates/conex-browser/src/cdp/bus.rs:277-284`](file:///c:/Software/conex/crates/conex-browser/src/cdp/bus.rs#L277-L284)、[`crates/conex-browser/src/frames/session.rs:376`](file:///c:/Software/conex/crates/conex-browser/src/frames/session.rs#L376)
- **根因分析**：
  `BusHandle` 中的帧流接收端被设计为独占 `Mutex<Option<Receiver<FrameChunk>>>`。当第一次调用 `subscribe_frames()` 时，通过 `guard.take()` 取出接收端。若后续再次调用（例如重建 `ScreencastSession` 或发生重连恢复），`guard.take()` 返回 `None`，代码回退创建了一个容量为 1 且 Sender 立即被丢弃的虚拟通道：
  ```rust
  // crates/conex-browser/src/cdp/bus.rs:277-283
  pub fn subscribe_frames(&self) -> tokio::sync::mpsc::Receiver<FrameChunk> {
      let mut guard = self.frame_rx.lock().unwrap_or_else(|p| p.into_inner());
      guard.take().unwrap_or_else(|| {
          tracing::warn!("帧流接收端已被消费（重复订阅），返回空通道");
          let (_tx, rx) = tokio::sync::mpsc::channel(1);
          rx // ❌ 空通道永远无法接收到真实帧数据！
      })
  }
  ```
- **危害与故障场景**：
  当前端或上层生命周期重新初始化 `ScreencastSession::new` 时，新实例持有的 `frames_rx` 将是一个死通道，永远不会产出新帧，导致视频流画面静止死锁，且不会报错。

---

### 2.3 快照采集巨型 JSON 字符串化与内存颠簸

- **缺陷位置**：[`crates/conex-browser/src/snapshot/collect.rs:856-870`](file:///c:/Software/conex/crates/conex-browser/src/snapshot/collect.rs#L856-L870)、[`crates/conex-browser/src/snapshot/collect.rs:1261-1273`](file:///c:/Software/conex/crates/conex-browser/src/snapshot/collect.rs#L1261-L1273)
- **根因分析**：
  为了评估 CDP 响应的原始负载大小以进行预算控制，代码对解析后的 `serde_json::Value` 直接调用 `.to_string().len()`：
  ```rust
  // crates/conex-browser/src/snapshot/collect.rs:1261-1262
  let snapshot_bytes = snapshot_value.to_string().len();
  let dom_bytes = dom_value.to_string().len();
  ```
- **危害与故障场景**：
  `snapshot_value` 与 `dom_value` 是包含数万个 DOM 节点及其样式的巨型 JSON 对象（通常 2MB~10MB）。每次快照捕获时，在堆上完整分配并序列化出一个数兆字节的临时字符串，仅为了获取长度后立即销毁。这在高频快照或多标签场景下会导致严重的 GC 压力、内存抖动和 CPU 尖峰。

---

### 2.4 恢复重连域 Enable 阻塞与未托管后台协程泄漏

- **缺陷位置**：[`crates/conex-browser/src/lib.rs:218-229`](file:///c:/Software/conex/crates/conex-browser/src/lib.rs#L218-L229)、[`crates/conex-browser/src/lib.rs:330-430`](file:///c:/Software/conex/crates/conex-browser/src/lib.rs#L330-L430)
- **根因分析**：
  1. 在 `restore_session` 恢复流程中，代码串行遍历所有标签并调用 `enable_domains`。每个标签的 `enable_domains` 包含 6 次 CDP 交互（超时各为 5s）。如果某个被挂起的标签无响应，将导致整个重连恢复链条阻塞 5s~30s。
  2. 在 `BrowserSession::connect` 中，启动了 4 个独立的后台 `tokio::spawn` 任务（`spawn_event_pump`、`spawn_version_driver`、`dialogs rx loop`、`active tabs rx loop`），但 `BrowserSession` 结构体本身未持有这些 `JoinHandle`。若调用方仅丢弃 `BrowserSession` 而未显式调用 `Transport::shutdown`，这些任务将持续运行直到底层广播通道完全断开，存在协程生命周期脱节与泄漏隐患。

---

## 三、第二维度：系统感知与 Computer Use 全盘审计

### 3.1 UIA 焦点树上溯越界至 Desktop 根节点导致全桌面遍历雪崩

- **缺陷位置**：[`crates/conex-computer/src/perception.rs:488-498`](file:///c:/Software/conex/crates/conex-computer/src/perception.rs#L488-L498)
- **根因分析**：
  在 `UiaPerception::snapshot` 中，为了获取活动窗口的根元素，代码从当前焦点元素开始向上遍历父节点：
  ```rust
  // crates/conex-computer/src/perception.rs:488-498
  let focused = self.automation.GetFocusedElement().map_err(|e| {
      PerceptionError::NoActiveWindow
  })?;
  let mut root_el: IUIAutomationElement = focused;
  while let Some(parent) = self.parent_of(&root_el) {
      root_el = parent; // ❌ 致命缺陷：一路向上直到 Desktop 根节点！
  }
  let raw = self.read_node(&root_el, 0);
  Ok(build_snapshot(&raw))
  ```
  在 Windows UI Automation 规范中，顶层窗口的父节点就是 **桌面根元素（Desktop Root Element，`UIA_RootControlTypeId`）**。
- **危害与故障场景**：
  `while let Some(parent)` 循环不会在顶层窗口停止，而是直接上溯到了系统桌面根节点。随后 `self.read_node(&root_el, 0)` 开始以桌面为根遍历整个 Windows 系统的所有屏幕、所有后台应用程序、任务栏和托盘图标。遍历立即在第 1~2 层触顶 `MAX_TREE_NODES (2000)` 并截断，导致最终采集到的快照根本不是当前活动窗口的 UI 控件树，而是系统任务栏和桌面图标的残缺片段。

---

### 3.2 共享层 InputBackend 接口完全穿透并绕过急停（E-Stop）检查

- **缺陷位置**：[`crates/conex-computer/src/action.rs:1007-1081`](file:///c:/Software/conex/crates/conex-computer/src/action.rs#L1007-L1081)
- **根因分析**：
  `OsInputBackend` 实现了跨 crate 共享的 `conex_shared::input::InputBackend` trait，但其 trait 方法实现中：
  1. `click`（第 1026 行）和 `scroll`（第 1059 行）直接调用了旧的 `run_steps(&mut enigo, &steps)`，而 `run_steps` 内部硬编码传入 `stop: None`（第 581 行），直接丢弃了急停标志。
  2. `mouse_move`（第 1007 行）和 `button`（第 1030 行）未包含任何急停检查逻辑。
- **危害与故障场景**：
  当外部通过抽象的 `Arc<dyn InputBackend>` 接口调用输入模拟时（如通过插件或工具共享总线），急停系统（Emergency Stop）完全失效，无法在急停置位时中止鼠标移动、点击或滚动操作，存在严重的安全防护穿透风险。

---

### 3.3 坐标系边界校验（Validate & Clamp）越界 1px 缺陷

- **缺陷位置**：[`crates/conex-computer/src/coord.rs:123-128`](file:///c:/Software/conex/crates/conex-computer/src/coord.rs#L123-L128)、[`crates/conex-computer/src/coord.rs:133-137`](file:///c:/Software/conex/crates/conex-computer/src/coord.rs#L133-L137)
- **根因分析**：
  在基于 0 索引的像素坐标系中，宽度为 `W` 的有效坐标区间应为 `[0, W - 1]`。
  但代码中的边界检查与钳制函数使用了包含等于号的条件：
  ```rust
  // crates/conex-computer/src/coord.rs:123-125
  pub fn validate_api(&self, p: Point) -> Result<Point, CoordError> {
      if p.x < 0 || p.y < 0 || p.x > self.target_w as i32 || p.y > self.target_h as i32 {
          Err(CoordError::CoordsOutOfBounds)
      } else { ... }
  }
  // crates/conex-computer/src/coord.rs:133-136
  pub fn clamp_phys(&self, p: Point) -> Point {
      let x = p.x.clamp(self.origin_x, self.origin_x + self.phys_w as i32);
      let y = p.y.clamp(self.origin_y, self.origin_y + self.phys_h as i32);
      Point::new(x, y)
  }
  ```
- **危害与故障场景**：
  当 `p.x == target_w` 时，换算后的物理坐标为 `origin_x + phys_w`。在 Windows 多显示器无缝拼接场景下，该坐标已经溢出当前主屏幕并落入相邻右侧屏幕的第 0 像素，导致点击位置漂移到错误显示器。

---

### 3.4 屏幕捕获双重枚举开销与多显示器混合 DPI 拼接畸变

- **缺陷位置**：[`crates/conex-computer/src/screen.rs:228-241`](file:///c:/Software/conex/crates/conex-computer/src/screen.rs#L228-L241)、[`crates/conex-computer/src/screen.rs:144-162`](file:///c:/Software/conex/crates/conex-computer/src/screen.rs#L144-L162)
- **根因分析**：
  1. `capture_once` 在单次截屏中连续调用了两次 `xcap::Monitor::all()`：第一次在 `Self::query_layout()` 中枚举并读取所有显示器属性；第二次紧随其后再次枚举所有显示器以捕获图像。
  2. `compose_scale_encode` 在画布拼接时，直接将各屏幕图像按物理坐标偏移粘贴到 `canvas` 上，但未对不同 DPI 缩放比的屏幕（如主屏 4K 150% + 副屏 1080P 100%）进行物理/逻辑像素对齐归一化处理。
- **危害与故障场景**：
  在混合 DPI 多屏环境下，截屏合成产物会出现画面错位、重叠或黑边，进而导致视觉模型看到的坐标与注入后端 `SetCursorPos` 实际到达的物理坐标产生偏差。

---

## 四、第三维度：死代码、过度设计与多余补丁全盘排查

### 4.1 违背反过度设计铁律的预请求 DNS A/AAAA 解析器与双重 Gate 冗余

- **缺陷位置**：[`crates/conex-browser/src/gate.rs:34-46`](file:///c:/Software/conex/crates/conex-browser/src/gate.rs#L34-L46)、[`crates/conex-browser-tools/src/gate.rs:38-46`](file:///c:/Software/conex/crates/conex-browser-tools/src/gate.rs#L38-L46)
- **根因分析**：
  在 `AGENTS.md`（第 8 条）与 `ANTI_OVERENGINEERING_GUARDRAILS.md` 中明确规定严禁引入 **「预请求 DNS A/AAAA 解析器」**。
  然而，代码库中同时存在两套庞大的域名门禁实现：
  1. `conex-browser/src/gate.rs` 中的 `FormalDomainGate`（1,210 行），实现了同步 `ToSocketAddrs` 解析、60 秒重绑定窗口缓存与时钟抽象。
  2. `conex-browser-tools/src/gate.rs` 中的 `MvpDomainGate`（673 行），重复实现了完全一致的 `SystemResolver`、IP 字面量黑白名单与正则匹配。
- **危害与故障场景**：
  1. **代码重复率极高**：两处近 1,900 行代码维护着高度重叠的域名与 IP 匹配规则。
  2. **异步运行时阻塞隐患**：在 Tokio 协程中同步调用系统 `ToSocketAddrs` 进行 DNS 解析，若网络缓慢或 DNS 服务器不可达，会直接阻塞 Tokio Worker 线程。

---

### 4.2 仓库遗留未清理的 `tmp_*` 临时探针测试文件

- **缺陷位置**：
  - `crates/conex-browser/tests/tmp_payload_probe.rs`（252 行）
  - `crates/conex-browser/tests/tmp_perf_matrix_probe.rs`（356 行）
  - `crates/conex-browser/tests/tmp_setcookies_probe.rs`（264 行）
  - `crates/conex-browser/tests/tmp_xframe_probe.rs`（367 行）
- **根因分析**：
  上述 4 个文件头部均明确标注了：
  ```rust
  //! 临时探针（...；用完即删，不入库）：
  ```
  这些文件是历史重构阶段用于性能测量和数据采集的临时脚本，共计 1,239 行，但在战役结束后未被及时清理，长期滞留在集成测试目录中，拖慢整体测试运行时间并污染测试矩阵。

---

### 4.3 `conex-doc-collab` 历史战役残留的 Skeleton 仪式性假断言与包锚代码

- **缺陷位置**：[`crates/conex-doc-collab/src/w6_a_s.rs`](file:///c:/Software/conex/crates/conex-doc-collab/src/w6_a_s.rs)、[`crates/conex-doc-collab/src/w6_d_s.rs`](file:///c:/Software/conex/crates/conex-doc-collab/src/w6_d_s.rs)、[`crates/conex-doc-collab/tests/w6_d_s_a_col_subset.rs`](file:///c:/Software/conex/crates/conex-doc-collab/tests/w6_d_s_a_col_subset.rs)
- **根因分析**：
  在 `conex-doc-collab` 中存在大量名为 `W6-A-S`、`W6-D-S` 的模块与测试文件。这些文件充斥着对静态字符串常量和元数据的假校验：
  ```rust
  // crates/conex-doc-collab/src/w6_a_s.rs:84-99
  assert_eq!(W6_A_S_PACKAGE_ID, "W6-A-S");
  assert!(W6_A_S_PACKAGE_ID.ends_with("-S"));
  assert!(does_not_close_el01_or_w6_a());
  assert!(W6_A_S_NOT_CLOSING.iter().any(|s| s.contains("EL-01")));
  ```
  这些代码是前期战役用于防假关审计的元数据锚点，不包含任何真实的文档协同业务逻辑，形成了冗余的形式主义测试资产。且根据当前战役通则（§4.2），Markdown 编辑器已规划收拢为 TypeScript 插件体系（`@crish/plugin-markdown-editor`），这些残留的 Rust 结构需要精简与解耦。

---

## 五、第四维度：测试资产有效性与 Mock 质量审查

### 5.1 形式主义假断言与纯字符串包含测试

- **缺陷位置**：[`crates/conex-doc-collab/tests/w6_d_s_a_col_subset.rs:42-59`](file:///c:/Software/conex/crates/conex-doc-collab/tests/w6_d_s_a_col_subset.rs#L42-L59)
- **分析证据**：
  测试用例仅对字符串常量进行子串包含断言：
  ```rust
  let honest = "W6-D-S ≠ W6-D / ≠ EL-04 满关";
  assert!(honest.contains("≠ W6-D"));
  assert!(honest.contains("≠ EL-04"));
  ```
  此类断言不涉及任何实际代码逻辑运行，对软件质量和正确性起不到任何保护作用，属于必须清理的无意义断言。

---

### 5.2 未接线 Unwired Mock 与无故障注入能力的 MockSession

- **缺陷位置**：[`crates/conex-browser/src/import/verify.rs:36-37`](file:///c:/Software/conex/crates/conex-browser/src/import/verify.rs#L36-L37)、[`crates/conex-browser-tools/tests/common/mod.rs:133-155`](file:///c:/Software/conex/crates/conex-browser-tools/tests/common/mod.rs#L133-L155)
- **分析证据**：
  1. `verify.rs` 中的 `UnwiredCdpCookieReader` 仅返回 `Err(VerifyError::NotImplemented("...待进程管理接线（TODO）"))`，导致回读校验测试全部跳过了真实 CDP 验证链路。
  2. `conex-browser-tools` 的测试替身 `MockSession` 仅能返回预设的固定数据（如 `{"frameId": "F1"}`），无法模拟网络中断、慢渲染器超时或目标标签崩溃等异常路径，导致工具层的大多数异常恢复逻辑缺乏有效的集成测试覆盖。

---

### 5.3 缺乏真实并发与死锁验证的感知测试

- **缺陷位置**：[`crates/conex-computer/tests/perception_source.rs`](file:///c:/Software/conex/crates/conex-computer/tests/perception_source.rs)、[`crates/conex-computer-tools/src/tests.rs`](file:///c:/Software/conex/crates/conex-computer-tools/src/tests.rs)
- **分析证据**：
  现有的感知源测试主要集中在单线程静态 `RawNode` 纯函数树转换上。对于 Windows 真实环境下 `UiaPerception` 的 COM MTA 线程模型、高频截屏并发、以及输入模拟中按键未释放的边界情况，缺乏针对性的并发压力与死锁测试验证。

---

## 六、综合问题清单与重构整改建议矩阵

遵循**纯逻辑规划、问题同权、不谈工期、直指根因**的原则，汇总本次审计发现的全部缺陷与重构目标：

| 编号        | 模块 / 文件域                                                   | 缺陷性质           | 根因与现象                                                    | 重构与修复方案（优雅内化）                                                                                          |
| :---------- | :-------------------------------------------------------------- | :----------------- | :------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------ |
| **BUG-01**  | `conex-browser/src/cdp/dialog.rs`                               | 状态机竞态         | 忽略 `gen` 代次标识导致对话框超时误杀后续新对话框             | 将 `gen` 存入 `DialogState::Open { gen, .. }`，超时唤醒时严格比对代次，不匹配则静默退出。                           |
| **BUG-02**  | `conex-browser/src/cdp/bus.rs`                                  | 资源破坏           | `subscribe_frames` 的 `take()` 操作导致二次订阅获得空通道     | 将帧流接收模式改造为支持生命周期重置的重订阅机制，或通过广播分发帧通知。                                            |
| **BUG-03**  | `conex-computer/src/perception.rs`                              | 遍历逻辑越界       | 焦点上溯循环直达 Desktop 根节点，遍历全系统窗口导致数据失效   | 在 `parent_of` 上溯时增加顶层窗口识别断言（检测 `ControlType == Window` 或匹配有效 HWND），到达窗口层即刻停止上溯。 |
| **BUG-04**  | `conex-computer/src/action.rs`                                  | 安全检查穿透       | `InputBackend` trait 实现调用 `run_steps` 时传入 `stop: None` | 统一 `InputBackend` 内部实现，全面接入 `run_steps_guarded` 与 `EmergencyStop` 轮询检查。                            |
| **BUG-05**  | `conex-computer/src/coord.rs`                                   | 边界越界 1px       | `validate_api` 与 `clamp_phys` 使用 `>=` 导致坐标落入屏幕外   | 严格限制坐标区间为 `[0, width - 1]` 与 `[0, height - 1]`，修正边界判定。                                            |
| **PERF-01** | `conex-browser/src/snapshot/collect.rs`                         | 内存颠簸           | 对巨型 `Value` 调用 `.to_string().len()` 估算体积             | 采用流式计数器或基于 AST 节点估算字节数，杜绝整包转字符串带来的内存分配。                                           |
| **PERF-02** | `conex-computer/src/screen.rs`                                  | 重复系统调用       | 单次截屏中重复调用 `Monitor::all()`                           | 统一截屏流程，仅在单次遍历中完成几何属性更新与图像数据拉取。                                                        |
| **RED-01**  | `conex-browser/src/gate.rs` & `conex-browser-tools/src/gate.rs` | 过度设计与代码冗余 | 违背反过度设计红线引入 DNS 解析器，两处存在 1900 行重复实现   | 彻底拔除预请求 DNS 解析器，域名过滤收敛为统一的轻量级纯域名匹配模块。                                               |
| **RED-02**  | `conex-browser/tests/tmp_*_probe.rs`                            | 死代码/测试残留    | 4 个已过期的临时探针测试文件（1239 行）滞留仓库               | 彻底清理删除所有 `tmp_*_probe.rs` 文件，保持测试目录干净。                                                          |
| **RED-03**  | `conex-doc-collab`                                              | 形式主义测试资产   | 包含大量仪式性字符串断言与过期包锚验证代码                    | 清理 `w6_a_s` 与 `w6_d_s` 中的虚假字符串断言，聚焦核心 CRDT 算法与状态收敛测试。                                    |
