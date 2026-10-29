# Conex / Crish — 移动端 UI、Screens 与组件系统深度审计报告

> **审查工作区**：`docs/full-codebase-changes-audit/audits/`  
> **审查对象**：`apps/crish-mobile/`（Expo Router 路由层 `app/`、表现层 Screens、交互组件库、时间线系统与设计 Token 单一真源）  
> **核心对齐契约**：`docs/mobile-app-rebuild/01-界面设计规范.md`、仓库根目录 `AGENTS.md` §7「严禁补丁、绕过与作弊」及 §7.1「立体验证纪律」  
> **审查性质**：只读实证审查、静态 AST/语法与类型分析、交互状态机严谨度断言（严格零业务代码修改、零 git commit）

---

## 一、执行摘要与总评

本次对重构后的移动端界面层（`apps/crish-mobile/app/` 与 `apps/crish-mobile/src/presentation/`）进行了立体化、无死角的系统级审计。

**总体评价**：移动端呈现层在视觉设计系统、无障碍热区规范、手势状态机解耦方面展现出了高度的工程素养。设计系统对齐了桌面端 tokens 单一真源，核心危险操作 `SlideToConfirm` 实现了优雅的纯逻辑状态机分离，触控热区与读屏语义普及率极高。然而，在**Expo Router 路由栈边界鲁棒性**、**深层链接（Deep Link）白名单完备性**、**容错边界降级逃生路径**以及**键盘弹出状态下的安全区适配**等关键场景下，存在若干**P0 致命缺陷**与**P1 严重隐患**，必须在正式交付与打包前彻底收敛。

### 1. 核心审计发现一览

1. **路由与深链断裂（P0 致命）**：
   - `src/notifications/notificationMeta.ts` 的 `DEEP_LINK_ROUTE_TABLE` 白名单发生严重遗漏：Tab 根路由 `/sessions`（会话列表）未被收录；`notifications` 与 `approval-history` 亦未登记。来自外部推送或通知的 `crish://sessions` 深链会被白名单静默吞噬（返回 `null` 并放弃导航）。
   - 存在规范自相矛盾：`deepLinkRoute.ts` 登记了 `task` / `subagent` / `timer` 主定位参数并生成 `crish://task/...` 深链，但 `notificationMeta.ts:108` 遇到非白名单目标直接阻断返回 `null`，导致其下方的回退语义（Line 123-130）彻底成为死代码，任务类推送全部无法跳转。
2. **冷启动深链与推送进入的“返回栈死锁”（P1 严重）**：
   - `app/approval/[toolCallId].tsx`、`app/session/[sessionId].tsx` 等所有二级详情页的返回逻辑均硬编码为 `onBack={() => router.back()}`。
   - 当用户从系统推送或 Deep Link 冷启动直接唤起详情页时，路由历史栈仅包含当前页（`router.canGoBack() === false`），点击返回或关闭遮罩没有任何反应，用户被永久困死在页面中。尤其是以 `transparentModal` 呈现的审批弹窗，将面临无法关闭的黑屏遮罩死锁。
3. **全局单一 ErrorBoundary 与崩溃重试死锁循环（P0 致命）**：
   - 全局仅在根布局 `app/_layout.tsx` 包裹了一层 `ErrorBoundary`，Tab 容器、Screen 页面与 `TimelineView` 均无局部保护边界。
   - 根级 `ErrorFallback` 的“重试”按钮仅执行 `this.setState({ error: null })`，若崩溃源于当前路由关联的坏数据（如某条会话消息渲染异常），点击重试将无限次重复崩溃；且界面上没有任何“返回首页”或“重置路由”的逃生手段。
4. **手势与动效细节瑕疵（P1/P2 风险）**：
   - `SlideToConfirm.tsx` 将 `PanResponder` 事件直接挂在整个外层轨道 View 上而非滑块上，用户在滑轨右侧误触滑动亦能拉动滑块。
   - `Sheet.tsx` 顶部绘制了拖拽手柄指示条，但并未挂载任何拖动手势处理器，仅为“装饰手柄”，违背规范中承诺的“下滑关闭”。
   - `TimelineView.tsx` 中 `FadeIn` 动效在虚拟列表滚动复用时会为已读消息重复播放，且完全忽视了 `reduce-motion` 系统的无障碍开关。
