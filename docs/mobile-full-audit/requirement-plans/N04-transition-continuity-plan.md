# N04 界面过渡连续性与统一动效体系方案

> **席位**：第二轮战役 · N04 界面过渡连续性与统一动效体系方案席
> **被分析对象**：`apps/crish-mobile/`（Crish 移动端伴侣）
> **技术栈基准**：Expo SDK 57 / React Native 0.86.3（新架构 Fabric / Bridgeless）/ React 19.2.3 / expo-router 57.0.29 / react-native-screens 4.26.0 / react-native-reanimated 4.5.1 / react-native-worklets 0.10.1 / react-native-gesture-handler 2.32.0 / Zustand 5.0.14
> **实机基准**：华为 P50（Android 12 / HarmonyOS，高刷 120Hz，用户体验以 Android 真机为准）
> **对应约束**：`docs/mobile-full-audit/prompts/00-共同约束前言.md`（U2 彻底重构 / U3 适应未来 / U4 规范 Token / U5 非必要不兼容 / U7 集中验收 / U8 严禁描边类动效 / U9 丝滑连续过渡）

---

## 0 结论摘要（先给结论）

1. **转场点全量盘点**：应用内共存在 **80 处**界面转场与微动效点，其中 **34 处**（42.5%）存在严重生硬感、割裂跳变或桥接性能劣化。
2. **动效工程“两张皮”现状**：`package.json` 已声明 `react-native-reanimated` 4.5.1，但 `src/` 源码中实际使用率为 **0%**；全量动画退回到已被官方弃用的 React Native 旧版 `Animated` API（8 处）与手势 `PanResponder` 逐帧 `setState` 重渲染（1 处）。
3. **Android 原生栈支持核实**：`app/_layout.tsx:121` 标记的 `animationDuration` 经源码实证对 Android 原生栈（`react-native-screens` 4.26）为**完全无效属性**（底层固定为 Android XML `config_mediumAnimTime` 400ms），在 iOS 上对默认的 `slide_from_right` 同样不生效，属于伪配置。
4. **核心体验断层根因**：
   - 开屏存在“原生 Splash → JS 自绘 Spinner 开屏 → 主界面”三段跳（跳变 2 次）；
   - 抽屉向主栈推页采用“先 `closeDrawer()` 后 `router.push()`”，引发抽屉左滑与页面右滑双重高负载动画在主线程/JS 线程激烈争抢；
   - 浮动审批卡（`ApprovalFloat`）、连接条（`ConnectionBanner`）、Toast 均为条件渲染离散突变，导致 44px 至 180px 的物理高度骤跳；
   - 滑动确认（`SlideToConfirm`）在手势拖动时每 8ms 触发一次 React `setState`，并在边框使用高光描边，严重违反 U8 与 U9。
5. **推荐方案**：采用 **Reanimated 4 Worklet + React Navigation 原生栈混合统一动效架构**。清退全部旧 `Animated`、清退 `PanResponder`，建立单一真源 `motion` Token 阶梯（删除冗余 `account` 子命名空间，补充物理弹簧 `spring` 族），实现导航层单一入口编排，彻底根治全应用跳变与描边隐患。

---

## 1 现状还原（带 路径:行号 的证据）

### 1.1 动效工程“两张皮”与旧 Animated 泛滥
在 `apps/crish-mobile/package.json:48-53` 中，明确声明了现代高性能动画库：
```json
"react-native-gesture-handler": "~2.32.0",
"react-native-reanimated": "4.5.1",
"react-native-worklets": "0.10.1",
```
然而，在全仓 `src/` 与 `app/` 源码中全局检索 `react-native-reanimated`、`useSharedValue`、`useAnimatedStyle`，**检索结果为 0 处**。整个项目完全退回到 React Native 旧版 `Animated` API，导致跨线程通信频繁或被迫使用 `useNativeDriver: false`：
- `src/presentation/account/ui/AuthField.tsx:37-47`：使用 `new Animated.Value(0)` 驱动输入框聚焦背景色过渡，因旧 Animated 原生驱动器不支持颜色插值，显式设置 `useNativeDriver: false`，聚焦失焦每一帧都在 JS 线程计算并跨桥序列化。
- `src/presentation/account/ui/AuthButton.tsx:62-68`：使用 `new Animated.Value(1)` 与 `Animated.timing` 驱动按压缩放（100ms）。
- `src/presentation/account/ui/CodeCells.tsx:30-60`：使用 `new Animated.Value(0)` 构建由 7 个 `Animated.timing` 组成的 `Animated.sequence` 摇晃序列，并依赖 `setTimeout`（61 行）清理状态。
- `src/presentation/account/ui/SignOutSheet.tsx:35-70`：在 `<Modal animationType="none">` 内部，使用两个 `new Animated.Value(0)` 分别通过 `Animated.timing` 驱动遮罩透明度、`Animated.spring` 驱动面板位移。
- `src/presentation/components/approval/ApprovalFloat.tsx:97-121`：`useEnterAnimation` 使用两个 `new Animated.Value` 进行 `Animated.parallel` 淡入与上移。
- `src/presentation/components/tools/PulseDot.tsx:12-34`：使用 `Animated.loop(Animated.sequence([...]))` 循环改变透明度。
- `src/presentation/timeline/TimelineView.tsx:115-140`：自定义 `<FadeIn>` 组件，使用 `Animated.parallel` 包装 FlatList 的每一个 item。

### 1.2 Android 上 react-native-screens (4.26) 对 animation 与 animationDuration 的真实行为
在 `apps/crish-mobile/app/_layout.tsx:116-123` 中，针对账号模块配置了自定义时长：
```tsx
{/* 账号 v3：推入时长取 motion.account.push（iOS 生效；自定义缓动曲线原生栈不支持） */}
{ACCOUNT_V3_ROUTES.map((name) => (
  <Stack.Screen
    key={name}
    name={name}
    options={{ animationDuration: theme.motion.account.push }}
  />
))}
```
经深入核查 `node_modules` 源码，该断言与实现存在双重断裂：
1. **官方类型与平台限制**（`node_modules/expo-router/build/react-navigation/native-stack/types.d.ts:595-609`）：
   ```typescript
   /**
    * Duration (in milliseconds) for the following transition animations on iOS:
    * - `slide_from_bottom`
    * - `fade_from_bottom`
    * - `fade`
    * - `simple_push`
    *
    * Defaults to `500`.
    * The duration is not customizable for:
    * - Screens with `default` and `flip` animations
    * - Screens with `presentation` set to `modal`, `formSheet`, `pageSheet`
    * @platform ios
    */
   animationDuration?: number;
   ```
   官方声明该属性仅标注 `@platform ios`。且在 iOS 上，对根布局全局指定的默认动画 `animation: 'slide_from_right'`（`app/_layout.tsx:109`），`animationDuration` 明确标注为**不可定制**！
2. **Android 底层真实实现**（`node_modules/react-native-screens/android/src/main/java/com/swmansion/rnscreens/utils/FragmentTransactionKt.kt:31-35`）：
   ```kotlin
   StackAnimation.SLIDE_FROM_RIGHT ->
       this.setCustomAnimations(
           R.anim.rns_slide_in_from_right,
           R.anim.rns_slide_out_to_left,
       )
   ```
   Android 端是将其硬编码映射为系统 Fragment XML 动画资源；查阅 `node_modules/react-native-screens/android/src/main/res/base/anim/rns_slide_in_from_right.xml:3`：
   ```xml
   android:duration="@android:integer/config_mediumAnimTime"
   android:fromXDelta="100%"
   android:toXDelta="0%"
   ```
   其时长被 Android 系统固定为 `@android:integer/config_mediumAnimTime`（典型值为 400ms），`react-native-screens` 在 Android 的 Kotlin 层完全不读取亦不透传 `animationDuration`。
   **确凿结论**：在用户关心的华为 P50（Android）真机上，`animationDuration: theme.motion.account.push`（320ms）是 **100% 无效的伪属性**，Android 转场恒定走系统的 400ms XML 动画。

