# 反馈路由宪法（桌面端）

> 立于 2026-11-03 批 C（反馈与信任）。本表是桌面端「什么事该出现在哪种面」
> 的唯一正典：后续一切反馈施工以本表为验收依据。判据是**用户下一步要做
> 什么**，而不是失败的严重程度。实现落点与本表逐条对应，改实现先改本表。
>
> 移动端同构口径：家族命名与移动端 `LocalChatErrorKind` 13 类对齐
> （见 §3）；移动呈现面（浮层面板/通知中心）为用户既定形态，不在本表
> 管辖内。

## 1. 硬规则

1. **一个事件类只有一个呈现面 owner**。终态/待决事件的生产者只有一个：
   chat-bridge `dispatchEvent` 的旁路观察器（`services/desktopNotificationObserver.ts`），
   裁决只有一个：`DesktopNotificationService`。功能代码不得自行再接一套
   run 终态通知。
2. **失败标题单独出现永不构成弹窗**。弹窗（ConfirmGate / ConfirmDialog）
   只给两种场合：继续前必须由用户做的决定；继续前必须读完的阻断信息。
3. **后端原始错误串永不内联**。气泡、横幅、toast、OS 通知正文都算内联面。
   原始串是诊断数据，只许出现在用户主动打开的详情（错误面板 technical
   字段、详情视图）与日志中。内联失败文案一律来自失败分类表（§3）：
   标题 + 一句话 + 至多一个动作。
4. **瞬时过程态不抢位**。自动重试中、重连中、压缩中、排队、同步这类
   瞬时态只配安静行（状态行 / ContentState 行内形态），不用 toast、
   不用横幅；只有真失败才逐级升格到 §2/§3 的呈现面。
5. **toast / 弹窗宿主单例**。toast 只走 `services/toast`（ToastStore /
   ToastContext）+ 唯一 `ToastViewport`；确认只走 `useConfirmGate` 桥或
   设置页直用 `ui/ConfirmDialog`（LayerStack 管叠层），禁止再挂第二个宿主。

## 2. 终态 / 待决事件路由（注意力通道）

适用事件：run 终态（完成/失败/取消）、审批请求与介入请求、子代理终态、
后台工具/任务终态（完成/失败/被杀/卡死）、安全拦截、运行时异常。

分类门（先于路由）：`approval`、`failure` 必达，不可关；`completion`
受偏好 `notify_on_task_done`（默认开）；`scheduled`（定时器/cron）桌面
不发；总开关 `desktop_notifications_enabled`（默认开）一票否决全体。

| 用户状态 | 呈现面 |
| --- | --- |
| 窗口聚焦中，且正在看该会话（会话 store `activeSessionId` 命中） | **静默**——亲见即达：不弹窗、不发通知；按业务键记已达，事后不补发 |
| 窗口聚焦中，但不在该会话（或事件无会话归属） | **应用内 toast**：failure → `error` 变体，approval → `warning`，completion → `success`；条目 id = `attention:<业务去重键>` |
| 窗口未聚焦 / 最小化 / 托盘隐藏（不可见） | **OS 通知**：点击回焦窗口并发 `open-chat` 跳到对应会话 |

配套规则：

- **去重**：业务键派生（`run:` / `approval:` / `subagent:` / `tool:` /
  `task:` / `security:` / `agent-end:` / `runtime-error:` /
  `intervention:` 前缀 + 业务 id），同一终态只达一次（任一面计达）。
- **双终态互斥**：本地 run 的 `agent-end` 与 `run-terminal` 是同一终态
  的两面，同会话同类 10 秒互斥窗内只达一次（观察器裁决）。
- **打开即退休**：`activeSessionId` 变更（打开/切换会话）即退休该会话
  的应用内条目（即时 dismiss）并清其 OS 通知点击路由映射；退休按既有
  业务键/会话映射反查，不新造键体系。去重集**不**随退休清除（终态只
  达一次的语义不重置）。已知边界：桌面通知插件无按 id 撤销已发 OS
  横幅的能力，退休以应用内面为界。