5. **键盘弹出底边距悬空与小屏表单截断（P1 严重）**：
   - `sessionDetailScreen.tsx` 的 composerBar 底部硬编码了 `Math.max(insets.bottom, 8)`。在 iOS 键盘弹出时，`KeyboardAvoidingView` 向上顶起的同时，原有的 Home Bar 34pt 安全区依然保留，导致输入条尴尬地悬浮在软键盘上方 34pt。
   - `pairManualScreen.tsx` 页面表单未包裹在 `ScrollView` 中，在 iPhone SE 等小屏设备上展开高级设置并弹出键盘时，输入框和“连接”按钮会被推至视口外且无法滚动。

### 2. 缺陷严重级别速览表

| 编号 | 缺陷类别 | 现场实证与代码根因 | 涉及文件与行号 | 现状判定 | 严重级别 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **ROU-01** | **深链白名单断裂** | `DEEP_LINK_ROUTE_TABLE` 遗漏 `sessions`、`notifications`，且与 `deepLinkRoute.ts` 冲突导致任务类推送跳转逻辑短路被吞 | `src/notifications/notificationMeta.ts:48-57, 107-108`<br>`src/notifications/deepLinkRoute.ts:14-22` | **实证确凿** | **P0 致命** |
| **ERR-01** | **崩溃重试死锁** | 全局单一根错误边界；重试仅复位局部 state，缺乏路由重置与逃生通道，页面坏数据将引发无限崩溃死循环 | `src/presentation/components/ErrorBoundary.tsx:27-35`<br>`app/_layout.tsx:118-120` | **实证确凿** | **P0 致命** |
| **NAV-01** | **冷启动返回死锁** | 二级页与弹窗无条件 `router.back()`，冷启动/深链唤醒时栈深为 1，用户点击关闭或返回直接卡死无法退出 | `app/approval/[toolCallId].tsx:11`<br>`app/session/[sessionId].tsx:11`<br>`app/run/[runId].tsx:12` | **实证确凿** | **P1 严重** |
| **KBD-01** | **键盘悬空与截断** | 会话输入框键盘抬起叠加 34pt 底部内衬悬空；手动配对表单缺少 ScrollView 导致小屏键盘弹出阻断操作 | `src/presentation/screens/sessionDetailScreen.tsx:166`<br>`src/presentation/pair/pairManualScreen.tsx:161-236` | **实证确凿** | **P1 严重** |
| **TOK-01** | **设计规范违规** | `TimelineView` 硬编码 `borderRadius: 16` 违背规范；`SessionListItem` 散落未 token 化的硬编码 16 进制颜色组 | `src/presentation/timeline/TimelineView.tsx:389`<br>`src/presentation/components/sessions/SessionListItem.tsx:10-30` | **规范违规** | **P1 严重** |
| **GES-01** | **滑轨手势区域歧义** | `SlideToConfirm` 将手势绑定到全轨而非滑块，非滑块区域滑动亦被误判为有效位移 | `src/presentation/components/blocks/SlideToConfirm.tsx:316` | **交互瑕疵** | **P2 中风险** |
| **PERF-01**| **大文件预览无虚拟化** | `FilePreview` 使用标准 `ScrollView` 一次性渲染多达 5000 行 `numberedLines`，引发低端机内存与掉帧灾难 | `src/presentation/components/files/FilePreview.tsx:84-96`<br>`src/adapters/viewmodels/useFilePreviewVm.ts:30` | **性能隐患** | **P2 中风险** |
| **SHT-01** | **伪手柄与动效泄漏** | `Sheet` 手柄无手势纯属装饰；`FadeIn` 在列表滚动回收复用时重复触发且未适配 reduce-motion | `src/presentation/ui/Sheet.tsx:71`<br>`src/presentation/timeline/TimelineView.tsx:72, 110-132` | **体验瑕疵** | **P2 中风险** |

---

## 二、Expo Router 路由结构与状态传递审计

### 1. 路由骨架与导航层次

移动端路由采用了 Expo Router 的文件路由体系：
- 根层级：`app/_layout.tsx`（启动装配、水合状态网关、统一 Stack）
- Tab 容器：`app/(tabs)/_layout.tsx`（5 个一级 Tab：`index`, `sessions`, `approvals`, `files`, `settings`）
- 认证与配对网关：`app/pair/_layout.tsx` 与 `app/_components/Protected.tsx`
- 业务详情栈：`session/[sessionId]`, `run/[runId]`, `terminal/[runId]`, `approval-history`, `notifications`, `approval/[toolCallId]`

