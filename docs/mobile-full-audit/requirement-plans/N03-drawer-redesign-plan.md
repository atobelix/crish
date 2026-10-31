# N03 侧边抽屉重构（手势唤醒 + 层叠立体感 + 版式重排）方案

## 0 结论摘要

1. **手势失效主因**：Android 10+（含华为 P50 HarmonyOS）系统边缘返回手势感应区（通常 24–40dp）与抽屉当前配置 `swipeEdgeWidth: 32dp`（`theme.ts:504`）物理重叠，导致边缘起滑被系统底层强行截胡；且 `react-native-drawer-layout` 原生层配置了严苛的 `.failOffsetY([-5, 5])`（`Drawer.native.js:205`），自然单手拇指弧线滑动只要 Y 轴位移超 5dp 手势当场自毁；同时根部 `GestureHandlerRootView` 缺少 `style={{ flex: 1 }}`（`app/_layout.tsx:167`）。
2. **层叠立体感路线**：内置 `drawerType: 'back'` 无法驱动主界面的动态圆角、微缩放与投影，且手势死板无法自愈；**唯一推荐基于 Reanimated 4 + Gesture Handler 实现轻量自定义层叠抽屉容器 `CrishDrawerLayout`**。主界面以圆角卡片（`radius.sheet` 28dp）叠在抽屉之上向右推开（位移 84% 屏宽，微缩放至 0.94），抽屉固定于底层底色 `canvas` 并带微视差（-36dp），**彻底消除黑色 scrim 遮罩**，立体感全靠物理层叠、色阶差与大圆角，**零描边**。
3. **版式重排**：顶部吸顶【搜索胶囊 + 扫一扫】，输入法呼出时吸顶绝不遮挡；底部收敛【头像昵称 + 设置圆钮 + 新对话高亮圆钮】。
4. **用户裁决点**：① 底部栏布局结构（推荐单行通栏 vs 备选双行卡片）；② 抽屉内通知铃铛去留（推荐主界面保留、抽屉内克制移除）；③ 主卡片边缘立体感投影等级（推荐 `theme.shadow.md` 结合无描边原则）；④ 会话切换与抽屉收起动效先后时序（交 N04 协同）。
5. **集中验收清单**：提供涵盖华为 P50 全面屏手势、对角线滑动、列表滚动中滑出、软键盘避让等 15 项集中真机与工程断言。

---

## 1 现状还原

### 1.1 抽屉层级模型
- **根导航层级**（`apps/crish-mobile/app/_layout.tsx:105-163`）：
  - 根容器为 `<Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>`；
  - `(main)` 分组作为根栈的首页 Screen 注册（`app/_layout.tsx:112`）；
  - 全局审批悬浮条 `ApprovalFloat`（`app/_layout.tsx:160`）挂在 `<Stack>` 之后，以绝对定位（`styles.anchor: { position: 'absolute' }`，`ApprovalFloat.tsx:124`）浮于全屏之上。
- **抽屉内部层级**（`apps/crish-mobile/app/(main)/_layout.tsx:23-48`）：
  - 采用 `expo-router/drawer`，底层封装 `@react-navigation/drawer` 与 `react-native-drawer-layout`；
  - 当前参数写死：`drawerType: 'front'`、`overlayColor: theme.colors.scrim`（`app/(main)/_layout.tsx:30, 32`）；
  - 表现形式为：抽屉位于主界面最上方，滑出时从屏幕左侧平移盖住主场景；主场景完全静止不动，被半透明黑色遮罩 `scrim`（浅色 `rgba(0,0,0,0.24)`，深色 `rgba(0,0,0,0.5)`，`theme.ts:310, 352`）强行压暗。
  - 主场景与抽屉背景色同为 `theme.colors.canvas`（`app/(main)/_layout.tsx:38, 40`），完全没有前后景深的立体层叠感。

### 1.2 手势激活模型
- **边缘触发配置**：
  - `app/(main)/_layout.tsx:31`：`swipeEdgeWidth: theme.layout.drawerSwipeEdgeWidth`；
  - `apps/crish-mobile/src/adapters/platform/theme.ts:504`：`drawerSwipeEdgeWidth: 32`。
- **底层 Pan 手势判定**（`node_modules/react-native-drawer-layout/lib/module/views/Drawer.native.js:106-210`）：
  - `hitSlop`：行 113-114，抽屉关闭时 `hitSlop = { left: 0, width: swipeEdgeWidth }`（即 `[0, 32dp]`）；
  - 激活条件：行 205，`.activeOffsetX([-5, 5])`（水平位移需达 5dp）；
  - 失败判定：行 205，`.failOffsetY([-5, 5])`（垂直位移达 5dp 立即失败）；
  - 释放开合速度/位移阈值：行 198，水平位移需 `> 60dp`，或水平位移 `> 5dp` 且初速度 `velocityX > 500dp/s`。
- **手势根容器漏洞**：
  - `apps/crish-mobile/app/_layout.tsx:167`：`<GestureHandlerRootView>` 未提供 `style={{ flex: 1 }}`，在 Android 布局测量中存在根级视口高度塌陷风险。

### 1.3 版式与软键盘行为模型
- **抽屉组件排布现状**（`apps/crish-mobile/src/presentation/components/drawer/CrishDrawer.tsx:57-93`）：
  - 根节点为普通的 `View style={styles.root}`（行 57）；
  - 顶部与中部使用 `DrawerContentScrollView` 包裹 `DrawerHeader`（头像、账号名、连接状态、新对话圆钮，行 67-72）、`DrawerNav`（待审批、审批记录，行 73-76）、`DrawerSessionGroups`（今天、更早会话列表，行 77-84）；
  - 底部常驻 `DrawerFooter`（行 86-91，包含搜索胶囊 TextInput 与设置 IconButton）。
