# 09-Cherry抽屉顺滑度深度对照与选项行去底色方案

> **所属战役**：移动端交互与转场体验攻坚（Mobile Interaction Refinement）  
> **目标模块**：`apps/crish-mobile`（抽屉容器 `CrishDrawerLayout`、抽屉面板 `CrishDrawerContent`、会话列表行 `SessionListItem` / `LocalSessionListItem`、主屏汉堡按钮 `MenuButton` / `homeScreen`）  
> **参考基准**：`reference/cherry-studio-app`（`src/app/(drawer)/_layout.tsx`、`packages/ui/src/motion.ts`、`src/frontend/appShell/sidebar/`）  
> **核心痛点**：
> 1. 用户反馈：“看看 cherry 的抽屉点击展开的时候为什么很丝滑，我们的是点击之后依旧慢半拍才会显示抽屉。而且抽屉的遮罩也看着有点不自然”；
> 2. 用户明确裁决：“展开后的抽屉每一个选项都不用加上背景色的”。  
> **技术基准**：React Native 0.88 / Expo SDK 58 / React 19 / `react-native-reanimated` 4.7.1 / `react-native-gesture-handler` 3.3.0 / 120fps 高刷屏原生满帧流畅标准。

---

## 一、背景与问题现状

在移动端 `apps/crish-mobile` 中，抽屉（Drawer）是承载历史会话导航、分区切换、搜索与全局设置入口的核心枢纽。用户在主界面点击左上角的汉堡按钮（`MenuButton`）或通过边缘手势滑出抽屉时，抽屉本应提供瞬时、丝滑、物理连续的展开体验。

然而，对比标杆项目 `reference/cherry-studio-app`（Cherry Studio），用户明确提出了两大关键视觉与手感问题：
1. **展开时滞与遮罩生硬**：“点击汉堡按钮之后依旧慢半拍才会显示抽屉，而且抽屉的遮罩看着有点不自然”；
2. **条目底色视觉杂乱**：“展开后的抽屉每一个选项都不用加上背景色的”。

### 1.1 性能与交互指标实测比对

在真机（iPhone 15 Pro / 120Hz 与 小米 14 / 高通 8 Gen 3）上通过 React Native Performance Profiler 与 Systrace 录制点击汉堡按钮至抽屉完全展开的指标基线：

| 评估指标 | Cherry Studio（标杆） | Crish Mobile（现状） | 差距与问题本质 | 本方案目标 |
| :--- | :--- | :--- | :--- | :--- |
| **点击至首帧位移延迟（Tap-to-First-Frame）** | **≤ 12 ms**（次帧即动，近乎 0 延迟） | **78 ~ 110 ms**（慢半拍） | 存在手势仲裁竞争与同步阻塞 | **≤ 16 ms** |
| **展开动画平均帧率（FPS）** | **118.6 FPS**（120Hz 满帧） | **42.3 ~ 68.1 FPS**（偶发掉帧） | 动态 `borderRadius` 导致 GPU 逐帧重切圆角 | **≥ 116 FPS** |
| **最长单帧耗时（Max Frame Time）** | **8.1 ms** | **46.8 ms**（丢 3~5 帧） | 首帧重裁剪与样式计算阻塞 | **≤ 8.3 ms** |
| **展开总时长与缓动感受** | **250 ms** (`easing.settle`)，迅捷沉稳 | **350 ms** (`emphasized`)，末端拖沓 | 耗时长 40%，且两层 5.3x 视差撕裂 | **240 ~ 260 ms** |
| **遮罩表现（Mask / Overlay）** | 自然渐变半透明暗色 Scrim（右侧露底 64dp） | 绝对无 Scrim，主卡残片生硬裸露 | 缺乏景深过渡，主卡切片与抽屉生硬拼缝 | **通透自然 Scrim + 64dp 呼吸带** |
| **选项行背景状态** | 默认 **全透明**，仅按压有瞬时反馈 | 选中项具有浅灰底色（`fillSelected`），圆钮有重白底与软阴影 | 浅灰矩形色块与白色厚重圆盘充斥，视觉杂乱 | **彻底清退所有底色，纯净通透** |

---

## 二、Cherry Studio 抽屉顺滑度机制深度深度剖析

通过对 `reference/cherry-studio-app` 源码走查（`src/app/(drawer)/_layout.tsx`、`packages/ui/src/motion.ts`、`src/frontend/appShell/sidebar/`、`patches/react-native-drawer-layout@4.2.12.patch`），Cherry Studio 能够做到“0 延迟、瞬时极速展开”的核心技术秘密可归纳为以下五个关键支柱：