#### 优秀实践亮点
1. **水合闸门与 Splash 解耦**：`_layout.tsx:73-80` 在 `authStore.hydrated === false` 时渲染原生一致的 Splash 品牌态，防止未水合状态引发的路由抖动。
2. **透明弹窗原生化**：`approval/[toolCallId]` 配置为 `presentation: 'transparentModal'` 与 `animation: 'fade'`（`_layout.tsx:100-106`），结合内部的半透明 Scrim 与底部抽屉卡片，实现了性能极高的原生级模态遮罩交互。
3. **未配对状态硬守卫**：`TabsLayout`（`(tabs)/_layout.tsx:27-29`）与各 Stack 路由均通过 `Protected` 组件（`_components/Protected.tsx:8-10`）进行配对态拦截，未配对用户被严格强制重定向至 `/pair/welcome`。

---

### 2. 深层缺陷：深链白名单断裂与路由映射缺漏 (ROU-01)

#### 实证分析
在系统通知与 Deep Link 链路中，`src/notifications/deepLinkRoute.ts` 负责将后端推过来的事件元数据翻译为 `crish://` 深链，而 `src/notifications/notificationMeta.ts` 负责将 `crish://` 映射为 Expo Router 的页面路径。

比对两处核心代码：

1. **白名单遗漏 Tab 核心路径与二级页面**：
   查看 `src/notifications/notificationMeta.ts:48-57`：
   ```ts
   const DEEP_LINK_ROUTE_TABLE: Record<string, (id: string) => string | null> = {
     approval: (id) => (id ? `/approval/${id}` : null),
     session: (id) => (id ? `/session/${id}` : null),
     run: (id) => (id ? `/run/${id}` : null),
     terminal: (id) => (id ? `/terminal/${id}` : null),
     approvals: () => '/approvals',
     dashboard: () => '/',
     files: () => '/files',
     settings: () => '/settings',
   };
   ```
   **缺陷 1**：Expo Router 中 `(tabs)/sessions.tsx` 对应的实际路由是 `/sessions`，而白名单中**完全没有 `sessions`**！当系统发送会话列表跳转请求（`crish://sessions`）时，`notificationRouteToPath` 查询 `DEEP_LINK_ROUTE_TABLE['sessions']` 为 `undefined`，直接返回 `null`，用户点击通知**完全不跳转**！  
   **缺陷 2**：`notifications`（通知中心，`app/notifications.tsx`）与 `approval-history`（审批历史，`app/approval-history.tsx`）同样未在表中注册。

2. **逻辑冲突致使任务/子代理推送无法导航**：
   查看 `src/notifications/deepLinkRoute.ts:14-22`：
   ```ts
   const SCREEN_PRIMARY_PARAM: Record<string, string> = {
     approval: 'toolCallId',
     session: 'sessionId',
     run: 'runId',
     terminal: 'runId',
     task: 'taskId',
     subagent: 'subagentId',
     timer: 'timerId',
   };
   ```
   当后端推送一个任务失败事件时，`target.screen = 'task'`，`buildDeepLinkRoute` 生成了 `crish://task/t-123`。  
   然而在 `src/notifications/notificationMeta.ts:107-108`：
   ```ts
   const builder = DEEP_LINK_ROUTE_TABLE[screen];
   if (!builder) return null; // 此处直接返回 null 退出！
   ```
   因为 `task` 不在 `DEEP_LINK_ROUTE_TABLE` 中，代码在第 108 行直接短路返回 `null`！  
   而在 `notificationMeta.ts:123-130` 原本设计的回退逻辑：
   ```ts
   if (
     src.runId &&
     (src.kind.startsWith('run') ||
       src.kind.startsWith('task') ||
       src.kind.startsWith('subagent'))
   ) {
     return `/run/${src.runId}`;
   }
   ```
   **该段代码永远无法被执行到**，因为只要 `route` 字段存在（即生成了 `crish://task/...`），前面的白名单校验就会先将其拦截并返回 `null`。这导致所有 `task` / `subagent` 类的系统通知点击后只能标记为已读，完全无法导航至对应的运行页面！

---

### 3. 冷启动深链与推送进入的“返回栈死锁” (NAV-01)

#### 实证分析
在移动端所有 Stack 页面中，返回回调几乎统一写为：
- `app/approval/[toolCallId].tsx:11`：`onBack={() => router.back()}`
- `app/session/[sessionId].tsx:11`：`onBack={() => router.back()}`
- `app/run/[runId].tsx:12`：`onBack={() => router.back()}`
- `app/terminal/[runId].tsx:9`：`onBack={() => router.back()}`
- `app/approval-history.tsx:8`：`onBack={() => router.back()}`
- `app/notifications.tsx:9`：`onBack={() => router.back()}`