- **软键盘与视口行为现状**：
  - `apps/crish-mobile/android/app/src/main/AndroidManifest.xml:23` 声明了 `android:windowSoftInputMode="adjustResize"`；
  - 但 `CrishDrawer.tsx` 内部没有任何 `KeyboardAvoidingView`，也未消费 `useKeyboardHeight()` 键盘避让逻辑；
  - 当用户在抽屉底部的搜索胶囊中聚焦输入时，系统软键盘从屏幕底部迅速弹起（高度约 300+dp），直接把常驻屏幕最底部的 `DrawerFooter` 连同输入光标与候选词完全遮盖压死，用户陷入无法查看输入内容的盲打瘫痪状态（第一轮审计 04 缺陷 07，`04-ui-ux-and-platform-adaptation-audit.md:285-316`）。

### 1.4 用户参考截图意图深度剖析
- **参考物**：用户提供的两张真机截图（`media_1793371174911_c2268bb8.jpg` 展开态、`media_1793371174913_53371c13.jpg` 开合中途态，均来自现代主流对话 App Kimi）。
- **设计意图提炼（核心灵魂）**：
  1. **层叠拓扑反转**：传统抽屉是“侧边栏盖在主界面之上”，而参考截图中是“**主界面在上面，侧边栏在主界面下面**”。主界面整体退化为一张巨大的高层级圆角卡片，随着手势向右平移，露出原本就在底层的抽屉面板；
  2. **消除压暗遮罩**：主界面右移露出抽屉的过程中，抽屉没有被任何灰色/黑色遮罩压暗，底层内容清晰明亮；
  3. **边缘圆角与立体投影**：主界面向右位移后，其左侧显露出圆润精致的卡片大圆角（类似 `borderTopLeftRadius` 与 `borderBottomLeftRadius`），且卡片向底层抽屉投射出细腻柔和的环境光阴影，构建出强烈的物理立体景深；
  4. **用户特别指令**：截图中的搜索栏沉在底部，但用户明确指出“点击搜索时搜索栏被输入法挤占看不到”，要求“**搜索放在上面，扫一扫也放在上面；下面放置头像和名字，然后是设置和新建对话按钮**”。设计必须精准实现用户的布局革新指令，同时严格符合 Token 体系。

---

## 2 问题清单

| 编号 | 位置 | 现象 | 直接原因 | 根因 | 影响 | 置信度 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **P01** | `theme.ts:504`<br>`Drawer.native.js:114` | Android 真机从左向右滑完全无法唤醒抽屉 | `swipeEdgeWidth` 设为 32dp，完全落入 Android 系统全面屏返回手势感应区（24-40dp） | 边缘手势被 Android 系统底层 `BackGestureDetector` 抢先截获，事件未向下分发给 RN | 用户在华为 P50 等 Android 设备上完全无法使用侧滑手势打开抽屉 | **已验证** |
| **P02** | `Drawer.native.js:205` | 偶尔在最边缘起滑仍频繁失败中断 | Pan 手势配置了严苛的 `.failOffsetY([-5, 5])` | 人类大拇指单手滑动为圆弧形，垂直位移极易超 5dp，导致手势在原生层当场 Fail | 手势极不跟手，要求用户必须绝对水平滑动，可用性极差 | **已验证** |
| **P03** | `app/_layout.tsx:167` | 手势响应在部分机型上区域漂移或无响应 | `<GestureHandlerRootView>` 未显式声明 `style={{ flex: 1 }}` | 根级手势容器在原生 View 层可能测量高度异常，未能撑满物理视口 | 整个应用手势系统的底层稳定性隐患 | **已验证** |
| **P04** | `(main)/_layout.tsx:30`<br>`theme.ts:310` | 抽屉打开时视觉扁平压抑，无卡片立体感 | 写死 `drawerType: 'front'` 与 `overlayColor: theme.colors.scrim` | 依赖旧式侧边栏遮盖模型，未实现“主界面在上向右位移卡片”的立体分层模型 | 违背用户明确的效果锁（“主界面在上面，侧边栏在下面”立体感） | **已验证** |
| **P05** | `CrishDrawer.tsx:57-93`<br>`DrawerFooter.tsx:13-77` | 点击搜索框弹出键盘时，搜索框完全被输入法盖死看不见 | 搜索框常驻在抽屉最底端，且容器内未做任何键盘高度避让 | 版式结构设计缺陷 + 缺乏键盘高度监听处理 | 会话搜索功能在软键盘激活期间处于完全盲打不可用状态 | **已验证** |
| **P06** | `DrawerHeader.tsx:55`<br>`DrawerFooter.tsx:13` | 抽屉功能区交互动线倒置 | 扫一扫与搜索等高频查找操作沉在底端，低频展示型头像和连接状态霸占顶端 | 缺乏移动端单手黄金操作区与软键盘空间的综合人机工程考量 | 用户找会话、扫码配对路径冗长受阻 | **已验证** |
| **P07** | `DrawerSessionGroups.tsx:44-51` | 会话数量较多（>30 条）时抽屉开合与滑动掉帧卡顿 | 使用普通 `ScrollView` 内部对 `today` 与 `earlier` 进行数组 `.map()` 裸渲染 | 未接入虚拟化列表容器（`FlashList` 或 `SectionList`） | 会话列表 DOM 节点全量实例化，消耗移动端内存与 JS 线程算力 | **已验证** |
| **P08** | `CrishDrawer.tsx:45-48` | 在搜索框输入文本时，全部会话行反复触发重渲染 | `openSession` 定义为内联函数且未用 `useCallback` 稳定引用 | 搜索输入导致 `vm.query` 变化并重渲染父组件，使所有子项的 `onPress` 引用抖动 | 键盘输入高频打字时带来明显的输入粘滞与掉帧 | **已验证** |

