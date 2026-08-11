# 电脑操作二期（S6 前置）—— 共享层 trait 设计

> 状态：设计文档（S6 前置产物，供 S6 实施轮直接派单）。
> 输入：`04-二期立项-电脑操作.md` §3（共享层核对结论：6 复用 + 2 需抽象 + 1 接口抽取）、§2 S6（抽象化与双实现对等）；
> `source/18-维度-电脑操作二期与共享层.md` §10（trait 签名草案）与 §5（适配点）；
> 仓库现状签名核对（本文件 §2，全部为只读代码确认）。
> 产出范围：`FrameSource` / `InputBackend` 两个 trait 定稿 + 动作前检查器接口抽取 + 兼容性/侵入面分析 + 依赖方向建议 + S6 落地清单。`PerceptionSource`（S2 面）与 `ScaleCoordinator` 仅在本文件标注并入位置，不展开设计。

---

## 1. 结论速览

1. **trait 落点**：新建叶子 crate `conex-shared`（04 §2 文件域与 18 §5 复用原则指定；权衡见 §7）。`conex-browser` 与 `conex-computer` 各依赖之，共享抽象不反向依赖任何实现侧。
2. **FrameSource 定稿**：在 18 §10 三方法（next_frame/request_sync_frame/set_frame_policy）基础上补齐生命周期（start/stop）、帧订阅（subscribe → FrameStream）、状态投影（status）——浏览器侧 `CdpScreencastSource` 包装 `ScreencastSession`（纯加法适配器）；桌面侧 `DesktopCaptureSource` 包装既有 `ScreenCapture`。
3. **InputBackend 定稿**：对齐 18 §10 八方法全形，修订 1 处（`click` 增加 `count: ClickCount` 参数——双击/三击间隔必须由后端生成，04 §2.1 语义）。浏览器侧 `CdpInputBackend` 把方法序列映射为既有 `InputCmd` 经 `InputPipeline::dispatch` 注入；桌面侧既有 `OsInputBackend` 改造为内可变后直接实现。
4. **动作前检查器**：抽共享 `ActionTargetGate` trait（`check(&ActionTarget)`），两线各一实现：浏览器线 `BrowserTargetGate`（委托既有 `DomainGate`，`ActionExecutor` 检查点位置不动）；桌面线 `WindowTargetGate`（白名单标题/进程 + 提权探测 → `tool.computer.elevated_window`）。
5. **侵入面**：浏览器线**行为零改动**——新增文件 3 个适配器 + 1 个共享 crate；既有文件仅 lib.rs 模块声明与两处 Cargo.toml 依赖声明（接线级）；`FrameOut`/12 字节定长头协议/`ActionExecutor` 全部不动。

---

## 2. 现状签名核对（只读代码确认）

### 2.1 帧面（FrameSource 语义对等点）

| 对等点              | 现状签名（证据）                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ScreencastSession` | `new(session: Arc<BrowserSession>, config: ScreencastConfig) -> Self`（`conex-browser/src/frames/session.rs:255`）；`start(&self) -> Result<(), ScreencastError>`（`:314`）；`stop(&self)`（`:344`）；`shutdown(&self)`（`:357`）；`subscribe_frames(&self) -> FrameReceiver`（`:396`，独占消费槽）；`set_fps_level(&self, level: FpsLevel)`（`:416`）；`mark_input/mark_burst`（`:424/:429`）；`status()/subscribe_status()/subscribe_events()/stats()`（`:381-411`） |
| `FrameReceiver`     | `recv(&self) -> Option<FrameOut>`（挂起等帧，销毁返回 None）；`recv_timeout`（`frames/sink.rs:118-144`）                                                                                                                                                                                                                                                                                                                                                               |
| `FrameOut`          | `{ seq: u64, width: u32, height: u32, data: Vec<u8> }`（JPEG 字节，`frames/sink.rs:22-31`）                                                                                                                                                                                                                                                                                                                                                                            |
| 背压                | `FrameSink` 满时丢队首保新帧（`frames/sink.rs:58-70`，§2.4 丢旧保新）                                                                                                                                                                                                                                                                                                                                                                                                  |
| 恢复                | 监督任务订阅 `ConnectionRestored` → 自动重启 + 泵代数重置（`session.rs:554-629`，R-9-3）                                                                                                                                                                                                                                                                                                                                                                               |
| 帧率档              | `FpsLevel { Base/Interactive/Burst }`（≈8/15/20fps，ack pacing 换算，`frames/fps.rs`）                                                                                                                                                                                                                                                                                                                                                                                 |
| 消费面              | app 侧 `frame_stream.rs`：12 字节定长头（seq/width/height u32 小端）+ JPEG 负载 → Tauri Channel（`apps/agent-workbench/src-tauri/src/browser/frame_stream.rs:10-18`，前端 `frameProtocol.ts` 双端对齐）                                                                                                                                                                                                                                                                |

### 2.2 输入面（InputBackend 语义对等点）

| 对等点          | 现状签名（证据）                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InputCmd`      | 语义化命令枚举：`MouseMove/MousePress/MouseRelease/Wheel/Scroll/KeyDown/KeyUp/Text`（`conex-browser/src/input/mod.rs:63-133`）                                                                                                                 |
| `InputPipeline` | `dispatch(&self, cmd: InputCmd) -> Result<(), InputError>`（no-wait 快速路径 + 单消费者保序 + bump 即时 +1，`input/pipeline.rs:133`）；`attach_activity`（`:157`，注入成功回调 → 帧率升降档）                                                  |
| `to_cdp`        | `InputCmd → (method, params)`（省略字段不发 null，`input/mod.rs:173-358`）；修饰键位掩码 1=Alt 2=Ctrl 4=Meta 8=Shift（§3.1）                                                                                                                   |
| 键名查表        | `action/keyboard.rs::lookup_key`（KEY_MAP：key → KeySpec{vk, code, modifier_mask}，12 文档 §4.1 AI 路径复用）                                                                                                                                  |
| 桌面侧既有      | `conex-computer/src/action.rs::inject::OsInputBackend`（enigo 0.6.1 + 直连 SetCursorPos/GetCursorPos；key/type_text/click/mouse_button/drag/scroll/hold_key/press_modifiers/release_modifiers，`action.rs:343-691`；**方法均为 `&mut self`**） |

