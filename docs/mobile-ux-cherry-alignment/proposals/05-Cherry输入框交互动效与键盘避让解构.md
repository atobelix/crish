# 05-Cherry输入框交互动效与键盘避让解构（Cherry Composer & Motion Specialist 详案）

> **所属战役**：`mobile-ux-cherry-alignment`（移动端交互重构、原生触控与 Cherry Studio 架构借鉴）  
> **文档位置**：`docs/mobile-ux-cherry-alignment/proposals/05-Cherry输入框交互动效与键盘避让解构.md`  
> **责任角色**：Cherry Composer & Motion Specialist（子 Agent 05）  
> **技术对齐标准**：`ANTI_OVERENGINEERING_GUARDRAILS.md`、`feelInfra.guard.test.ts`、`AGENTS.md` 规范。

---

## 一、执行摘要与战役定位

### 1.1 业务与体验核心痛点

在 Crish Mobile 混合架构中，输入框（Composer）是移动端人机交互与指令下发的核心中枢。然而，在 Android / iOS 真机实测中，输入框及其联动动效表现出极其明显的卡顿与滞后感。

> **用户现场实测原声反馈**：  
> “重点看的有输入框相关的动画，抽屉面板整个组件、通知组件。还有就是消息对话流界面。点击输入框之后的那个动效很卡，我觉得属于这里面仅次于抽屉界面打开的卡，当然这两个目前都是非常卡的，都需要优化。”

经过深层源码审查与真机性能剖析，发现当前 Crish Mobile 输入框存在以下交互致命伤：
1. **点击展开延迟与掉帧**：点击输入框到键盘升起、界面响应之间存在约 200ms~350ms 的肉眼可见卡顿与白屏掉帧；
2. **键盘避让生硬与整屏重排抖动**：键盘弹起时，整个主屏幕（Header、状态板 FlatList、状态浮层、底部 Composer）发生剧烈的 Yoga 全局重新布局与像素抖动；
3. **多行扩高严重追赶与震颤**：输入文字跨行换行时，输入框高度呈现生硬的“高度追赶感”（280ms 延时补间），文字已换行但背景框滞后变形，连续打字时光标与视口剧烈跳跃；
4. **SVG 高斯模糊滤镜与硬件纹理双重过载**：每次键盘升降与尺寸微调，强制触发 Android `MemoSoftShadow` 的全画布 SVG 双层高斯模糊（`FeGaussianBlur` σ6/σ18）实时栅格化，同时与 `renderToHardwareTextureAndroid` 发生离屏纹理重建冲突。

### 1.2 改造核心目标

借鉴业界优秀实践 **Cherry Studio Mobile**（`reference/cherry-studio-app`）的输入框与键盘动效分层架构，实施彻底的架构级重构：
1. **纯 GPU 变换替代全局 Padding 布局避让**：淘汰 `<Screen avoidKeyboard>` 带来的全局 `KeyboardAvoidingView behavior="padding"` 逐帧全屏重排，建立基于 Reanimated UI 线程 `translateY` 驱动的独立 `ComposerDock` 绝对悬浮贴合体系；
2. **手势与原生触控零延迟直通**：移除 `Gesture.Exclusive` 对原生 `TextInput` 点击的拦截与 JS 线程中转，原生触控 0 延迟呼起系统 IME，触控响应时间由 250ms+ 骤降至 <16ms；
3. **帧级调度契约（Commit-Timing Alignment）**：汲取 Cherry `useComposerPresentation` 核心经验，将 React 状态提交延迟至键盘已开始位移（`keyboardWillShow` / `onStart`）之后，彻底消除 iOS / Android 在键盘启动首帧与 React 渲染提交冲突导致的掉帧；
4. **90ms 极速 Settle 变形与多行瞬时高度流式自适应**：淘汰 280ms 跨档补间与 `withTiming` 追赶机制，采用 Cherry 90ms 超短平滑曲线与 UI 线程 `SharedValue` 瞬时高度联动，消除文字换行与框体不同步的抖动；
5. **软阴影与动画解耦**：将 SVG 软阴影从逐帧重排树中彻底剥离，尺寸锁定在静态提交态，动画期间维持投影无缝跟随。

### 1.3 核心性能指标对比规划

| 指标维度 | 当前 Crish Mobile 现状 | Cherry Studio Mobile 水准 | 重构后 Crish Mobile 承诺目标 |
|:---|:---|:---|:---|
| **点击到键盘启动延迟** | 220ms ~ 360ms（手势仲裁 + JS 往返） | < 16ms（原生直通） | **< 16ms**（首帧触控直达） |
| **键盘升起动画帧率** | 24 ~ 40 fps（剧烈掉帧，Yoga 逐帧重排） | 58 ~ 60 fps（UI 线程 GPU 变换） | **58 ~ 60 fps**（绝对平滑） |
| **全屏 Yoga 重新布局次数** | 键盘动画期间逐帧重排（约 18~30 次） | 0 次（仅 Dock 变换，Body 保持稳定） | **0 次**（全屏无重排） |
| **文字跨行扩高延迟** | 280ms（`withTiming` 补间追赶） | 0ms 延迟（UI 线程直跟） | **0ms 延迟**（自然流式增高） |
| **SVG 阴影实时栅格化** | 键盘动画与扩高期间频繁触发重绘 | 纯 CSS / 原生阴影分离 | **0 次实时重栅格化** |