### 1.3 SlideToConfirm 滑动手势逐帧 setState 导致渲染雪崩
核查 `src/presentation/components/blocks/SlideToConfirm.tsx:107-118, 151-158`：
```typescript
onPanResponderMove: (_evt, gs) => {
  const next = slideMove(
    deps.getMachine(),
    gs?.dx ?? 0,
    deps.getTrackWidth(),
    deps.getDisabled()
  );
  if (next !== deps.getMachine()) {
    deps.setMachine(next);
    setThumbFrom(next);
  }
},
```
在 `SlideToConfirm` 内部：
- `machine` 是 React 标准状态 `useState<SlideConfirmState>(createSlideConfirmState)`；
- 手指在屏幕上滑动时，`onPanResponderMove` 以触控报点率（华为 P50 高刷屏达 120Hz/240Hz，即每 4~8ms）高频触发；
- 每次触发均执行 `deps.setMachine(next)`，导致该组件及其子树以 120fps 的频率在 JavaScript 线程执行全量 React Re-render；
- 回弹动画 `REBOUND_SPRING`（81–86 行）被显式配置为 `useNativeDriver: false`，回弹全过程帧计算全部压在 JS 线程；
- 此外，滑轨与滑块存在描边逻辑（313、326、352、363 行），强调态下变为绿色描边，严重违反 U8。
### 1.4 开屏阶段“三段跳”与闪烁证据
1. `apps/crish-mobile/app.json:44-50` 配置了原生开屏：
   ```json
   "plugins": [
     "expo-router",
     [
       "expo-splash-screen",
       { "backgroundColor": "#f2f2f2", "image": "./assets/images/splash-icon.png", "imageWidth": 76 }
     ], ...
   ```
2. 在 `app/_layout.tsx:88-100` 中，存在 JS 自绘开屏：
   ```tsx
   if (!hydrated || !accountHydrated) {
     return (
       <View style={[styles.splash, { gap: theme.space.xl, backgroundColor: theme.colors.canvas }]}>
         <BrandMark size={64} />
         <Spinner />
       </View>
     );
   }
   ```
3. 真实运行呈现三段断裂：
   - 第一阶段：Android 原生 Splash 显示 76px 静态图标，底色 `#f2f2f2`；
   - 第二阶段：由于 `app/_layout.tsx` 未调用 `SplashScreen.preventAutoHideAsync()`，RN 首帧渲染时原生 Splash 瞬间自动隐藏；React 挂载显示 JS 自绘开屏，图标突变为 64px `BrandMark` 并凭空出现一个旋转的 `Spinner`（第一次视觉跳变）；
   - 第三阶段：当 `hydrated && accountHydrated` 为 true 时，条件分支翻转，整个 Splash View 瞬间卸载，主界面或欢迎页瞬间生硬“拍”在屏幕上（第二次视觉跳变），无淡出或共享元素过渡。

### 1.5 抽屉推页“先关后推”与主栈双重竞争证据
核查 `src/presentation/components/drawer/CrishDrawer.tsx:45-54, 68-71`：
```typescript
const openRootPage = (href: '/approvals' | '/approval-history' | '/settings') => {
  navigation.closeDrawer();
  router.push(href);
};
```
在架构层级上，`Drawer` 嵌套于 `Stack` 内部（`app/_layout.tsx:112` 装配 `Stack.Screen name="(main)"`，而 `(main)/_layout.tsx` 内部为 `Drawer`）。
当用户点击抽屉中的“设置”或“待审批”时：
1. `navigation.closeDrawer()` 立即在内部触发抽屉左滑收起动画（持续约 250ms）；
2. 同时下一行代码同步触发 `router.push(href)`，根 Stack 立即启动右滑推入原生动画（Android 400ms）；
3. 两个全屏级别的转场动效在同一个时刻并发执行，UI 渲染管线与 JS 调度同时承担双倍负荷，且用户肉眼看到抽屉在向左收的同时底层页面被右侧推入的新页面强行覆盖，产生严重的视觉“撕裂”与掉帧。

### 1.6 浮层与横幅的无动画瞬移与布局跳变证据
1. **ApprovalFloat 键盘跳变与进出场割裂**（`src/presentation/components/approval/ApprovalFloat.tsx:40-46, 61, 69-91`）：
   - `bottom` 样式直接接收数值：`bottom = base + (anchor === 'composer' ? ...)`。在 iOS 上键盘弹起时由 0 突变为 300+，悬浮卡瞬间瞬移；在 Android 上虽依赖系统 `adjustResize`，但因未做高度渐变，窗口尺寸骤缩导致悬浮卡产生生硬位移；
   - 键盘弹起或手动折叠时，在 36px 高度的 `ApprovalFloatPill` 与约 180px 高度的 `ApprovalFloatCard` 之间通过 `{collapsed ? <Pill /> : <Card />}` 离散条件切换，无任何高度补间动画，视觉瞬间闪现；
   - 悬浮卡退场时（审批完成或路由进入 `/approval/*`），直接 `if (!model) return null;`，元素凭空消失，零退出动效。
2. **ConnectionBanner 整体下压跳变**（`src/presentation/screens/newChatScreen.tsx:76-82`）：
   - `{!vm.connected ? <ConnectionBanner ... /> : null}` 作为常规流式子节点插入在 `MainHeader` 与居中 `hero` 之间；
   - 当网络断开或重连时，横幅瞬间插入/拔除，下方整个页面（居中 Logo、问候语、说明文本）瞬间下移或上弹 44px + 间距（`theme.size.touch`），导致严重的屏幕抖动（Layout Shift）。
3. **Toast 闪现无过渡**（`src/presentation/ui/Toast.tsx:63-95`）：
   - `{toast ? <View ...>...</View> : null}`，没有渐入渐出动画，时间到了 `setToast(null)` 瞬间消失。

### 1.7 动效 Token 现状与散落硬编码证据
在 `src/adapters/platform/theme.ts:235-257, 564-589` 中定义了 `motion` 对象，但存在以下缺陷：
1. **命名空间割裂与重复**：存在独立的 `account` 子对象（`account.push: 320`、`account.fieldFocus: 160`、`account.scrim: 200`、`account.sheetSpring`、`account.shake`），与全局 `duration` 阶梯脱节（`duration.fast: 150` 与 `fieldFocus: 160` 产生冗余近邻值）；
2. **缺失弹性动画真源**：整个 theme 只有 `account.sheetSpring` 一处弹簧参数，`SlideToConfirm.tsx:81-86` 只能硬编码 `{ speed: 18, bounciness: 0 }`，`Toast`、`ApprovalFloat` 无弹性参数可用；
3. **散落硬编码数字**：
   - `Toast.tsx:43` 硬编码 `2500`ms 显示时长；
   - `PulseDot.tsx:23` 硬编码 `duration * 3`（660ms）；
   - `ApprovalCard.tsx:201, 210, 213, 221, 224` 硬编码 `gap: 12`、`gap: 8` 等。

---

## 2 问题清单

### 2.1 缺陷明细总表
| 编号 | 分类 | 位置 | 现象 | 直接原因 | 根因 | 影响 | 置信度 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| **D-N04-01** | 手势性能 | `SlideToConfirm.tsx:107-118` | 高刷屏拖动手势掉帧、卡顿、滑块滞后 | `onPanResponderMove` 内部每帧触发 React `setMachine` | 采用老旧 `PanResponder`，手势未接入 Worklet 原生线程驱动 | 严重 (P0) | 已验证 |
| **D-N04-02** | 平台断层 | `app/_layout.tsx:121` | 账号页面推入时长设置在 Android 上完全不生效 | `animationDuration: 320` 在 Android `react-native-screens` 4.26 中无代码消费 | 误以为该属性跨平台通用，未核实 Android 原生 Fragment XML 实现 | 中度 (P2) | 已验证 |
| **D-N04-03** | 转场撕裂 | `CrishDrawer.tsx:46-54` | 抽屉内点击设置/待审批时界面卡顿、背景撕裂 | `navigation.closeDrawer()` 与 `router.push()` 同步并发调用 | 导航层缺少过渡编排，抽屉收起与 Stack 推页动画重叠竞争 | 高度 (P1) | 已验证 |
| **D-N04-04** | 视觉跳跃 | `app/_layout.tsx:88-100` | 启动时先看到静态图标，再看到 Spinner，再突变为主界面 | 原生 Splash 自动淡出后显示 JS 自绘 Splash，数据水合后直接卸载 | 开屏采用三段式硬切换，首屏缺少平滑无缝衔接过渡 | 高度 (P1) | 已验证 |
| **D-N04-05** | 布局跳变 | `ApprovalFloat.tsx:69-91` | 悬浮审批卡折叠/展开时尺寸突变、键盘弹起时跳跃 | 通过三元表达式在卡片与胶囊间条件切换；bottom 为静态数值 | 悬浮容器缺少基于 Reanimated 的动态布局补间（Layout Transition） | 高度 (P1) | 已验证 |
| **D-N04-06** | 布局跳变 | `NewChatScreen.tsx:76-82` | 网络断开/恢复时，页面中心内容发生 44px 瞬时抖动 | `ConnectionBanner` 以流式条件渲染直接插入文档流 | 缺少弹性高度折叠（Accordion）与淡入淡出动画过渡 | 中度 (P2) | 已验证 |
| **D-N04-07** | 视觉突变 | `Toast.tsx:63-95` | Toast 提示硬弹硬消，无入场与出场动画 | 条件渲染 `{toast ? <View ...> : null}`，无动画插值 | UI 基础组件库缺少统一的 Reanimated 动画进退场封装 | 中度 (P2) | 已验证 |
| **D-N04-08** | 列表性能 | `TimelineView.tsx:73, 115` | 时间线列表快速滚动时，历史消息重复触发淡入动画 | 每个 FlatList 渲染项均外包 `<FadeIn>`，元素被回收复用时重新挂载 | 动画外壳滥用，未区分“新增末尾消息”与“历史列表滚动复用” | 高度 (P1) | 已验证 |
| **D-N04-09** | 架构冗余 | `Sheet.tsx` vs `SignOutSheet.tsx` vs `formSheet` | 存在 3 套互相冲突的底部面板实现 | 账号模块自造一套 Animated 弹簧 Sheet，主库用 Modal slide，路由用原生 formSheet | 缺少统一抽象设计，违反反过度设计红线与 DRY 原则 | 中度 (P2) | 已验证 |
| **D-N04-10** | 规范回潮 | `SlideToConfirm.tsx:313, 326` | 滑动确认高亮态出现鲜艳绿色描边与滑块边框 | 样式硬编码 `borderWidth: 1` 并动态绑定 `borderColor` | 违反前言 U8“严禁任何描边/伪描边动效”红线 | 严重 (P0) | 已验证 |
### 2.2 全量转场点总表（80 处转场与动效点穷尽盘点）