**运行期事故场景**：
当手机处于锁屏或冷启动状态，用户点击了一条 APNs/系统推送通知（例如一条高风险审批通知），操作系统通过深链直接唤起并挂载 `/approval/tc-123`。  
此时导航器处于栈底，栈内只有一个页面，`router.canGoBack()` 为 `false`。
- 用户看完审批详情后，点击右上角 `x` 关闭按钮、或点击半透明背景 Scrim、或处理完点击“关闭”按钮；
- 触发 `onBack()` -> 调用 `router.back()`；
- **因为栈底无历史路由，`router.back()` 成为空操作（No-op）**！
- 用户无论怎么点击关闭或返回，都**无法退出该审批弹窗**，界面被永久冻结在当前页面，严重影响核心可用性。

**正确契约**：应封装全局安全返回工具或统一模式：
```ts
const safeBack = (fallback: Href = '/(tabs)') => {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
};
```

---

## 三、交互鲁棒性与核心组件审计

### 1. `SlideToConfirm` 滑动确认组件架构剖析

`SlideToConfirm.tsx` 是承载危险操作（如 L2 级别审批允许、不可撤销操作）的核心阻断组件。

#### 优秀设计
1. **注入式状态机纯逻辑隔离**：组件将所有手势计算彻底解耦至 `src/presentation/components/blocks/slideConfirmMachine.ts`。手势位移（`dx`）、有效滑轨宽度（`slideUsableWidth`）、70% 触发阈值（`SLIDE_TRIGGER_THRESHOLD = 0.7`）全部由无副作用纯函数驱动，并在 `slideConfirmMachine.test.ts` 中实现 100% 单测覆盖。
2. **冲突仲裁逻辑（Conflict Arbitration）**：
   在 `slideConfirmMachine.ts:43-50` 中实现了精确的水平仲裁公式：
   ```ts
   export function shouldClaimSlidePan(
     dxPx: number,
     dyPx: number,
     minDxPx: number = SLIDE_ARBITER_MIN_DX, // 12dp
     ratio: number = SLIDE_ARBITER_RATIO     // 1.2
   ): boolean {
     return Math.abs(dxPx) > minDxPx && Math.abs(dxPx) > Math.abs(dyPx) * ratio;
   }
   ```
   且 `onStartShouldSetPanResponder` 恒为 `false`，确保在垂直滚动列表或弹窗内点击或纵向滑行时绝对不劫持父容器的手势。
3. **Busy 锁定与防双击**：在 `SlideToConfirm.tsx:203-211` 中，当外部传入 `disabled=true`（如网络请求进行中）时，自动重置拖拽状态并强制关闭二次确认弹窗，杜绝并发重复提交。

#### 发现的隐患 (GES-01)
查看 `SlideToConfirm.tsx:316`：
```tsx
<View
  testID={testID ?? 'slide-to-confirm'}
  ...
  style={[styles.track, ...]}
  {...panResponder.panHandlers}
>
  <Animated.View testID="slide-thumb" style={[styles.thumb, ...]} />
  <Text testID="slide-label" ...>{labelText}</Text>
</View>
```
**隐患点**：`panResponder.panHandlers` 被挂载到了外层**整个轨道的 View 上**，而非内部的滑块 `Animated.View`。  
由于 `onMoveShouldSetPanResponder` 仅仅依赖于 `gestureState.dx > 12`，如果用户的拇指并未触碰滑块，而是在滑轨最右侧（如 80% 宽度处）按下并向右微动，手势响应链同样会被激活，此时滑块（位于 0 处）会跟随向右移动；且由于触控点已靠近屏幕边缘，用户手指滑到屏幕外也无法达到 70% 的有效位移，造成不可预期的操作挫败感。  
**改进建议**：应校验起始触控点的 `pageX` / `locationX` 是否落在滑块物理边界内（`locationX <= SLIDE_THUMB_SIZE`），或将 `panHandlers` 直接绑定到滑块元素上。

---

### 2. `Sheet.tsx` 底部抽屉与伪手柄问题 (SHT-01)