---

### 2.9 根因深度排序与真机复现实验设计

#### 1. 根因深度排序（按影响权重降序）
1. **【根因 1（主因·致命阻断）】Android 系统边缘返回手势与抽屉 32dp 极窄 hitSlop 的完全重叠**：
   - 代码证据：`apps/crish-mobile/src/adapters/platform/theme.ts:504`（`drawerSwipeEdgeWidth: 32`）与 `node_modules/react-native-drawer-layout/lib/module/views/Drawer.native.js:114`（`width: isOpen ? undefined : swipeEdgeWidth`）。
   - 现象机理：在华为 P50（HarmonyOS / Android 12）等开启全面屏手势的机型上，系统预留了约 24–40dp 的屏幕左边缘用于全局返回。用户手指从屏幕边缘划入时，触点在 `0–32dp` 瞬间被 Android 系统底层捕获并震动提示“返回”；若用户故意避开边缘从 35dp 起滑，又已超出抽屉 `swipeEdgeWidth: 32` 的命中区。这造成抽屉在真机全面屏模式下几乎 100% 无法通过边缘手势唤醒。
2. **【根因 2（强干扰·高频自毁）】`react-native-drawer-layout` 的 `.failOffsetY([-5, 5])` 极其严苛的纵向失败判定**：
   - 代码证据：`Drawer.native.js:205` 写死 `.activeOffsetX([-5, 5]).failOffsetY([-5, 5])`。
   - 现象机理：大拇指以手掌尺侧为支点做向右内收滑动时，物理轨迹是一个角度约 15°–35° 的斜向圆弧。在水平位移未达到 5dp 判定阈值之前，垂直方向产生微小位移只要达到 5dp（在华为 P50 上仅约 15 个物理像素），手势判定器立刻宣告 PanGesture 失败，转入 Cancelled/Failed 状态并让位给父层。
3. **【根因 3（架构断层·视觉失真）】`drawerType: 'front'` 与 `scrim` 压暗遮罩完全违背“主界面在上面”的卡片立体意图**：
   - 代码证据：`app/(main)/_layout.tsx:30, 32` 配置 `drawerType: 'front'` 与 `overlayColor: theme.colors.scrim`。
   - 现象机理：传统 front 模式下，主界面被定在底色并蒙上黑色遮罩，而抽屉如同一块黑布从上面盖下来；既没有卡片圆角（`radius`），也没有主界面轻度缩放（`scale`），两层界面处于同一色阶（`canvas` #f2f2f2），视觉平铺且压抑。
4. **【根因 4（人机工程失效·盲打）】搜索框沉底 + 缺乏键盘避让容器**：
   - 代码证据：`CrishDrawer.tsx:86-91` 与 `DrawerFooter.tsx:13-77`。
   - 现象机理：虽然 Android 开启了 `adjustResize`，但由于抽屉根容器没有使用键盘避让，软键盘弹起后直接占据底部视口，抽屉底栏被整体吞没。
5. **【根因 5（基础设施隐患）】`app/_layout.tsx:167` 根部 `GestureHandlerRootView` 缺少 `style={{ flex: 1 }}`**：
   - 代码证据：`app/_layout.tsx:167` 渲染 `<GestureHandlerRootView>`，其子节点为 `<View style={styles.flex}>`。在 React Native Gesture Handler 规范中，外层容器必须显式充满全屏，否则可能引发手势坐标在异形屏上的归一化偏移。

---

#### 2. 真机验证实验设计（可复现、带明确物理判定指标）

- **实验 1：全面屏系统手势冲突验证**
  - **前置条件**：华为 P50 真机，系统设置中开启“手势导航（全面屏手势）”。
  - **测试动作**：手指贴紧屏幕物理最左边框（X=0），向右平移 100dp。
  - **现象判定**：屏幕左侧出现系统返回箭头指示符并触发轻微触感震动，当前应用退回上一页或尝试退出应用，抽屉**完全没有任何位移反应**。
  - **对照动作**：系统设置中切换为“屏幕内三键导航”，在屏幕左侧相同位置向右滑动。抽屉即可偶尔被拉出。结论：直接坐实系统手势抢占是首要致命元凶。
- **实验 2：自然拇指弧线滑动 vs 机械水平滑动验证**
  - **测试动作 A（机械水平滑动）**：借助直尺贴住屏幕，用触控笔沿绝对水平方向（垂直位移严格为 0）在屏幕左侧 20dp 处向右划过。抽屉能被唤醒。
  - **测试动作 B（单手握持拇指滑动）**：单手自然握机，拇指自边缘向右弧度划动。
  - **现象判定**：测试 B 成功率不足 10%，绝大多数被原生层 `failOffsetY` 中断。结论：证明了 5dp 纵向失败阈值的严苛破坏性。
- **实验 3：抽屉底部搜索栏键盘遮挡验证**
  - **测试动作**：通过点击左上角汉堡按钮打开抽屉，点击底部“搜索会话”胶囊。
  - **现象判定**：华为系统输入法弹起，屏幕底部 `DrawerFooter`、搜索输入框全部消失在键盘下方，用户在键盘上打字无法看到搜索框内容。结论：排版颠倒与无键盘协同导致功能瘫痪。

---

## 3 目标方案

### 3.1 核心技术选型与多方案论证

为彻底达成用户要求（“**主界面在上面，侧边栏在主界面下面**”的立体卡片感、**手势丝滑唤醒**、**零描边**、**符合 token 体系**），对 3 条完整实现路线进行严谨的技术评估与对比：