### 2.3 门禁面（动作前检查点）

- `DomainGate` trait：`check(&self, url: &str) -> Result<(), GateDenial>`（`conex-browser/src/action/gate.rs:24-25`；`GateDenial { url, reason }`；`UnwiredGate` 未接线兜底）。
- 检查点位置：`ActionExecutor::run_once` 第①步门禁（`action/mod.rs:393-399`，`self.gate.check(&url)`）；`with_gate` 注入（`mod.rs:328`）。
- 唯一权威实现：`conex-browser-tools/src/gate.rs::MvpDomainGate`（scheme 门禁 → IP 字面量 → 解析级校验，17 §4；`gate.rs:228-316`）；引擎侧经 `BrowserToolsConfig.gate` 注入（`conex-browser-tools/src/lib.rs:116/137-143`）。
- 消费面：`ActionExecutor` 字段 `gate: Arc<dyn DomainGate>`（`action/mod.rs:302`）；测试 mocks `AllowGate/DenyGate`（`action/mocks.rs:667/684`）。

### 2.4 桌面线既有成果（conex-computer，S1/S2 已落盘）

- `crates/conex-computer/`（**未入 workspace members、未 git 提交**，`git status` 显示 `?? crates/conex-computer/`；Cargo.lock 无条目）：
  - `src/action.rs`：`Action` 动作枚举 + 参数校验纯函数 + `chunk_text`（50 字符/块）+ `OsInputBackend`（Windows，enigo）。
  - `src/coord.rs`：`Point { x: i32, y: i32 }`、`ScaleSpec`（origin/phys/target，API↔物理双向换算 + 校验链）、`choose_target`（XGA/WXGA/FWXGA 容差选择）。
  - `src/screen.rs`：`MonitorInfo/DesktopLayout`（18 §4.3 布局表语义）、`layout_from_raw`、`compose_scale_encode`（合成 + CatmullRom + PNG）、`ScreenCapture`（xcap，`capture() -> CapturedFrame`，重试 3 次；`CapturedFrame { seq, width, height, data }` 已是 FrameOut 语义）。
- 结论：桌面侧帧产出与注入后端均已存在，**S6 无需重写，只需「提升共享类型 + 对齐 trait 签名」**；crate 命名（04 文档写 `conex-desktop`，实际为 `conex-computer`）差异见 §9 开放问题 1。

---

## 3. FrameSource trait 设计

### 3.1 设计原则

1. **对象安全 + 共享引用**：18 §10 草案为 `&mut self` 拉取式（`async fn next_frame(&mut self)`），无法经 `Arc<dyn FrameSource>` 共享调用（app 侧接线面是共享引用）。定稿统一 `&self` + `async_trait`（仓库既有 async-trait 依赖）。
2. **生命周期入 trait**：18 §10 只给了取帧面；`ScreencastSession` 的 start/stop/恢复是操作语义，面板与互斥切换（S3 清理清单①）必须能启停帧源——故补 start/stop/status。
3. **订阅而非直拉**：浏览器侧帧是「泵推入槽、`FrameReceiver` 拉取」的独占消费形态（`sink.rs` take_receiver 契约）；trait 用 `subscribe() -> Box<dyn FrameStream>` 对齐该独占契约，两线消费形态同构。
4. **背压/恢复为实现内语义**：trait 不规定队列策略，契约注明「帧可丢、画面追最新」；恢复（浏览器重连自愈 / 桌面捕获重试）留在实现内，trait 只暴露 `status()` 供投影。

### 3.2 共享类型与 trait 签名（定稿）