查看 `src/presentation/ui/Sheet.tsx:60-72`：
```tsx
<View style={[styles.sheet, ...]}>
  <View style={[styles.handle, { backgroundColor: theme.colors.borderStrong }]} />
  {title ? (
    <View style={styles.header}>
      <AppText variant="heading" style={styles.title} numberOfLines={1}>{title}</AppText>
      <IconButton name="x" accessibilityLabel="关闭" onPress={onClose} testID="sheet-close" />
    </View>
  ) : null}
  <ScrollView style={styles.scroll} ...>
    {children}
  </ScrollView>
</View>
```
在界面设计规范 `01-界面设计规范.md` §5.14 明确定义：
> “使用 RN Modal（transparent, animationType slide）+ 底部安全区；顶部圆角 18；拖拽指示条可选。关闭：遮罩 / 下滑 / Android 返回。”

**代码实证**：组件虽然渲染了视觉指示条（`styles.handle`），但该手柄没有绑定任何手势识别器（PanResponder 或 GestureHandler），也没有监听滑动位移。用户按照移动端心智在指示条上下滑时，抽屉纹丝不动！当前仅能通过点击遮罩或右上方 `x` 关闭，这属于**交互可传达性（Affordance）断层**。

---

### 3. `TimelineView.tsx` 虚拟列表复用时的动效泄漏 (SHT-01)

查看 `src/presentation/timeline/TimelineView.tsx:71-75` 及 `FadeIn` 实现（Line 110-132）：
```tsx
renderItem={({ item }) => (
  <FadeIn>
    <TimelineBlockView block={item} onOpenApproval={onOpenApproval} />
  </FadeIn>
)}
```
```tsx
function FadeIn({ children }: { children: ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(6)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start();
  }, [opacity, translateY]);
  return <Animated.View style={{ opacity, transform: [{ translateY }] }}>{children}</Animated.View>;
}
```
**问题实证**：
1. `FlatList` 在长会话中开启了虚拟化复用（`windowSize={9}`），当用户来回快速上下翻动时间线时，滑出视口的 Item 会被卸载；重新滑入时，`FadeIn` 会被重新挂载！这意味着历史消息会在滚动过程中**不断触发 180ms 的透明度与 6px 偏移淡入动画**，导致列表滚动时产生严重的视觉闪烁与卡顿。
2. `FadeIn` 没有读取系统 `AccessibilityInfo.isReduceMotionEnabled()`，在开启“减少动态效果”的系统上依然强制执行 6px 位移变换，违反规范 §4.4。

---

## 四、容错与降级设计审计

### 1. 全局单一 ErrorBoundary 架构硬伤 (ERR-01)

查看 `app/_layout.tsx:113-126`：
```tsx
export default function RootLayout() {
  return (
    <GestureHandlerRootView>
      <View style={styles.flex}>
        <SafeAreaProvider>
          <ToastProvider>
            <ErrorBoundary>
              <RootShell />
            </ErrorBoundary>
          </ToastProvider>
        </SafeAreaProvider>
      </View>
    </GestureHandlerRootView>
  );
}
```
查看 `src/presentation/components/ErrorBoundary.tsx:27-37, 39-55`：
```tsx
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }
  private reset = () => {
    this.setState({ error: null });
  };
  render() {
    if (this.state.error) {
      return <ErrorFallback onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
function ErrorFallback({ onRetry }: { onRetry: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.canvas }]}>
      <AppText variant="heading">应用遇到问题</AppText>
      <AppText variant="meta" color="textSecondary" style={styles.hint}>
        请重试；若持续出现，请重新打开应用。
      </AppText>
      <Button label="重试" variant="secondary" onPress={onRetry} style={styles.action} />
    </View>
  );
}
```

#### 致命缺陷推演
1. **单一爆炸半径（Single Point of Failure）**：  
   经检索，全项目仅在 `RootLayout` 存在这一个 `ErrorBoundary`。无论是在 `TimelineView` 中由于流式文本解析异常、在 `TerminalView` 中由于转义符溢出、还是在 `FilePreview` 中由于文本切片异常抛出未捕获错误，**整个 App 的所有 UI 会被全盘卸载**，整屏变为空白底色的“应用遇到问题”！
2. **重试死循环死锁（Retry Loop Trap）**：  
   `ErrorFallback` 仅提供了一个“重试”按钮，其实现是直接调用 `this.reset`（即 `this.setState({ error: null })`）。  
   如果抛错原因与当前展示的数据相关（例如当前打开的 Session 包含一段引起 React 渲染崩溃的畸形富文本），点击“重试”后 React 会立即尝试重新渲染引发崩溃的同一个页面和同一份数据！  
   结果是：**点击重试 -> 立即崩溃 -> 再次弹出错误页 -> 点击重试 -> 再次崩溃**。