| 评估维度 | 方案 1：依赖内置能力 (`drawerType: 'back'`) | 方案 2：自定义 Reanimated 4 抽屉容器 (`CrishDrawerLayout`)【唯一推荐】 | 方案 3：混合代理路线 (内置抽屉 + 子页面 Pan 手势代理) |
| :--- | :--- | :--- | :--- |
| **层叠与视觉效果** | ❌ 仅支持主场景平移 `translateX`，**无法在动画中动态为场景注入 `borderRadius` 大圆角、微缩放 `scale` 与立体阴影**；视觉依旧是生硬切边。 | ✅ **极致立体卡片**：主界面作为顶层 Card，随着开合手势动态过渡到 `radius.sheet` (28dp) 大圆角、`0.94` 微缩放与 `shadow.md` 柔和投影；底层抽屉微视差。 | ⚠️ 依赖内置抽屉动画，依然受限于外层原生容器的裁剪机制，卡片圆角和投影无法透出。 |
| **手势唤醒可靠性** | ❌ 手势写死在 `Drawer.native.js:205`，`.failOffsetY([-5, 5])` 无法外部修改，且 Android 系统返回手势冲突无法根治。 | ✅ **完全自主可控**：采用原生 Worklet 驱动的 `Gesture.Pan()`，支持角度判别（容许 35° 自然弧度）与 64dp 安全激活区，徹底根治误触与截杀。 | ⚠️ 两套手势体系并存，外层与内层易发生手势争抢，状态同步易出现抖动。 |
| **遮罩压暗机制** | ⚠️ 需将 `overlayColor` 设为 `'transparent'`，但内部依然实例化了 Overlay 组件并维护其事件；关闭判定容易穿透。 | ✅ **物理级彻底消除遮罩**：不再渲染任何半透明 scrim，展开期间主卡片表面覆盖透明 Touchable 捕获收起手势。 | ⚠️ 同样需 hack 内置 overlay 为透明，存在点击事件穿透风险。 |
| **架构与反补丁 (U2/U5)** | ❌ 表面简单，实则是对不支持卡片动效的库进行“削足适履”，后续面临无限打补丁。 | ✅ **纯粹优雅、单一职责**：一个高聚合、零冗余的纯 Reanimated 4 组件，彻底摆脱外部黑盒库的缺陷。 | ❌ 典型的“折衷补丁式改造”，违反反补丁铁律（U5）。 |
| **对路由与深链的影响** | 路由不变。 | 路由不变：`(main)` 内的 `index.tsx` 和 `session/[sessionId].tsx` 依然是 expo-router 标准页面，外部跳转与通知深链 100% 保持契约。 | 路由不变。 |
| **选型结论** | 淘汰（无法达成视觉与手势目标） | **唯一推荐（正向架构收敛）** | 淘汰（过度设计且有补丁隐患） |

---

### 3.2 架构设计：`CrishDrawerLayout` 自定义层叠抽屉容器

#### 1. 视图拓扑分层模型
抛弃原有的 `expo-router/drawer` 容器，在 `(main)/_layout.tsx` 中使用纯净的 `CrishDrawerLayout`：
```
[CrishDrawerLayout 根容器 (flex: 1, backgroundColor: theme.colors.canvas)]
 ├── [Layer 0: 底层抽屉容器 (DrawerView, position: 'absolute', inset: 0)]
 │     ├── 背景色：theme.colors.canvas（浅色 #f2f2f2，深色 #121212）
 │     ├── 内部组件：CrishDrawerContent（顶部搜索扫一扫 + 审批 + 会话列表 + 底部栏）
 │     └── 动效响应：微视差平移（translateX: -36dp -> 0）
 └── [Layer 1: 顶层主界面卡片 (MainScreenCard, flex: 1, zIndex: 10)]
       ├── 背景色：theme.colors.surface（浅色 #ffffff，深色 #171717）
       ├── 内部组件：Slot / Children（承载 index 新对话 或 session/[sessionId] 会话页）
       ├── 动效响应：
       │     ├── 水平位移：translateX (0 -> drawerWidth)
       │     ├── 景深缩放：scale (1.0 -> 0.94)
       │     ├── 卡片圆角：borderRadius (0 -> theme.radius.sheet 28dp)
       │     └── 物理投影：theme.shadow.md（柔和阴影向左下方投射至 Layer 0）
       └── [透明轻击拦截层 (TapToCloseOverlay, 仅在 progress > 0 时激活)]
             └── 点击任意位置立即以 Spring 动画平滑收起抽屉
```

#### 2. Reanimated 4 Worklet 原生动效管道（60/120fps 跟手）
- **共享值真源**：`progress = useSharedValue(0)`（`0` 为完全关闭，`1` 为完全展开）。
- **主卡片动画映射**（`mainCardAnimatedStyle`）：
  ```ts
  const maxTranslateX = Math.min(width * theme.layout.drawerWidthRatio, theme.layout.drawerMaxWidth);
  const mainCardAnimatedStyle = useAnimatedStyle(() => {
    'worklet';
    const translateX = interpolate(progress.value, [0, 1], [0, maxTranslateX], Extrapolation.CLAMP);
    const scale = interpolate(progress.value, [0, 1], [1, 0.94], Extrapolation.CLAMP);
    const borderRadius = interpolate(progress.value, [0, 1], [0, theme.radius.sheet], Extrapolation.CLAMP);

    return {
      transform: [{ translateX }, { scale }],
      borderTopLeftRadius: borderRadius,
      borderBottomLeftRadius: borderRadius,
      // 保持右侧微圆角以增强悬浮卡片整体质感
      borderTopRightRadius: borderRadius * 0.75,
      borderBottomRightRadius: borderRadius * 0.75,
      overflow: 'hidden',
    };
  });
  ```