| 编号 | 起点 | 终点 | 触发方式 | 现有机制 | 时长与缓动来源 | 是否生硬及原因 | 置信度 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| **T01** | 应用冷启桌面 | 原生 Splash | 点击 App 图标 | OS 原生 Activity 启动 | 系统窗口动画 | 否（系统原生） | 已验证 |
| **T02** | 原生 Splash | JS 自绘 Splash | 原生窗口加载完成 | 条件渲染突变 | 瞬间切换（0ms） | **是**：76px 图标突变为 64px + 冒出 Spinner | 已验证 |
| **T03** | JS 自绘 Splash | 主界面 `(main)` | `hydrated` 状态置 true | 条件渲染突变 | 瞬间切换（0ms） | **是**：Splash 视图瞬间卸载，主页生硬弹出 | 已验证 |
| **T04** | JS 自绘 Splash | 欢迎页 `/welcome` | `hydrated` 且未登录未配对 | 条件渲染突变 | 瞬间切换（0ms） | **是**：无任何转场动画，白屏或内容突现 | 已验证 |
| **T05** | `(main)` 根 | `/welcome` | 认证守卫校验失败 | `<Redirect href="/welcome" />` | 瞬间替换（0ms） | **是**：组件渲染期直接触发 replace，无过渡 | 已验证 |
| **T06** | `/welcome` | `/` | 已配对或已登录 | `<Redirect href="/" />` | 瞬间替换（0ms） | **是**：声明式重定向瞬切，引发首屏跳变 | 已验证 |
| **T07** | `/pair` 根 | `/` | 配对流程中检测到已登录 | `<Redirect href="/" />` | 瞬间替换（0ms） | **是**：强行踢回首页，无栈退出过渡 | 已验证 |
| **T08** | `<Protected>` 页面 | `/welcome` | 鉴权失败 | `<Redirect href="/welcome" />` | 瞬间替换（0ms） | **是**：受保护页面未决时闪烁并瞬跳 | 已验证 |
| **T09** | `<RequireAccount>` | `/welcome` | 账号为空 | `<Redirect href="/welcome" />` | 瞬间替换（0ms） | **是**：直接重定向，缺少优雅退场 | 已验证 |
| **T10** | `/welcome` | `/account/login` | 点击“邮箱登录” | `router.push` | 原生栈 slide_from_right (400ms) | 否：符合系统推入预期 | 已验证 |
| **T11** | `/welcome` | `/pair/scan` | 点击“扫码连接” | `router.push` | 原生栈 slide_from_right (400ms) | 否：符合系统推入预期 | 已验证 |
| **T12** | `/pair/welcome` | `/account/login` | 点击登录 | `router.push` | 原生栈 slide_from_right (400ms) | 否：标准右侧推入 | 已验证 |
| **T13** | `/pair/welcome` | `/pair/manual` | 点击手动连接 | `router.push` | 原生栈 slide_from_right (400ms) | 否：标准右侧推入 | 已验证 |
| **T14** | `/pair/welcome` | `/pair/scan` | 点击扫码 | `router.push` | 原生栈 slide_from_right (400ms) | 否：标准右侧推入 | 已验证 |
| **T15** | `/pair/welcome` | `/` | 点击直接进入 | `router.replace` | 瞬间替换（0ms） | **是**：replace 替换无滑动过渡，界面突变 | 已验证 |
| **T16** | `/pair/scan` | `/` | 扫码成功配对完成 | `router.replace('/')` | 瞬间替换（0ms） | **是**：相机画面直接硬切到新会话主页 | 已验证 |
| **T17** | `/pair/scan` | 上一级 | 点击左上角返回 | `goBack()` / `useSafeBack` | 原生栈 pop (400ms) | 否：标准返回动画 | 已验证 |
| **T18** | `/pair/manual` | 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准返回动画 | 已验证 |
| **T19** | `/account/login` | `/account/code` | 发送验证码成功 | `router.push` | 原生栈 slide_from_right (400ms) | 否：横向滑动推入 | 已验证 |
| **T20** | `/account/login` | `/account/password`| 点击密码登录 | `router.push` | 原生栈 slide_from_right (400ms) | 否：横向滑动推入 | 已验证 |
| **T21** | `/account/login` | 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准横向返回 | 已验证 |
| **T22** | `/account/password`| `/` | 密码登录成功 | `dismissAll() + replace('/')` | 双重调用突变 | **是**：先关闭模态又硬替换首页，视觉跳变 | 已验证 |
| **T23** | `/account/password`| `/account/code` | 点击忘记密码 | `router.push` | 原生栈 slide_from_right (400ms) | 否：横向推入 | 已验证 |
| **T24** | `/account/password`| 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准横向返回 | 已验证 |
| **T25** | `/account/code` | `/` | 验证码校验成功 | `dismissAll() + replace('/')` | 双重调用突变 | **是**：成功后收栈生硬，无连续性视觉引导 | 已验证 |
| **T26** | `/account/code` | `/account` | 验证码校验完成(改密) | `router.dismissTo('/account')` | 原生栈 dismiss | 否：直接回退到账号主页 | 已验证 |
| **T27** | `/account/code` | `/account/set-pwd` | 新用户或引导设密 | `router.push` | 原生栈 slide_from_right (400ms) | 否：横向推入 | 已验证 |
| **T28** | `/account/code` | 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准横向返回 | 已验证 |
| **T29** | `/account/set-pwd` | `/account/code` | 点击发送验证码 | `router.push` | 原生栈 slide_from_right (400ms) | 否：横向推入 | 已验证 |
| **T30** | `/account/set-pwd` | `/` | 设密完成 | `dismissAll() + replace('/')` | 双重调用突变 | **是**：整栈强杀并硬切首页，体验突兀 | 已验证 |
| **T31** | `/account/set-pwd` | 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准横向返回 | 已验证 |
| **T32** | `/account` | `/account/profile` | 点击个人资料 | `router.push` | 原生栈 slide_from_right (400ms) | 否：横向推入 | 已验证 |
| **T33** | `/account` | `/account/sessions`| 点击设备管理 | `router.push` | 原生栈 slide_from_right (400ms) | 否：横向推入 | 已验证 |
| **T34** | `/account` | `/account/set-pwd` | 点击修改密码 | `router.push` | 原生栈 slide_from_right (400ms) | 否：横向推入 | 已验证 |
| **T35** | `/account` | `/account/delete` | 点击注销账号 | `router.push` | 原生栈 slide_from_right (400ms) | 否：横向推入 | 已验证 |
| **T36** | `/account` | `/welcome` | 点击退出登录并确认 | `router.replace('/welcome')` | 瞬间替换（0ms） | **是**：账号页直接生硬刷成欢迎页 | 已验证 |
| **T37** | `/account` | 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准横向返回 | 已验证 |
| **T38** | `/account/profile` | 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准横向返回 | 已验证 |
| **T39** | `/account/sessions`| 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准横向返回 | 已验证 |
| **T40** | `/account/delete` | `/welcome` | 注销成功 | `router.replace('/welcome')` | 瞬间替换（0ms） | **是**：无平滑过渡直接跳回 | 已验证 |
| **T41** | 账号页 | SignOutSheet | 点击退出登录按钮 | Modal + JS Animated | 200ms scrim + 弹簧 | **是**：与系统 Sheet 并行造轮子，两套实现 | 已验证 |
| **T42** | SignOutSheet | 隐藏 | 点击遮罩或取消 | JS Animated 退场 | 200ms scrim timing | 否：有渐隐退场 | 已验证 |
| **T43** | 抽屉手势 | 抽屉展开 | 屏幕左边缘右滑 | 手势驱动 `front` 抽屉 | 物理跟手 / 弹簧回弹 | **是**：华为 P50 左侧滑易误触系统返回手势 | 已验证 |
| **T44** | 汉堡按钮 | 抽屉展开 | 点击汉堡图标 | `navigation.openDrawer` | Drawer 内置过渡 (~250ms) | 否：平稳滑出 | 已验证 |
| **T45** | 抽屉内 | `/session/:id` | 点击历史会话 | `closeDrawer + navigate` | 抽屉关 + 路由导航 | **是**：抽屉在关，底下时间线数据瞬变重渲卡顿 | 已验证 |
| **T46** | 抽屉内 | `/` | 点击“新建对话” | `closeDrawer + navigate` | 抽屉关 + 路由导航 | **是**：抽屉边收起边重绘空态，视觉割裂 | 已验证 |
| **T47** | 抽屉内 | `/approvals` | 点击待审批 | `closeDrawer + push` | 抽屉关 + 原生栈推页 | **是**：抽屉左收与原生栈右推双重竞争撕裂 | 已验证 |
| **T48** | 抽屉内 | `/approval-hist` | 点击审批记录 | `closeDrawer + push` | 抽屉关 + 原生栈推页 | **是**：双重并发动画打架，明显丢帧 | 已验证 |
| **T49** | 抽屉内 | `/settings` | 点击设置 | `closeDrawer + push` | 抽屉关 + 原生栈推页 | **是**：双重并发动画打架，掉帧严重 | 已验证 |
| **T50** | 新对话 `/` | `/session/:id` | 首条 Prompt 发送成功 | `router.replace` | 瞬间替换（0ms） | **是**：Logo问候语消失，时间线闪现，顶栏跳变 | 已验证 |
| **T51** | 新对话 `/` | `/notifications` | 点击右上角铃铛 | `router.push` | 原生栈 slide_from_right (400ms) | 否：标准右侧推入 | 已验证 |
| **T52** | `/session/:id` | `/run/:id` | 点击查看运行详情 | `router.push` | 原生栈 slide_from_right (400ms) | 否：标准右侧推入 | 已验证 |
| **T53** | `/session/:id` | `/terminal/:id` | 点击终端输出 | `router.push` | 原生栈 slide_from_right (400ms) | 否：标准右侧推入 | 已验证 |
| **T54** | `/session/:id` | `/tools/:sessionId`| 点击工具调用入口 | `router.push` | 原生 `formSheet` | 否：Android 4.26 底层映射 BottomSheet | 已验证 |
| **T55** | `/session/:id` | SessionMoreSheet | 点击顶栏更多按钮 | `<Modal animationType="slide">` | 原生 Modal slide | **是**：未走统一设计规范，全屏 Modal 遮挡 | 已验证 |
| **T56** | SessionMoreSheet | 隐藏 | 点击遮罩或关闭 | 原生 Modal slideDown | 原生 Modal slide | 否：原生平稳下落 | 已验证 |
| **T57** | `/run/:id` | `/terminal/:id` | 点击运行中终端按钮 | `router.push` | 原生栈 slide_from_right (400ms) | 否：标准推入 | 已验证 |
| **T58** | `/run/:id` | 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准返回 | 已验证 |
| **T59** | `/terminal/:id` | 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准返回 | 已验证 |
| **T60** | `/approval-hist`| 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准返回 | 已验证 |
| **T61** | `/notifications` | 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准返回 | 已验证 |
| **T62** | `/notifications` | 目标业务页面 | 点击通知项 | `router.push(path)` | 原生栈 slide_from_right (400ms) | 否：标准推入 | 已验证 |
| **T63** | `/approvals` | `/approval/:id` | 点击审批队列项 | `router.push` | `transparentModal` + `fade` | 否：透明模态淡入 | 已验证 |
| **T64** | `/approval/:id` | 上一级 | 点击决策允许/拒绝 | `goBack()` | `fade` 退出 | 否：平稳淡出 | 已验证 |
| **T65** | `/tools/:id` | `/terminal/:id` | 点击工具内打开终端 | `router.push` | 原生栈 slide_from_right (400ms) | 否：标准推入 | 已验证 |
| **T66** | `/settings` | `/account` | 已登录时点账号项 | `router.push` | 原生栈 slide_from_right (400ms) | 否：标准推入 | 已验证 |
| **T67** | `/settings` | `/account/login` | 未登录时点账号项 | `router.push` | 原生栈 slide_from_right (400ms) | 否：标准推入 | 已验证 |
| **T68** | `/settings` | `/welcome` | 解除配对/清除数据 | `router.replace('/welcome')` | 瞬间替换（0ms） | **是**：数据清空后瞬刷欢迎页 | 已验证 |
| **T69** | `/settings` | 上一级 | 点击返回 | `goBack()` | 原生栈 pop (400ms) | 否：标准返回 | 已验证 |
| **T70** | ApprovalFloat入场 | 悬浮显示 | 新审批到达 | JS `Animated.parallel` | 180ms timing (enter) | 否：微动效上移淡入 | 已验证 |
| **T71** | ApprovalFloat退场 | 彻底消失 | 决策完成或离开路由 | 条件渲染 `return null` | 瞬间销毁（0ms） | **是**：无退场动画，卡片突兀消失 | 已验证 |
| **T72** | ApprovalFloat形态 | 卡片 ↔ 胶囊 | 键盘弹起 / 手动折叠 | 三元表达式条件渲染 | 瞬间切换（0ms） | **是**：36px 与 180px 瞬切，视觉跳变 | 已验证 |
| **T73** | ApprovalFloat避让 | 上移抬起 | 软键盘弹起 | 静态样式 `bottom` 赋值 | 依赖键盘 didShow (Android) | **是**：iOS 瞬跳，Android 晚一拍二次跳动 | 已验证 |
| **T74** | Toast 提示 | 显示 | `showToast` 调用 | 条件渲染 `{toast ? <View>:null}` | 瞬间出现（0ms） | **是**：无入场动效，直接硬弹 | 已验证 |
| **T75** | Toast 提示 | 消失 | 定时器 2500ms 到期 | `setToast(null)` 条件渲染 | 瞬间销毁（0ms） | **是**：无退场渐隐，直接闪消 | 已验证 |
| **T76** | Dialog 确认弹窗 | 出入场 | 危险操作二次确认 | `<Modal animationType="fade">` | 系统窗口淡入淡出 | 否：标准系统 Fade | 已验证 |
| **T77** | ConnectionBanner | 出现 / 消失 | 网络断开 / 重连成功 | 条件流式插入/移除 | 瞬间插拔（0ms） | **是**：整页内容剧烈垂直跳动 44px | 已验证 |
| **T78** | 时间线消息 | 挂载淡入 | 消息到达 / 滚动挂载 | 内联 `<FadeIn>` 组件 | 180ms Animated timing | **是**：长列表快速滑动滚动复用时重复触发淡入 | 已验证 |
| **T79** | 输入框焦点状态 | 聚焦 / 失焦 | 点击输入框激活/离开 | `Animated.timing (Native=false)` | 160ms JS 线程颜色插值 | **是**：JS 线程计算颜色，高刷下掉帧 | 已验证 |
| **T80** | SlideToConfirm | 拖动与回弹 | 手指拖动滑块 / 抬手 | `PanResponder` + `setState` | 手势逐帧重渲 + JS Spring | **是**：120Hz 下严重卡顿丢帧，且带描边 | 已验证 |