3. **逃生通道完全缺失**：  
   界面上没有提供“返回首页”、“清空当前会话缓存”或“重置导航器”等降级操作。一旦用户触发此类数据级渲染异常，整个伴侣 App 陷入彻底瘫痪，唯一脱困手段只有到系统设置中强杀 App 并清除存储。

---

### 2. 状态占位与离线降级表现

在数据加载与离线场景下，代码展现了极佳的兜底设计：
- **真实加载态**：遵循 §5.17“不以骨架块伪装真实内容”，在会话列表、文件树首次加载时统一使用居中 `Spinner`；刷新数据时通过 `RefreshControl` 原位刷新，不清空既有列表。
- **离线 Outbox 状态透视**：`approvalListScreen.tsx:48-55` 当存在离线待发送决策时，顶部渲染 `vm.outboxCount 条决策等待网络恢复后发送` 的警示细条，状态清晰不瞒报。
- **终端离线重建**：`terminalScreen.tsx:66-76` 当没有活跃连接的 liveView 时，通过 `collectRunTerminalChunks(entries)` 从历史事件流实时重建终端行缓冲，保障历史回顾体验。

---

## 五、主题、Token 与设计规范对齐审计

### 1. 设计规范遵循度评估

`src/adapters/platform/theme.ts` 对 `docs/mobile-app-rebuild/01-界面设计规范.md` 的实现非常完备：
- 严格遵循 4pt 阶梯网格（`space.xs=4` 到 `section=32`）；
- 排版系统定义了 `display` 到 `caption` 共 9 档字阶，并针对 iOS（Menlo）与 Android（monospace）配置了正确的等宽字体；
- 主题切换实现了三态控制（`system` / `light` / `dark`），深色模式并非简单的浅色反色，而是精心调配的独立暗调板（`canvas: '#0d0d0d'`, `surface: '#161616'`）。

---

### 2. 硬编码与规范断裂实证 (TOK-01)

尽管全局主题框架完善，但在具体业务组件中依然存在数处违背规范的硬编码与魔术值：

#### 违规 1：`TimelineView.tsx:389` 出现规范明令禁止的圆角值
```tsx
// src/presentation/timeline/TimelineView.tsx:389
approvalCard: {
  borderRadius: 16, // 违规！
  borderWidth: StyleSheet.hairlineWidth,
  ...
}
```
- **规范契约**（`01-界面设计规范.md` §4.2）：
  > “卡片、分组容器、Sheet 内卡使用 `radius.md = 12`；外框使用 `radius.lg = 18`；**禁止 10/14/16/17/23 等自由值**。”
- **判定**：直接违背设计红线，应纠正为 `theme.radius.md`（12）或 `theme.radius.lg`（18）。

#### 违规 2：`SessionListItem.tsx:10-30` 散落未 Token 化的局部调色板
```tsx
const LIGHT_TONES = [
  { bg: '#e7f6ec', fg: '#047857' },
  { bg: '#e8f1fd', fg: '#0b66d6' },
  { bg: '#fdf3e1', fg: '#9a5200' },
  { bg: '#f3e8ff', fg: '#7e22ce' },
  { bg: '#fce7f3', fg: '#be185d' },
  { bg: '#e0f2fe', fg: '#0369a1' },
  { bg: '#eef2ff', fg: '#4338ca' },
  { bg: '#f1f5f9', fg: '#475569' },
];
const DARK_TONES = [
  { bg: '#17301f', fg: '#34d399' },
  ...
];
```
- **判定**：虽然作者针对深浅模式分别配置了色组，但 16 个硬编码 Hex 色值直接散落在业务组件顶部，未收拢进 `theme.ts` 的 palette 扩展中，脱离了设计系统集中管辖。

#### 违规 3：规范自相矛盾与 `radius: 24` 漂移
- `src/presentation/screens/approvalDetailScreen.tsx:150` 设置了 `borderTopLeftRadius: 24`。
- 查看 `01-界面设计规范.md` §6.3.1 文案写道：“遮罩 + 24 圆角底部卡片”，但查阅同一文档 §4.2 的 Token 表格，根本不存在 `radius: 24` 这一项！规范自身出现前后撕裂，导致实现侧无法使用 Token 只能写死数字。

---