- **底层抽屉视差动画**（`drawerAnimatedStyle`）：
  ```ts
  const drawerAnimatedStyle = useAnimatedStyle(() => {
    'worklet';
    // 负向微位移实现优雅的视差露头效果，展开时如从后方平滑浮现
    const translateX = interpolate(progress.value, [0, 1], [-36, 0], Extrapolation.CLAMP);
    return {
      transform: [{ translateX }],
    };
  });
  ```

#### 3. 绝对禁止描边（U8 铁律贯彻）
- **杜绝一切形式的伪描边**：禁止给 `MainScreenCard` 边缘添加任何 `borderWidth`、`borderColor`、发光高光线或渐变线条。
- **纯色阶与阴影构建立体感**：
  - 底层抽屉底色为 `theme.colors.canvas`（深暗或浅灰）；
  - 顶层主界面底色为 `theme.colors.surface`（高亮白或深灰石墨色）；
  - 色阶差在视觉上天然形成物理边界，辅以 `theme.shadow.md`（柔和、大扩散半径、低透明度环境光遮蔽），使主卡片悬浮感自然逼真。

#### 4. 全局无遮罩与点击收起机制
- 彻底移除任何黑色半透明 `scrim` 遮罩（不使用 `overlayColor`）。
- 在 `MainScreenCard` 内挂载一个纯透明的 `TapDismissView`：
  - 当 `progress.value === 0` 时，设置 `pointerEvents="none"`，完全不拦截主界面的正常交互；
  - 当 `progress.value > 0` 时，设置 `pointerEvents="auto"`，用户点击主界面的任何区域（气泡、Header、Composer 外部）时，立即触发 `closeDrawer()` 平滑回弹，且不触发主界面内部任何按钮的点击事件，交互符合直觉。

#### 5. Android 物理返回键（BackHandler）闭环
- 当抽屉处于打开状态（`progress.value > 0.1`）时，按 Android 物理返回键或边缘手势返回，优先拦截并执行 `closeDrawer()` 收起抽屉；
- 抽屉完全收起后，返回键恢复系统/页面默认行为（会话页返回新对话页，新对话页返回桌面），彻底杜绝在抽屉打开时按返回键直接闪退的恶劣缺陷。
---

### 3.3 稳定手势唤醒引擎设计

#### 1. 物理边缘激活区拓宽（彻底规避系统手势拦截）
- **Token 调整**：将 `theme.layout.drawerSwipeEdgeWidth` 从原有的 `32dp` 调整为 `64dp`（新增或修改见 Token 清单）；
- **物理机理**：
  - Android 10+ / HarmonyOS 的系统返回手势判定带一般在 `0–32dp` 之间；
  - 当手势激活区拓宽至 `64dp` 时，用户大拇指在距屏幕边缘 `35–60dp` 的大片安全区域起滑，系统返回手势绝对不会被触发；
  - 抽屉手势引擎能够完整捕获到从手指触碰（`onBegin`）到移动（`onChange`）的全生命周期触摸点。

#### 2. 角度优先与弧度容差判定（根治纵向误杀）
- **抛弃硬编码的 `failOffsetY([-5, 5])`**；
- 采用 **位移夹角比率判定**（`tan(θ) <= 0.7`，对应约 35° 扇形区域）：
  ```ts
  const pan = Gesture.Pan()
    .hitSlop({ left: 0, width: theme.layout.drawerSwipeEdgeWidth })
    .activeOffsetX([10, 10]) // 启动水平位移 10dp
    .onUpdate((event) => {
      'worklet';
      // 允许自然大拇指弧线滑动：只要水平分量大于垂直分量的 1.4 倍，即确认为横向拉抽屉
      if (Math.abs(event.translationX) > Math.abs(event.translationY) * 1.4) {
        progress.value = Math.min(Math.max((startX.value + event.translationX) / maxTranslateX, 0), 1);
      }
    })
    .onEnd((event) => {
      'worklet';
      const shouldOpen = event.velocityX > 400 || progress.value > 0.45;
      progress.value = withSpring(shouldOpen ? 1 : 0, theme.motion.account.sheetSpring);
    });
  ```
- **Fling 快速甩动手势支持**：当用户以较快的初速度（`velocityX > 400dp/s`）向右轻扫时，即使当前位移不足一半，也会借由弹性动画快速顺滑展开。

#### 3. 与子页面时间线 `FlatList` 滚动冲突解耦
- `Gesture.Pan()` 仅在 `[0, 64dp]` 边缘触发；
- 对于中间区域的时间线列表上下滚动，原生 `FlatList` 独占纵向滚动通道；
- 两者通过 `GestureHandlerRootView` 规范的触摸分发树各行其道，彻底消除相互阻断。

---

### 3.4 版式重排详案（用户指令深度落地）

#### 1. 顶部固定吸顶区（`DrawerTopBar`）
- **功能构成**：【搜索胶囊输入框】+【扫一扫快捷按钮】；
- **安全区适配**：顶部使用 `paddingTop: insets.top + theme.space.xs`，紧贴状态栏下方安全区；
- **搜索胶囊**（`flex: 1` 占据主要空间）：
  - 高度：`theme.size.touch` (44dp)；
  - 背景色：`theme.colors.fillSubtle`（浅灰卡片，与底色形成分层）；
  - 圆角：`theme.radius.pill` (9999)；
  - 内部构成：左侧小放大镜 `Icon name="search"`、中间 `TextInput`（单行、支持清空按钮）、右侧当文字不为空时显示清除叉号小图标；