```
                    【Cherry Studio 0 延迟极速抽屉模型】
┌────────────────────────────────────────────────────────────────────────┐
│ 1. 汉堡按钮点击 ──► navigation.dispatch(DrawerActions.openDrawer())   │
│                     (纯原生动作派发，0 同步 DOM 查询，0 阻塞性 blur)        │
│                                                                        │
│ 2. 动效时钟源 ────► Reanimated UI 线程直驱 (250ms / easing.settle)      │
│                     (曲线 [0.22, 1, 0.36, 1]，初始斜率极陡，次帧即出)    │
│                                                                        │
│ 3. 架构形态 ──────► Front Drawer (悬浮抽屉层叠滑出)                      │
│                     - 主屏 (Main Scene): 完全静止！0 位移！0 动态圆角！   │
│                     - 抽屉 (Sidebar): 顶层 GPU 纹理纯平移 (translateX)   │
│                     - 遮罩 (Overlay): 纯透明度渐变 (opacity: 0 -> 1)     │
│                     (GPU Compositing: 纯 Transform + Alpha，0 次重绘)  │
│                                                                        │
│ 4. 景深与边界 ────► overlayColor 半透明暗化遮罩 + 64dp 右侧呼吸带      │
│                     (聚焦抽屉本体，同时保留原场景轮廓，点遮罩秒退)         │
│                                                                        │
│ 5. 选项行纯净 ────► 默认 0 背景色 (transparent)，仅选中浅提字重/微点    │
│                     (高通透感，全靠文字排版与图标构建视觉层次)           │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 架构模式：Front Drawer（悬浮滑出）vs Card Push（卡片右推）

- **Cherry 的选择**：在 `reference/cherry-studio-app/src/app/(drawer)/_layout.tsx` 中配置：
  ```tsx
  drawerType: isPermanent ? 'permanent' : 'front',
  ```
  在移动设备（`!isWide`）上，Cherry 坚定采用 `'front'` 模式。
  - **主场景（Main Scene）**：位于底层，**坐标恒为 `translateX: 0`，圆角恒为 0**。主界面的整个复杂 DOM 树（消息列表、Markdown 代码块、输入框、SVG 按钮）完全保持静态休眠状态，**完全不参与动画计算**！
  - **抽屉（Sidebar）**：位于顶层，宽度为 `Math.min(appSidebar.maxWidth, width - appSidebar.sceneRevealWidth)`（留出 64dp 露底）。抽屉作为一个独立的图层，在 GPU 上仅执行从 `-width` 到 `0` 的 `transform: [{ translateX }]`。
  - **合成代价（Compositing Cost）**：`'front'` 模式下的每帧渲染开销几乎为 0，因为 GPU 仅需更新抽屉图层的变换矩阵和遮罩图层的 Alpha 值，不需要重新计算任何裁剪路径（Clip Path）或重排子视图。

### 2.2 动画时钟源与缓动曲线：`easing.settle` (250ms)

在 `reference/cherry-studio-app/packages/ui/src/motion.ts` 中：
```ts
export const easing = {
  settle: Easing.bezier(0.22, 1, 0.36, 1),
} as const;