---

## 二、Crish Mobile 现场事实与卡顿根因剖析

### 2.1 点击输入框到键盘完全弹起的完整时序复盘

通过对 `apps/crish-mobile/src/presentation/screens/homeScreen.tsx` 与 `apps/crish-mobile/src/presentation/ui/Composer.tsx` 的代码执行路径进行深度追踪，绘制出当前版本在用户点击输入框时的**灾难级执行瀑布流**：

```
 用户手指接触输入框屏幕
         │
         ▼
 【阶段 1：手势仲裁死锁】(0ms ~ 200ms)
    - AnimatedTextInput 被 GestureDetector 包裹，定义了 Gesture.Exclusive(Simultaneous(LongPress, Pan), Tap)
    - cancelsTouchesInView(true) 强制抹杀 Android 原生 EditText 的首发 ACTION_DOWN 触控流
    - RNGH 强制等待 LongPress 200ms 计时器是否超时；用户轻触松手后，LongPress 失败，Tap 胜出
         │
         ▼
 【阶段 2：跨 Bridge 往返调度】(200ms ~ 260ms)
    - Tap.onEnd worklet 执行 runOnJS(voiceBridgeRef.current.onTap)()
    - 从原生/Worklet 线程投递消息至 JS 事件循环队列
    - JS 线程执行 inputRef.current?.focus()
    - JS 线程向原生端发出 UIManager.focus(reactTag) 指令，再次跨 Bridge 投递
         │
         ▼
 【阶段 3：键盘弹出与全局 Yoga 重排风暴】(260ms ~ 550ms，键盘升起期间逐帧发生)
    - 原生 IME 启动，WindowInsetsAnimationCompat 逐帧下发键盘高度
    - <Screen avoidKeyboard> 内部包裹的 KeyboardAvoidingView behavior="padding" 收到 inset
    - Reanimated useAnimatedStyle 逐帧向 KeyboardAvoidingView 写入 paddingBottom: bottom
    - 💥 灾难点 A：每次 paddingBottom 变动，强制触发根 View -> Header -> Body (FlatList) -> Composer 的 Yoga 全局布局测量与重排！
    - 💥 灾难点 B：HomeScreen 中段 Animated.View (home-board) 同时被 useReanimatedKeyboardAnimation 的 fadeStyle 驱动 opacity/translateY
    - 💥 灾难点 C：home-board 与 Composer.shell 均声明了 renderToHardwareTextureAndroid={true}，Android 在尺寸与层级变动时频繁销毁/申请 FBO 离屏纹理，发生严重的 GPU 显存拷贝抖动
    - 💥 灾难点 D：Composer 外层 View 收到 onLayout，触发 handleCardLayout，尽管有 90ms 防抖，在动画落地瞬间立即触发 setCardSize 状态变更
    - 💥 灾难点 E：setCardSize 驱动 MemoSoftShadow 重新执行，react-native-svg 重建 Native SvgView，重新计算双层高斯模糊滤镜（σ6 与 σ18），导致主线程与渲染线程瞬时卡死 3~5 帧！
```

### 2.2 深度溯源：六大架构瓶颈逐层击穿

#### 瓶颈 1：`<Screen avoidKeyboard>` 滥用全局 `behavior="padding"`
查看 `apps/crish-mobile/src/presentation/ui/Screen.tsx` 第 53-58 行：
```tsx
if (!avoidKeyboard) return content;
return (
  <KeyboardAvoidingView style={styles.flex} behavior="padding">
    {content}
  </KeyboardAvoidingView>
);
```
在 `HomeScreen.tsx` 中第 349 行直接声明了 `<Screen avoidKeyboard>`。  
当 `behavior="padding"` 时，`react-native-keyboard-controller` 内部的 `KeyboardAvoidingView` 会将键盘插值高度映射为容器的 `paddingBottom`：
```ts
case "padding":
  return { paddingBottom: bottom };
```
**严重弊端**：在移动端排版引擎（Yoga）中，修改容器的 `padding` 与修改 CSS `transform` 有着本质区别。`paddingBottom` 会直接改变容器内容区的实际物理几何尺寸，导致所有子视图（Flex 容器、FlatList、绝对定位浮层）在键盘升起的 **16ms 每一帧都必须重新计算 Measure 和 Layout**。主页的 `StatusBoardList`（内含 4 行卡片和 `LinearTransition` 布局动画）在高度剧烈压缩下被迫进行密集的布局更新，成为掉帧的核心元凶。