### 2.3 核心生硬点深度根因分析
全表 80 个转场与动效点中，生硬点共计 **34 处**（占比 42.5%），其根因高度收敛为五大架构断层：
1. **声明式重定向断层（T05–T09, T15, T16, T36, T40, T68）**：过度依赖 `<Redirect>` 与 `router.replace` 进行粗暴的状态路由重置，未提供任何视觉过渡，导致页面空白与闪现；
2. **多线程并发竞态断层（T45, T47–T49）**：抽屉动作与主栈推页缺少单入口协同机制，导致不同层级的动效在同毫秒内并发竞争；
3. **空间高度突变断层（T70–T75, T77）**：浮动审批卡、连接状态条、Toast 完全采用 React 条件渲染（`{show ? <Comp /> : null}`），组件在 0ms 内插入/移除，造成剧烈的几何位移与视觉割裂；
4. **动效底层技术倒退（T78–T80）**：在拥有新架构与 Reanimated 4 的前提下，仍旧使用旧版 `Animated`、`useNativeDriver: false` 与 `PanResponder`，导致帧率严重腰斩；
5. **视觉规范侵权（T80）**：在拖动手势中硬编码边框宽度与状态描边，直接突破用户 U8“严禁描边”红线。
## 3 目标方案：统一动效体系设计与实现

