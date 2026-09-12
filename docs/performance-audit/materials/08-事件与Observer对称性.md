# 08 · 扫描素材：事件监听 / Observer / 定时器对称性

> 日期：2026-09-13  
> 范围：`apps/crish-desktop/src/` 内 addEventListener / removeEventListener、ResizeObserver / MutationObserver / IntersectionObserver、setInterval / rAF 的注册-清理对称性。  
> 方法：静态走读 + 关键文件对照。生产代码约 402 处 addEventListener（排除测试）。

## 1. 总体结论

监听器清理对称性**总体健康**：hooks / services / bootstrap 层的 cleanup 闭包普遍完整。未发现「注册后永久悬挂」的系统性泄漏。少量边界项见 §3。

## 2. 正面对称样本（证据）

| 位置 | 注册 | 清理 |
| ---- | ---- | ---- |
| `hooks/useVirtualScroll.ts:268-277` | wheel/touchstart/pointerdown/scrollend | 同 return 中四路 removeEventListener |
| `hooks/usePointerDragBase.ts:196-217` | pointermove/up/cancel/capture/blur/keydown | 完整六路 remove |
| `hooks/useTreeResize.ts:422-437` | pointermove/up/cancel/keydown | 完整 remove |
| `app/AppShortcuts.ts:65/173` | document keydown capture | removeEventListener 对称 |
| `api/beforeunloadFlush.ts:94-99` | beforeunload + pagehide | 双路 remove |
| `bootstrap-services.ts:84-88,120-122` | error/unhandledrejection/pagehide | remove 对称 |
| `app/AppBootstrap.ts:205/244-254` | fullscreenchange + Tauri unlisten | disposed 标志 + remove + unlistenTauri |
| `services/ShortcutService.ts:64-75` | keydown/keyup on container | dispose 中双路 remove |
| `workers/worker-pool.ts:208-221` | signal abort once | { once: true }，合并为单监听器 |
| `components/chat-message-row/MessageToolCallsSection.tsx:121-129` | 私有 ResizeObserver | return () => ro.disconnect() |
| `components/diff/VirtualPlainCodeViewer.tsx:91-155` | 两处 ResizeObserver | 均 disconnect |
| `components/sidebar/session-list/useSessionListWindow.ts:80-108` | RO + MO | 双 disconnect |
| `components/chat-message-list/FlowScrubber.tsx:206-257` | IO + MO | 双 disconnect |
| `components/chat-message-list/MessageVirtualizer.tsx:186-229` | RO per-row | disconnect on unmount |
| `api/uiEvents.ts:229-236` | window CustomEvent 桥 | removeEventListener |
| `hooks/useEngineState.ts:274-311` | interval + dataPlane 订阅 | refcount 归零时 clearInterval + 三路 unsub |

## 3. 边界 / 风险项

### 3.1 长驻 interval（设计内，可感知）

- `hooks/useEngineState.ts:271`：`setInterval(_tick, 4000)` 单例；refcount 归零即 clearInterval。设计内。
- `hooks/useAgentStream.ts:362-366`：每 agent 状态轮询 4s；effect cleanup clearInterval。每个 running agent 一条 interval——多 agent 并发时 N×4s 轮询，内存面可接受，CPU 面归 01/12。
- `workers/worker-pool.ts:365-379`：idle monitor 30s tick 直至 dispose。设计内。

### 3.2 AbortController 使用面偏窄

全仓生产 AbortController 主要在：
- `workers/worker-pool.ts`（任务取消）
- `api/directFetchBridge.ts:129/322`（direct fetch 流式）
- `store/layout-helpers/store-persistence.ts:131/319`（hydrate 中止）
- `components/workspace/activePortDetector.ts:81-84`
- `components/binary-tree/SidePanelLauncherHub.tsx:38-39`（timeout 包装）

多数 DOM 监听不走 AbortSignal（用 cleanup 闭包），对称性已覆盖；非泄漏问题。

### 3.3 PTY fanout unlisten 条件耦合 history

`api/ptySessionApi.ts:61-70`：`checkCleanupUnlisten` 要求 `handlers.size===0 && ptyHistoryMap.size===0` 才 unlisten。history 非空时 Tauri 事件监听保持存活——**设计内**（history 需要持续 record），但多终端场景下 unlisten 生命周期与 history 生命周期绑定，history 清理依赖 kill/exit 路径。

## 4. 未发现项（负面清单）

- 未发现「addEventListener 后无对应 remove 且非单例 bootstrap」的组件级泄漏。
- 未发现 ResizeObserver/MutationObserver 在组件卸载路径缺失 disconnect 的生产路径。
- 未发现 rAF 循环无 cancelAnimationFrame 的常驻循环（useStreamRenderThrottle / useVirtualScroll / useColumnResize 均有 cancel）。