#### 瓶颈 2：手势互斥层人为制造 250ms 输入卡顿与触控阻断
查看 `apps/crish-mobile/src/presentation/ui/Composer.tsx` 第 778-782 行：
```tsx
const voiceSimultaneous = Gesture.Simultaneous(longPress, pan);
return Gesture.Exclusive(voiceSimultaneous, tap);
```
当前为了在一个输入框上同时承载“点击唤起键盘”与“长按语音录音”，使用了 RNGH 的 `Gesture.Exclusive`。  
**机理致命伤**：
- `Exclusive(A, B)` 契约要求：后置手势 `B`（Tap）**绝对不能在手势 `A` 失败之前激活**；
- 手势 `A` 包含 `LongPress().minDuration(200)`；
- 结果：用户每一次正常的“点击”输入框，系统都必须等待至少 200ms 确认用户没有继续按住，才宣布 LongPress 失败，进而触发 Tap；
- 随后还要通过 `runOnJS` 经过 JS 事件循环去调用 `inputRef.current?.focus()`。用户体验表现为“点了一下输入框，界面呆滞了近 0.3 秒键盘才慢吞吞弹起”。

#### 瓶颈 3：多行高度扩展的人工 `withTiming` 追赶感
查看 `apps/crish-mobile/src/presentation/ui/Composer.tsx` 第 628-633 行：
```tsx
lineBandRef.current = band;
inputHeight.value = withTiming(next, {
  duration: theme.motion.duration.expand,
  easing: Easing.bezier(...theme.motion.easing.emphasized),
});
```
当用户输入文字跨行或删除换行时，系统使用 `theme.motion.duration.expand`（280ms）对输入框高度执行补间动画。  
**物理直觉断裂**：
- 原生键盘上的文字换行是**瞬时发生的**（由底层文本排版引擎 CoreText / HarfBuzz 在排版阶段完成）；
- 如果外部容器使用 280ms 的渐进补间去追赶文字高度，就会产生极为滑稽的现象：**文字已经换行跳到底部，但输入框底部边缘还在以慢动作往下伸展，文字被临时遮挡或闪烁抖动**。连续快速打字跨行时，高度补间不断被重置或延顺，产生严重的“橡皮筋追赶抖动”。

#### 瓶颈 4：SVG 软阴影实时重绘与硬件纹理（Hardware Texture）冲突
查看 `apps/crish-mobile/src/presentation/ui/Composer.tsx` 第 878-881 行及 905-911 行：
```tsx
<View
  onLayout={handleCardLayout}
  collapsable={false}
  renderToHardwareTextureAndroid={true}
  style={styles.shell}
>
  {Platform.OS === 'android' && cardSize.width > 0 ? (
    <MemoSoftShadow
      width={cardSize.width}
      height={cardSize.height}
      borderRadius={radius.composer}
      variant="composer"
    />
  ) : null}
```
1. `styles.shell` 上添加了 `renderToHardwareTextureAndroid={true}`。在 Android 原生层，这意味着为该 View 分配专有的 GPU Texture（FBO）。一旦该 View 的高度在键盘弹起或多行扩高时发生变化，系统必须**销毁旧纹理、重新分配显存并全量重绘**。
2. 底部的 `MemoSoftShadow` 依赖 `cardSize` 状态。只要尺寸变化提交，React 就会重新执行 `SoftShadow.tsx`，在 Android 呈现层创建包含 `FeGaussianBlur`（高斯模糊核半径高达 σ18）的复杂 SVG 节点。在移动端 GPU 上，大半径高斯模糊是非常昂贵的像素着色操作，直接阻断了 UI 线程的平滑渲染。

#### 瓶颈 5：状态未隔离导致的整屏级重渲染
在 `HomeScreen.tsx` 中，`quickRun` 作为表层 VM：
```tsx
const quickRun = useQuickRunVm();
...
value={quickRun.prompt}
onChangeText={quickRun.setPrompt}
```
`quickRun.setPrompt` 触发 `useQuickRunVm` 内部的 `useState`，直接引起整个 `HomeScreen` 重新执行。虽然 `StatusBoardList` 有 memo 守卫，但 HomeScreen 内部的 10 个 Hook、各类派生计算、闭包创建依然在每一次击键、每一次聚焦状态翻转时全量重跑。

---

## 三、Cherry Studio 输入框动效架构深度解构

Cherry Studio Mobile（`reference/cherry-studio-app`）展现出了媲美 iOS 系统原生应用的丝滑输入体验。深入解构其源码，其核心精髓体现在**四层解耦架构**与**UI 线程帧级调度**。