```rust
// conex-shared/src/frame.rs —— 帧源抽象（18 §5 项 1 / §10 定稿）

/// 帧图格式（浏览器线 JPEG；桌面线 PNG/JPEG 可配，§3.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FrameFormat { Jpeg, Png }

/// 帧率档位（跨线语义档：浏览器线映射 FpsLevel，桌面线映射事件驱动/轮询）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FrameRate {
    /// 事件驱动（桌面线默认：UI/输入事件触发捕获，不轮询）
    EventDriven,
    /// 低档（浏览器线 Base ≈ 8fps；桌面线 ≈ 2fps 轮询）
    Low,
    /// 交互档（浏览器线 Interactive ≈ 15fps；桌面线 ≈ 3-5fps）
    Interactive,
    /// 突发档（浏览器线 Burst ≈ 20fps）
    Burst,
}

/// 运行期帧策略（start 初始档 + set_frame_policy 运行期调档）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FramePolicy {
    pub rate: FrameRate,
    pub format: FrameFormat,
    /// JPEG 质量档（50-75 有效面；PNG 无损忽略）。
    pub quality: Option<u8>,
}

/// 共享帧（浏览器侧由 FrameOut 转换，format 补 Jpeg；桌面侧 PNG 原生）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    pub format: FrameFormat,
    pub data: Vec<u8>,
}

/// 帧源状态（浏览器侧映射 ScreencastStatus，session.rs:51-61）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameSourceStatus { Idle, Starting, Active, Stopping }

#[derive(Debug, thiserror::Error)]
pub enum FrameSourceError {
    #[error("帧源已激活（重复 start）")]
    AlreadyActive,
    #[error("帧源未启动")]
    NotActive,
    #[error("帧源已关闭（消费端流终止）")]
    Closed,
    #[error("帧源失败：{0}")]
    Failed(String),
}

#[async_trait]
pub trait FrameSource: Send + Sync {
    /// 启动帧流（幂等拒绝：Active/Starting 时返回 AlreadyActive）。
    async fn start(&self, policy: FramePolicy) -> Result<(), FrameSourceError>;
    /// 停止帧流（幂等；停帧后订阅流仍可排空已入队帧）。
    async fn stop(&self) -> Result<(), FrameSourceError>;
    /// 订阅帧输出流（独占消费契约，同 FrameReceiver；重复订阅返回 Err）。
    fn subscribe(&self) -> Result<Box<dyn FrameStream>, FrameSourceError>;
    /// 动作后同步回显帧（实现内语义：流内取下一帧；桌面线亦可单帧直捕）。
    async fn request_sync_frame(&self) -> Result<Frame, FrameSourceError>;
    /// 运行期调档（帧率/质量/格式请求；实现内可降级，如浏览器线格式恒 JPEG）。
    fn set_frame_policy(&self, policy: FramePolicy);
    /// 当前状态（面板投影/互斥切换清理断言用）。
    fn status(&self) -> FrameSourceStatus;
}

#[async_trait]
pub trait FrameStream: Send {
    /// 取下一帧（空时挂起；背压契约：队列满时实现内丢旧保新——帧可丢，画面追最新；
    /// 源停止并排空后返回 Err(Closed)）。
    async fn next_frame(&mut self) -> Result<Frame, FrameSourceError>;
}
```

### 3.3 与 18 §10 草案的差异（定稿说明）

| 18 §10 草案                      | 定稿                                                                              | 理由                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `next_frame(&mut self)` 拉取式   | 拆为 `subscribe() -> Box<dyn FrameStream>` + `FrameStream::next_frame(&mut self)` | 对象安全 + 独占订阅契约对齐 `FrameReceiver`（sink.rs take_receiver 语义）；拉取端可独占持有流句柄                     |
| 无 start/stop/status             | 补 `start(policy)/stop()/status()`                                                | `ScreencastSession` 生命周期是操作语义（S3 切换清理清单①「停止 screencast 帧源」必须走 trait）；面板状态投影需 status |
| `set_frame_policy(&mut self, p)` | `set_frame_policy(&self, policy)`                                                 | 共享引用面；浏览器侧映射 `set_fps_level`（session.rs:416），`&self` 成立                                              |
| 无帧格式字段                     | `Frame.format` + `FrameFormat`                                                    | 桌面线 PNG vs 浏览器线 JPEG，前端渲染需 MIME 判定（§9 开放问题 6）                                                    |
| `Frame` 未定义                   | 定义 `{ seq, width, height, format, data }`                                       | 对齐 `FrameOut`（sink.rs:22）并补 format                                                                              |

### 3.4 浏览器侧适配点（`CdpScreencastSource`，最小改动面）

| trait 方法                 | 适配实现（委托既有面）                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start(policy)`            | 帧率档映射（`FrameRate → FpsLevel`：Low→Base / Interactive→Interactive / Burst→Burst）→ `set_fps_level` 初始化 + `ScreencastSession::start()`（session.rs:314）；quality/format 由构造期 `ScreencastConfig` 决定（格式恒 Jpeg，策略降级） |
| `stop()`                   | `ScreencastSession::stop()`（session.rs:344）                                                                                                                                                                                             |
| `subscribe()`              | 取一次 `subscribe_frames()`（session.rs:396）包成 `FrameStream` 适配器（`recv() → Frame`，None → Err(Closed)）                                                                                                                            |
| `request_sync_frame()`     | 已启动：流内取下一帧；未启动：Err(NotActive)（浏览器线动作后回显走既有 screenshot 工具面，不依赖本方法——语义注记见 §9 开放问题 5）                                                                                                        |
| `set_frame_policy(policy)` | `set_fps_level`（帧率档）+ `mark_input/mark_burst` 活动信号语义由调用方经既有方法驱动；质量/格式降级忽略                                                                                                                                  |
| `status()`                 | `ScreencastStatus → FrameSourceStatus` 投影（session.rs:381）                                                                                                                                                                             |

**适配器构造**：`CdpScreencastSource::new(session: Arc<ScreencastSession>)`——会话由 app 侧按既有流程懒创建（frame_stream.rs 现状不变），适配器**不替换**既有 `frame_stream.rs` 接线，仅作为共享层消费面的新入口。恢复（ConnectionRestored 自动重启）由 `ScreencastSession` 监督任务自愈（session.rs:554-629），适配器零参与。

### 3.5 桌面侧实现说明（`DesktopCaptureSource`，conex-computer）

- 包既有 `ScreenCapture`（screen.rs:177-261，xcap + 重试）：`start(policy)` 按 policy.rate 启动捕获循环（EventDriven = 事件驱动单帧槽；Low/Interactive = 2-5fps 轮询档），产出 `CapturedFrame → Frame`（format 依 policy 为 Png 或 Jpeg 质量档）。
- 背压：内部 latest-slot（Notify 唤醒），捕获写入时覆盖旧帧（丢旧保新，与 FrameSink 语义一致）。
- 隐私联动：UIA 密码框聚焦暂停捕获（04 §4.5 数据面抑制）由桌面会话层调用 `stop()`/恢复实现，trait 面零感知。
- 布局表变化（热插拔）→ 感知版本号推进在桌面会话层，不在 trait 面。

---

## 4. InputBackend trait 设计

### 4.1 共享类型与 trait 签名（定稿）

```rust
// conex-shared/src/input.rs —— 输入注入抽象（18 §5 项 3 / §10 定稿）