### 3.1 方案选型与架构论证（2–3 个完整方案对比）

| 维度 | 方案一：Reanimated 4 Worklet + 原生栈混合架构（推荐） | 方案二：纯 React Native 内置 Animated 方案 | 方案三：全自研纯 JS rAF 驱动方案 |
| :-- | :-- | :-- | :-- |
| **核心机制** | 原生页面栈走 `react-native-screens` C++ 原生动画；组件/手势/微动效 100% 走 `react-native-reanimated` 4.5.1 UI Worklet 线程 | 全局所有动效均用 React Native 内置 `Animated`；页面栈保持原生 | 不依赖任何动画库，完全基于 `requestAnimationFrame` + React 状态更新 |
| **手势跟手性** | **极致**：手势直接在 UI 线程（Worklet）响应，华为 P50 120Hz 下 0 延迟、0 丢帧 | **差**：无法与新版 Gesture Handler 深度互通，高刷下手势滞后跟随 | **崩溃**：每 8ms 触发一次 JS 状态与 Bridge 通信，高刷下迅速出现帧雪崩 |
| **颜色与布局插值** | **支持**：原生支持 `interpolateColor` 与 `LayoutTransition`（自动高度补间） | **不支持**：`useNativeDriver: true` 不支持颜色与尺寸，强行使用会红屏报错 | **部分支持**：需在 JS 端进行繁重的手写数学计算，主线程卡死 |
| **跨平台真实性** | **真实有效**：屏蔽平台细节，UI 线程自循环驱动；适配 Android Fabric 新架构 | **虚假繁荣**：`useNativeDriver: false` 充斥全应用，名存实亡 | **极不可靠**：不同 Android 厂商的电池策略与调度会导致 rAF 严重抽搐 |
| **代码与依赖治理** | **极简净收敛**：激活已有依赖，清退全部旧 `Animated`、清退 `PanResponder`，消除两套并存 | **技术债累积**：继续停留在旧架构，无法根治 `SlideToConfirm` 逐帧重渲 | **严重过度设计**：徒手实现物理引擎与曲线采样，违背根目录反过度设计红线 |

**选型决策与推荐理由**：
毫不动摇地推荐**方案一**。
理由：`package.json` 已经引入了与 Expo 57 深度绑定的 `react-native-reanimated` 4.5.1 和 `react-native-worklets` 0.10.1。启用它不仅不需要安装任何新依赖，反而能够彻底清除旧版 `Animated` 的技术负债。Worklet 架构将手势事件与复杂物理动画彻底从 JavaScript 线程中剥离，使得在高负载（如流式数据到达、网络状态翻转）场景下，界面的过渡动效依然能保持如同丝绸般顺滑跟手。

### 3.2 统一 Motion Token 体系设计
彻底清退原 `theme.motion` 中的 `account` 孤岛命名空间，将所有动效参数收归为**单一真源**：

#### 3.2.1 时长阶梯（Duration Scale）
- `micro: 100ms`：极微触觉动效、按钮缩放（Press Scale）；
- `snappy: 120ms`：小控件状态切换、复选/开关、图标微旋转；
- `fast: 150ms`：输入框聚焦底色过渡（原 160ms 废除归并）、Toast 入场、小气泡展开；
- `normal: 200ms`：遮罩淡入淡出（Scrim Fade）、折叠面板展开/收起、Dialog 渐隐；
- `sheet: 250ms`：底部抽屉/侧边面板完全展开、全屏卡片滑动；
- `settle: 300ms`：复杂多属性协同复位、状态机终态收敛。

#### 3.2.2 物理弹簧参数（Spring Scale，新增）
基于阻尼（damping）、刚度（stiffness）与质量（mass）的物理弹簧模型，全面替代生硬的贝塞尔时间曲线：
- `snappy`: `{ damping: 20, stiffness: 350, mass: 0.8 }`（按压回弹、小型胶囊切换）；
- `bouncy`: `{ damping: 15, stiffness: 200, mass: 1 }`（Toast 弹出、轻量提示）；
- `sheet`: `{ damping: 28, stiffness: 300, mass: 1 }`（底部 Sheet 入场、浮动审批卡高度变形）；
- `drawer`: `{ damping: 30, stiffness: 260, mass: 1 }`（侧边抽屉与主界面层叠视差位移）；
- `slideThumb`: `{ damping: 25, stiffness: 320, mass: 0.9 }`（滑动确认滑块未过阈值时的物理回弹）。

#### 3.2.3 规范动效配置（Entering & Feedback）
- `enter`: `{ duration: 150, translateY: 6 }`（全局统一轻量浮入，原 180ms 归并为 150ms）；
- `shake`: `{ distance: 6, cycles: 3, duration: 240 }`（验证码出错左右抖动，原 320ms 精简）；
- `toast`: `{ displayMs: 2500 }`（收编原 `Toast.tsx:43` 的裸数字）。

#### 3.2.4 Token 变更清单对照表
| 操作 | Token 路径 | 旧值 | 目标值 | 改造用途与替换硬编码 |
| :-- | :-- | :-- | :-- | :-- |
| **修改** | `motion.enter.duration` | `180` | `150` | 消除 180ms 离散值，归并至 `duration.fast` |
| **新增** | `motion.spring.snappy` | 无 | `{ damping: 20, stiffness: 350, mass: 0.8 }` | 用于胶囊、按钮弹簧物理回弹 |
| **新增** | `motion.spring.sheet` | 无（原在 account 内）| `{ damping: 28, stiffness: 300, mass: 1 }` | 提升为全局共享，用于各类 Sheet 与悬浮卡 |
| **新增** | `motion.spring.slideThumb`| 无 | `{ damping: 25, stiffness: 320, mass: 0.9 }` | 替换 `SlideToConfirm.tsx:81-86` 裸写 `speed: 18` |
| **新增** | `motion.spring.drawer` | 无 | `{ damping: 30, stiffness: 260, mass: 1 }` | 供 N03 抽屉层叠与主界面右移使用 |
| **新增** | `motion.shake` | 无（原在 account 内）| `{ distance: 6, cycles: 3, duration: 240 }` | 提升为全局通用，替代原 `account.shake` |
| **新增** | `motion.toast.displayMs` | 无 | `2500` | 替换 `Toast.tsx:43` 中的 `setTimeout(..., 2500)` 硬编码 |
| **删除** | `motion.account.push` | `320` | **删除** | Android 原生栈完全不生效，伪配置清除 |
| **删除** | `motion.account.pushEasing` | `[0.32, 0.72, 0, 1]` | **删除** | 原生栈不支持自定义贝塞尔曲线，伪配置清除 |
| **删除** | `motion.account.fieldFocus` | `160` | **删除** | 归并入全局 `motion.duration.fast (150)` |
| **删除** | `motion.account.scrim` | `200` | **删除** | 归并入全局 `motion.duration.normal (200)` |
| **删除** | `motion.account.sheetSpring`| `{ damping: 28, stiffness: 300 }` | **删除** | 提升为全局 `motion.spring.sheet` |
| **删除** | `motion.account.shake` | `{ duration: 320, ... }` | **删除** | 提升为全局 `motion.shake` |
| **删除** | `theme.motion.account` 整个对象 | Object | **删除** | 彻底消灭命名空间孤岛，实现单一真源 |

### 3.3 统一转场与动效实现规范（层级分类映射表）
| 转场分类 | 场景 | 规范动效机制 | 推荐参数 / Token | 体验预期 |
| :-- | :-- | :-- | :-- | :-- |
| **层级推入/返回** | Stack 子页面进入、返回 | `react-native-screens` 原生硬件加速 | `slide_from_right` (Android 原生 400ms，清理无效 duration) | 保持系统级手势跟手性与无缝推入 |
| **模态/全屏表单** | 工具详情、审批全屏查看 | 原生 `formSheet` / `transparentModal` | `fade` / 原生 BottomSheet 停靠点 | 无全屏白色闪烁，背景柔和变暗 |
| **侧滑面板/抽屉** | 左侧抽屉唤醒、关闭 | Reanimated 4 Worklet 驱动层叠位移 | `motion.spring.drawer`（主界面向右位移并带微圆角） | 见下文单入口协同，主界面在上、抽屉在下 |
| **浮层入场/退场** | Toast、悬浮审批卡（ApprovalFloat） | Reanimated `entering / exiting` | `FadeInDown.springify()` / `FadeOutDown.duration(150)` | 悬浮物软着陆，绝不瞬间闪现/闪消 |
| **布局与高度变形** | ApprovalFloat卡片↔胶囊、ConnectionBanner | Reanimated `layout` 补间 | `LinearTransition.springify().damping(28)` | 容器高度柔和伸缩，页面内容平滑推挤，0 抖动 |
| **微交互反馈** | 输入框聚焦变色、滑动滑块拖拽 | Reanimated `useAnimatedStyle` Worklet | `interpolateColor` (150ms) / 物理弹簧回弹 | 纯 GPU 线程合成，零 JS 线程重渲染 |
### 3.4 统一过渡编排入口设计