- **文案**：标题/正文人名优先（会话标题、任务命令原文、工具名），裸 id
  只进去重键；失败正文经失败分类表出文案（§3），不拼原始错误串。

## 3. 失败呈现（分类表）

- **封闭分类表**：`src/api/failureTaxonomy.ts` 是单一映射模块——家族
  枚举 → 唯一 zh/en 标题 + 一句话说明 + 至多一个动作。共 22 家族：
  与移动端 13 类同名的 network / auth / quota / model-not-found /
  endpoint-unavailable / rate-limit / context-length / invalid-request /
  payload-too-large / server / stream / not-configured / unknown，
  加桌面扩展 timeout / no-project / blocked / local-core-not-ready /
  restoring / session-busy / storage-busy / internal / engine-crash。
- **分类入口**：`userFacingErrors.presentFailure(input)` 查表——判定
  顺序为 Rust kebab 错误码 → 差异化域（S1–S8 / engine_crash）→ 文本
  软分类；既有 S 域文案与软分类文案均为分类表投影（同源派生，不再
  散写）。`aborted`（用户取消）不构成失败呈现，静默收口。
- **标题归一**：i18n `error.*.title` 中属于分类表的 20 条（provider /
  network / context / runtime 域）已归一到家族唯一标题，双语逐字一致
  由 `failureTaxonomy.test.ts` 钉死；同家族多码同标题是预期形态，
  区分信息在错误码本身与详情中，不在标题。
- **呈现分工**：整页加载失败/无内容 → `ContentState`（带重试动作）；
  操作结果且不离开当前面 → toast；属于对话记录的失败 → 流内 notice /
  横幅链（onRunError），不写进 assistant 气泡正文。

## 4. 确认弹窗队列

- `useConfirmGate` 是 **FIFO 队列**单例桥：多个确认依次呈现，无静默
  消失；每个调用方的 Promise 只由其对应条目的决定落定；宿主卸载时
  当前与排队条目一并以「取消」结算。旧「后调覆盖前调」语义已废弃
  （FN-4：先者对话框永不出现且按取消继续，非危险流程会静默跳过确认）。
- 设置页直用 `ConfirmDialog` 的路径彼此独立、靠 `ui/Dialog` 的
  LayerStack 管 Esc 与层级，不经本队列，两轨互不干涉。

## 5. Toast 规格（桌面现行值，即正典）

| 项 | 值 | 落点 |
| --- | --- | --- |
| 变体 | 6 型：info / success / warning / error / recovery / loading | `services/toast/types.ts` |
| 默认时长 | 5000 ms（`TOAST_TTL_MS`）；loading 型为 Infinity（状态持有，不自动消失） | `hooks/toastQueueLogic.ts`、`services/toast/ToastStore.ts` |
| 队列上限 | 3 条（`TOAST_MAX_QUEUE`），超出挤掉最旧；同文案去重并刷新 TTL | 同上 |
| 文案门 | 成功/状态/进度类文案默认不进 toast（策略门 `FORBIDDEN_SUCCESS_TOAST_PATTERNS`）；错误类、可撤销操作（带 onUndo）、门闩放行文案可进；显式指定变体的呈现（如 §2 应用内通道）按变体直达 | `hooks/toastQueueLogic.ts` |

与 Cherry 参照（4000 ms / 4 档）的差异登记：桌面保留 5000 ms 与
recovery（撤销型操作）/ loading（进度持有）两型——均为桌面既有真实
消费面，非漂移，不收敛。

## 6. 安静行与状态面（既有落点索引）

- 等待/运行状态行：`WorkingStatusIndicator`（定高 24px，含已等待秒数）。
- 发送期分域提示：Composer 错误条消费 `userFacingErrors` 分域文案
  （S1–S8 投影自 §3 分类表）。
- 后台任务存在感：DynamicChipBar「后台任务 (N)」聚合入口。
- 页面三态：`ContentState`（加载/空/错误，批 A 落地）管页面级呈现。
- 连接态与执行态分开陈述：连接断开不等于执行停止，文案先说执行状态
  再说连接状态。