/// 物理像素坐标（虚拟桌面原点可负；API 空间换算由 ScaleCoordinator 完成，后端不感知缩放）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PhysicalPoint { pub x: i32, pub y: i32 }

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum MouseButton { Left, Middle, Right, Back, Forward }

/// 点击次数语义（双击/三击间隔由后端生成，≤ 系统双击时间，04 §2.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ClickCount { Single, Double, Triple }

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ScrollDirection { Up, Down, Left, Right }

/// 归一化键名 newtype（04 §2.4 键名规范；跨平台解析在实现侧注册表，共享层不校验）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct KeyName(pub String);

#[derive(Debug, thiserror::Error)]
pub enum InputBackendError {
    #[error("输入注入失败：{0}")]
    Failed(String),
    #[error("输入后端未接线")]
    Unavailable,
    #[error("输入被急停中断")]
    Aborted,
}

#[async_trait]
pub trait InputBackend: Send + Sync {
    /// 移动光标（物理像素）。
    async fn mouse_move(&self, p: PhysicalPoint) -> Result<(), InputBackendError>;
    /// 点击系列：带坐标先移动；带修饰键按住点击（ctrl+click）；count 由后端生成间隔。
    async fn click(
        &self,
        btn: MouseButton,
        count: ClickCount,
        p: Option<PhysicalPoint>,
        mods: &[KeyName],
    ) -> Result<(), InputBackendError>;
    /// 按下/抬起分离原语（作用于当前光标位置）。
    async fn button(&self, btn: MouseButton, down: bool) -> Result<(), InputBackendError>;
    /// 拖拽：按下起点 → 分步插值移动 → 终点抬起。
    async fn drag(&self, from: PhysicalPoint, to: PhysicalPoint) -> Result<(), InputBackendError>;
    /// 滚动（方向 + 量；带坐标先移动；带修饰键按住滚动）。
    async fn scroll(
        &self,
        dir: ScrollDirection,
        amount: u32,
        p: Option<PhysicalPoint>,
        mods: &[KeyName],
    ) -> Result<(), InputBackendError>;
    /// 文本输入（内部按 50 字符分块 + 12ms 节流；每块写入前自查急停，04 §2.3）。
    async fn type_text(&self, text: &str) -> Result<(), InputBackendError>;
    /// 组合键（修饰键按序 down → 主键 down/up → 修饰键逆序 up）；hold_ms = Some 按住后松开。
    async fn key(&self, keys: &[KeyName], hold_ms: Option<u32>) -> Result<(), InputBackendError>;
    /// 光标位置查询（物理坐标）。
    async fn cursor_position(&self) -> Result<PhysicalPoint, InputBackendError>;
}
```

### 4.2 与 18 §10 草案的差异（定稿说明）

| 18 §10 草案                    | 定稿                                               | 理由                                                                                                        |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `click(btn, p, mods)` 无次数   | `click(btn, count: ClickCount, p, mods)`           | 双击/三击间隔必须由后端生成（04 §2.1「由后端生成间隔 ≤ 系统双击时间」），工具层三次调用无法保证系统双击语义 |
| `KeyName` 未定义               | `KeyName(pub String)` newtype                      | 类型安全 + 跨平台注册表在实现侧（04 §2.4 KeyNameRegistry 属桌面线）                                         |
| 错误面未定义                   | `InputBackendError { Failed/Unavailable/Aborted }` | 急停中断（Aborted）需区别于注入失败（04 §4.3 在途批次自查语义）                                             |
| `scroll(dir, amount, p, mods)` | 同左                                               | 无修订                                                                                                      |

### 4.3 浏览器侧适配点（`CdpInputBackend`）—— 与既有 `InputCmd` 的映射

适配器持有 `Arc<InputPipeline>`（构造注入，app 侧既有实例）+ `MouseState`（`RwLock<{ last_pos, last_buttons }>`，内部状态仅浏览器线需要——CDP mouseMoved 必须携带当前按压状态，§3.2）。

| trait 方法                           | InputCmd 序列（经 `InputPipeline::dispatch`，pipeline.rs:133）                                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mouse_move(p)`                      | `MouseMove { x, y, button: 当前按压键, buttons: 状态位, modifiers: 0 }`（mod.rs:65-71）                                                                                                                                                                                |
| `click(btn, Single, p, mods)`        | ① mods 非空：修饰键 `KeyDown`（查表 `action/keyboard.rs::lookup_key`，§4.1 复用）→ ② p 存在：`MouseMove` → ③ `MousePress { click_count: 1 }` → `MouseRelease { click_count: 1 }` → ④ 修饰键逆序 `KeyUp`                                                                |
| `click(btn, Double/Triple, p, mods)` | 同上但 click_count = 2/3（§3.5 点击判定：CDP clickCount 由 Chrome 判定双击/三击语义，间隔由浏览器生成）                                                                                                                                                                |
| `button(btn, down)`                  | `MousePress`/`MouseRelease { click_count: 1 }`（位置 = MouseState.last_pos，CDP 无光标查询）                                                                                                                                                                           |
| `drag(from, to)`                     | `MouseMove(from)` → `MousePress(Left)` → 分步 `MouseMove`（步长对齐桌面 DRAG_STEP_PX 语义）→ `MouseRelease(Left)`                                                                                                                                                      |
| `scroll(dir, amount, p, mods)`       | 归一化像素增量 `delta = amount × 120`（§3.4 归一化后的像素增量）：Up/Down → deltaY（Up 为负）/ Left/Right → deltaX（Left 为负）→ `Wheel { x, y, delta_x, delta_y, buttons, modifiers }`（mod.rs:91-98）；mods → 修饰键位掩码（1=Alt 2=Ctrl 4=Meta 8=Shift，mod.rs:11） |
| `type_text(text)`                    | 按 50 字符分块（复用 `chunk_text` 语义，conex-computer action.rs:331 同构）→ 每块 `Text { text }` + 12ms 间隔                                                                                                                                                          |
| `key(keys, hold_ms)`                 | 修饰键按序 `KeyDown` → 主键 `KeyDown`/`KeyUp`（可打印字符携带 text，§3.3）→ 修饰键逆序 `KeyUp`；hold_ms=Some：主键 `KeyDown` → sleep → `KeyUp`                                                                                                                         |
| `cursor_position()`                  | 返回 `MouseState.last_pos`（浏览器线无 OS 光标，语义注记见 §9 开放问题 4）                                                                                                                                                                                             |