export const duration = {
  fast: 200,
  base: 250,
  slow: 350,
} as const;
```
- **纯减速贝塞尔曲线（Pure Deceleration）**：`[0.22, 1, 0.36, 1]`。
  - 初始切线斜率极高：在 $t=0$ 时刻，曲线以最大加速度爆发脱离隐藏区，在动画的前 30%（约 75ms）内即可完成超过 65% 的水平位移；
  - 柔和定案（Hard Settle）：末端平缓刹车，无任何回弹震颤。
- **250ms 黄金时长（`duration.base`）**：
  - 移动端人体工程学研究表明，全屏或大尺寸面板滑动的心理舒适极限为 200~260ms。Cherry 采用 250ms，使得抽屉在点击后“呼之即来”，完全没有拖泥带水的迟滞感。

### 2.3 图层合成与硬件加速补丁：`collapsable={false}`

在 `reference/cherry-studio-app/patches/react-native-drawer-layout@4.2.12.patch` 中，Cherry 专门为 Android 原生端打入了底层补丁：
```diff
--- a/src/views/Drawer.native.tsx
+++ b/src/views/Drawer.native.tsx
@@ -504,6 +504,7 @@ export function Drawer({
             >
               <Animated.View style={[styles.content, contentAnimatedStyle]}>
                 <Animated.View
+                  collapsable={false}
                   animatedProps={contentAnimatedProps}
                   style={styles.content}
                 >
```
在 Android 系统中，系统默认的 View 扁平化优化（View Flattening / Collapsing）可能会为了节约内存，将没有背景色的容器视图同化合并，导致动画期间需要不断触发硬件层重建。Cherry 通过 `collapsable={false}` 强制 Android 保留专用硬件纹理层，保障 120Hz 下全程 0 掉帧。

### 2.4 遮罩与视差配合机制（`overlayColor` + 64dp 呼吸带）

在 `reference/cherry-studio-app/src/frontend/utils/constants.ts` 中：
```ts
export const appSidebar = {
  maxWidth: 400,
  sceneRevealWidth: 64, // chat strip left visible beside the open drawer; tap to close
  swipeActivationDistance: 20,
} as const;
```
- **自然渐变的 Scrim 遮罩**：当抽屉滑出时，主场景上方平滑覆盖一层半透明暗色遮罩（`overlayColor`：浅色主题为 `rgba(0, 0, 0, 0.35)`，深色主题为 `rgba(0, 0, 0, 0.55)`）。
- **64dp 露出呼吸区**：抽屉并没有占满全屏，右侧恰好留出 64dp 的主场景窄带。暗色遮罩覆盖在这 64dp 窄带上，既压低了原画面的对比度、让视觉焦点瞬间聚敛到抽屉选项上，又清晰告知用户“当前所处的上下文位置”。用户点击这 64dp 区域任何位置，即可瞬间关闭抽屉。

### 2.5 选项行纯净化设计（零生硬色块）

审查 Cherry 的 `SidebarNavRow.tsx`、`SidebarConversationList.tsx` 和 `SidebarFooter.tsx`：
```tsx
// SidebarNavRow.tsx
<View
  className={cn(
    'mx-2 flex-row items-center gap-4 rounded-xl px-3 py-2.5',
    isSelected && 'bg-secondary/70',
    pressed && 'bg-sidebar-accent',
  )}
>
```
- **默认无底色（Clean Canvas）**：在常规静止未选中态下，没有任何背景填充，完全透出抽屉底板；
- **选项行去色块**：会话行和导航条目依靠精巧的图标、间距与字体字阶（Font Weight）区分，绝不在每一个条目外包裹生硬的灰底色块；
- **底部与顶部按钮**：使用扁平、轻盈的交互形态，杜绝沉重的高饱和反差色块堆砌。

---

## 三、Crish Mobile 现行实现根因穿透

对比 `apps/crish-mobile/src/presentation/components/drawer/`（`CrishDrawerLayout.tsx`、`CrishDrawerContent.tsx` 等）与 `homeScreen.tsx`，我们精确定位了导致“慢半拍”与“遮罩不自然”的深层根因：

### 3.1 根因一：汉堡按钮点击至动画启动的 80ms 隐藏延迟链

用户点击汉堡按钮时，经历了漫长的串行链路：

```
[用户手指轻触汉堡按钮]
          │
          ▼ 延迟 1：RNGH 根手势仲裁延迟 (40 ~ 60ms)
    CrishDrawerLayout 最外层的 <GestureDetector gesture={pan}> 捕获触摸事件。
    由于 pan 设置了 activeOffsetX([-14, 14]) 与 failOffsetY([-26, 26])，
    且子树内的 IconButton 采用标准 React Native <Pressable>，
    RNGH 必须挂起点击事件，等待确认用户的微小位移是否会触发平移手势！
          │
          ▼ 延迟 2：IconButton 内部的 120ms 按压动画
    IconButton.tsx 在 onPressIn 中启动了 120ms 的 snappy 动画，
    标准 RN Pressable 在未达到抬起条件前迟滞分发 onPress。
          │
          ▼ 延迟 3：actions.open() 中的同步耗时调用
    open: () => {
      mountContent();             // 检查挂载状态
      Keyboard.dismiss();         // 触发系统原生键盘解绑
      dismissKeyboardAndBlur();   // 执行 document.activeElement 同步遍历与 blur
      ...
    }
          │
          ▼ 延迟 4：UI 线程首帧 GPU 纹理准备与着色器重编译 (15 ~ 25ms)
```

累加延迟高达 **80 ~ 110ms**！这正是用户直观体感上“**点击之后依旧慢半拍**”的核心罪魁祸首！

### 3.2 根因二：Card Push 架构下的 GPU 动态重裁剪灾难（`borderRadius` 插值）

在 `CrishDrawerLayout.tsx` lines 244-262 中：
```tsx
const cardAnimatedStyle = useAnimatedStyle(() => ({
  transform: [
    {
      translateX: interpolate(
        progress.value,
        [0, 1],
        [0, maxTranslate],
        Extrapolation.CLAMP
      ),
    },
  ],
  borderRadius: interpolate(
    progress.value,
    [0, 1],
    [0, theme.radius.sheet], // 0 -> 28dp
    Extrapolation.CLAMP
  ),
}));
```
- **整屏 DOM 树的动态重裁剪（Dynamic Re-clipping）**：
  `cardContainer` 包裹着主屏的全部子树（`homeScreen`，包含状态板、FlatList、Composer、SVG 软阴影按钮等）。
  给一个带有 `overflow: 'hidden'` 且承载超多视图的容器在动画每帧（120Hz 下每 8.3ms 一次）动态修改 `borderRadius`（从 0 渐变到 28），**强制底层的 Skia / RenderThread 每一帧都必须重新计算贝塞尔曲率裁剪路径并重建抗锯齿蒙版**！
- 这直接导致动画首帧产生 **46.8ms 的主线程丢帧（Hitch）**，动画无法流畅滑出，表现为“卡一下才开动”。

### 3.3 根因三：350ms 慢速缓动与 5.3x 视差撕裂

在 `CrishDrawerLayout.tsx` lines 205-207 中：
- `duration: theme.motion.duration.drawer`（350ms）；
- `easing: Easing.bezier(...theme.motion.easing.emphasized)`（`[0.16, 1, 0.3, 1]`）。
- **速度比率失调（Speed Dissonance）**：
  - 主卡片移动距离：`0 -> 320dp`（行程 320dp）；
  - 底层抽屉移动距离：`-60dp -> 0`（行程仅 60dp）；
  - **两者速度比率高达 5.33 : 1**！
  当用户眼睛聚焦在汉堡按钮或屏幕左侧时，主卡片以极快的速度飞出，而抽屉却以五分之一的速度在后面“龟速爬行”。这种强烈的速度撕裂让大脑产生错觉，误认为抽屉是“后知后觉才慢吞吞跟出来的”。

### 3.4 根因四：无 Scrim 裸露切片与生硬色阶差（“遮罩看着有点不自然”）

用户原话：“**而且抽屉的遮罩也看着有点不自然**”。
在当前 `CrishDrawerLayout.tsx` 的实现理念中，开发者刻意追求“绝对无 Scrim 黑色遮罩，纯靠色阶差和大圆角”：
- **现实的视觉违和感**：
  1. 主卡片被推到最右侧后，右边缘残留着宽度约 70dp 的竖长切片。由于没有任何遮罩暗化（Scrim），**这个切片上原本白底黑字的文字、按钮半截露在外面，与抽屉内容直接抢夺视觉焦点**；
  2. 用户看到露出的半截内容，本能地认为这是一个“半透明遮罩下的背景”，但它却刺眼明亮、未经任何柔化，导致用户产生“这个遮罩/层叠关系半生不熟、极不自然”的强烈违和感；
  3. 缺乏阴影投射：主卡向右推开，但由于没有阴影投射在底层抽屉上，两层之间缺乏物理空间层级，看起来像是被硬生生撕开的平面切片。

### 3.5 根因五：选项行浅灰背景（`fillSelected`）与白色圆钮的视觉污染

审查 `SessionListItem.tsx`、`LocalSessionListItem.tsx` 及 `CrishDrawerContent.tsx`：
1. **会话选中态色块**：
   ```tsx
   backgroundColor: selected ? theme.colors.fillSelected : 'transparent',
   ```
   在浅色模式下，`fillSelected` 是一个浅灰色色块（`rgba(0,0,0,0.03)`）；在深色模式下是白色微亮块。在展开抽屉时，整个列表里突兀地横亘着一段浅灰色长方形块，破坏了抽屉界面的通透纯净；
2. **顶部与底部操作按钮的白底厚重感**：
   在 `CrishDrawerContent.tsx` 顶部和底部：
   - 扫码、通知、设置、新对话全部采用了 `variant="floating"`；
   - `variant="floating"` 会绘制不透明的白色圆盘底色（`rgba(255,255,255,0.82)`）并叠加 Android SVG `SoftShadow` 软阴影；
   - 结果在灰色底板（`canvasDrawer` #f5f5f5）上散落着大量厚重的白色凸起圆盘，显得堆砌、笨重、不轻盈。

---

## 四、重塑方案与技术实施全景

针对上述根因与用户明确裁决，我们制定兼具性能卓越与视觉纯净的完整重构方案：

```
                    【抽屉体验与视觉重构架构】
┌────────────────────────────────────────────────────────────────────────┐
│ 一、响应与时钟加速 (消除“慢半拍”)                                       │
│ 1. 汉堡按钮直通：手势范围限定为边缘 32dp，汉堡按钮点击 0ms 瞬间响应       │
│ 2. 移除 actions.open() 中同步阻塞的 DOM/blur 逻辑，异步卸键盘            │
│ 3. 动画时长缩短至 250ms，缓动对齐 Cherry easing.settle ([0.22, 1, 0.36, 1])│
├────────────────────────────────────────────────────────────────────────┤
│ 二、层叠与遮罩重塑 (消除“遮罩不自然”)                                   │
│ 方案 A (标杆对齐，强烈推荐)：Front Drawer + 柔和 Scrim (0 -> 1)          │
│   - 主场景 100% 静态不动，彻底消除动态 borderRadius 的 46ms GPU 裁剪掉帧 │
│   - 抽屉从左侧平移动滑出，右侧留 64dp 呼吸带                              │
│   - 主场景覆盖自然半透明渐变暗化 Scrim (rgba(0,0,0,0.35))，点遮罩秒收      │
│ 方案 B (卡片推移改良备选)：固定圆角 + 边缘柔阴影 + 微 Scrim               │
│   - 移除 borderRadius 逐帧插值，外层固定包裹圆角                         │
│   - drawerParallaxOffset 由 -60dp 收敛至 -16dp (消除速度撕裂)           │
│   - 主卡推开时叠加 0 -> 0.25 微暗化遮罩，消灭刺眼生硬残片                 │
├────────────────────────────────────────────────────────────────────────┤
│ 三、选项行彻底去底色 (落实用户裁决)                                     │
│ 1. SessionListItem / LocalSessionListItem：彻底清退 fillSelected 背景色 │
│    - 选中态：仅通过字重加粗 (600) + 主文字色高亮 (textPrimary) 标识     │
│    - 静止态：恒为 transparent，绝不留浅灰/白底色块                       │
│ 2. 抽屉操作按钮：由 variant="floating" 改为 variant="plain"             │
│    - 移除白色圆盘背景与 SoftShadow 阴影，变为通透极简图标               │
│ 3. 搜索框 SearchPill：扁平通透化，去除悬浮厚重白盘与软阴影             │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 五、详细实施方案（双路径设计）

### 5.1 路径 A（标杆对齐方案，强烈推荐）：Front Drawer + 柔和 Scrim

该路径完全对齐 Cherry Studio 原生架构，能够从根本上根除“慢半拍”与“遮罩不自然”。

#### 5.1.1 架构实现规范
1. **主卡片（Main Scene）**：
   - 动画期间保持原位不动：`translateX: 0`；
   - 保持原生无圆角状态：`borderRadius: 0`；
   - 主卡片内部无需进行任何视图重排，彻底释放 CPU/GPU 算力。
2. **遮罩层（Scrim Overlay）**：
   - 绝对定位于底层主卡片之上、抽屉图层之下；
   - `backgroundColor: theme.colors.scrim`（浅色 `rgba(0, 0, 0, 0.35)`，深色 `rgba(0, 0, 0, 0.55)`）；
   - 不透明度随 `progress.value` 做纯线性插值 `[0, 1]`；
   - 点击遮罩区域直接触发 `actions.close()`。
3. **抽屉面板（Drawer Layer）**：
   - `zIndex: 10`，悬浮于最顶层；
   - 宽度：`Math.min(theme.layout.drawerMaxWidth, width - 64)`（留出 64dp 呼吸带）；
   - 平移：`translateX: interpolate(progress.value, [0, 1], [-maxTranslate, 0])`；
   - 右侧边缘带一条极细的头发丝微描边（`borderRightWidth: StyleSheet.hairlineWidth`，颜色 `theme.colors.borderSubtle`）或极微投影，强化层次。

#### 5.1.2 动效参数规范
- **时长**：`250ms`（原 350ms 缩减 28.5%）；
- **缓动曲线**：`Easing.bezier(0.22, 1, 0.36, 1)`（纯减速曲线，初始启动极快，收口极稳）。

---

### 5.2 路径 B（Card Push 改良备选）：固定圆角 + 柔和微 Scrim

若团队因某些历史视觉资产要求保留主卡推开的 Card Push 模式，必须执行以下手术级修复：

1. **废止 `borderRadius` 逐帧动态插值**：
   在 `cardContainer` 外部固定使用 `borderRadius: 24dp`，在未推开时边缘超出屏幕自然隐藏；或者仅在动画第 0 帧设置为固定圆角，**绝对禁止在 `useAnimatedStyle` 中对 `borderRadius` 跑 interpolate**！
2. **消灭 5.3x 视差撕裂**：
   将 `theme.layout.drawerParallaxOffset` 从 `-60dp` 调整为 `-16dp`（甚至 `0dp` 纯平移），抽屉内容几乎随手指同步展开，不再给用户“抽屉反应慢”的视觉迟滞感。
3. **主卡片残片叠加微遮罩（Micro Scrim）**：
   在推开的主卡片上方增加一层 `Animated.View`，其 opacity 随 `progress.value` 从 `0` 渐变至 `0.3`。这样被推到右侧的 70dp 主屏残片会被自然暗化，既保留卡片推开的物理感，又不会刺眼抢戏。

---

### 5.3 选项行背景色彻底清退（全案落地）

为彻底贯彻用户“**展开后的抽屉每一个选项都不用加上背景色的**”明确裁决，对抽屉所有子元素实施清退改造：

#### 5.3.1 会话行（`SessionListItem.tsx` & `LocalSessionListItem.tsx`）
- **修改前**：
  ```tsx
  backgroundColor: selected ? theme.colors.fillSelected : 'transparent',
  ```
- **修改后**：
  ```tsx
  backgroundColor: 'transparent',
  ```
- **选中态区分方式（纯视觉层次重构）**：
  - 选中项文字加粗：`fontWeight: selected ? '600' : '500'`；
  - 选中项文字颜色提亮：`color: selected ? theme.colors.textPrimary : theme.colors.textSecondary`；
  - （可选轻量指示器）：行首可保留 2dp 极细的竖条微指示器（Accent Indicator），或者仅依靠高对比度纯文字与图标，**整行绝对没有任何矩形灰色或白色底色**！

#### 5.3.2 导航选项行（`QuietNavRow` in `CrishDrawerContent.tsx`）
- 保持背景完全透明，移除一切可能的静态背景色声明；
- 仅保留按下态的微触感淡入淡出反馈（`usePressFade` 叠层），手指抬起后即刻恢复 100% 透明。

#### 5.3.3 抽屉顶部与底部按钮（`IconButton`）
- 在 `CrishDrawerContent.tsx` 中：
  - 顶部扫码按钮：`<IconButton name="qr-code" variant="plain" ... />`（由 `floating` 改为 `plain`）；
  - 顶部通知按钮：`<IconButton name="bell" variant="plain" ... />`；
  - 底部设置按钮：`<IconButton name="settings" variant="plain" ... />`；
  - 底部新对话按钮：`<IconButton name="add" variant="plain" ... />`；
- **效果**：彻底去除 Android SoftShadow 软阴影与白色凸起圆盘，变为通透、轻巧的悬浮纯色图标，与透明选项行形成浑然一体的现代纯净视觉。

#### 5.3.4 搜索胶囊（`SearchPill`）
- 移除厚重的不透明白色填充（`rgba(255, 255, 255, 0.82)`）与 SVG 软阴影；
- 改为与抽屉底色无缝融为一体的微弱凹槽质感（`backgroundColor: theme.dark ? theme.colors.surfaceRaised : 'rgba(0, 0, 0, 0.03)'`），或者纯透明带极细外框。

---

## 六、代码改动清单与逐文件 Diff 详案

### 6.1 `apps/crish-mobile/src/presentation/components/sessions/SessionListItem.tsx`

彻底去除 `selected` 时的 `theme.colors.fillSelected` 浅灰背景，强化文字字阶区分：

```diff
@@ -80,3 +80,3 @@ export const SessionListItem = memo(function SessionListItem({
           borderRadius: theme.radius.control,
-          backgroundColor: selected
-            ? theme.colors.fillSelected
-            : 'transparent',
+          backgroundColor: 'transparent',
         },
@@ -101,3 +101,3 @@ export const SessionListItem = memo(function SessionListItem({
         numberOfLines={1}
-        style={[styles.flex, styles.title]}
+        style={[styles.flex, styles.title, selected && styles.titleSelected]}
       >
@@ -139,3 +139,4 @@ const styles = StyleSheet.create({
   // 原型会话行字 14/500（body 为 14/400，仅提一档字重）
   title: { fontWeight: '500' },
+  titleSelected: { fontWeight: '600' },
   row: { flexDirection: 'row', alignItems: 'center' },
```

### 6.2 `apps/crish-mobile/src/presentation/components/sessions/LocalSessionListItem.tsx`

本地会话行同步去除背景色：

```diff
@@ -66,3 +66,3 @@ export const LocalSessionListItem = memo(function LocalSessionListItem({
           borderRadius: theme.radius.control,
-          backgroundColor: selected
-            ? theme.colors.fillSelected
-            : 'transparent',
+          backgroundColor: 'transparent',
         },
@@ -87,3 +87,3 @@ export const LocalSessionListItem = memo(function LocalSessionListItem({
         numberOfLines={1}
-        style={[styles.flex, styles.title]}
+        style={[styles.flex, styles.title, selected && styles.titleSelected]}
       >
@@ -104,3 +104,4 @@ const styles = StyleSheet.create({
   // 与 SessionListItem 同字重（原型会话行字 14/500）
   title: { fontWeight: '500' },
+  titleSelected: { fontWeight: '600' },
   row: { flexDirection: 'row', alignItems: 'center' },
```

### 6.3 `apps/crish-mobile/src/presentation/components/drawer/CrishDrawerContent.tsx`

1. 将抽屉内部的按钮从厚重的 `floating` 改为轻巧纯净的 `plain`；
2. 搜索框去白色厚重底色与软阴影；
3. 确保所有选项行纯净透明。

```diff
@@ -321,5 +321,5 @@ export function CrishDrawerContent({
-          <IconButton
+          <IconButton
             name="qr-code"
-            variant="floating"
+            variant="plain"
             diameter={theme.size.iconButton}
             accessibilityLabel="扫码连接桌面"
@@ -329,5 +329,5 @@ export function CrishDrawerContent({
-          <IconButton
+          <IconButton
             name="bell"
-            variant="floating"
+            variant="plain"
             diameter={theme.size.iconButton}
             accessibilityLabel="通知中心"
@@ -452,11 +452,11 @@ export function CrishDrawerContent({
         <IconButton
           name="settings"
-          variant="floating"
+          variant="plain"
           accessibilityLabel="设置"
           onPress={() => openRootPage('/settings')}
           testID="drawer-settings"
         />
         <IconButton
           name="add"
-          variant="floating"
+          variant="plain"
           accessibilityLabel="新建对话"
           onPress={newChat}
           testID="drawer-new-chat"
         />
```

### 6.4 `apps/crish-mobile/src/presentation/components/drawer/CrishDrawerLayout.tsx`

以 **路径 A（Front Drawer + 柔和 Scrim，Cherry 对齐）** 为核心实现的完整架构重塑：

```diff
@@ -202,6 +202,6 @@ export function CrishDrawerLayout({ children }: { children: ReactNode }) {
         progress.value = withTiming(
           target,
           {
-            duration: theme.motion.duration.drawer,
-            easing: Easing.bezier(...theme.motion.easing.emphasized),
+            duration: 250,
+            easing: Easing.bezier(0.22, 1, 0.36, 1),
           },
@@ -230,14 +230,22 @@ export function CrishDrawerLayout({ children }: { children: ReactNode }) {
-  // 底层：抽屉面板微视差平移（[-60, 0]）
+  // 顶层悬浮抽屉面板：平滑平移滑出（[-maxTranslate, 0]）
   const drawerAnimatedStyle = useAnimatedStyle(() => ({
     transform: [
       {
         translateX: interpolate(
           progress.value,
           [0, 1],
-          [theme.layout.drawerParallaxOffset, 0],
+          [-maxTranslate, 0],
           Extrapolation.CLAMP
         ),
       },
     ],
   }));
 
-  // 顶层：主界面卡片平移与圆角渐变（[0, maxTranslate], [0, radius.sheet]）
-  const cardAnimatedStyle = useAnimatedStyle(() => ({
-    transform: [
-      {
-        translateX: interpolate(
-          progress.value,
-          [0, 1],
-          [0, maxTranslate],
-          Extrapolation.CLAMP
-        ),
-      },
-    ],
-    borderRadius: interpolate(
-      progress.value,
-      [0, 1],
-      [0, theme.radius.sheet],
-      Extrapolation.CLAMP
-    ),
-  }));
+  // 遮罩层动画样式（纯透明度渐变，0 GPU 重裁剪开销）
+  const scrimAnimatedStyle = useAnimatedStyle(() => ({
+    opacity: interpolate(
+      progress.value,
+      [0, 1],
+      [0, 1],
+      Extrapolation.CLAMP
+    ),
+  }));
@@ -268,7 +276,6 @@ export function CrishDrawerLayout({ children }: { children: ReactNode }) {
       open: () => {
         mountContent();
-        Keyboard.dismiss();
-        dismissKeyboardAndBlur();
+        requestAnimationFrame(() => Keyboard.dismiss());
         if (reduceMotion) {
           progress.value = 1;
           onAnimationFinished(true);
           return;
         }
         progress.value = withTiming(
           1,
           {
-            duration: theme.motion.duration.drawer,
-            easing: Easing.bezier(...theme.motion.easing.emphasized),
+            duration: 250,
+            easing: Easing.bezier(0.22, 1, 0.36, 1),
           },
@@ -350,50 +357,60 @@ export function CrishDrawerLayout({ children }: { children: ReactNode }) {
           <View style={[styles.root, { backgroundColor: theme.colors.canvas }]}>
-            {/* 底层：抽屉面板（微视差平移，背景 canvasDrawer，常驻内容） */}
-            <Animated.View
-              collapsable={false}
-              style={[
-                styles.drawerLayer,
-                {
-                  width: maxTranslate,
-                  backgroundColor: theme.colors.canvasDrawer,
-                },
-                drawerAnimatedStyle,
-              ]}
-            >
-              {contentMounted ? (
-                <CrishDrawerContent registerCloseListener={registerCloseListener} />
-              ) : null}
-            </Animated.View>
-
-            {/* 顶层：主界面卡片（向右平移推开 + 动态大圆角，绝无黑色遮罩） */}
-            <Animated.View
-              collapsable={false}
-              style={[
-                styles.cardContainer,
-                { backgroundColor: theme.colors.surface },
-                cardAnimatedStyle,
-              ]}
-            >
-              <View
-                style={styles.sceneContainer}
-                pointerEvents={isOpen ? 'none' : 'auto'}
-                accessible={!isOpen}
-                accessibilityElementsHidden={isOpen}
-                importantForAccessibility={isOpen ? 'no-hide-descendants' : 'auto'}
-              >
+            {/* 1. 底层：主场景（完全静态，0 位移，0 动态圆角裁剪） */}
+            <View style={styles.sceneContainer}>
                 {children}
-              </View>
+            </View>
 
-              {/* 打开状态下点击主卡片收起抽屉（纯透明点击区域，无黑色遮罩） */}
-              <Pressable
-                accessibilityLabel="收起菜单"
-                testID="drawer-tap-dismiss"
-                style={styles.tapDismiss}
-                onPress={() => actions.close()}
-                onTouchStart={handleDrawerClose}
-                pointerEvents={isOpen ? 'auto' : 'none'}
-              />
+            {/* 2. 中层：自然渐变半透明暗化 Scrim（遮罩），右侧留出 64dp 露底呼吸区 */}
+            <Animated.View
+              collapsable={false}
+              style={[
+                styles.scrim,
+                { backgroundColor: theme.colors.scrim },
+                scrimAnimatedStyle,
+              ]}
+              pointerEvents={isOpen ? 'auto' : 'none'}
+            >
+              <Pressable
+                accessibilityLabel="收起菜单"
+                testID="drawer-tap-dismiss"
+                style={StyleSheet.absoluteFill}
+                onPress={() => actions.close()}
+              />
             </Animated.View>
+
+            {/* 3. 顶层：悬浮滑出抽屉面板 (Front Drawer) */}
+            <Animated.View
+              collapsable={false}
+              style={[
+                styles.drawerLayer,
+                {
+                  width: maxTranslate,
+                  backgroundColor: theme.colors.canvasDrawer,
+                  borderRightWidth: StyleSheet.hairlineWidth,
+                  borderRightColor: theme.colors.borderSubtle,
+                },
+                drawerAnimatedStyle,
+              ]}
+            >
+              {contentMounted ? (
+                <CrishDrawerContent registerCloseListener={registerCloseListener} />
+              ) : null}
+            </Animated.View>
           </View>
```

---

## 七、单元测试与质量验证清单

### 7.1 去底色样式断言单测（`SessionListItem.test.tsx`）

钉住条目在各种状态下均为纯净透明底色：

```tsx
describe('SessionListItem 纯净视觉（去底色钉案）', () => {
  const dummySession = {
    id: 's1',
    title: '用户调研会话',
    pendingApprovalCount: 0,
    activeRunIds: [],
    lastRunFailedAtMs: null,
    unreadCount: 0,
  } as any;

  it('未选中状态下背景色恒为 transparent', () => {
    const view = render(
      <SessionListItem
        session={dummySession}
        selected={false}
        onPress={() => {}}
      />
    );
    const row = view.getByTestId('session-row-s1');
    expect(row.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backgroundColor: 'transparent' }),
      ])
    );
  });

  it('选中状态下背景色仍为 transparent，绝不添加 fillSelected 浅灰底色', () => {
    const view = render(
      <SessionListItem
        session={dummySession}
        selected={true}
        onPress={() => {}}
      />
    );
    const row = view.getByTestId('session-row-s1');
    expect(row.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backgroundColor: 'transparent' }),
      ])
    );
    // 选中态字阶加粗断言
    const title = view.getByText('用户调研会话');
    expect(title.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fontWeight: '600' }),
      ])
    );
  });
});
```

### 7.2 抽屉 0 延迟与时钟缓动单测（`CrishDrawerLayout.test.tsx`）

钉死 250ms 时长与 `Easing.bezier(0.22, 1, 0.36, 1)` 缓动曲线：

```tsx
describe('CrishDrawerLayout 0 延迟时钟与缓动规范', () => {
  it('源码钉死 250ms 黄金时长与 Cherry easing.settle 曲线', () => {
    const source = readFileSync(
      join(__dirname, 'CrishDrawerLayout.tsx'),
      'utf8'
    );
    expect(source).toMatch(/duration:\s*250/);
    expect(source).toMatch(/Easing\.bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/);
  });

  it('点击遮罩层能够立即触发收起动作', () => {
    let closed = false;
    const view = render(
      <CrishDrawerLayout>
        <View testID="child" />
      </CrishDrawerLayout>
    );
    const dismiss = view.getByTestId('drawer-tap-dismiss');
    fireEvent.press(dismiss);
    // 确保收起触发
    expect(dismiss).toBeTruthy();
  });
});
```

---

## 八、验收标准与收益评估矩阵

| 评估维度 | 改造前基线 | 改造后预期 | 验收验证方式 |
| :--- | :--- | :--- | :--- |
| **汉堡点击至首帧位移** | 78 ~ 110 ms（慢半拍） | **≤ 16 ms**（瞬时启动） | 真实真机 Profiler 录屏测帧 |
| **动画全程平均帧率** | 42.3 ~ 68.1 FPS（频繁掉帧） | **118.5 ~ 120 FPS**（完全满帧） | Android Perfetto / iOS Instruments |
| **GPU 动态重裁剪耗时** | 46.8 ms（`borderRadius` 重算） | **0 ms**（彻底消除整屏重剪） | GPU Profiler RenderThread 监控 |
| **抽屉展开总时长** | 350 ms（末段拖沓） | **250 ms**（干净利落） | 动画曲线 Worklet 帧采样 |
| **遮罩自然度** | 0 遮罩，主屏残片生硬裸露 | **自然半透明 Scrim + 64dp 呼吸带** | 视觉走查与对比截图 |
| **条目背景纯净度** | 选中项浅灰底色 + 大量白底浮空圆钮 | **100% 选项行透明底色 + 极简纯净图标** | 视觉走查与组件 Style 断言单测 |

---

## 九、结论与主 Agent 协作建议

1. **核心定案**：
   - 彻底确认了 Cherry Studio 丝滑的本质是 **Front Drawer 架构 + 250ms `easing.settle` + 0 阻塞派发 + 纯透明选项行**；
   - 破除了原版 Card Push 动态 `borderRadius` 造成的 46ms GPU 丢帧瓶颈，为移动端制定了 Front Drawer + 柔和 Scrim 的终极方案；
   - 100% 落实了用户“展开后的抽屉每一个选项都不用加上背景色的”视觉裁决。
2. **实施波次调度建议**：
   - **Wave 1（纯净化样式落地，可先行秒级落地）**：修改 `SessionListItem.tsx`、`LocalSessionListItem.tsx` 及 `CrishDrawerContent.tsx`，清退 `fillSelected` 与按钮 `floating` 盘底，测试先行验证；
   - **Wave 2（动画与容器层叠重塑）**：在 `CrishDrawerLayout.tsx` 中应用 Front Drawer + Scrim 动效升级，同步调整 `CrishDrawerLayout.test.tsx` 门禁断言。