## 六、可访问性、触控热区与键盘避让审计

### 1. 触控热区与无障碍语义覆盖

在触控面积与无障碍标签方面，移动端表现极其优秀：
- **触控物理尺寸**：
  - `Button.tsx:95`：`minHeight: 48`，满足移动端高阶热区标准；
  - `IconButton.tsx:81`：固定 `width: 44, height: 44`，同时外加 `hitSlop={4}`，有效触控域达 `52x52`；
  - `ListRow.tsx:97` 与 `FileRow.tsx:95`：统一为 `minHeight: 56`；
  - `NotificationRow.tsx:95`：`minHeight: 76`；
- **读屏器语义覆盖**：全仓库共有数十处 `Pressable`，每一个交互项均明确标注了 `accessibilityRole="button"` 与带动态状态插值的 `accessibilityLabel`（如 `NotificationRow` 明确标注类别、标题与未读状态，`FileRow` 标注文件名与敏感标识）。

---

### 2. 键盘避让与安全区交互缺陷 (KBD-01)

#### 缺陷 1：会话详情页键盘抬起叠加底部内衬悬空
查看 `src/presentation/screens/sessionDetailScreen.tsx:122-172`：
```tsx
<Screen avoidKeyboard>
  ...
  <View
    style={[
      styles.composerBar,
      {
        paddingBottom: Math.max(insets.bottom, theme.space.sm),
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.canvas,
      },
      theme.shadow.floating,
    ]}
  >
```
**运行期表现**：
- `Screen` 的 `avoidKeyboard` 在 iOS 下为包裹外层的 `<KeyboardAvoidingView behavior="padding">`。
- 当软键盘弹起时，`KeyboardAvoidingView` 会将整个内容区向上顶起一个键盘高度（如 336pt）。
- 此时软键盘已经覆盖了屏幕底部的 Home Indicator（即 `insets.bottom` 物理区域已被软键盘遮盖），输入框下方的安全区应收敛为 `theme.space.sm`（8pt）。
- 但由于 `paddingBottom` 依然无条件执行 `Math.max(insets.bottom, 8)`，在全面屏 iPhone 上，`insets.bottom = 34` 依然生效！
- 结果导致：**输入栏被顶起后，其底部与软键盘顶部之间多出了整整 34pt 的丑陋空白断层**！输入条尴尬地悬空。

#### 缺陷 2：手动配对表单缺少 ScrollView 导致小屏截断
查看 `src/presentation/pair/pairManualScreen.tsx:161-236`：
```tsx
<Screen avoidKeyboard>
  <AppHeader title="手动连接" onBack={handleBack} />
  <View style={styles.content}>
    <Input testID="pair-host-input" label="主机" ... />
    <Input testID="pair-code-input" label="配对码" ... />
    <Pressable ...><AppText>高级设置</AppText></Pressable>
    {advanced ? <Input testID="pair-port-input" label="端口" ... /> : null}
    ...
    <Button label="连接" ... />
    <Pressable ...><AppText>连接遇到问题？</AppText></Pressable>
  </View>
</Screen>
```
**小屏设备事故场景**：
- `content` 是一个普通的 `<View>`，**外部未包裹 `ScrollView`**！
- 当用户在 iPhone SE（4.7 寸，逻辑高度 667）或小屏 Android 手机上操作时，若展开了“高级设置”（出现端口输入框），接着点击输入框唤起数字键盘；
- 软键盘升起占据约 280~320pt 空间，剩余可用视口仅剩 300 多点；
- “连接”主按钮以及下方的帮助链接直接被挤出屏幕下方，且由于没有滚动容器，**用户完全无法向上滚动**，根本无法点击“连接”按钮，造成交互死锁。

---

### 3. 大文件文本预览未虚拟化性能风险 (PERF-01)

查看 `src/presentation/components/files/FilePreview.tsx:84-96` 与 `useFilePreviewVm.ts:30`：
```tsx
<ScrollView contentContainerStyle={styles.content}>
  {numberedLines(vm.content).map((line, index) => (
    <AppText key={index} testID="preview-line" variant="mono" ...>
      {line}
    </AppText>
  ))}
  ...
</ScrollView>
```
- `useFilePreviewVm.ts` 中定义的 `PREVIEW_LINES_HARD_CAP` 高达 5000 行，默认首屏也是 400 行。
- `FilePreview` 直接使用 `Array.map` 循环生成了几百到上千个独立的 `<AppText>` 原生文本组件，放置在一个普通的 `ScrollView` 中。
- **性能隐患**：在移动端，无虚拟化的大文本渲染会直接触发大量原生文本视图创建，当加载到 1000~2000 行以上时，在低端设备上会导致秒级的界面冻结（Main Thread 阻塞）甚至爆内存闪退。  
- **对比反差**：反观 `TerminalView.tsx`，其采用了固定行高（`TERMINAL_LINE_HEIGHT = 24`）与 `FlatList.getItemLayout` 实现了极致虚拟化。`FilePreview` 应当借鉴该设计，或将文本合并为一个大 Text 块进行展示。