**关键不变量**：适配器只消费 `InputPipeline` 的 pub 面（dispatch/attach_activity），管线内部（保序/no-wait/bump）零改动；`InputCmd`/`to_cdp` 原样复用，不新增 CDP 方法。

### 4.4 桌面侧实现说明（既有 `OsInputBackend` 对齐改造）

- 现状：全部方法 `&mut self`（enigo 句柄独占，`conex-computer/src/action.rs:343-691`）——为满足 trait `&self`，包 `Mutex<Enigo>`（std 互斥即可，注入为同步原语）。
- 对齐缺口（S6 需补的方法签名扩展）：`click` 增加坐标与修饰键参数（现状 `click(button, count)` 无坐标/修饰键，`action.rs:568`；补 move-then-click 与 press/release_modifiers 组合，复用既有 `press_modifiers/release_modifiers` `action.rs:647/658`）；`scroll` 增加坐标与修饰键（现状 `scroll(direction, amount)` `action.rs:630`）。
- 无需新写：`key/type_text/button/drag/cursor_position` 既有实现直接对齐（`type_text` 已含 50 字符分块 + 12ms 节流，`action.rs:545`；hold_key 语义并入 `key(keys, hold_ms)`）。
- 急停：`type_text` 分块间自查 `abort_token`（04 §4.3）由桌面会话层在调用 trait 前后接线（trait 面不持有 token；Aborted 错误由实现返回）。

---

## 5. 动作前检查器接口抽取（ActionTargetGate）

### 5.1 设计：`check(url)` → `check(&ActionTarget)`

04 §3 项 9 核对结论「接口抽取：动作前检查点框架存在，检查器实现替换」。抽取为共享 trait，目标描述从 URL 泛化为枚举：

```rust
// conex-shared/src/gate.rs —— 动作前检查点抽象（04 §3 项 9）

/// 动作目标（检查点输入）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ActionTarget {
    /// 浏览器线：目标页面 URL（既有 DomainGate 检查点输入）。
    Url(String),
    /// 桌面线：目标窗口（标题 + 进程名；进程名可空 = 仅标题匹配，04 §4 白名单窗口）。
    Window { title: String, process: Option<String> },
}

/// 拒绝分类（工具层错误码映射面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetDenialKind {
    /// 白名单外（浏览器线域名门禁 / 桌面线窗口白名单）。
    Whitelist,
    /// 提权窗口（桌面线 R3 → tool.computer.elevated_window）。
    Elevated,
    /// 其它（目标类型不适用 / 未接线等）。
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetDenial {
    pub kind: TargetDenialKind,
    /// 被拒绝目标的展示串（URL 或「标题 (进程)」，审计载荷用）。
    pub target: String,
    pub reason: String,
}

/// 动作前检查点（两线各一实现；检查点在审批**之前**，04 §4.6 守卫次序）。
pub trait ActionTargetGate: Send + Sync {
    fn check(&self, target: &ActionTarget) -> Result<(), TargetDenial>;
}
```

### 5.2 两线实现说明