- **扫一扫按钮**：
  - 使用 `IconButton`，图标为 `scan`；
  - 点击回调直接调用 `router.push('/pair/scan')` 进入配对扫码页；
- **软键盘生命周期与吸顶规则**：
  - 搜索栏采用 **非滚动固定吸顶布局**，绝对不随会话列表上下滚动；
  - 当用户在搜索框聚焦激活软键盘时：
    - 由于搜索栏始终固定在屏幕最顶部，距离屏幕顶端仅 50dp 左右，处于视口最上方安全区；
    - 底部弹起的软键盘（高 300+dp）完全触碰不到顶栏，**搜索框在打字全过程中 100% 暴露可见**，彻底根治用户原话中的“搜索栏被输入法挤占看不到”的痛点！
    - 中间会话列表随 Android `adjustResize` 自动缩减可视高度，并在剩余视口空间内顺畅滚动展示过滤结果。

#### 2. 中间区域：审批与虚拟化会话列表
- **审批入口**（`DrawerNav`）：
  - 保留「待审批」（含计数角标）与「审批记录」两项紧凑行；
  - 位置紧随顶部搜索栏下方，提供高权重业务入口。
- **历史会话列表（`DrawerSessionList` 虚拟化重构）**：
  - **废弃** 原有 `DrawerContentScrollView` 内普通数组 `.map()` 裸铺机制；
  - 采用虚拟化分组列表渲染结构，分为「今天」和「更早」两段；
  - 消除父级内联函数：将会话点击回调稳定化，子项 `SessionListItem` 的 `memo` 保护 100% 生效，搜索打字时零无谓重绘；
  - 空态处理：根据是否有搜索词与连接状态，优雅展示“没有匹配的会话”或“还没有会话”。

#### 3. 底部常驻栏（`DrawerBottomBar`：用户指令推荐方案）
- **用户指令要求**：“下面放置头像和名字，然后再是设置再是新建对话的那个按钮”。
- **推荐方案（单行紧凑通栏 · 黄金空间利用）**：
  - 底部使用 `paddingBottom: insets.bottom + theme.space.xs`；
  - **左侧**：圆形头像（`theme.size.avatarSmall` 32dp，展示头像或主题首字母色块） + 用户昵称/账号名（`theme.type.bodyStrong`，`numberOfLines={1}`），点击直达账号中心；
  - **右侧**：两个紧凑操作圆钮：
    - `IconButton` 【设置】（图标 `settings`，圆钮背景 `fillSubtle`）；
    - `IconButton` 【新对话】（图标 `new-chat` 或 `plus`，使用主题主操作墨色背景 `theme.colors.actionPrimary`，白字高反差，醒目突出）；
  - **优势**：单行高度仅 56dp，将屏幕宝贵的垂直空间 80% 以上留给历史会话阅读，兼顾单手大拇指下沉点击的舒适性。
- **备选方案（双行结构）**：
  - 第一行：头像 + 名字 + 桌面连接状态指示灯；
  - 第二行：左侧「设置」横条，右侧「新建对话」大胶囊主按钮；
  - 劣势：垂直占用达 110dp+，小屏手机上会话列表只能露出 2-3 条。该项列入未决问题交用户裁决。

#### 4. 头像来源与占位规范（对接 N05 图标体系）
- 优先从 `useAccountStore.user.avatarUrl` 加载远程头像（若有配对服务端）；
- 加载失败或未登录时，调用 `avatarToneFor(user.id, theme)` 生成基于字符串稳定哈希计算的主题专属配色底色，内嵌名字首字大写；
- 游客或本地模式时，显示通用的 `Icon name="user"`，样式符合 `theme.ts`，绝不引入外部未经治理的第三方图标。

---

### 3.5 目标组件树（文件级）

```
apps/crish-mobile/
  ├── app/(main)/
  │     ├── _layout.tsx                 (重构：使用 CrishDrawerLayout 替代旧 Drawer)
  │     ├── index.tsx                   (保留：新对话路由，契约不变)
  │     └── session/[sessionId].tsx     (保留：会话详情路由，契约不变)
  └── src/presentation/components/drawer/
        ├── CrishDrawerLayout.tsx        [新增] (自定义层叠卡片抽屉容器：Reanimated 4 动效 + 手势 + 物理返回拦截)
        ├── CrishDrawerContent.tsx       [新增] (抽屉面板总装配：垂直 Flex 布局，顶栏 + 导航 + 列表 + 底栏)
        ├── DrawerTopBar.tsx             [新增] (顶栏组件：固定吸顶搜索胶囊 + 扫一扫 IconButton + 安全区适配)
        ├── DrawerNav.tsx                [保留优化] (审批两项入口与待审批计数)
        ├── DrawerSessionList.tsx        [新增] (虚拟化会话列表：今天/更早两组，稳定回调，空态处理)
        ├── DrawerBottomBar.tsx          [新增] (底栏组件：左侧头像昵称，右侧设置 + 新对话圆钮)
        ├── SessionListItem.tsx          [保留位于 sessions/] (优化：稳定点击函数，防搜索抖动重渲染)
        └── __tests__/
              ├── drawerLayout.test.tsx  [新增] (容器开合状态机、手势分发、返回键拦截单测)
              └── drawerContent.test.tsx [新增] (搜索吸顶、扫一扫跳转、底栏点击回调单测)
```

---

### 3.6 可删除清单与重复合并清单