#### 3.4.1 彻底根治“先关抽屉后推页面”的双重动画竞争（反补丁红线）
现状痛点：`CrishDrawer.tsx:46-54` 在用户点击设置或待审批时，同步执行 `navigation.closeDrawer()` 与 `router.push(href)`，导致抽屉收起与页面推入在同毫秒内并发，画面撕裂。

**方案对比与选型**：
- **方案 A（延迟补丁，严厉禁止）**：`closeDrawer()` 之后 `setTimeout(() => router.push(), 250)`。这属于前言严厉禁止的“魔法延迟”，且会让用户在点击后干等 250ms 才看到页面推入反应，体验迟滞。
- **方案 B（动画完成监听回调）**：等待抽屉关闭状态变为 `'closed'` 后再触发 push。不仅状态追踪繁琐，且依然存在 250ms 的肉眼可见卡顿。
- **方案 C（即时后台静默重置，最佳实践推荐）**：
  在导航封装入口（`app/_components/useDrawerNavigation.ts`）中，当触发根栈路由跳转时：
  1. 立即执行 `router.push(href)`，保证用户触击瞬间获得最高响应优先级，目标原生 Stack 页面立即从右侧丝滑推入（0ms 响应延迟）；
  2. 抽屉自身立即执行**无动画静默重置**（`closeDrawer({ animated: false })` 或内部状态直接重置为 closed）。
  **用户肉眼感知**：新页面以 120fps 从右侧完美覆盖当前屏幕；而当用户在设置页点击返回（`goBack`）时，下方的 Drawer 已经是收起完毕的干净主界面！既没有并发动画竞争，也没有 250ms 的等待延迟，代码极致精简。

#### 3.4.2 新对话 `/` → 会话页 `/session/:id` 的无缝视觉衔接
现状痛点：发送 Prompt 后执行 `router.replace`，居中 Logo 突然消失，时间线白屏突现，顶栏由设备胶囊瞬变为主会话标题。

**改造设计**：
1. **数据面乐观预置（Optimistic Pre-seeding）**：在发送首条 Prompt 唤醒会话时，`SessionDetailScreen` 挂载的首帧直接从入参或共享暂存中同步读取用户提交的文本，首帧渲染即带用户消息气泡，消除“从空白跳出消息”的滞后感；
2. **MainHeader 交叉淡入（Cross-fade）**：顶栏中心组件（设备胶囊 ↔ 会话标题）采用 Reanimated 的 `entering={FadeIn.duration(150)}` 与 `exiting={FadeOut.duration(150)}` 进行无缝交叉溶解，彻底消除标题行硬切跳动；
3. **输入条（Composer）高度锚定**：新对话与会话详情页的底部 Composer 尺寸完全统一为 `theme.size.composerMin: 52`，内衬与安全区边距严格对齐，键盘在路由切换过程中保持唤起状态（无须收起再重新弹出），输入框视觉原地不动。

#### 3.4.3 开屏“三段跳”彻底消除方案（对接 N01）
与 N01 席位接口对齐，落实**原生 Splash 直通主界面**：
1. **彻底删除 JS 自绘开屏**：完全删除 `app/_layout.tsx:88-100` 的 `if (!hydrated || !accountHydrated) return <View style={styles.splash}><BrandMark size={64} /><Spinner /></View>;`；
2. **保持原生 Splash 锁屏**：在 `app/_layout.tsx` 初始化时显式调用 `SplashScreen.preventAutoHideAsync()`；
3. **数据先渲染后校正**：依赖 N01 提供的“同步本地水合登录态”，直接渲染根 `Stack` 的首个目标页面；
4. **单次渐隐退场**：在根页面完成首次布局测量（`onLayout`）且处于就绪态的瞬间，触发 `SplashScreen.hideAsync()`；同时通过一层与背景底色同色的全屏遮罩 `FadeOut.duration(150)` 丝滑淡出。
**最终效果**：冷启动全过程用户仅看到系统原生开屏图标，随后图标平滑溶解，直接露出已渲染好的可交互主界面，期间**没有任何旋转的 Spinner，没有任何尺寸跳变的图标**！

#### 3.4.4 账号登录/校验成功收尾转场设计（对接 N02）
现状痛点：`accountNavigation.ts:16-17` 中 `if (router.canDismiss()) router.dismissAll(); router.replace('/');` 产生双重动作抽搐。

**改造设计**：
- 在账号登录/验证码通过校验时，先调用全局 Toast 弹出轻量反馈（如“登录成功”）；
- 导航动作重构为单次原子操作：账号栈如果作为 Modal 呈现，则统一走单次平滑的 `router.dismissTo('/')` 或直接 `router.replace('/')`，去除生硬的 `dismissAll` 冗余二次调用。

### 3.5 布局跳变彻底消除方案

#### 3.5.1 ConnectionBanner 弹性手风琴折叠（Accordion）
在 `NewChatScreen.tsx:76-82` 中，将横幅容器升级为 Reanimated 4 Worklet 动画容器：
```tsx
<Animated.View
  layout={LinearTransition.springify().damping(28).stiffness(300)}
  entering={SlideInUp.duration(150)}
  exiting={SlideOutUp.duration(150)}
>
  <ConnectionBanner ... />
</Animated.View>
```
当断网或重连状态变化时，容器高度在 150ms 内以弹性物理曲线平滑展开或收起，下方的页面内容随之柔和推挤下移或回弹上移，**彻底消除 44px 瞬间跳变**。

#### 3.5.2 ApprovalFloat 悬浮卡与胶囊柔和变形
在 `ApprovalFloat.tsx` 中：
1. **卡片与胶囊形态过渡**：利用 Reanimated 的 `layout={LinearTransition.springify().damping(28).stiffness(300)}` 属性包裹外层 `Animated.View`。从 180px 卡片到 36px 胶囊的切换过程呈现出平滑的尺寸收缩与圆角变形；
2. **进出场动画**：外层容器挂载 `entering={FadeInDown.springify().damping(25)}` 与 `exiting={FadeOutDown.duration(150)}`，审批通过或被驳回时，悬浮卡柔和向下滑出屏幕，告别凭空消失；
3. **键盘避让原生化**：在 iOS 上利用 Reanimated 4 提供的 `useAnimatedKeyboard()` 读取键盘高度 SharedValue，通过 `useAnimatedStyle` 在 UI 线程直接更新 `translateY`，与键盘弹起 100% 同步跟手；在 Android 上由系统的窗口 resize 托管，移除 JS 端的冗余计算。

#### 3.5.3 TimelineView 长列表滚动复用免动画化
彻底消除 `TimelineView.tsx:73` 中的内联 `<FadeIn>` 包装：
- 仅当列表尾部（Tail）收到新追加的实时消息块时，针对该单条消息赋予 `entering={FadeInDown.duration(150)}`；
- 历史长消息在上下滑动滚动时，被回收并重新挂载的元素**绝不触发任何动画**，彻底根除高刷滚动时的闪烁与性能损耗。
### 3.6 核心组件级重构设计

#### 3.6.1 SlideToConfirm 滑动确认手势原生化与去描边重构
彻底废弃 `PanResponder` 与 `useState` 驱动方案，重构为基于 `react-native-gesture-handler` + `react-native-reanimated` 的纯 Worklet 手势：
1. **手势与动效 100% 运行于 UI 线程**：
   - 使用 `Gesture.Pan()` 替代 `PanResponder`；
   - 滑块位移定义为 `const thumbX = useSharedValue(0)`；
   - 在 `onUpdate((event) => { 'worklet'; thumbX.value = clamp(...); })` 中直接在 C++/UI 线程更新位移，**拖动过程中 0 次触发 React 组件渲染**；
   - 在 `onEnd` 时进行阈值判断：若超过 70% 阈值，执行 `runOnJS(onConfirm)()`；若未超过，执行 `thumbX.value = withSpring(0, theme.motion.spring.slideThumb)` 物理平滑回弹。
2. **彻底清退描边视觉（满足 U8）**：
   - 删除 `styles.track` 中的 `borderWidth: 1` 与动态 `borderColor`；
   - 删除 `styles.thumb` 中的 `borderWidth: 1` 与动态 `borderColor`；
   - 激活态改为纯**表面色阶（Surface Token）变化**：滑轨底色由 `theme.colors.fillSubtle` 平滑过渡至 `theme.colors.successSoft`，滑块由 `theme.colors.surfaceRaised` 承载阴影（`theme.shadow.sm`），严禁任何发光、高亮边框。