| 实现                | 位置                                                                | 行为                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BrowserTargetGate` | `conex-browser/src/adapters/browser_target_gate.rs`（新增，纯加法） | `Url(url)` 分支委托内部 `Arc<dyn DomainGate>::check(url)`（错误映射为 `TargetDenial{ kind: Whitelist, .. }`）；`Window` 分支返回 `kind: Other`「目标类型不适用」。**不替换** `ActionExecutor::run_once` 第①步既有 `self.gate.check(&url)`（action/mod.rs:393-399 不动）——`BrowserTargetGate` 仅服务共享层消费者与对等测试      |
| `WindowTargetGate`  | `conex-computer/src/security/window_gate.rs`（新增）                | `Window{title, process}` 分支：① 提权探测（目标窗口进程提权 → `kind: Elevated`，reason 携带 `tool.computer.elevated_window` 语义，04 §6.2 风险 R3）→ ② 白名单匹配（标题/进程；白名单为空 = 默认放行，04 §4 项 6 可选默认关）；`Url` 分支返回「目标类型不适用」。检查点接线：S5 工具面执行前（互斥守卫之后、审批之前，04 §4.6） |

**接线原则**：浏览器线动作执行面（ActionExecutor/ops.rs）与工具面（conex-browser-tools）零改动；共享 trait 供「未来统一动作执行器」与桌面线使用。若后续要求浏览器线也走共享 trait，可在 ActionExecutor 增加可选第二检查器字段——本设计不预埋（保持最小侵入，§6 侵入面结论）。

---

## 6. 兼容性分析与侵入面

### 6.1 浏览器线侵入面清单

| 文件                                                           | 改动类型       | 内容                                                                                                               |
| -------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `crates/conex-shared/`（新 crate）                             | 新增           | frame.rs / input.rs / gate.rs / coord.rs（§7 依赖方向）                                                            |
| `crates/conex-browser/src/adapters/screencast_source.rs`       | 新增（纯加法） | `CdpScreencastSource`（§3.4）                                                                                      |
| `crates/conex-browser/src/adapters/cdp_input_backend.rs`       | 新增（纯加法） | `CdpInputBackend`（§4.3）                                                                                          |
| `crates/conex-browser/src/adapters/browser_target_gate.rs`     | 新增（纯加法） | `BrowserTargetGate`（§5.2）                                                                                        |
| `crates/conex-browser/src/lib.rs`                              | 接线级         | 新增 `mod adapters;` 声明（±1 行）+ 可选 `pub use`                                                                 |
| `crates/conex-browser/Cargo.toml`                              | 接线级         | 新增 `conex-shared` 依赖声明                                                                                       |
| 根 `Cargo.toml`                                                | 接线级         | workspace members 增加 `crates/conex-shared`（+ 一并入 `crates/conex-computer`，见 §9 开放问题 1）                 |
| `apps/agent-workbench/src-tauri/src/browser/frame_stream.rs`   | **零改动**     | 12 字节定长头 + JPEG 协议不动（frame_stream.rs:10-18）；桌面帧走新 `desktop_frame_stream` 命令（04 §3 其他对接点） |
| `conex-browser/src/frames/*`（session.rs/sink.rs/fps.rs）      | **零改动**     | `FrameOut`/`FrameReceiver`/`FrameSink` 不迁移不修改——共享 `Frame` 由适配器转换                                     |
| `conex-browser/src/input/*`（mod.rs/pipeline.rs）              | **零改动**     | `InputCmd`/`to_cdp`/`dispatch` 原样复用                                                                            |
| `conex-browser/src/action/*`（gate.rs/mod.rs/ops.rs/mocks.rs） | **零改动**     | `DomainGate`/`ActionExecutor` 检查点位置与语义不变（方案 A 裁决，见 §6.3）                                         |
| `crates/conex-browser-tools/*`                                 | **零改动**     | 工具框架/审批/审计消费面不动；`register_builtin_tools` 注册数断言（lib.rs:8-11）不受扰动                           |

### 6.2 纯加法判定

**结论：整体为纯加法**。浏览器线全部既有行为文件零改动；新增 1 个叶子 crate + 3 个适配器文件 + 3 处接线级声明。理由：

1. **不替换既有接线**：`frame_stream.rs`（帧下行）与 `panel_input.rs`（输入上行）继续直连 `ScreencastSession`/`InputPipeline`；适配器是平行新增的共享层入口，只在未来统一接线（或对等测试）时被消费。
2. **不迁移既有类型**：`FrameOut`（sink.rs:22）与 12 字节定长头协议保持唯一权威；共享 `Frame` 是适配器侧的转换视图。
3. **不移动既有 trait**：`DomainGate` 留在 `conex-browser/src/action/gate.rs`（R-7 唯一权威声明不动，gate.rs:3-5）；`ActionTargetGate` 是平行抽象，浏览器线经适配器委托。

### 6.3 门禁统一方案权衡（接口抽取两种走法）

| 方案                                                                                                                                                                                                                     | 侵入面                              | 判定                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------ |
| A（**推荐**）：抽 `ActionTargetGate` 入 conex-shared，浏览器线经 `BrowserTargetGate` 委托既有 `DomainGate`，`ActionExecutor` 不动                                                                                        | 新增 1 适配器文件；既有检查点零改动 | 纯加法，行为零变化，符合 04 §6.3「抽象改造行为不变」硬性验收；R-7 权威声明不动 |
| B：把 `DomainGate` 本体提升进 conex-shared 并泛化为 `ActionTargetGate`（gate.rs 改 re-export、mocks.rs 目标类型改、mod.rs:302 字段类型改、run_once:398 调用点改、conex-browser-tools/gate.rs impl 目标改、引擎注入点改） | 约 5 处既有文件 + 引擎接线          | 侵入中等、收益（单一 trait）在二期无消费方；违反「浏览器线行为零变化」验收面   |

### 6.4 测试回归面

- 适配器单测（新增，与桌面实现同构）：复用既有 mock 基建（`MockServer`/`AllowHooks`，session.rs:672-797 / pipeline.rs:225-336 同款）——`CdpScreencastSource` start/stop/订阅/调档断言（对照 session.rs 既有测试口径）；`CdpInputBackend` click 序列 wire 断言（press 不越过 move、click_count 透传、修饰键顺序）；`BrowserTargetGate` 委托断言（AllowGate/DenyGate 同款，mocks.rs:667/684）。
- 既有单测/e2e 全量保留全绿（S6 验收断言 8：73 套件基线 + 快/中层门禁）。

---

## 7. 依赖方向建议（trait 放哪）

### 7.1 三个候选与权衡

| 方案                                       | 依赖关系                                                                                                                     | 权衡                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A（推荐）**：新叶子 crate `conex-shared` | `conex-browser → conex-shared`；`conex-computer → conex-shared`；conex-shared 零实现侧依赖（仅 async-trait/thiserror/serde） | ① 18 §5 复用原则与 04 §2 文件域已指定；② conex-browser 是重量 crate（CDP/websocket/大依赖面），桌面线依赖它违反「桌面线无浏览器进程」边界（18 §5 不共享清单）且拉入无关编译面；③ 共享抽象由两线共同拥有而非一侧持有，符合依赖倒置；④ 叶子地位与 agent-tools 同构（`agent-tools/src/tools/mod.rs` 头注释依赖合规） |
| B：trait 放 conex-browser                  | `conex-computer → conex-browser`                                                                                             | 依赖方向反了：桌面线被迫编译整个 CDP 栈；共享抽象被浏览器线垄断，未来第三实现（如 MCP 桥）不成立                                                                                                                                                                                                                  |
| C：trait 放 agent-tools                    | `conex-browser → agent-tools`（既有方向）+ `conex-computer → agent-tools`                                                    | agent-tools 是工具执行面（Tool/ToolContext/registry），帧/输入不是工具语义；且共享类型（Frame/PhysicalPoint）污染工具 crate 职责                                                                                                                                                                                  |

### 7.2 conex-shared 内容边界（04 S6 单元 1）

```
crates/conex-shared/
├── src/
│   ├── lib.rs        // 模块声明 + 再导出
│   ├── frame.rs      // FrameSource/FrameStream + Frame/FramePolicy/FrameFormat/FrameRate/FrameSourceStatus/FrameSourceError
│   ├── input.rs      // InputBackend + PhysicalPoint/MouseButton/ClickCount/ScrollDirection/KeyName/InputBackendError
│   ├── gate.rs       // ActionTargetGate + ActionTarget/TargetDenial/TargetDenialKind
│   ├── coord.rs      // （S6 与 S2 交接面）从 conex-computer 提升：ScaleSpec/choose_target；后续并入 ScaleCoordinator
│   └── layout.rs     // （后续）MonitorInfo/DesktopLayout（18 §4.3）
├── Cargo.toml        // 依赖：async-trait、thiserror、serde（+ derive）；无 tokio 运行时依赖（traits 由实现侧提供运行时）
└── tests/            // 契约单测（类型序列化/默认值/策略映射纯函数）
```

依赖方向结论：**conex-shared 为纯抽象面（无 tokio/无设备代码）**，实现侧各自携带运行时（tokio、xcap、enigo、windows-sys）。`PerceptionSource`（S2 面，18 §10）与 `ScaleCoordinator`（04 S6 单元 1）随后并入同一 crate，避免第二个共享 crate。

---

## 8. 落地清单（S6 实施步骤，逻辑序）

> 前置纪律：`crates/conex-computer/` 当前**未入库未入 workspace**（§2.4）——开工第一步必须先 `git add` 提交既有成果（测试资产铁律，AGENTS.md），再动代码。

| 步骤 | 任务单元                                                                                                                                                               | 文件域                                              | 验收断言                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1    | 建 `conex-shared`：frame.rs/input.rs/gate.rs/coord.rs + workspace members 加入 + 单测                                                                                  | `crates/conex-shared/`、根 `Cargo.toml`             | `cargo check --workspace` 通过；类型序列化/默认值/纯函数单测全绿                                                     |
| 2    | conex-computer 入库 + 入 workspace + 类型提升对齐（`coord::Point → conex_shared` 引用，保留 re-export 兼容）                                                           | `crates/conex-computer/`、根 `Cargo.toml`           | 既有 conex-computer 单测不回退（action/coord/screen 全绿）                                                           |
| 3    | `OsInputBackend` 内可变改造（`Mutex<Enigo>`）+ 实现 `InputBackend`（补齐 click 坐标/修饰键/count、scroll 坐标/修饰键、key hold_ms）                                    | `conex-computer/src/action.rs`（+ 单测）            | 对等单测：click 带坐标先移动、修饰键按住点击、count 生成间隔；既有键名/分块单测不回退                                |
| 4    | `DesktopCaptureSource` 实现 `FrameSource`/`FrameStream`（事件驱动 latest-slot + 轮询档 + FramePolicy 映射）                                                            | `conex-computer/src/capture/`（新）+ screen.rs 复用 | 对等单测：start/stop 状态机、背压丢旧保新、policy 映射（EventDriven/Low 档）、request_sync_frame                     |
| 5    | `WindowTargetGate` 实现 `ActionTargetGate`（白名单 + 提权探测）                                                                                                        | `conex-computer/src/security/`（新）                | 单测：白名单命中/未命中、提权 → Elevated 分类、Url 目标不适用                                                        |
| 6    | `CdpScreencastSource` + `CdpInputBackend` + `BrowserTargetGate`（纯加法，§6.1 清单）+ lib.rs 声明 + Cargo.toml 依赖                                                    | `crates/conex-browser/src/adapters/`（新）          | 适配器单测全绿（mock 基建复用，§6.4）；浏览器线既有单测全量全绿                                                      |
| 7    | 回归门禁                                                                                                                                                               | 全仓                                                | `cargo test --workspace`（73 套件基线不回退 + 新套件）；前端 `npm run typecheck` + 快层/中层两 job（04 §5 验收项 8） |
| 8    | （移交，不在本任务）前端 `desktop_frame_stream`/`desktop_panel_input` 命令接线 + `frameProtocol` format 扩展（§9 开放问题 6）；S2 `PerceptionSource` 并入 conex-shared | app 侧 + 前端                                       | 04 S6 单元 3 前端面板零感知验收                                                                                      |

---

## 9. 开放问题（需主 Agent 裁决）

1. **crate 命名**：04 §1.1 形态行写「建议 crate：`conex-desktop`」，实际 S1/S2 成果为 `conex-computer`（含 action/coord/screen 三模块，未入库）。建议**保留 `conex-computer`**（避免改名 churn，既有 Cargo.toml 已带 capture-wgc feature 面）；04 文档命名差异建议主 Agent 在 S6 派单时一并裁决（归档更新或沿用现状）。
2. **ClickCount 参数**：本设计在 `click` 增加 `count`（18 §10 无）；若裁决沿用 18 §10 原签名，双击/三击改为工具层三次调用，间隔语义弱于后端生成——建议采纳本设计（§4.1）。
3. **conex-computer 入库时机**：S6 步骤 1 前置 `git add` 提交；建议主 Agent 先派「提交」类子 Agent 固化现状再开工。
4. **cursor_position 浏览器线语义**：无 OS 光标，适配返回最后已知注入坐标（MouseState.last_pos）；如需「真实光标」需 CDP `Input.setIgnoreInputEvents` 面或 DOM 事件探针，二期不引入。
5. **request_sync_frame 浏览器线语义**：= 流内下一帧（不保证新画面）；`Page.captureScreenshot` 域已在 session_caps 白名单（`conex-browser/src/cdp/session_caps.rs:79/179`），但高层封装不在本设计范围（浏览器线动作后回显走既有 screenshot 工具面）。
6. **Frame 格式与前端传输**：桌面帧 PNG vs 浏览器帧 JPEG——共享 `Frame.format` 供前端按 MIME 渲染；浏览器线 12 字节定长头协议（frame_stream.rs:10-18）**保持不变**，桌面帧建议走新 `desktop_frame_stream` 命令 + 独立头（含 format 字节），`frameProtocol.ts` 浏览器路径零改动（04 §3 其他对接点已列新增命令）。
7. **quality/format 降级语义**：`FramePolicy.format` 对浏览器线恒 Jpeg（ScreencastConfig 构造期决定，会话不可重建因 `new()` 独占帧通道）——适配器实现内降级并记录日志，trait 文档注明「策略为运行期请求，实现可降级」。

---

## 附：本文件核对证据索引

| 引用点                                    | 证据                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| ScreencastSession 生命周期/订阅/调档      | `crates/conex-browser/src/frames/session.rs:255/314/344/396/416/381`                   |
| FrameOut/FrameReceiver/背压               | `crates/conex-browser/src/frames/sink.rs:22/108-144/58-70`                             |
| 恢复重启（R-9-3）                         | `crates/conex-browser/src/frames/session.rs:554-629`                                   |
| InputCmd 全形                             | `crates/conex-browser/src/input/mod.rs:63-133`                                         |
| InputPipeline::dispatch / attach_activity | `crates/conex-browser/src/input/pipeline.rs:133/157`                                   |
| 修饰键位掩码                              | `crates/conex-browser/src/input/mod.rs:11`（§3.1）                                     |
| DomainGate / 检查点位置                   | `crates/conex-browser/src/action/gate.rs:24-25`、`action/mod.rs:393-399/328`           |
| MvpDomainGate 唯一实现                    | `crates/conex-browser-tools/src/gate.rs:228-316`                                       |
| 工具注册面（消费面零改动依据）            | `crates/conex-browser-tools/src/lib.rs:8-11/116/132-172`                               |
| 帧下行协议（12 字节头）                   | `apps/agent-workbench/src-tauri/src/browser/frame_stream.rs:10-18`                     |
| 桌面侧既有实现                            | `crates/conex-computer/src/action.rs:343-691`、`src/screen.rs:177-261`、`src/coord.rs` |
| 18 §10 草案签名                           | `docs/browser-collaboration/source/18-维度-电脑操作二期与共享层.md:311-339`            |