---

## 七、改进建议与修复路线图

针对上述审计发现，按照影响等级与修复紧迫度提出如下整改方案：

### 第一阶段：P0 级路由与崩溃自愈收敛（立即阻断）

1. **补齐深链映射并解开任务路由死锁**：
   - 在 `src/notifications/notificationMeta.ts` 的 `DEEP_LINK_ROUTE_TABLE` 中显式补齐：
     - `sessions: () => '/sessions'`
     - `notifications: () => '/notifications'`
     - `approvalHistory: () => '/approval-history'`
   - 重构 `notificationRouteToPath` 的判定流程：如果 `DEEP_LINK_ROUTE_TABLE[screen]` 未命中，先不要返回 `null`，而是继续流转至后方的 `kind` / `runId` 兜底解析（使 `task`、`subagent` 事件能顺利回退到 `/run/{runId}` 或 `/session/{sessionId}`）。
2. **重构 ErrorBoundary 并注入逃生路径**：
   - 在 `ErrorBoundary.tsx` 的 Fallback 界面中，新增“返回主页”按钮（调用 `router.replace('/(tabs)')`）与“重置缓存”选项；
   - 在 `sessionDetailScreen.tsx` 与 `runDetailScreen.tsx` 等复杂重数据页面入口处，包裹屏级二级 `ErrorBoundary`，避免局部数据损坏引发全局白屏。

### 第二阶段：P1 级导航防死锁与键盘交互适配

1. **统一二级页面安全返回（Safe Back Pattern）**：
   - 提取 `useSafeBack` hook 或通用返回方法：
     ```ts
     export function useSafeBack(fallback: Href = '/(tabs)') {
       return useCallback(() => {
         if (router.canGoBack()) router.back();
         else router.replace(fallback);
       }, [fallback]);
     }
     ```
   - 全面替换 `session/[sessionId].tsx`、`run/[runId].tsx`、`approval/[toolCallId].tsx` 等处的裸 `router.back()`。
2. **键盘弹出安全区动态收敛**：
   - 在 `sessionDetailScreen.tsx` 中监听键盘状态（或使用 `useKeyboard`），在键盘处于打开状态（`keyboardShown === true`）时，底部 padding 动态降为 `theme.space.sm`（8pt），关闭时恢复 `Math.max(insets.bottom, 8)`，消除悬空断层。
3. **手动配对页滚动容器补齐**：
   - 将 `pairManualScreen.tsx` 的内容容器改为带 `keyboardShouldPersistTaps="handled"` 的 `ScrollView`，确保小屏设备弹键盘时表单可顺畅上下滑动。

### 第三阶段：P2 级体验与规范收敛

1. **收拢设计 Token**：
   - 将 `SessionListItem.tsx` 中的 `LIGHT_TONES` / `DARK_TONES` 抽取并合并入 `theme.ts` 的语义 Palette；
   - 将 `TimelineView.tsx:389` 的 `borderRadius: 16` 纠正为 `theme.radius.md`（12）；
   - 在 `theme.ts` 中补齐 `radius.cardModal: 24`（或按规范统一收敛回 18），消灭规范两处文档冲突。
2. **`SlideToConfirm` 与 `Sheet` 手势健全**：
   - 限制 `SlideToConfirm` 的触发起点仅限滑块自身区域；
   - 为 `Sheet.tsx` 的顶部指示手柄挂载基于 PanResponder 的下滑 80dp 关闭手势，提升原生触摸跟手感；
   - 为 `TimelineView.tsx` 的 `FadeIn` 增加 `reduceMotion` 判断，并利用已读状态标志位避免滚动复用时二次播放。
3. **文件预览长文本虚拟化**：
   - 改造 `FilePreview.tsx`，将逐行 `map` 改为单一大文本容器，或采用 `FlatList` 虚拟化渲染，消除长文件内存隐患。