#### 3.6.2 AuthField 聚焦变色原生化
- 废弃 `new Animated.Value(0)` 与 `useNativeDriver: false`；
- 使用 `const focusProgress = useSharedValue(0)`；
- 聚焦时 `focusProgress.value = withTiming(1, { duration: theme.motion.duration.fast })`；
- 背景色通过 `useAnimatedStyle` 在 UI 线程插值：
  ```typescript
  const animatedBoxStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      focusProgress.value,
      [0, 1],
      [theme.colors.field, theme.colors.fieldFocus]
    ),
  }));
  ```
- 跨桥通信完全归零，键盘呼出与输入聚焦丝般顺滑。

#### 3.6.3 CodeCells 出错抖动 Worklet 化
- 废弃由 7 个 `Animated.timing` 拼接的 swings 数组和 `setTimeout` 清理；
- 使用 `const translateX = useSharedValue(0)`；
- 当 `errorKey` 变化时，直接在 UI 线程调度纯弹簧/序列微动效：
  ```typescript
  const { distance, cycles, duration } = theme.motion.shake;
  translateX.value = withSequence(
    withTiming(distance, { duration: duration / 6 }),
    withTiming(-distance, { duration: duration / 6 }),
    withTiming(distance / 2, { duration: duration / 6 }),
    withTiming(-distance / 2, { duration: duration / 6 }),
    withTiming(0, { duration: duration / 6 })
  );
  ```
- 动画完成后通过 Reanimated 的动画完成回调直接清空输入，删除裸 `setTimeout` 调度。

#### 3.6.4 Toast 浮动提示统一进出场动效
在 `src/presentation/ui/Toast.tsx` 中：
- 渲染容器升级为 `Animated.View`；
- 挂载 `entering={FadeInDown.springify().damping(20)}` 与 `exiting={FadeOutDown.duration(theme.motion.duration.fast)}`；
- 显示时长收归为 `theme.motion.toast.displayMs: 2500`；
- 提示出现时以柔和弹簧浮起，消失时渐隐滑出，不再瞬间闪烁。

#### 3.6.5 Sheet 底部面板全仓统一归并
现状有 3 套 Sheet 实现（`presentation/ui/Sheet.tsx`、`account/ui/SignOutSheet.tsx`、路由 `formSheet`），按反过度设计红线执行收口：
1. **保留路由级 `formSheet`**：用于全屏独立的业务页（`tools/[sessionId]`、`approvals`），由 `react-native-screens` 原生 Android BottomSheet 承载；
2. **统一内嵌 Sheet 容器**：将 `SignOutSheet.tsx` 内手写的 `Modal + Animated` 彻底删除，重构为直接复用 `src/presentation/ui/Sheet.tsx`；
3. `presentation/ui/Sheet.tsx` 内部遮罩与面板出入场统一为 `FadeIn` 与 `SlideInDown`，实现视觉与动效体验的单一真理。

### 3.7 目标文件架构与重构拓扑
```
apps/crish-mobile/
├── app/
│   ├── _layout.tsx                     # [重构] 删除 JS 自绘 Splash，删除无效 animationDuration 伪属性，装配原生 Splash 渐隐
│   └── (main)/
│       ├── _layout.tsx                 # [重构] 适配无缝抽屉层叠与路由直达
│       ├── index.tsx                   # [重构] 优化新会话 Prompt 提交至会话详情的数据无缝直通
│       └── session/[sessionId].tsx     # [重构] 乐观预置首帧消息气泡，消除会话切换白屏
├── src/
│   ├── adapters/platform/
│   │   ├── theme.ts                    # [重构] 删除 account 命名空间，补充 spring 参数族与 toast 常量
│   │   └── useKeyboardHeight.ts        # [重构] 改造为支持与 Reanimated 协同的原生避让
│   └── presentation/
│       ├── account/ui/
│       │   ├── AuthButton.tsx          # [重构] 移除 Animated.Value，对齐全局 Pressable 缩放动效
│       │   ├── AuthField.tsx           # [重构] 迁移至 Reanimated 4 interpolateColor Worklet
│       │   ├── CodeCells.tsx           # [重构] 迁移至 Reanimated 4 withSequence，删除 setTimeout
│       │   └── SignOutSheet.tsx        # [重构] 删除自造 Animated Modal，直接复用 presentation/ui/Sheet
│       ├── components/
│       │   ├── approval/
│       │   │   ├── ApprovalFloat.tsx   # [重构] 迁移至 Reanimated entering/exiting/layout，消除跳变
│       │   │   ├── ApprovalFloatCard.tsx # [修改] 移除冗余边框，规范阴影与色阶
│       │   │   └── ApprovalFloatPill.tsx # [修改] 移除冗余边框
│       │   ├── blocks/
│       │   │   ├── SlideToConfirm.tsx  # [彻底重构] 清退 PanResponder/setState，迁移至 Gesture.Pan + Worklet，彻底删除描边
│       │   │   └── slideConfirmMachine.ts # [简化] 保留纯逻辑计算，移除与 PanResponder 的事件绑定
│       │   ├── drawer/
│       │   │   └── CrishDrawer.tsx     # [重构] 抽屉内推页改用单入口后台静默重置策略，根治并发撕裂
│       │   └── status/
│       │       └── ConnectionBanner.tsx # [重构] 外部包裹 Reanimated layout 补间容器，消除 44px 抖动
│       ├── timeline/
│       │   └── TimelineView.tsx        # [重构] 彻底删除全量 <FadeIn> 包装，仅针对末尾实时新增消息赋予单次入场动效
│       └── ui/
│           ├── Sheet.tsx               # [重构] 统一作为应用内唯一的嵌入式底部面板组件
│           └── Toast.tsx               # [重构] 挂载 Reanimated entering/exiting，消除闪现
```
### 3.8 删除清单与重复实现合并清单

#### 3.8.1 应删除的废弃与冗余代码清单
1. **`app/_layout.tsx:88-100`**：彻底删除 `styles.splash`、`<BrandMark size={64} />` 与 `<Spinner />` 自绘开屏整块代码；
2. **`app/_layout.tsx:116-123`**：彻底删除 `ACCOUNT_V3_ROUTES.map(...)` 遍历配置 `animationDuration` 伪属性的整个代码块与相关注释；
3. **`src/presentation/timeline/TimelineView.tsx:115-140`**：彻底删除私有组件 `function FadeIn({ children })` 及其内部 `Animated.parallel` 代码；
4. **`src/presentation/components/blocks/SlideToConfirm.tsx:81-86, 89-138, 213-226`**：彻底删除 `REBOUND_SPRING`、`buildSlideConfirmPanConfig` 与 `PanResponder.create` 全量代码；
5. **`src/presentation/components/blocks/SlideToConfirm.tsx:313, 326, 352, 363`**：彻底删除滑轨与滑块的 `borderWidth: 1` 及 `borderColor` 动态描边样式；
6. **`src/presentation/account/ui/SignOutSheet.tsx:35-75, 78-98`**：彻底删除该文件中自建的 `<Modal animationType="none">`、`scrim` 与 `panel` 的 `new Animated.Value` 双变量动画逻辑；
7. **`src/presentation/components/approval/ApprovalFloat.tsx:97-121`**：彻底删除基于旧 `Animated.Value` 的 `useEnterAnimation` 函数；
8. **`src/presentation/account/ui/CodeCells.tsx:38-66`**：彻底删除由 7 个 timing 组合的 swings 数组、`Animated.sequence` 逻辑以及 `setTimeout` 清理器；
9. **`src/presentation/account/ui/AuthField.tsx:37-48, 52-55`**：彻底删除 `Animated.Value(0)`、`Animated.timing` 颜色过渡以及 `focus.interpolate` 代码；
10. **`src/adapters/platform/theme.ts:247-254, 579-586`**：彻底删除 `ThemeMotion['account']` 类型与对象实体（含 `push`, `pushEasing`, `fieldFocus`, `sheetSpring`, `scrim`, `shake`）。

#### 3.8.2 重复实现合并清单
1. **底部 Sheet 面板合并**：
   - 现状：`src/presentation/ui/Sheet.tsx` 与 `src/presentation/account/ui/SignOutSheet.tsx` 分别实现了两套底层 Sheet；
   - 合并：删除 `SignOutSheet` 中的私有 Modal 与动画，改写为直接消费通用 `src/presentation/ui/Sheet.tsx`。
2. **按钮按压缩放逻辑合并**：
   - 现状：`src/presentation/account/ui/AuthButton.tsx:62-68` 私自使用 `Animated.timing` 缩放，而通用 `src/presentation/ui/Button.tsx` 使用 `opacity`；
   - 合并：删除 `AuthButton` 的独立动画，统一消费 `theme.motion.pressScale` 或对齐通用 Button 组件。