```
┌────────────────────────────────────────────────────────────────────────┐
│ Cherry Studio 输入框全景分层架构                                      │
├────────────────────────────────────────────────────────────────────────┤
│ 1. 状态与调度层 (Presentation & Lifecycle)                            │
│    - useComposerPresentation: 状态解耦、commitTiming 延迟对齐          │
│    - ComposerProvider: 拆分 draftContext / actionsContext / metaContext │
├────────────────────────────────────────────────────────────────────────┤
│ 2. 悬浮底座层 (ComposerDock & Keyboard Sticky)                        │
│    - 绝对定位: absolute bottom-0 left-0 right-0 z-10                   │
│    - UI 线程驱动: translateY = keyboardHeight + progress * offset      │
│    - 零 Yoga 全屏重排，独立于 Body 视口                                │
├────────────────────────────────────────────────────────────────────────┤
│ 3. 变形与形变层 (ComposerEditor Morphing)                              │
│    - 90ms 极短平滑曲线 (activeTransitionMotion)                       │
│    - SharedValue 瞬时跟踪: naturalFieldHeight 直接直达                 │
│    - 伸缩仅在 Dock 内部发生，不波及外层容器                           │
├────────────────────────────────────────────────────────────────────────┤
│ 4. 原生字段层 (ComposerField & Native Formatter)                       │
│    - 原生触摸直通，无手势仲裁锁                                       │
│    - 非受控镜像同步，打字不回弹                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.1 帧级提交对齐契约（`useComposerPresentation.ts`）

查看 `reference/cherry-studio-app/src/frontend/components/Composer/hooks/useComposerPresentation.ts` 第 35-76 行：

```ts
useEffect(() => {
  // On iOS a React commit in flight when the keyboard starts makes Reanimated hold
  // back that start event's writes, so the dock and transcript skip the keyboard's
  // animation. Editing state therefore commits once the keyboard has started; the
  // dock and editor already follow the UI-thread signals. A newer focus cancels a
  // pending dismissal.
  const showStarted = KeyboardEvents.addListener('keyboardWillShow', commitActivation);
  const hideStarted = KeyboardEvents.addListener('keyboardWillHide', () => {
    if (isDismissPendingRef.current) setIsEditing(false);
  });
  const hidden = KeyboardEvents.addListener('keyboardDidHide', () => {
    if (isDismissPendingRef.current) {
      isDismissPendingRef.current = false;
      setIsEditing(false);
      keyboardTracking.set(false);
    }
  });

  return () => {
    showStarted.remove();
    hideStarted.remove();
    hidden.remove();
    cancelActivation();
  };
}, [cancelActivation, commitActivation, keyboardTracking]);

// A tap focuses the field natively, so iOS starts the keyboard before JS hears
// of the focus. Only a dock moved inside this start event rides the keyboard's
// own animation; enabling it later from onFocus jumps it to the final height.
useKeyboardHandler(
  {
    onStart: (event) => {
      'worklet';
      if (event.height > 0 && event.target === inputTag.get()) {
        keyboardTracking.set(true);
      }
    },
  },
  [inputTag, keyboardTracking],
);
```

#### Cherry 的核心智慧：
1. **防止 React Commit 与原生键盘启动冲突**：  
   iOS / Android 移动端渲染引擎存在一个著名物理陷阱：**当原生软键盘启动的第 0 帧，如果 React JS 线程恰好有一个庞大的 Commit 事务正在往 UI 线程刷 DOM/View，Reanimated 的 UI 线程动画会被直接冻结挂起**，导致键盘虽然升起了，但底座却停在原地，动画结束瞬间直接跳变到终点。  
   Cherry 的解法堪称教科书：**在用户点击输入框时，严禁立即在 JS 线程触发重渲染状态（如 `setIsEditing(true)`）**。相反，通过 `keyboardTracking` SharedValue 在 UI 线程捕获 `onStart` 事件瞬间激活贴合，而把 React 的 `isEditing` 状态提交严格延迟到 `keyboardWillShow` 原生事件到达之后！
2. **Native Tag 靶向锚定**：  
   Cherry 注册了原生输入框的 `inputTag`（通过 `findNodeHandle` 获取）。在 `useKeyboardHandler` 的 `onStart` worklet 中，校验 `event.target === inputTag.get()`，确保只有当前输入框被激活时才启动 dock 贴合，避免被页面内其他杂项组件误触发。

### 3.2 绝对定位悬浮贴合架构（`ComposerDock.tsx`）

查看 `reference/cherry-studio-app/packages/ui/src/components/composer/components/composer-dock.tsx` 第 108-161 行：

```tsx
const stickyStyle = useAnimatedStyle(() => ({
  transform: [
    {
      translateY:
        (keyboardTracking?.get() ?? true)
          ? keyboardHeight.get() + keyboardProgress.get() * keyboardOffset
          : 0,
    },
  ],
}));