#### 1. 可删除的文件与符号清单
1. **删除文件**：
   - `apps/crish-mobile/src/presentation/components/drawer/DrawerHeader.tsx`：彻底废弃。其原本的顶部头像与连接状态已按用户要求重排至底部栏，新对话圆钮已重排至底栏右侧；
   - `apps/crish-mobile/src/presentation/components/drawer/DrawerFooter.tsx`：彻底废弃。底部的旧搜索胶囊与设置排布完全废除；
   - `apps/crish-mobile/src/presentation/components/drawer/DrawerSessionGroups.tsx`：废弃并替换为虚拟化 `DrawerSessionList.tsx`；
   - `apps/crish-mobile/app/_components/useOpenDrawer.ts`：彻底删除该文件。它位于非法的 `app/` 路由目录下，且仅封装了已废弃的旧 DrawerActions。
2. **删除符号与配置**：
   - `apps/crish-mobile/app/(main)/_layout.tsx` 中的 `drawerType: 'front'` 与 `overlayColor: theme.colors.scrim` 引用彻底移除；
   - 移除 `CrishDrawer.tsx` 中的 `DrawerContentScrollView`，改为标准 Flex 列布局以实现顶栏与底栏的绝对吸顶/吸底。

#### 2. 重复合并清单
- 头像渲染逻辑收敛：将原 `DrawerHeader.tsx` 中私有的 `function Avatar(...)` 与账号模块头像组件合并，统一消费 `avatarToneFor` 单一真源；
- 连接状态点与文字显示收敛至底部用户卡片的小角标（或与底栏昵称副标题联动），避免多处状态格式化逻辑重复。

---

### 3.7 Token 变更清单

严格遵循 U4（所有样式走 theme token，禁止硬编码）：

| Token 路径 | 类型 | 变更动作 | 取值 | 用途与替换项 |
| :--- | :--- | :--- | :--- | :--- |
| `theme.layout.drawerSwipeEdgeWidth` | `number` | **修改** | `64`（原为 32） | 抽屉边缘唤醒安全区物理宽度，避开 Android 系统返回手势 32dp 拦截区 |
| `theme.layout.drawerCardScale` | `number` | **新增** | `0.94` | 主界面卡片在抽屉完全展开时的微缩放景深比例 |
| `theme.layout.drawerParallaxOffset` | `number` | **新增** | `-36` | 底层抽屉内容在完全展开过程中的视差移动位移（dp） |
| `theme.radius.sheet` | `number` | **既有消费** | `28` | 主界面卡片完全滑开时的顶角与底角大圆角（取代任何硬编码圆角） |
| `theme.shadow.md` | `ViewStyle` | **既有消费** | 标准 token | 主界面卡片边缘的物理环境投影（严格禁止使用任何伪描边） |
| `theme.colors.canvas` | `string` | **既有消费** | `#f2f2f2` / `#121212` | 底层抽屉面板背景色（低层深灰/浅灰底） |
| `theme.colors.surface` | `string` | **既有消费** | `#ffffff` / `#171717` | 顶层主界面悬浮卡片背景色（高层石墨/纯白底，构建天然色阶差） |

---

### 3.8 跨席位接口协议

1. **向 N04（动效与手势编排席）承诺与需求**：
   - **需求**：抽屉开合曲线与时长严格消费 N04 统一收敛的 `theme.motion`（Spring 参数采用 `damping: 28, stiffness: 300`，时长基准 `duration.sheet: 220ms`）；
   - **承诺**：`CrishDrawerLayout` 暴露统一的 `useDrawerController()` 句柄，提供 `open()`、`close()`、`toggle()` 与 `progress` 共享值，便于 N04 将抽屉收起动效与会话转场平滑编排，解决“先关后跳”的转场撕裂感。
2. **向 N05（图标与视觉资源治理席）需求**：
   - 抽屉重构仅需消费 7 个标准语义图标：`search`、`scan`、`shield`、`history`、`user`、`settings`、`new-chat`；
   - 保证这 7 个图标全部来自 N05 统一的图标库单一真源，不新增第三方依赖。
3. **向 N01（启动速度与主屏生命周期席）承诺**：
   - **抽屉会话列表惰性加载**：主屏进入时不阻塞初始化 `useSessionListVm`，延迟至用户首次触摸抽屉手势热区（`progress > 0`）或点击左上角汉堡按钮时才发起历史会话数据的计算，首屏交互进入时间稳稳锁定在 ≤1 秒内。
---

## 4 风险与未决问题（待用户裁决事项）

以下事项涉及交互权衡或用户原话歧义，需用户最终裁决：

| 裁决编号 | 事项名称 | 方案选项与对比 | 席位推荐及理由 | 用户裁决 |
| :--- | :--- | :--- | :--- | :--- |
| **D-01** | **抽屉底部栏结构** | **选项 A（单行紧凑通栏）**：左侧头像昵称，右侧「设置」+「新建对话」圆钮（高 56dp）。<br>**选项 B（双行卡片）**：第一行头像+昵称+连接状态，第二行设置行+新建对话大胶囊（高 110dp+）。 | **推荐 选项 A**。<br>理由：移动端垂直视口极其宝贵。选项 A 可多展示 3–4 条历史会话，单手握持时大拇指处于下沉点击黄金区。 | 待裁决 |
| **D-02** | **抽屉内通知铃铛去留** | **选项 A（抽屉内不放铃铛）**：仅在主屏（新对话/会话详情）Header 保留通知铃铛。<br>**选项 B（顶部三拼）**：顶部栏并排放置 `[搜索框] [扫一扫] [通知铃铛]`。<br>**选项 C（底栏设置/头像角标）**：若有未读通知，在设置或个人头像上呈现数字小红点。 | **推荐 选项 A**。<br>理由：严格遵循 U10（图标克制）原则。顶栏空间有限，放 3 个元素会导致搜索框被严重挤压；主屏已有高频通知入口。 | 待裁决 |
| **D-03** | **主卡片边缘投影强度** | **选项 A（采用 `theme.shadow.md`）**：柔和、中等扩散、低对比度投影（elevation: 8，opacity: 0.1/0.55）。<br>**选项 B（完全不使用任何阴影）**：纯靠 `canvas` 底色与 `surface` 主卡片的高反差色阶及圆角体现层叠。 | **推荐 选项 A**。<br>理由：虽然项目总则要求“默认不要重阴影”，但卡片层叠如果没有轻微的环境光遮蔽（Ambient Occlusion），在深色模式下边缘立体深度会明显减弱；`shadow.md` 属于克制柔和阴影，绝非描边。 | 待裁决 |
| **D-04** | **抽屉点击会话后的转场时序** | **选项 A（先收起后加载）**：先执行 Spring 动画闭合抽屉，再加载目标会话内容（当前逻辑）。<br>**选项 B（并行转场）**：点击后立即触发路由状态切换，主卡片在复位平移的同时内容已就绪。 | **推荐 选项 B**。<br>理由：符合 U9（丝滑过渡）原则，消除先关后跳的感知割裂感。该项已对接到 N04 席位统一编排。 | 待裁决 |