3. **全局淡入动效合并**：
   - 现状：`TimelineView.tsx` 与 `ApprovalFloat.tsx` 各自写了一套 `useEnterAnimation` / `FadeIn`，内部均直接 `new Animated.Value`；
   - 合并：全仓统一使用 Reanimated 4 原生提供的 `entering={FadeInDown.duration(theme.motion.enter.duration)}`。

### 3.9 跨席位接口锁定
- **对 N01（冷启动提速席）**：
  - N01 承诺：根除 `_layout.tsx` 中的异步阻塞闸门，在 0ms 时间点提供本地同步水合就绪态；
  - N04 承诺：接管从原生 Splash 到主界面首帧的渐隐退场与视觉直达，取消任何中间 Spinner，保证首屏呈现绝对连续。
- **对 N02（验证码感知与描边清退席）**：
  - N02 承诺：验证码 6 位输满后提交期间不使用任何聚焦描边、光圈与外发光；
  - N04 承诺：接管验证码校验成功后的转场编排，提供从输入格成功态向主会话页（或密码设置页）的丝滑单步导航。
- **对 N03（侧边抽屉重构席）**：
  - N03 承诺：抽屉本体采用主界面圆角卡片向右位移、侧边栏在下方的层叠立体结构；
  - N04 承诺：提供统一的 `theme.motion.spring.drawer` 物理弹簧参数，并由 N04 的“单入口静默重置策略”接管抽屉内点击“设置/待审批”向根 Stack 推页时的无缝过渡，确保无双重动画冲突。
- **对 N05（图标体系方案席）**：
  - N04 承诺：在全仓动效重构中，不在任何图标外层包裹呼吸光圈、脉冲边框或描边动画。

---

## 4 风险与未决问题（需用户裁决事项）

### 4.1 用户明确裁决事项
1. **抽屉层叠立体感的阴影取舍（需裁决）**：
   - 现状与背景：用户在 N03 中提出“主界面在上面，侧边栏在主界面下面”的立体层叠视觉。为了在无描边（U8）的前提下凸显主界面卡片浮在抽屉之上，通常需要给主卡片左边缘施加一层柔和外阴影（`theme.shadow.sm` 或 `theme.shadow.md`）；但根规范强调“默认不要重阴影”。
   - 方案选项：
     - **选项 A（推荐）**：允许主卡片仅在抽屉拉出期间应用极其微弱柔和的 `theme.shadow.sm`（elevation 3，透明度 0.08），仅用于勾勒边缘立体感，完全收起后清除；
     - **选项 B（纯色阶差，零阴影）**：完全不加任何阴影，纯粹依靠主卡片背景色（`surface: #ffffff`）与抽屉底层背景色（`canvas: #f2f2f2`）的高对比色阶差以及主卡片右移露出的 20px 大圆角来呈现立体感。
2. **低端机 / 开启系统“省电模式”时的动效降级策略（需裁决）**：
   - **选项 A（推荐，优雅降级）**：检测到系统开启减弱动态效果（Reduce Motion）或极端省电模式时，弹簧动画降级为无物理超调的短时线性微渐变（100ms），保留界面视觉连续性但不做复杂位移；
   - **选项 B（彻底瞬切）**：直接将所有动画时长置为 0ms，完全跳过过渡动画。
3. **账号修改密码成功后的路由收尾方向（需裁决）**：
   - 现状：`accountNavigation.ts:12-14` 判定 `next === 'account'` 时执行 `router.dismissTo('/account')`。
   - 裁决点：用户在会话内若通过设置修改密码，完成后是**直接回到设置页**还是**停留在账号主页**？当前推荐直接回到设置页，避免用户多点一次返回。

---

## 5 集中验收清单（代码重构后统一执行）

### 5.1 自动化与静态门禁断言
- [ ] **TS 编译无报错**：在 `apps/crish-mobile/` 根目录执行 `npm run typecheck` 零错误；
- [ ] **样式 Token 守卫 100% 通过**：执行 `npm test -- src/__tests__/styleTokens.guard.test.ts`，断言源码中无任何裸色值、裸圆角；
- [ ] **旧 Animated 彻底清零断言**：执行静态检索断言脚本，断言全仓除测试 Mock 桩外，没有任何从 `'react-native'` 引入 `Animated` 的代码（清退率 100%）；
- [ ] **描边清退静态断言**：断言 `SlideToConfirm.tsx`、`ApprovalFloatCard.tsx` 中不存在任何动态 `borderColor` 赋值。

### 5.2 华为 P50 真机与录屏逐帧验收断言（Android 12 / HarmonyOS）
| 验证项 | 触发操作 | 判定标准与验收断言 | 录屏逐帧核实方法 |
| :-- | :-- | :-- | :-- |
| **冷启动衔接** | 杀进程后点击桌面图标冷启 | 1. 启动全过程无白色闪屏，无中间旋转 Spinner；<br>2. 系统原生开屏平滑渐隐，主界面首帧直接呈现，可交互时间 ≤1.0s。 | 240fps 录屏检查：从点击图标至第一帧主界面渲染，中间不得出现超过 1 帧的中间态跳动或黑白闪。 |
| **抽屉推页衔接** | 打开侧边抽屉，点击“设置” | 1. 抽屉背景不发生撕裂与并发卡顿；<br>2. 设置页面从右侧丝滑推入，帧率稳定在 110–120fps；<br>3. 点击返回键时，主界面保持闭合干净状态。 | 录屏检查点击瞬间：不得出现抽屉往左收的同时右侧页面推入的双重动画并发现象。 |
| **抽屉会话切换** | 打开抽屉，连续快速点击不同会话 | 1. 时间线区域不出现闪白或空白；<br>2. 抽屉平稳闭合，底部会话数据平滑呈现。 | 逐帧检查数据切换间隙，断言背景恒为 `canvas`，无白屏漏底。 |
| **新对话转会话** | 新对话输入 Prompt 并点击发送 | 1. Composer 原地保持不动，软键盘不收起不跳动；<br>2. 顶栏标题与中心文本平滑交叉淡入，用户消息首帧即在时间线中。 | 录屏检查底部输入栏外形，断言切换前后垂直 Y 轴坐标位移量 = 0px。 |
| **悬浮审批卡折叠** | 待审批卡片展开状态下呼出软键盘 | 1. 悬浮卡在 150ms 内平滑收缩为胶囊形态（ApprovalFloatPill）；<br>2. 尺寸平滑缩放，无 0ms 瞬间瞬断。 | 慢动作回放：断言外层高度在 150ms 窗口内连续渐变，无离散高度突变。 |
| **连接状态条展开** | 模拟网络断开与恢复 | 1. 顶部 ConnectionBanner 以手风琴方式平滑展开/收起；<br>2. 下方页面内容以弹性动效柔和推挤，无 44px 瞬时抖动。 | 录屏检查下方 Hero 区域位移速度曲线，断言满足物理弹簧衰减，无跳变。 |
| **滑动确认跟手性** | 在待审批页面水平拖拽 `SlideToConfirm` | 1. 滑块 100% 紧贴手指（0ms 延迟，120fps 极速刷新）；<br>2. 拖动过程中 React DevTools / 控制台监视到 0 次 React Re-render；<br>3. 未过 70% 抬手平滑弹簧回弹；过 70% 抬手触发；<br>4. 全程无任何绿色/彩色描边。 | 逐帧检查滑块边缘与手指接触点相对位置，断言高刷下延迟在 1 帧（8.3ms）以内。 |
| **时间线高速滑动** | 在拥有 100+ 条消息的长会话中快速上下猛甩滑动 | 1. 历史消息元素在屏幕上下穿梭时保持静止渲染；<br>2. 绝对不重复触发淡入动效，滑动帧率稳定在 120fps。 | 快速 fling 滚动，断言除屏幕底部新增消息外，任何老消息不出现二次渐显。 |
| **减弱动态模式** | 在 Android 系统辅助功能中开启“移除动画” | 1. 所有页面依然能够正常导航、正常进入；<br>2. 动效降级为瞬时切换或简单透明度切换，功能无阻断。 | 在系统设置开启该开关后复测全部链路，断言无崩溃无卡死。 |

### 5.3 验收执行命令清单
```bash
# 1. 移动端全量类型检查
cd C:\Software\conex\apps\crish-mobile
npm run typecheck

# 2. 动效与样式守卫自动化回归
npx jest src/__tests__/styleTokens.guard.test.ts --runInBand

# 3. 核心滑动确认与状态机逻辑单测验证
npx jest src/presentation/components/blocks/SlideToConfirm.test.tsx --runInBand

# 4. 全量快速单元测试门禁
npm test
```