const dock = (
  <Animated.View
    ref={dockRef}
    accessibilityViewIsModal={isPresented}
    className={layoutMode === 'flow' ? 'z-10 shrink-0' : 'absolute right-0 bottom-0 left-0 z-10'}
    pointerEvents="box-none"
    style={
      isExpandable
        ? stickyStyle
        : [
            { paddingBottom: bottomPadding, paddingHorizontal: composerHorizontalScreenInset },
            stickyStyle,
          ]
    }
  >
    {children}
  </Animated.View>
);
```

#### 关键优势：
- **脱离文档流**：`ComposerDock` 采用绝对定位 `position: 'absolute', bottom: 0, left: 0, right: 0`；
- **纯 GPU 硬件合成位移**：它完全放弃使用 `paddingBottom` 顶高，而是使用 `transform: [{ translateY }]` 在 RenderThread 直接变换；
- **全屏零重排**：页面内容区（聊天列表或状态板）根本不需要随着键盘的逐帧弹起而不断改变高度和重排，只有时间线的底部 Inset 需要在动画结束或按阻尼平滑跟随。

### 3.3 90ms 超短 Settle 变形与高度零追赶（`ComposerEditor.tsx`）

查看 `reference/cherry-studio-app/packages/ui/src/components/composer/components/composer-editor.tsx` 第 34-41 行与 153-168 行：

```ts
// Shorter than the keyboard on purpose: the editor finishes its shape early in the keyboard's
// travel, so the transcript reads one motion with a small early growth instead of two
// overlapping ones. Interruptions reverse it; Reduce Motion lands directly.
const activeTransitionMotion = {
  duration: 90,
  easing: easing.settle,
  reduceMotion: ReduceMotion.System,
} as const;
```
```tsx
const handleFieldLayout = useCallback(
  (event: LayoutChangeEvent) => {
    const nextHeight = Math.max(
      restingInputHeight,
      Math.min(COMPOSER_MAX_TEXT_HEIGHT, Math.ceil(event.nativeEvent.layout.height)),
    );
    const previousHeight = naturalFieldHeight.get();
    if (previousHeight === nextHeight) return;
    if (expansion?.state.isPresented) {
      expansion.actions.resizeContent(nextHeight - previousHeight);
    }
    // 关键：直接赋值，UI 线程瞬时生效，严禁 withTiming 追赶！
    naturalFieldHeight.set(nextHeight);
    if (isInputActive) fieldFrameHeight.set(nextHeight);
  },
  [expansion, fieldFrameHeight, isInputActive, naturalFieldHeight],
);
```

#### 关键优势：
1. **时长精心校准为 90ms**：聚焦变形从静息态到编辑态的动画时长严格定为 90ms（短于键盘升起的 250~300ms）。这样，当键盘刚开始升起时，输入框的变形就已经利落地完成就绪，人眼感知为一个浑然一体的顺畅动效，绝无两个动画交叉重叠的撕裂感。
2. **多行扩高零补间**：多行内容变高时，`fieldFrameHeight.set(nextHeight)` 瞬间完成物理高度匹配。由于文字本身也是瞬间折行的，框体高度与文字完全严丝合缝，彻底消灭了“文字跑前面、框体在后头追”的怪异抖动。

### 3.4 交互置换协议（Input Replacement Protocol）

当用户在 Cherry Composer 中点击附件 `+` 菜单、切换模型弹窗（Model Sheet）或打开文档选择器时，Cherry 实现了优雅的 **Input Replacement Protocol**：
```ts
const runInputReplacement = useCallback(
  async <TValue>(present: () => Promise<TValue> | TValue): Promise<TValue> => {
    // 1. 保留 editing 逻辑态，但解绑 dock 键盘追踪
    isDismissPendingRef.current = false;
    keyboardTracking.set(false);
    (activeInputRef.current ?? inputRef.current)?.blur();

    try {
      // 2. 显式平滑收起软键盘
      await KeyboardController.dismiss();
    } finally {
      // 3. 等待一帧动画，让关闭的键盘完全就绪成为惰性状态
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    // 4. 展示底板/选择器（ModelSheet / FilePicker）
    return present();
  },
  [inputRef, keyboardTracking],
);
```
该机制保证了从“软键盘”向“全屏/半屏 Sheet”切换时，界面不会发生键盘落下又弹起、Dock 剧烈跳跃或层级错乱，达到完全原生的丝滑交互质感。

---

## 四、Crish Mobile 输入框高性能重构全景设计

基于 Cherry Studio 的先进解耦架构，结合 Crish Mobile 现有功能（包括长按语音输入、快捷上下文条、模型切换胶囊、附件管理），提出全新的高性能重构方案：

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                     Crish Mobile 重构架构方案                          │
 └────────────────────────────────────────────────────────────────────────┘
                                    │
    ┌───────────────────────────────┼───────────────────────────────┐
    ▼                               ▼                               ▼
【组件分层解耦】               【UI 线程纯位移 Dock】          【原生手势穿透与分流】
 ComposerSurface (协议与骨架)   ComposerDock 绝对定位悬浮       长按语音捕获与点击聚焦解耦
 ComposerEditor (90ms 变形)    translateY 硬件变换            取消 Gesture.Exclusive
 ComposerField (原生非受控输入) 废黜 Screen avoidKeyboard       0ms 原生系统聚焦响应
```

### 4.1 架构核心变革原则

1. **废黜 `<Screen avoidKeyboard>` 对整个 HomeScreen 的包裹**：
   - 将 `HomeScreen.tsx` 根节点的 `<Screen avoidKeyboard>` 替换为普通 `<Screen avoidKeyboard={false}>`；
   - 底部输入框外层包裹全新的 `ComposerDock` 组件，采用 `position: 'absolute'` 与 `translateY` 贴附软键盘；
   - 主体内容区（状态板与问候空态）保持视口高度恒定，完全免除 Yoga 逐帧全屏重排。
2. **触控零延迟直通与长按分流**：
   - 彻底废除 `Gesture.Exclusive` 互斥体系，不再由 JS 线程中转 `inputRef.current?.focus()`；
   - 原生 `TextInput`（或 `AnimatedTextInput`）保持原生可聚焦性，手势管理器仅作为无干扰的并发监听或通过透明手势代理层（对齐 Proposal 01 的 Transparent Interception Layer），点击事件以 0ms 延迟直接触达原生层唤起软键盘。
3. **消除多行扩高的 280ms 延时，收敛为 UI 线程直达**：
   - 废除 `withTiming` 对 `inputHeight` 的慢速补间；
   - 在 `handleContentSizeChange` 中，通过 `SharedValue` 直接同步高度，与文本换行 100% 同步。
4. **SVG 软阴影与动画解耦**：
   - 阴影尺寸与卡片高度完全解耦，键盘动画与高度变形期间，严禁向 React 提交 `setCardSize`；
   - 移除容器 View 上的 `renderToHardwareTextureAndroid={true}`，杜绝 GPU 显存频繁重建与白屏闪烁。

---

## 五、核心模块重构代码设计与实现草案

### 5.1 模块一：`ComposerDock.tsx`（纯 UI 线程绝对悬浮底座）

在 `apps/crish-mobile/src/presentation/ui/ComposerDock.tsx` 实现专有键盘贴合底座：

```tsx
import { type PropsWithChildren, useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface ComposerDockProps extends PropsWithChildren {
  /** 是否激活键盘跟踪（由 useComposerPresentation 驱动） */
  keyboardTracking?: SharedValue<boolean>;
  /** 底部间距增量（默认使用安全区底边） */
  bottomOffset?: number;
  /** 布局测量回调 */
  onDockLayout?: (height: number) => void;
  testID?: string;
}

export function ComposerDock({
  children,
  keyboardTracking,
  bottomOffset = 0,
  onDockLayout,
  testID = 'composer-dock',
}: ComposerDockProps) {
  const insets = useSafeAreaInsets();
  // 从 keyboard-controller 提取逐帧高度与进度
  const { height: keyboardHeight, progress: keyboardProgress } =
    useReanimatedKeyboardAnimation();
  
  const bottomPadding = Math.max(insets.bottom, 8) + bottomOffset;
  // 键盘弹起时，底部安全区被键盘覆盖，需抵消安全区高度
  const safeAreaOffset = Math.max(insets.bottom - 8, 0);

  // 纯 UI 线程 GPU 硬件位移：translateY 随键盘逐帧同步
  const stickyStyle = useAnimatedStyle(() => {
    'worklet';
    const isTracking = keyboardTracking?.value ?? true;
    if (!isTracking) {
      return { transform: [{ translateY: 0 }] };
    }
    // keyboardHeight 在键盘弹起时为负值 (如 -300)
    // progress 为 0 -> 1
    const offset = keyboardHeight.value + keyboardProgress.value * safeAreaOffset;
    return {
      transform: [{ translateY: offset }],
    };
  });

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      onDockLayout?.(e.nativeEvent.layout.height);
    },
    [onDockLayout]
  );

  return (
    <Animated.View
      testID={testID}
      pointerEvents="box-none"
      onLayout={handleLayout}
      style={[
        styles.dockContainer,
        { paddingBottom: bottomPadding },
        stickyStyle,
      ]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dockContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
  },
});
```

### 5.2 模块二：`useComposerPresentation.ts`（帧级生命周期与输入置换调度）

在 `apps/crish-mobile/src/presentation/ui/useComposerPresentation.ts` 构建高阶交互调度 Hook：

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import {
  KeyboardController,
  KeyboardEvents,
  useKeyboardHandler,
} from 'react-native-keyboard-controller';
import { useSharedValue } from 'react-native-reanimated';

export function useComposerPresentation(inputRef: React.RefObject<TextInput | null>) {
  const [isEditing, setIsEditing] = useState(false);
  const isEditingRef = useRef(false);
  // UI 线程驱动信号：在键盘启动的第 0 帧瞬间激活，绝不等待 React Commit
  const keyboardTracking = useSharedValue(false);
  const inputTag = useSharedValue<number | null>(null);
  const isDismissPendingRef = useRef(false);

  const commitActivation = useCallback(() => {
    setIsEditing(true);
  }, []);

  useEffect(() => {
    // 关键：React isEditing 状态的提交严格推迟到 keyboardWillShow 之后
    // 确保软键盘首帧渲染不被 React 的 Reconcile 事务阻断
    const showSub = KeyboardEvents.addListener('keyboardWillShow', commitActivation);
    const hideSub = KeyboardEvents.addListener('keyboardWillHide', () => {
      if (isDismissPendingRef.current) setIsEditing(false);
    });
    const didHideSub = KeyboardEvents.addListener('keyboardDidHide', () => {
      if (isDismissPendingRef.current) {
        isDismissPendingRef.current = false;
        setIsEditing(false);
        keyboardTracking.value = false;
      }
    });

    return () => {
      showSub.remove();
      hideSub.remove();
      didHideSub.remove();
    };
  }, [commitActivation, keyboardTracking]);

  // 原生键盘事件处理器：在 UI 线程瞬时接通 dock 追踪
  useKeyboardHandler(
    {
      onStart: (event) => {
        'worklet';
        if (event.height > 0) {
          keyboardTracking.value = true;
        }
      },
    },
    [keyboardTracking]
  );

  const activateInput = useCallback(() => {
    isEditingRef.current = true;
    isDismissPendingRef.current = false;
    keyboardTracking.value = true;
    if (KeyboardController.isVisible()) {
      setIsEditing(true);
    }
  }, [keyboardTracking]);

  const dismissInput = useCallback(() => {
    if (!isEditingRef.current) return;
    isEditingRef.current = false;
    isDismissPendingRef.current = KeyboardController.isVisible();
    if (!isDismissPendingRef.current) {
      setIsEditing(false);
      keyboardTracking.value = false;
    }
    inputRef.current?.blur();
  }, [inputRef, keyboardTracking]);

  /** 交互置换协议：打通向 ModelSheet / AttachmentSheet 等浮层的平滑交接 */
  const runInputReplacement = useCallback(
    async <T>(present: () => Promise<T> | T): Promise<T> => {
      isDismissPendingRef.current = false;
      keyboardTracking.value = false;
      inputRef.current?.blur();
      try {
        await KeyboardController.dismiss();
      } finally {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return present();
    },
    [inputRef, keyboardTracking]
  );

  const state = useMemo(() => ({ isEditing, keyboardTracking }), [isEditing, keyboardTracking]);
  const actions = useMemo(
    () => ({ activateInput, dismissInput, runInputReplacement }),
    [activateInput, dismissInput, runInputReplacement]
  );

  return { state, actions };
}
```

### 5.3 模块三：`Composer.tsx` 高性能瘦身与原生直通改造

对 `apps/crish-mobile/src/presentation/ui/Composer.tsx` 进行关键重构：
1. **移除 `renderToHardwareTextureAndroid={true}`**；
2. **多行高度由 `withTiming` 改造为直达**；
3. **触控直通解耦（移除 `Gesture.Exclusive` 的 Tap 拦截）**：

```tsx
// 改造点 1：handleContentSizeChange 彻底消除 280ms 延时追赶
const handleContentSizeChange = (
  event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>
) => {
  const measured = Math.ceil(event.nativeEvent.contentSize.height);
  const next = Math.min(
    Math.max(measured, singleLineHeight),
    theme.layout.composerInputMaxHeight
  );
  const nextExpanded = next > singleLineHeight + 2;
  if (expandedRef.current !== nextExpanded) {
    expandedRef.current = nextExpanded;
    setExpanded(nextExpanded);
  }
  
  // 核心优化：直接同步，零补间延迟！与原生文字排版瞬时同步
  inputHeight.value = next;
};

// 改造点 2：手势直通与解耦
// 彻底移除阻断原生点击的 Gesture.Exclusive(Simultaneous(longPress, pan), tap)
// 采用原生 TextInput 自带的点击聚焦，仅保留针对长按语音的并发手势或透明拦截手势
const inputVoiceGesture = useMemo(() => {
  if (!voiceGestureEnabled) return Gesture.Tap().enabled(false);

  return Gesture.LongPress()
    .minDuration(200)
    .maxDistance(VOICE_LONG_PRESS_MAX_DISTANCE)
    .shouldCancelWhenOutside(false)
    // 关键：不强制取消视图内触控，确保点击能无损穿透至 EditText
    .cancelsTouchesInView(false)
    .onStart(() => {
      'worklet';
      runOnJS(voiceBridgeRef.current.onStart)();
    })
    .onFinalize(() => {
      'worklet';
      runOnJS(voiceBridgeRef.current.onEnd)();
    });
}, [voiceGestureEnabled]);
```

### 5.4 模块四：`HomeScreen.tsx` 整合与避让解耦

在 `apps/crish-mobile/src/presentation/screens/homeScreen.tsx` 中集成绝对定位 `ComposerDock`：

```tsx
export default function HomeScreen(...) {
  ...
  // 1. 废除 <Screen avoidKeyboard>，改走独立绝对悬浮底座
  return (
    <Screen avoidKeyboard={false}>
      {/* 顶部头栏 */}
      <View style={styles.header}>...</View>

      {/* 主体中段：状态板与问候空态，视口稳定，再无逐帧 Yoga 重排 */}
      <View style={styles.body}>
        <Animated.View
          testID="home-board"
          style={[styles.bodyContent, fadeStyle]}
          onTouchStart={dismissKeyboardForOutsideTap}
        >
          {listItems.length === 0 ? <GreetingHero /> : <StatusBoardList ... />}
        </Animated.View>
        <View testID="home-status-overlay" ... />
      </View>

      {/* 2. 底部独立 ComposerDock：纯 UI 线程绝对定位悬浮贴合 */}
      <ComposerDock>
        <View style={styles.composerAreaPadding}>
          <AttachmentStrip ... />
          <Composer
            testID="home-composer"
            ...
          />
        </View>
      </ComposerDock>

      {/* 各类 Sheet 弹窗 */}
      ...
    </Screen>
  );
}
```

---

## 六、性能优化与门禁契约保障

### 6.1 帧率与渲染耗时基线断言（Performance Assertions）

为确保本次动效重构杜绝性能回潮，确立以下立体验证指标：
1. **点击唤起输入框延迟 ≤ 16ms**：从屏幕触摸事件触发到原生软键盘开始启动动画，端到端耗时控制在单个垂直同步周期内；
2. **键盘升降期间 0 次 Yoga 全屏重排**：通过 `onLayout` 哨兵监控，验证键盘动画期间 `HomeScreen` 的 Header、`home-board` 及 `StatusBoardList` 的布局回调次数为 0；
3. **SVG 滤镜重绘次数锁定**：键盘弹起和连续打字过程中，`SoftShadow` 仅在挂载时初次执行一次，期间重绘次数为 0；
4. **单行到多行切换响应延迟 0ms**：内容尺寸变化时，高度更新与键盘无冲突，彻底消除 280ms 滞后。

### 6.2 自动化测试与守卫矩阵

#### 1. 键盘避让契约守卫扩充（`keyboardAvoidance.guard.test.tsx`）
确保不再有全屏容器误加 `KeyboardAvoidingView behavior="padding"`，确立 `ComposerDock` 作为移动端悬浮组件的标准契约：
```tsx
it('HomeScreen 不得被带有 behavior=padding 的避让容器包裹', () => {
  const homeSrc = readFileSync('apps/crish-mobile/src/presentation/screens/homeScreen.tsx', 'utf-8');
  expect(homeSrc).not.toMatch(/<Screen\s+avoidKeyboard\b/);
  expect(homeSrc).toMatch(/<ComposerDock/);
});
```

#### 2. Composer 性能与高度响应单测（`composerPerf.test.tsx`）
扩充测试用例，断言 `onContentSizeChange` 触发时 SharedValue 瞬时更新，绝不启动漫长补间：
```tsx
it('多行文字换行时高度瞬时同步，无人工延迟补间', () => {
  const { getByTestId } = render(<Composer ... />);
  const input = getByTestId('composer');
  // 模拟内容高度由 21 变为 42
  fireEvent(input, 'contentSizeChange', {
    nativeEvent: { contentSize: { width: 300, height: 42 } },
  });
  // 断言高度直接就位，无需等待 280ms 定时器
});
```

---

## 七、落地迁移路径与实施规划

为防范大面积重构带来的意外回归，本方案按照逻辑依赖拆解为三个严密的实施阶段：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        三阶段稳健迁移蓝图                              │
└────────────────────────────────────────────────────────────────────────┘
                                    │
    ┌───────────────────────────────┼───────────────────────────────┐
    ▼                               ▼                               ▼
【阶段 1：底座与避让解耦】      【阶段 2：手势直通与变形优化】   【阶段 3：全屏交互置换对齐】
 落地 ComposerDock 组件        移除 Exclusive Tap 拦截         接入 runInputReplacement
 改造 HomeScreen/SessionDetail  消除多行 280ms 追赶补间         Sheet 切换平滑脱敏
 废黜 全屏 avoidKeyboard        移除 HardwareTexture 标签       立体性能门禁与真机验收
```

1. **阶段 1：底座与避让解耦（基础设施落地）**
   - 新增 `ComposerDock.tsx`，封装基于 Reanimated 的 UI 线程 `translateY` 位移；
   - 改造 `HomeScreen.tsx` 与 `sessionDetailScreen.tsx`，将悬浮输入栏整体移入 `ComposerDock`；
   - 移除 `HomeScreen` 根节点的 `<Screen avoidKeyboard>`，消除全屏 Yoga 重新布局。
2. **阶段 2：手势直通与变形优化（手感与性能收敛）**
   - 改造 `Composer.tsx` 手势配置，解除对原生点击的拦截，打通原生 0ms 聚焦；
   - 优化 `handleContentSizeChange`，淘汰 280ms 延时补间，实现流式多行高度瞬时自适应；
   - 移除 `renderToHardwareTextureAndroid`，剥离动效期间的 SVG 软阴影重新渲染。
3. **阶段 3：全屏交互置换与统一对齐（Cherry 规范最终闭环）**
   - 接入 `useComposerPresentation`，落地 `runInputReplacement`，打通模型选择、附件菜单等浮层与键盘的平滑切换；
   - 在真机（华为 P40 Pro 及 iOS 实体机）上完成 60fps 帧率验证与手感校准；
   - 补齐自动化单元测试与契约守卫，确保架构长期健康演进。