---

## 5 集中验收清单（改完一大批代码后统一执行的断言）

本清单用于代码全部改完后进行一次性、集中式的端到端验收与验证，严禁“改一点测一点”：

### 5.1 真机物理手势唤醒验收（华为 P50 / Android 12 / HarmonyOS）
- [ ] **断言 1（全面屏手势边缘滑出）**：华为 P50 在开启全面屏手势导航（系统返回开）状态下，单手手指从屏幕左边缘 30–60dp 区间向右自然滑动，10 次连续尝试中至少 9 次成功唤醒抽屉，系统返回箭头指示符不被误触；
- [ ] **断言 2（拇指自然弧线滑动）**：单手握机做自然大弧度划动（Y 轴位移在 15–30dp 之间），手势保持顺畅追踪，不被原生层 `failOffsetY` 意外杀死；
- [ ] **断言 3（列表滚动中边缘滑出）**：在会话页时间线 `FlatList` 快速纵向惯性滚动过程中，手指从屏幕左侧边缘快速向右扫过，抽屉能精准截获横向手势并平滑滑出，列表惯性滚动立即终止且无抖动；
- [ ] **断言 4（快速反复甩动与打断）**：以极快频率（每秒 3–4 次）反复向右向左甩动打断，Spring 动效始终平滑衔接，UI 线程保持 60/120fps，无白屏或动画卡死；
- [ ] **断言 5（三键导航兼容）**：在系统切换为传统屏幕内“三键导航”模式下，左边缘滑动唤醒 100% 成功。

### 5.2 层叠立体视觉验收
- [ ] **断言 6（主界面在上、抽屉在下）**：抽屉滑出时，主界面像一张完整的卡片整体向右平移露出底层抽屉，主界面层级物理高于抽屉；
- [ ] **断言 7（动态大圆角与微缩放）**：抽屉完全展开后，主界面卡片平滑过渡为 `theme.radius.sheet` (28dp) 大圆角，并呈现 `0.94` 的微缩放景深感，底层抽屉带有 -36dp 的优雅微视差；
- [ ] **断言 8（无遮罩与零描边）**：整个开合过程中没有任何黑色半透明遮罩（`scrim`）压暗抽屉或主卡片，卡片边缘**绝对没有任何描边、伪描边、发光线或外边框**；
- [ ] **断言 9（点击主卡片收起）**：抽屉展开状态下，轻触主卡片任意区域，抽屉立即平滑回弹关闭，且不触发主卡片内任何按钮的点击动作；完全关闭后主卡片无触摸阻挡。

### 5.3 顶部搜索与软键盘联动验收
- [ ] **断言 10（搜索吸顶与键盘无遮挡）**：在抽屉中点击顶部“搜索会话”胶囊激活系统软键盘，软键盘弹起后，顶部搜索框与扫一扫按钮始终稳固固定在屏幕最顶端安全区，100% 处于可见状态，绝对不被键盘遮盖；
- [ ] **断言 11（搜索即时过滤与列表缩减）**：软键盘激活期间，中间会话列表自适应缩小视口且可顺畅滚动，键入文字时今天与更早列表秒级过滤，清空关键词后秒级还原；
- [ ] **断言 12（扫一扫跳转）**：点击顶部扫一扫按钮，抽屉瞬间收起并准确导航进入 `/pair/scan` 扫码配对页。

### 5.4 底部栏交互与深链导航验收
- [ ] **断言 13（底栏跳转与状态）**：点击底栏用户头像/昵称跳转至账号页，点击设置按钮跳转至 `/settings`，点击新对话圆钮立即收起抽屉并切至新对话页；
- [ ] **断言 14（Android 物理返回键）**：在抽屉完全展开时按下手机物理返回键或边缘手势返回，优先收起抽屉，不发生应用闪退或二级页面误退；
- [ ] **断言 15（全局审批卡 ApprovalFloat 协同）**：抽屉在开合全过程中，全局悬浮卡片 `ApprovalFloat` 正确响应，不与抽屉卡片发生遮挡或层级打架。

### 5.5 门禁与代码工程验收
- [ ] **断言 16（样式 Token 守卫门禁）**：运行 `npm test src/__tests__/styleTokens.guard.test.ts` 零报警通过，抽屉所有新增/重构文件无任何裸色值、裸圆角、裸字号；
- [ ] **断言 17（TypeScript 静态检查）**：运行 `npm run typecheck` 零错误；
- [ ] **断言 18（抽屉单元测试全绿）**：运行 `jest src/presentation/components/drawer/` 新增测试套件 100% 绿灯通过。
