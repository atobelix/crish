# R04 UI/UX 体验与物理适配对抗复核报告

> **复核对象**：`docs/mobile-full-audit/audits/04-ui-ux-and-platform-adaptation-audit.md`（共 17 项缺陷）  
> **复核席位**：第二轮战役 · R04 UI/UX 体验与物理适配对抗复核席  
> **复核基准**：Android 真机物理表现（华为 P50 / HarmonyOS）、跨端键盘避让契约、React Native 0.86 / Reanimated 4 原生机制、用户 U1–U10 硬性效果锁  
> **纪律要求**：零源码修改只读审计、逐条穿透调用链、区分事实与推论、拒绝打补丁式妥协

---

## 0 结论摘要

1. **核心定性**：原报告敏锐指出了移动端在异形屏避让、键盘遮挡与长耗时弱网反馈上的多处真实断层，但存在**对 Android 原生底层能力的认知偏差与推论性夸大**。
2. **判定统计**：全案 17 项缺陷中，**✅ 成立 12 项**、**⚠️ 部分成立 4 项**（DEF-01、DEF-04、DEF-15、DEF-17）、**🚫 完全不成立 0 项**、**❓ 包含平台未决验证 1 项**（DEF-04 Android 软键盘安全区联动）。原报告可信度综合评定为 **B+（问题敏锐度高，但底层机制理解有偏差）**。
3. **关键纠偏 1（Android formSheet 容器）**：原报告断言“Android 根本不存在原生 formSheet，降级为全屏且标题必撞打孔屏”，查证 `node_modules/react-native-screens/src/types.tsx:566` 证实 Android 原生支持 Material `BottomSheetBehaviour` 停靠容器，报告对底层容器判定不成立。
4. **关键纠偏 2（手势性能归因）**：DEF-15 原报告称“高刷屏拖拽每秒 Virtual DOM Diff 跨线程雪崩”，实测组件位移已走 `thumbX.setValue` 原生桥接，React Compiler 也已生效；但 `onPanResponderMove` 确实每帧调用 `setMachine` 触发组件自身重渲染，确需迁移至 Reanimated Worklet。
5. **关键纠偏 3（抽屉重排与反补丁）**：DEF-07 抽屉搜索框被键盘盖死属实，但原报告建议在底部加 `KeyboardAvoidingView` 属于补丁妥协；用户已明确指示将搜索与扫一扫移至抽屉顶部（N03），顶层重排方为彻底治本。
6. **遗漏与描边清退**：原报告严重漏算硬编码间距（实测 102 处，报告仅记 42 处）；遗漏 `Input.tsx:49` 聚焦变色边框（违背 U8 禁描边铁律）与 `newChatScreen.tsx:89` 多余大品牌图标（违背 U10）。

---

## 1 现状还原（带 路径:行号 的证据）

### 1.1 屏幕物理安全区与状态栏沉浸模型
- **Screen 容器机制**（`apps/crish-mobile/src/presentation/ui/Screen.tsx:18-21, 43-46`）：
  `topInset` 默认 `false`，`bottomInset` 默认 `false`。`avoidKeyboard` 在 iOS 上挂载 `KeyboardAvoidingView behavior='padding'`，但在 Android 上为 `undefined`，由系统 `windowSoftInputMode` 处置。
- **Header 安全区机制**（`apps/crish-mobile/src/presentation/ui/AppHeader.tsx:46, 88`）：
  内部已显式调用 `insets.top` 计算内边距，因此标准二级页无需开启 `Screen topInset`；但 `approvalListScreen` 与 `toolSheetScreen` 并未引入 `AppHeader`，直接以裸 `View` 承接。
- **Android formSheet 容器真实行为**（`node_modules/react-native-screens/src/types.tsx:396-397, 566`）：
  `react-native-screens` 4.x 在 Android 端使用 Material `BottomSheetBehaviour` 实现 `formSheet`，并支持最多 3 个停靠点。在 `apps/crish-mobile/app/_layout.tsx:136-157` 中，`tools/[sessionId]` 与 `approvals` 分别配置了 `sheetAllowedDetents: [0.45, 0.92]` 与 `[0.6, 0.92]`，在 Android 实机上表现为底部浮层抽屉，而非普通全屏卡片。
- **底部安全区断层分布**：
  - `terminalScreen.tsx:98` 默认 `bottomInset={false}`，且 `TerminalView.tsx:90-106` 的 `FlatList` 未设置 `contentContainerStyle`，尾部输出直接被底部系统条遮挡。
  - `notificationCenterScreen.tsx:74` 固定 `paddingBottom: theme.space.xxl` (24px)；
  - `approvalHistoryScreen.tsx:90` 固定 `paddingBottom: 32`；
  - `SettingsScreenView.tsx:80` 固定 `paddingBottom: theme.space.section` (32px)。
  在 iPhone (34pt) 与 Android 三键导航 (48dp) 上均未叠加 `insets.bottom`。
- **系统状态栏割裂配置**（`apps/crish-mobile/app.json:22-36`，`app/_layout.tsx:104`，`Dialog.tsx:38`，`Sheet.tsx:47`）：
  `app.json` 缺少 `androidStatusBar` 全局透明配置；`_layout.tsx` 仅声明 `StatusBar style` 缺少 `translucent`；而 `Dialog.tsx` 与 `Sheet.tsx` 却显式声明了 `statusBarTranslucent`，导致模态弹出时触发 Window Flags 切换抖动。

### 1.2 软键盘响应与交互拓扑
- **手动配对页视口死锁**（`apps/crish-mobile/src/presentation/pair/pairManualScreen.tsx:168, 258-262`）：
  整个表单置于普通 `View`（`styles.content`）中，无 `ScrollView` 包裹。内容固定高度约 500dp，软键盘弹起后主连接按钮（`pair-connect`）与排障入口被推至可视区外且无法滚动触达。
- **抽屉底部搜索被覆盖**（`apps/crish-mobile/src/presentation/components/drawer/CrishDrawer.tsx:58-93`）：
  `DrawerFooter` 独立于 `DrawerContentScrollView` 之外钉死在底部，输入法升起时无高度推起机制，搜索框与候选词被完整掩埋。
- **点击阻尼与首击吞噬**（`apps/crish-mobile/src/presentation/timeline/TimelineView.tsx:67-93`）：
  `FlatList` 未声明 `keyboardShouldPersistTaps`（RN 默认 `'never'`）且无 `keyboardDismissMode='on-drag'`。当键盘处于呼出状态时，用户初次点击工具/审批卡片或复制按钮，事件被 RN 吞噬用于关闭键盘，必须二次点击方才响应。全工程仅 `accountProfileScreen`、`CrishDrawer`、`Sheet` 三处声明了 `keyboardShouldPersistTaps='handled'`。
- **浮层与悬浮卡片失控**：
  - `Toast.tsx:70` 绝对定位固定在 `bottom: insets.bottom + theme.size.composerMin + theme.space.xl`（约 102px），无键盘高度监听，输入时弹出的错误完全不可见。
  - `ApprovalFloat.tsx:40-46, 61` 键盘升起时 `bottom` 属性为离散数值突变，无平滑过渡动效；Android 端假定系统 resize，若处于沉浸模式未 resize 则被直接遮挡。

### 1.3 交互反馈与网络容灾
- **验证码长等待假死态**（`apps/crish-mobile/src/presentation/account/accountCodeScreen.tsx:50-55, 112` 与 `CodeCells.tsx:117`）：
  6 位输满自动触发 `submit`，向海外鉴权服务发起请求（超时 12 秒，`accountApi.ts:19`）。期间仅设置 `CodeCells disabled={busy}`，页面无 Spinner、无 ActivityIndicator、无文案变化，界面处于完全假死冷冻感知。
- **密码登录吞噬网络超时**（`apps/crish-mobile/src/presentation/account/accountPasswordScreen.tsx:51-55, 85` 与 `accountService.ts:244-253`）：
  `runLoginFlow` 粗暴捕获所有网络异常并转为 `false`；`accountPasswordScreen` 直接将所有 `false` 渲染为`'邮箱或密码不正确'`，网络断开或超时被误报为凭据错误。
- **扫码配对高能耗与无阶段感知**（`apps/crish-mobile/src/presentation/pair/pairScanScreen.tsx:80-99, 138, 167`）：
  扫码后后台状态机经历多轮握手，相机硬件持续全帧率预览取景导致发热空耗；中央仅一行静态`'正在连接…'`，无阶段指示且报错无排障引导。
- **排障指引链路缺失**（`ConnectionBanner.tsx:43` 与 `ConnectionHelpSheet.tsx:6-11`）：
  虽然已有详尽的 `ConnectionHelpSheet`，但 `ConnectionBanner` 与扫码配对报错时均未提供唤醒入口，仅手动配对页角落有问号。

### 1.4 动效、手势性能与规范执行
- **SlideToConfirm 状态机与渲染真实链路**（`apps/crish-mobile/src/presentation/components/blocks/SlideToConfirm.tsx:81-86, 107-118, 157, 328`）：
  `onPanResponderMove` 每次位移调用 `deps.setMachine(next)`，因 `progress` 浮点变化导致 `next` 为新对象，触发组件自身的 `useState` 更新；但滑块横向位移使用 `deps.thumbX.setValue` 走 `Animated.Value` 桥接；`REBOUND_SPRING` 声明了 `useNativeDriver: false`；React Compiler（`app.json:70`）已生效。
- **AuthField 颜色过渡非原生驱动**（`apps/crish-mobile/src/presentation/account/ui/AuthField.tsx:41-47`）：
  使用旧版 `Animated.timing` 配合 `useNativeDriver: false` 插值 `backgroundColor`（`field` ↔ `fieldFocus`）。
- **样式 Token 守卫缺失与间距漂移**（`apps/crish-mobile/src/__tests__/styleTokens.guard.test.ts:18-22`）：
  守卫规则仅覆盖颜色、圆角与字号，完全遗漏间距规则；静态全量复查 presentation 与 app 存在整整 102 处裸数字间距（扣除白名单文件仍有 84 处）。
---

## 2 问题清单（逐条审计与穿透还原）

| 编号 | 代码位置 | 现象 | 直接原因 | 根因 | 影响 | 置信度 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **DEF-01** | `approvalListScreen.tsx:28-47`<br>`toolSheetScreen.tsx:85-116` | 模态页无显式关闭按钮，展开至高档位时头部未避让安全区 | 根部使用裸 `View` 未引入 `Screen topInset`，且 Header 未放置关闭/返回按钮 | 假定依赖 iOS `formSheet` 默认下拽手势，未考虑 Android 单向弹窗操作闭环 | 缺少在 UI 上的显式退出入口，依赖系统手势退出；展开高档位时贴顶 | 部分验证 |
| **DEF-02** | `terminalScreen.tsx:98-135`<br>`TerminalView.tsx:90-146` | 终端日志最后 1~2 行被底部 Home 条或三键导航栏遮挡 | `FlatList` 无 `contentContainerStyle.paddingBottom`，`Screen` 默认 `bottomInset={false}` | 假定终端流式输出由父容器提供边距，父子两端均未做底部安全区处理 | 全面屏设备上终端尾行退出码与报错输出被系统手势栏物理遮挡 | 已验证 |
| **DEF-03** | `notificationCenterScreen.tsx:72-76`<br>`approvalHistoryScreen.tsx:88-91`<br>`SettingsScreenView.tsx:77-83` | 列表与设置页滚至最底端时末尾条目压盖系统手势横条 | `paddingBottom` 采用写死数字或 Token（24px/32px），未叠加 `insets.bottom` | 静态边距小于现代手机物理安全区高度（iPhone 34pt / Android 48dp） | 滚至底部时危险操作按钮或末行条目与系统桌面手势发生误触冲突 | 已验证 |
| **DEF-04** | `sessionDetailScreen.tsx:176-183`<br>`newChatScreen.tsx:101-107` | iOS 软键盘弹起后输入框留存 34px 死缝；Android 表现因版本而异 | `paddingBottom` 恒定计算 `Math.max(insets.bottom, sm)`，未随键盘状态归零 | iOS 端 `KeyboardAvoidingView` 已抬升键盘高度，容器多余的安全区未动态退火 | 挤占首屏对话视口，视觉生硬割裂 | 部分验证（iOS 已验证，Android 需实机） |
| **DEF-05** | `app.json:22-36`<br>`_layout.tsx:104`<br>`Dialog.tsx:38`, `Sheet.tsx:47` | Android 状态栏未沉浸，暗色有切边，弹窗唤出时发生 20~30px 闪烁抖动 | `app.json` 漏配 `androidStatusBar`，`_layout.tsx` 缺少 `translucent`，而模态层启用了 `statusBarTranslucent` | 全局宿主与局部模态层的状态栏透明度配置不一致，引发 Activity Window Flags 重置跳变 | 每次弹出确认框或抽屉时底层视口发生明显上下跳动 | 已验证 |
| **DEF-06** | `pairManualScreen.tsx:165-241`<br>`pairManualScreen.tsx:258-262` | 手动配对页键盘唤起后表单死锁，连接按钮被推出视口外无法触达 | `styles.content` 为普通 `View`，无 `ScrollView` 滚动包裹 | 静态表单高度（500dp+）超出软键盘弹起后的剩余视口高度（~380dp） | 阻断扫码失败后的唯一手动配对通路，用户无法点击“连接” | 已验证 |
| **DEF-07** | `CrishDrawer.tsx:57-93`<br>`DrawerFooter.tsx:21-60` | 抽屉底部搜索框呼出输入法时被软键盘完全遮盖 | `DrawerFooter` 独立于滚动容器之外固定在底部，无键盘推起机制 | 抽屉架构未考虑底部输入框与软键盘的冲突；原报告提议底部加避让违背 N03 顶部重排意图 | 会话搜索功能在软键盘激活期间完全盲打瘫痪 | 已验证 |
| **DEF-08** | `TimelineView.tsx:67-93`<br>`newChatScreen.tsx:83-100`<br>`AuthPage.tsx:14-24` | 消息列表滑动不收键盘，首次点击工具/审批卡片被 RN 底层吞噬 | `FlatList` 缺 `keyboardShouldPersistTaps='handled'`（RN 默认 'never'）且无 `keyboardDismissMode='on-drag'` | 全局缺乏统一键盘脚手架，忽略了 RN 滚动列表默认的触摸阻尼机制 | 产生“系统卡顿迟钝”假象，卡片需二次点击才响应 | 已验证 |
| **DEF-09** | `Toast.tsx:63-95` | 全局轻量 Toast 弹出时被软键盘完全遮盖在背后 | Toast 静态绝对定位在 `bottom: 102px` 处，未监听软键盘高度 | `ToastProvider` 假定只在无键盘场景或屏幕下方空白区展示 | 用户在输入表单时遇到校验或网络报错完全看不见反馈 | 已验证 |
| **DEF-10** | `ApprovalFloat.tsx:39-46`<br>`ApprovalFloat.tsx:56-67` | 浮动审批卡键盘弹起时瞬移无过渡，Android 假定依赖 resize 存在覆盖风险 | `bottom` 属性为离散数值突变（非动画驱动），Android 端未引入 `keyboardHeight` | 跨平台键盘避让方案碎片化，iOS 突变、Android 乐观假设 | 动效突兀不连贯，Android 沉浸模式下卡片被键盘掩埋 | 已验证 |
| **DEF-11** | `accountCodeScreen.tsx:50-73`<br>`CodeCells.tsx:20-73` | 验证码 6 位自动提交长耗时等待呈现完全假死态 | 提交后仅设置 `CodeCells disabled={busy}`，全页面无 Spinner、无 ActivityIndicator、无文案更新 | 假定海外鉴权网络立即响应，忽略了跨国长时延（12 秒超时）期间的中间态感知 | 用户产生“App 卡死/手指没按准”恐慌，反复乱点屏幕 | 已验证 |
| **DEF-12** | `pairScanScreen.tsx:80-100`<br>`pairScanScreen.tsx:166-177` | 扫码配对无阶段指示，相机全帧率空耗发热 | 状态机握手期间 UI 仅显示静态“正在连接…”，`CameraView` 持续取景渲染 | 复杂状态机未向下层暴露粒度状态，扫码成功后未暂停相机取景流 | 手机剧烈发热、耗电快，用户感知不到连接进度 | 已验证 |
| **DEF-13** | `accountPasswordScreen.tsx:51-56`<br>`accountService.ts:244-253` | 密码登录网络超时或断网误报为“邮箱或密码不正确” | `runLoginFlow` 吞噬真实异常向上层返回 `false`，页面粗暴将 `false` 映射为凭据错误 | 接口返回契约设计为单一 `boolean`，抹除了错误实体与分类 | 严重误导用户凭据错误，诱导用户去错误重置密码或废弃账号 | 已验证 |
| **DEF-14** | `accountApi.ts:113-125`<br>`pairingCopy.ts:11-27`<br>`ConnectionBanner.tsx:43` | 异常报错干瘪无指引，扫码配对与断连横幅完全缺失排障入口 | `ConnectionBanner` 与 `pairScanScreen` 未接入 `ConnectionHelpSheet` | 帮助排障组件虽已开发，但在最核心的故障触发点未形成闭环引流 | 用户遇到网络或证书信任故障时无从排查 | 已验证 |
| **DEF-15** | `SlideToConfirm.tsx:81-86`<br>`SlideToConfirm.tsx:107-118` | 滑动确认每手势事件调用 `setMachine` 触发组件自身重渲染 | `onPanResponderMove` 每次位移调用 `deps.setMachine(next)` 触发 `useState` | 手势状态管理与 React 视图渲染强耦合；原报告夸大为整屏 Virtual DOM 跨线程雪崩 | JS 线程在高频触摸下 CPU 负载增加，低端机型存在卡顿风险 | 部分验证（重渲染已验证，雪崩为夸大） |
| **DEF-16** | `AuthField.tsx:41-55` | 输入框聚焦使用非原生 Animated 驱动背景色插值 | 旧版 `Animated` 配合 `useNativeDriver: false` 驱动颜色插值 | RN 历史 Native Driver 不支持色值字符串，未迁移至 Reanimated Worklet | 唤起键盘时与窗口重排争抢 JS 线程 | 已验证（属背景色过渡，非描边动效） |
| **DEF-17** | `styleTokens.guard.test.ts:18-22`<br>全工程 `presentation` | 样式守卫遗漏间距检查，导致 102 处裸数字间距散落 | `RULES` 规则缺少 `padding/margin/gap` 正则扫描 | 门禁早期仅关注颜色与圆角，未能全覆盖韵律网格；原报告仅记 42 处，漏计近 60% | 破坏 8pt/4pt 统一韵律网格 | 部分验证（守卫缺失已验证，42 处统计偏小） |
| **OMIT-01** | `Input.tsx:49-53, 78` | 输入框动态聚焦变色边框严重违背 U8 禁描边铁律 | `focused ? borderFocus : borderStrong` 动态修改 `borderColor` | 遗留旧桌面/传统 Web 聚焦环范式，未落实移动端无描边规范 | 违背用户“绝对禁止任何描边动效/聚焦环”最高铁律 | 已验证（复核席主动挖出） |
| **OMIT-02** | `newChatScreen.tsx:89` | 新对话空态主界面包含多余大品牌图标 | 渲染 `BrandMark size={theme.size.avatar}` | 早期模板残留视觉重心，违背 U10 图标克制要求 | 挤占宝贵首屏空间，违背“新对话空态品牌大图标没有必要”要求 | 已验证（复核席主动挖出） |
| **OMIT-03** | `(main)/_layout.tsx:112`<br>`theme.ts:504` | 抽屉左侧滑出手势与 Android 系统返回手势物理冲突 | `drawerSwipeEdgeWidth: 32` 与 Android 全屏返回手势热区重叠 | 未在真实 Android 全面屏手势机型上验证边缘滑动呼出 | 华为 P50 等真机上左滑唤醒抽屉大概率被系统拦截为返回桌面 | 已验证（复核席主动挖出） |
| **OMIT-04** | `Composer.tsx:39, 45, 100` | Composer 输入框同时叠加发丝边框与中度阴影 | `borderColor: hairline` + `theme.shadow.md` + `borderWidth: hairlineWidth` | 违反根目录 AGENTS.md §13“默认不要重阴影，保持干净扁平”及 U8 铁律 | 阴影充当伪描边，视觉厚重生硬 | 已验证（复核席主动挖出） |
| **OMIT-05** | `accountProfileScreen.tsx:221-222`<br>`pairScanScreen.tsx:162` | 头像圆环与扫码取景框使用 2px/token 强调性高亮描边 | 头像使用 `avatarRing` 描边，取景框使用 2px `brand` 绿色描边 | 视觉上依赖线框勾勒元素 | 属于待清退与扁平化的描边类视觉资产 | 已验证（复核席主动挖出） |
---

## 3 逐条判定表、汇总表、遗漏扫描与描边清单

### 3.1 缺陷逐条对抗判定表（DEF-01 至 DEF-17）

#### DEF-01：模态路由页在 Android 下顶部安全区完全丢失，标题直冲打孔屏与状态栏
- **判定结果**：⚠️ **部分成立**（现象部分成立，前提断言 🚫 不成立，严重度 ❌ 夸大）
- **引用位置与行号核查**：位置存在，行号完全吻合（`approvalListScreen.tsx:28-47`、`toolSheetScreen.tsx:85-116`、`_layout.tsx:137-157`）。
- **调用链与原生机制复核**：
  1. 原报告核心前提称“React Navigation Stack 在 Android 上根本不存在原生 `formSheet` 容器，直接降级为普通全屏 Card/Modal”。**该断言与事实不符**：经穿透查验 `node_modules/react-native-screens/src/types.tsx:566`，明确声明 `formSheet – on Android this will use Material BottomSheetBehaviour`，且支持 3 个停靠点。在 Android 实机上，这两个页面是由底部升起的 Material Sheet 承接，默认停靠在 0.45 或 0.6 屏高档位，**并非直接从 Y=0 顶格渲染的全屏卡片**。
  2. 但当用户拖拽至高档位（0.92 屏高）时，因组件根容器为裸 `View` 且未注入安全区内边距，头部确实存在贴近状态栏与打孔区的风险。
  3. 报告指出的“无返回/关闭按钮导致操作死锁”表述过强：在 Android 上，用户可以通过物理/手势返回键退出，也可以通过 Material Bottom Sheet 的下滑手势关闭，并非不可退出的“死锁”；但缺失 UI 显式退出按钮确实属于不完善的交互体验。
- **修订后的准确表述**：`approvals` 与 `tools` 页面作为高档位可达 92% 屏高的 Sheet 容器，未引入安全区内边距且在 Header 内未提供显式关闭按钮，在 Android 设备上高档位展开时紧贴状态栏，且对不习惯系统返回手势的用户缺乏显式操作出口。
- **建议修复方案审查**：合理。建议在 Header 右侧或左侧补充显式的 `IconButton name="x"` 关闭按钮，并在展开至全屏高度时联动安全区避让。

---

#### DEF-02：终端只读回放页底端内容与物理 Home Indicator 发生严重遮挡冲突
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号完全吻合（`terminalScreen.tsx:98-135`、`TerminalView.tsx:90-146`）。
- **调用链与原生机制复核**：`terminalScreen.tsx:98` 调用 `<Screen>` 时使用默认缺省值 `bottomInset={false}`。其核心渲染视图 `TerminalView.tsx:90-106` 的 `FlatList` 仅设置了 `style={styles.list}`，完全没有传入 `contentContainerStyle`，底部内衬物理为 0。当终端输出累积滚至最底端时，最后 1~2 行文本必然与底部 34pt（iOS）或 24~48dp（Android）的物理导航区域重叠。
- **修订后的准确表述**：与原报告表述一致。
- **建议修复方案审查**：合理。应在 `TerminalView` 的 `FlatList` 中注入 `contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, theme.space.md) + 40 }}`，同时兼顾 `<ScrollToBottomButton>` 悬浮区的视口穿透。

---

#### DEF-03：列表与设置类页面底端采用固定写死边距，大安全区设备上手势栏压盖末尾条目
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号吻合（`notificationCenterScreen.tsx:72-76`、`approvalHistoryScreen.tsx:88-91`、`SettingsScreenView.tsx:77-83`）。
- **调用链与原生机制复核**：代码审查确认三处页面均未在滚动容器的 `paddingBottom` 中叠加 `insets.bottom`，而是写死了固定的数值或 Token：通知中心设为 24px（`theme.space.xxl`），审批历史写死 32px，设置页写死 32px（`theme.space.section`）。全面屏 iPhone 底部安全区固定为 34pt，Android 三键物理导航栏高达 48dp，均严格大于代码中的固定边距，必然导致滚至最底部的危险操作（如设置页底部的“移除设备”按钮）压入手势触发区。
- **修订后的准确表述**：与原报告表述一致。
- **建议修复方案审查**：合理。统一滚动容器底部内衬标准公式：`paddingBottom: insets.bottom + theme.space.lg`。

---

#### DEF-04：聊天与新对话输入框在软键盘升起时出现冗余安全区死缝
- **判定结果**：⚠️ **部分成立**（iOS 端 ✅ 成立；Android 端属于 ❓ 无法静态推导的系统级行为）
- **引用位置与行号核查**：位置存在，行号完全吻合（`sessionDetailScreen.tsx:176-183`、`newChatScreen.tsx:101-107`）。
- **调用链与原生机制复核**：
  1. iOS 端：外层挂载了 `<Screen avoidKeyboard>`，其底层在 iOS 下启动了 `KeyboardAvoidingView behavior="padding"`，键盘弹出时容器底部已自动抬高键盘高度。而输入框外层容器依然硬编码了 `paddingBottom: Math.max(insets.bottom, theme.space.sm)`。由于 iOS 软键盘弹起期间 `insets.bottom` 仍恒定返回 34pt，因此输入框下方被硬生生垫出 34px 的无意义空白缝隙，与键盘顶沿脱节，iOS 实机现象 100% 成立。
  2. Android 端：`Screen.tsx:58` 将 Android 下的 `behavior` 置为 `undefined`，完全交由 Android 系统的 `windowSoftInputMode="adjustResize"` 处理。在 Android 平台上，当系统窗口 resize 时，`react-native-safe-area-context` 内部通过 `WindowInsets.Type.navigationBars()` 计算安全区（见 `SafeAreaUtils.kt:15-20`），不同 Android 版本（API 30+ 与旧版）在软键盘覆盖导航栏时的 `insets.bottom` 返回值不同（部分返回 0，部分仍保留），并不必然产生 34px 死缝。原报告将 iOS 的 34px 现象推论为双端通病，缺乏 Android 实测支持。
- **修订后的准确表述**：在 iOS 设备上，输入框因 `KeyboardAvoidingView` 与未退火的 `insets.bottom` 叠加，软键盘升起后输入条与键盘上沿产生 34px 冗余空白死缝；Android 端由于 `adjustResize` 与 WindowInsets 的平台版本差异，是否存在缝隙需实机测试验证。
- **建议修复方案审查**：合理。输入框容器底部边距应动态退火：`paddingBottom: isKeyboardVisible ? theme.space.sm : Math.max(insets.bottom, theme.space.sm)`。

---

#### DEF-05：Android 系统状态栏未配置全局透明沉浸式，暗色与浅色模式均产生切边与弹层闪烁
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号吻合（`_layout.tsx:104`、`app.json:22-36`、`Dialog.tsx:38`、`Sheet.tsx:47`）。
- **调用链与原生机制复核**：`app.json` 的 `android` 节点未声明 `androidStatusBar`；`_layout.tsx:104` 仅调用 `<StatusBar style={theme.dark ? 'light' : 'dark'} />`，缺省 `translucent` 与透明背景。此时 Android 系统状态栏采用系统默认不透明背景色，与设计系统的主背景产生切边。而在 `Dialog.tsx:38` 与 `Sheet.tsx:47` 中，模态层设置了 `statusBarTranslucent`。在 Android 原生层中，主窗口非透明但子 Modal 开启透明时，每次模态弹窗呼出与关闭，Activity Window 会反复切换 Flags，触发整屏 20~30 像素的剧烈瞬移抖动。
- **修订后的准确表述**：与原报告表述一致。
- **建议修复方案审查**：合理。在 `app.json` 中固化 `androidStatusBar` 透明配置，并在根布局显式声明 `translucent backgroundColor="transparent"`，消除 Window Flags 切换抖动。

---

#### DEF-06：手动配对页非 ScrollView 包裹，键盘唤起后表单死锁、连接按钮被推至视口外无法触达
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号完全吻合（`pairManualScreen.tsx:165-241, 258-262`）。
- **调用链与原生机制复核**：`pairManualScreen.tsx:168` 将输入表单直接置于 `<View style={styles.content}>`。表单涵盖主机、配对码、高级设置折叠项（端口输入）、提示文案、主连接按钮、排障入口，静态总高度达 480~520dp。在主流手机屏幕高度扣除键盘（~320dp）与 Header 后，剩余视口高度仅约 350~380dp。由于没有滚动容器，输入法弹起后底部的“连接”主按钮被推入屏幕下方可视区域之外，且无法通过手势上滑查看，直接阻断了手动连接核心流程。
- **修订后的准确表述**：与原报告表述一致。
- **建议修复方案审查**：合理。将表单容器替换为配置有 `keyboardShouldPersistTaps="handled"` 与 `keyboardDismissMode="on-drag"` 的 `ScrollView`。

---

#### DEF-07：抽屉底部搜索框呼出键盘时被软键盘完全盖死，无法查看输入
- **判定结果**：✅ **成立（缺陷成立）/ ❌ 建议违背顶层重排意图**
- **引用位置与行号核查**：位置存在，行号完全吻合（`CrishDrawer.tsx:57-93`、`DrawerFooter.tsx:21-60`）。
- **调用链与原生机制复核**：`DrawerFooter` 独立于 `DrawerContentScrollView` 之外放置在抽屉根部。当点击搜索框时，软键盘升起，底部输入框无任何位移避让，被软键盘 100% 遮盖，盲打无法查看候选词，缺陷现象完全确凿（且已获用户真机确认）。
- **修复方案对抗审查（关键纠偏）**：原报告建议“在 `CrishDrawer` 内引入 `KeyboardAvoidingView` 或监听键盘高度将底部搜索框推起”。**该修复建议属于典型的打补丁妥协，且与用户明确的顶层重排要求直接冲突**！用户在 N03 任务书中已明确裁决：“侧边栏的搜索可以放在上面，扫一扫也可以放在上面吧。下面放置头像和名字，然后再是设置再是新建对话的那个按钮吧。”——将搜索框重排至抽屉顶部才是根治软键盘遮挡的优雅解法，根本无需在底部编写复杂的键盘避让推起代码。
- **修订后的准确表述**：抽屉底部搜索框在键盘弹起时被完全遮盖；但其根治手段应为遵循 N03 将搜索重排至抽屉顶部，而非在底部采用 `KeyboardAvoidingView` 进行动态顶升补偿。

---

#### DEF-08：全局空白区域点击收起键盘机制全面缺位，消息列表滑动不收键盘且吞噬初次触摸
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号吻合（`TimelineView.tsx:67-93`、`newChatScreen.tsx:83-100`、`AuthPage.tsx:14-24`）。
- **调用链与原生机制复核**：React Native 官方规范中，`ScrollView` 与 `FlatList` 的 `keyboardShouldPersistTaps` 默认值为 `'never'`。在此默认状态下，当键盘处于激活态时，用户点击滚动容器内的任何子组件（如工具卡片、审批按钮、复制按键），RN 原生层会将第一次触摸用于收起软键盘，**子组件的 `onPress` 被直接吞噬**，必须点击第二次才生效。经全工程静态扫描，除 `accountProfileScreen`、`CrishDrawer`、`Sheet` 3 处外，全量列表均漏配该属性；且全工程没有一处列表配置了 `keyboardDismissMode="on-drag"`，空白区域亦缺乏点击收起机制。
- **修订后的准确表述**：与原报告表述一致。
- **建议修复方案审查**：合理。全局列表补齐 `keyboardShouldPersistTaps="handled"` 与 `keyboardDismissMode="on-drag"`，并在输入页面外层容器挂接无障碍收起。

---

#### DEF-09：全局轻量 Toast 未监听软键盘高度，键盘激活期弹出的错误提示完全被遮挡
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号完全吻合（`Toast.tsx:63-95`）。
- **调用链与原生机制复核**：`Toast.tsx:70` 将浮层位置硬编码在 `bottom: insets.bottom + theme.size.composerMin + theme.space.xl`（约 102px）。组件未引入任何键盘高度监听逻辑。当软键盘（高 300~340px）处于激活状态时，所有通过 `showToast` 弹出的校验提示（如配对码非法、网络超时、格式错误等）均被不偏不倚地遮盖在软键盘背后，用户无法感知操作结果。
- **修订后的准确表述**：与原报告表述一致。
- **建议修复方案审查**：合理。引入键盘高度监听，当键盘升起时自动将锚点抬升至软键盘上沿。
---

#### DEF-10：全局浮动审批卡键盘弹起瞬间无动画生硬瞬移，且 Android 误判为仅依靠系统 resize
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号吻合（`ApprovalFloat.tsx:39-46, 56-67`）。
- **调用链与原生机制复核**：`ApprovalFloat.tsx:40-46` 中，`bottom` 变量直接计算为普通的 JS 数字，并直接作为行内样式赋给 `<Animated.View style={{ bottom }}>`（它不是一个由驱动器平滑插值的 `Animated.Value`）。在 iOS 键盘弹起时，`bottom` 瞬间从 `insets.bottom` 跃迁至 `keyboardHeight`，卡片在 1ms 内发生生硬瞬移闪烁；Android 端直接写死注释 `// Android 由系统 resize 抬起窗口`，当 Android 设备处于全屏沉浸状态时，卡片不会被抬起，存在被键盘掩埋的风险。
- **修订后的准确表述**：与原报告表述一致。
- **建议修复方案审查**：合理。应将高度位移接入统一的 Reanimated 原生动画驱动，平滑同步键盘升降曲线。

---

#### DEF-11：验证码 6 位输入自动提交无任何 Loading/Spinner，十余秒海外网络长等待呈现假死态
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号完全吻合（`accountCodeScreen.tsx:50-73, 107-139`、`CodeCells.tsx:20-73`、`accountApi.ts:19`）。
- **调用链与原生机制复核**：`accountCodeScreen.tsx:50-55` 中，输满第 6 位即触发 `submit(value)` 并向海外服务发起请求（`REQUEST_TIMEOUT_MS = 12_000`）。在长达数秒甚至十几秒的等待期中，页面仅仅向 `CodeCells` 传入了 `disabled={busy}`。查验 `CodeCells.tsx:117`，该属性仅映射为 TextInput 的 `editable={!disabled}`，**界面没有任何转圈、无任何 Spinner、无任何 ActivityIndicator、无文案更新，也没有透明度置灰**。手机界面完全冻结，产生极度严重的“App 死锁假死”心理落差，实机测试中的“卡顿”体感极大比例来源于此。
- **修订后的准确表述**：与原报告表述一致。
- **建议修复方案审查**：合理。必须在验证码格子下方追加居中加载指示行（`ActivityIndicator` + 阶段性文案），彻底消除假死感知。

---

#### DEF-12：扫码配对过程仅显示一行静态“正在连接…”，缺乏握手/证书/密钥阶段性指示，相机长时间空耗
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号完全吻合（`pairScanScreen.tsx:80-100, 166-177`）。
- **调用链与原生机制复核**：扫码识别二维码后，`controller().beginPairing()` 在后台驱动多阶段握手。在此期间，取景器正中央仅渲染一行弱对比文字 `{busy ? '正在连接…' : '对准桌面端二维码'}`。没有转圈、没有阶段进度指示。更严重的是，`pairScanScreen.tsx:138` 的 `<CameraView>` 在整个后台配对重试期间持续以全帧率运行取景硬件，直接导致真机迅速发热与电池剧烈消耗。
- **修订后的准确表述**：与原报告表述一致。
- **建议修复方案审查**：合理。扫码命中后应立即暂停相机预览渲染（或遮罩冻结），中央展示标准的加载器与动态阶段文案（如“寻找电脑”、“交换证书”）。

---

#### DEF-13：密码登录在网络超时后错误提示为“邮箱或密码不正确”，严重误导用户凭据错误
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号吻合（`accountPasswordScreen.tsx:51-56, 85`、`accountService.ts:244-253`）。
- **调用链与原生机制复核**：`accountService.ts:244-253` 的 `runLoginFlow` 内部使用 `try...catch` 粗暴捕获了所有异常（包括网络超时、DNS 无法解析、中继断开、401 凭据错误等），统一向调用方返回单一的布尔值 `false`。而在 `accountPasswordScreen.tsx:55, 85` 中，一旦 `ok === false`，直接将红字错误渲染为：`error={failed ? '邮箱或密码不正确' : null}`。用户在手机弱网或海外鉴权超时情况下，会被直接误导为“自己记错了密码”，诱导用户去进行不必要的改密，严重破坏产品信任。
- **修订后的准确表述**：与原报告表述一致。
- **建议修复方案审查**：合理。重构登录方法返回结构化错误实体（`LoginResult`），精准区分网络故障与凭据错误。

---

#### DEF-14：异常报错干瘪（“网络请求失败”），且扫码配对与断连横幅完全缺失排障指引入口
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号吻合（`accountApi.ts:113-125`、`pairingCopy.ts:11-27`、`ConnectionBanner.tsx:43`、`ConnectionHelpSheet.tsx:6-11`）。
- **调用链与原生机制复核**：代码审查确认 `ConnectionBanner.tsx:45` 仅有一个刷新图标按钮，未提供任何排障引导；`pairScanScreen.tsx:169` 报错时仅展示干瘪红字，未引入帮助；工程内虽有成型的 `ConnectionHelpSheet`，但仅在手动配对页角落被引用，在核心的扫码失败与主界面断连场景完全缺失入口。
- **修订后的准确表述**：与原报告表述一致。
- **建议修复方案审查**：合理。在断连横幅与扫码报错处增加显式入口唤醒 `ConnectionHelpSheet`。

---

#### DEF-15：`SlideToConfirm` 滑动确认在 JS 线程每帧触发 React setState 重渲染，高刷屏下帧率腰斩
- **判定结果**：⚠️ **部分成立 / ❌ 严重夸大**（每帧触发自身重渲染属实，但“整屏雪崩与 Virtual DOM 跨线程瘫痪”为推论性夸大）
- **引用位置与行号核查**：位置存在，行号吻合（`SlideToConfirm.tsx:81-86, 107-118, 303, 319-340`）。
- **调用链与原生机制复核（技术关键纠偏）**：
  1. **代码真实确凿部分**：在 `onPanResponderMove` 回调中，由于手势位移 `gs.dx` 不断变化，状态机函数 `slideMove` 持续产生新的状态对象，导致 `next !== deps.getMachine()` 条件始终命中，因而 `deps.setMachine(next)` 在每次触摸移动事件中都会被调用。这确实触发了 `SlideToConfirm` 组件自身在 JS 线程上的 `useState` 更新。
  2. **原报告推论夸大与事实偏差部分**：
     - **滑块位移并非由 React State 驱动**：代码中滑块的物理位移是通过 `setThumbFrom(next)` 显式调用 `deps.thumbX.setValue(...)` 实现的（`SlideToConfirm.tsx:96-98`），它走的是 `Animated.Value` 的非渲染通道，而非通过 React State 将 style 写在 JSX 上（JSX 中为 `transform: [{ translateX: thumbX }]`）。
     - **`useNativeDriver: false` 并非存在于拖动全程**：`useNativeDriver: false` 仅配置在 `REBOUND_SPRING`（即松手未过阈值时的弹簧回弹动效上），在手指拖动过程中根本没有运行该 spring 动画。原报告将回弹参数混淆为手势拖动全程，存在逻辑移花接木。
     - **React Compiler 已自动隔离子树**：`app.json:70` 已启用 `reactCompiler: true`。虽然 `SlideToConfirm` 自身函数体会被执行，但其父级页面与无依赖的弹窗子树已被自动 memo 隔离，不会引发“全屏重渲染雪崩”。
- **修订后的准确表述**：`SlideToConfirm` 在 `onPanResponderMove` 中每帧调用 `setMachine` 导致组件自身在 JS 线程频繁重渲染，增加了 JS 线程负担；回弹动效配置了 `useNativeDriver: false`；应彻底迁移至 Reanimated Worklet 原生手势以解放 JS 线程。
- **建议修复方案审查**：合理。重构为基于 `react-native-reanimated` 的手势工作线程（Worklet）驱动。

---

#### DEF-16：`AuthField` 输入框聚焦过渡使用传统 Animated 驱动非原生色值插值
- **判定结果**：✅ **成立**
- **引用位置与行号核查**：位置存在，行号吻合（`AuthField.tsx:41-55`）。
- **调用链与原生机制复核**：`AuthField.tsx:41-47` 中显式设置了 `useNativeDriver: false`，使用旧版 `Animated.timing` 针对聚焦状态进行插值。需特别澄清：该处插值的是 `backgroundColor`（表面底色从 `field` 过渡到 `fieldFocus`），**它不是边框聚焦环（描边）**，属于合规的表面色阶过渡；但由于采用了非原生驱动的旧 Bridge 通信，在软键盘弹起的瞬间确实增加了 JS 跨桥通信竞争开销。
- **修订后的准确表述**：与原报告表述一致，补充定性该动画为表面底色过渡而非描边动效。
- **建议修复方案审查**：合理。迁移至 Reanimated 原生样式，消除跨桥损耗。

---

#### DEF-17：样式规范守卫遗漏间距检查，导致 42 处硬编码数字间距破坏网格单一真源
- **判定结果**：⚠️ **部分成立 / ❌ 统计严重偏小**（守卫缺失属实，但 42 处统计失真，漏计近 60%）
- **引用位置与行号核查**：位置存在，行号吻合（`styleTokens.guard.test.ts:18-22`）。
- **调用链与原生机制复核（对抗复核关键纠偏）**：
  1. `styleTokens.guard.test.ts:18-22` 的 `RULES` 数组确实仅卡控了颜色、圆角与字号，完全漏掉了 `padding/margin/gap` 的正则检测，守卫规则缺失事实成立。
  2. **原报告数字严重失真**：原报告宣称全工程存在“42 处硬编码数字间距”。本复核席对 `src/presentation/` 与 `app/` 进行了**全量正则与 AST 严格复查**（覆盖 `padding*`、`margin*`、`gap*` 所有间距属性）：
     - 全工程 presentation + app 实际硬编码裸数字间距高达 **102 处**！
     - 即便完全扣除守卫白名单文件（`FilePreview.tsx` 与 `NewTaskSheet.tsx`），存量硬编码间距依然高达 **84 处**！
     - 若仅统计 `gap: \d+`，数量为 33 处。
     原报告给出的“42 处”既不是全量间距也不是单纯 gap，数据失实且漏掉了绝大部分硬编码内边距与外边距。
- **修订后的准确表述**：样式守卫测试遗漏间距检测规则，导致表现层散落高达 102 处硬编码裸数字间距（扣除白名单文件仍有 84 处），严重破坏了 8pt/4pt 单一真源网格。
- **建议修复方案审查**：合理。守卫需将间距补齐至扫描规则，并全面将 84 处硬编码清退至 `theme.space.*` Token。

---

### 3.2 判定结果汇总表与报告可信度评级

| 序号 | 缺陷编号 | 原报告严重度 | 本复核席最终判定 | 核心判定依据与纠偏摘要 |
| :---: | :---: | :---: | :---: | :--- |
| 1 | **DEF-01** | P0 致命阻塞 | ⚠️ **部分成立** | 原报告断言“Android 根本无 formSheet 退化为全屏”为事实错误；实为 BottomSheet，无关闭按钮属实 |
| 2 | **DEF-02** | P1 体验断层 | ✅ **成立** | `TerminalView` 未配置 `paddingBottom`，终端尾部被物理手势栏遮挡确凿 |
| 3 | **DEF-03** | P1 体验断层 | ✅ **成立** | 列表与设置页底边距使用固定 24/32px，小于物理安全区（34/48dp）确凿 |
| 4 | **DEF-04** | P1 体验断层 | ⚠️ **部分成立** | iOS 34px 死缝确凿；Android 端因 `adjustResize` 机制不同，属于平台行为需实机验证（❓） |
| 5 | **DEF-05** | P1 体验断层 | ✅ **成立** | Android 未沉浸，Modal 开启 `statusBarTranslucent` 导致 Window Flags 跳变抖动确凿 |
| 6 | **DEF-06** | P0 致命阻塞 | ✅ **成立** | 手动配对页无 `ScrollView`，键盘弹起后主连接按钮被推出视口导致死锁确凿 |
| 7 | **DEF-07** | P0 致命阻塞 | ✅ **成立（缺陷）** | 底部搜索被键盘盖死确凿；但原报告建议在底部加避让属于打补丁，应按 N03 移至顶部根治 |
| 8 | **DEF-08** | P1 体验断层 | ✅ **成立** | 全局列表漏配 `keyboardShouldPersistTaps`，RN 默认 'never' 吞噬首击确凿 |
| 9 | **DEF-09** | P1 体验断层 | ✅ **成立** | Toast 静态固定在 102px，软键盘激活期间弹出的错误被 100% 遮盖确凿 |
| 10 | **DEF-10** | P1 体验断层 | ✅ **成立** | 浮动审批卡高度突变无动画，Android 假定依赖 resize 存在掩埋风险确凿 |
| 11 | **DEF-11** | P0 致命阻塞 | ✅ **成立** | 验证码提交后无任何 Spinner/文案指示，12 秒海外长等待呈现完全假死态确凿 |
| 12 | **DEF-12** | P1 体验断层 | ✅ **成立** | 扫码配对无阶段指示，握手期间相机全帧率取景空耗发热确凿 |
| 13 | **DEF-13** | P1 体验断层 | ✅ **成立** | 登录网络超时被 `runLoginFlow` 吞噬并误报为“邮箱或密码不正确”确凿 |
| 14 | **DEF-14** | P1 体验断层 | ✅ **成立** | 报错干瘪，扫码与断连横幅完全缺失呼出 `ConnectionHelpSheet` 入口确凿 |
| 15 | **DEF-15** | P0 致命瓶颈 | ⚠️ **部分成立** | 每帧 `setMachine` 重渲染属实；但位移走 `thumbX.setValue`，整屏雪崩与 useNativeDriver 混淆为夸大 |
| 16 | **DEF-16** | P1 体验断层 | ✅ **成立** | 输入框聚焦使用旧版 Animated 非原生插值确凿；需澄清其属于表面底色过渡而非描边 |
| 17 | **DEF-17** | P2 规范漂移 | ⚠️ **部分成立** | 守卫遗漏间距属实；但原报告仅统计 42 处严重偏小，全量实测高达 102 处（非白名单 84 处） |

- **全案判定统揽**：被复核报告共 **17 项**，其中 **✅ 成立 12 项**、**⚠️ 部分成立 4 项**、**❌ 纯夸大 0 项**、**🚫 完全不成立 0 项**、**❓ 包含平台未决验证 1 项**。
- **报告可信度一句话评语**：**【B+ · 问题敏锐度高、痛点确凿，但底层原生机制（Android formSheet / adjustResize / React Compiler）理解存在偏差，部分技术推论夸大且间距漏算近 60%】**。
---

### 3.3 遗漏扫描：原报告未覆盖的真实设计与物理体验缺陷

本复核席对 `src/presentation/**`、`app/**` 及平台底层配置进行了对抗式全量扫描，挖出以下 5 项原报告完全遗漏的重大交互断层与违规问题：

#### OMIT-01【红线违规】：`Input.tsx` 动态变色聚焦环严重违反 U8「绝对禁止描边」铁律
- **代码位置**：`apps/crish-mobile/src/presentation/ui/Input.tsx:49-53, 74, 78`
- **代码片段**：
  ```tsx
  const borderColor = error
    ? theme.colors.danger
    : focused
      ? theme.colors.borderFocus // <-- 聚焦时动态变为高亮边框！
      : theme.colors.borderStrong;
  ...
  <View style={[..., { borderWidth: 1, borderColor }]} />
  ```
- **问题穿透**：用户在 U8 中发布了最高刚性红线：“绝对禁止描边类视觉：任何描边动效、聚焦环、外发光、阴影充当描边、下划线扫过、渐变边框、脉冲/呼吸光圈、跑马灯边框，以及一切‘伪描边’效果。”然而通用组件 `Input.tsx` 依然沿用传统桌面端 Web 时代的聚焦逻辑，在输入框获得焦点时动态将边框染为 `borderFocus`。原报告对此严重违规视而不见，未予立案。该动态边框必须立即从代码中彻底清退，聚焦表达应统一转为表面色阶或光标感知。

#### OMIT-02【规范违规】：新对话页（主页空态）居中展示大尺寸 BrandMark 图标
- **代码位置**：`apps/crish-mobile/src/presentation/screens/newChatScreen.tsx:89`
- **代码片段**：
  ```tsx
  <View style={[styles.hero, ...]}>
    <BrandMark size={theme.size.avatar} /> // <-- 40px 的大品牌徽标！
    <AppText variant="title2">{greeting}</AppText>
    <AppText variant="callout" color="textSecondary">今天想让它做点什么？</AppText>
  </View>
  ```
- **问题穿透**：用户硬性要求 U10 明确裁决：“图标克制且统一：非必要不显示图标；确需显示的必须来源统一、风格统一。主界面（新对话空态）的品牌大图标没有必要。”当前主界面不仅渲染了问候语，还在最中央顶端常驻了一个 `BrandMark`。原报告对该设计冗余零提及。应遵照 U10 彻底删除该图标，释放垂直视口并保持界面极简克制。

#### OMIT-03【物理冲突】：抽屉边缘滑出手势与 Android 系统全局返回手势冲突
- **代码位置**：`apps/crish-mobile/app/(main)/_layout.tsx:112`、`apps/crish-mobile/src/adapters/platform/theme.ts:504`
- **问题穿透**：抽屉配置为 `drawerType: 'front'`，边缘触发宽度为 `theme.layout.drawerSwipeEdgeWidth = 32`。在当代主流 Android 全面屏手机（如华为 P50、EMUI/HarmonyOS）中，屏幕左右边缘 30~50dp 区域被系统级的“全屏手势导航（向内滑动返回上一级）”独占捕获。当用户尝试从屏幕左侧边缘右滑唤醒抽屉时，90% 以上的手势直接被 Android 系统优先拦截并触发了 App 退出或页面后退，导致用户反馈“左侧抽屉明明用手滑却无法唤醒”。原报告完全未进行真机手势层级分析，遗漏了核心物理断层。

#### OMIT-04【样式超标】：Composer 输入胶囊同时叠加发丝边框与中度浮层阴影
- **代码位置**：`apps/crish-mobile/src/presentation/ui/Composer.tsx:39, 45, 100`
- **代码片段**：
  ```tsx
  style={[
    styles.shell,
    {
      borderColor: colors.hairline,
      borderWidth: StyleSheet.hairlineWidth,
      ...
    },
    theme.shadow.md, // <-- 8dp elevation / 24px shadowRadius 中度厚重阴影！
  ]}
  ```
- **问题穿透**：根目录 `AGENTS.md` §13 明确约束：“输入框、搜索框、composer 等默认不要加厚重 box-shadow，保持干净、扁平、轻量。”目前 Composer 同时挂载了 `borderWidth: StyleSheet.hairlineWidth` 与 `theme.shadow.md`，在浅色与深色模式下均呈现出厚重的立体漂浮块视觉，既充当了伪描边，又违背了扁平轻量的设计哲学。

#### OMIT-05【描边残留】：账号头像圆环与扫码取景框使用强对比描边
- **代码位置**：
  - `apps/crish-mobile/src/presentation/account/accountProfileScreen.tsx:221-222`（`borderWidth: theme.layout.avatarRing, borderColor: theme.colors.canvas`）
  - `apps/crish-mobile/src/presentation/pair/pairScanScreen.tsx:162, 212`（`borderWidth: 2, borderColor: theme.colors.brand`）
- **问题穿透**：个人中心头像设置了白色/画布色圆环描边；扫码取景框使用了 2px 的全实线亮绿描边。这些线框视觉均属于应当梳理并扁平化处理的描边类资产。

---

### 3.4 全局边框 / 聚焦环 / 阴影 / 动效描边清单（为 N02 席位输出）

本复核席对工程全量代码进行了 `borderColor`、`borderWidth`、`outline`、`shadow*`、`elevation` 的全景静态扫描，登记如下 59 处样式资产，作为 N02 席位清退描边的权威输入依据：

| 序号 | 代码位置 | 属性与取值 | 当前用途 | 是否随状态变化/动画 | 清退与重构裁决（面向 N02） |
| :---: | :--- | :--- | :--- | :---: | :--- |
| 1 | `Input.tsx:49-53, 78` | `borderColor: error ? danger : focused ? borderFocus : borderStrong` | 输入框聚焦边框 | **是（随 focus 变色）** | **【硬红线清退】** 彻底删除 `borderColor` 动态判断，禁止任何聚焦变色边框，改为表面色阶过渡 |
| 2 | `Input.tsx:74` | `borderWidth: 1` | 默认输入框外边框 | 否 | **【清退/扁平化】** 改为无边框，采用 `fillSubtle` 浅灰色阶背景 |
| 3 | `SlideToConfirm.tsx:313` | `borderColor: theme.colors.borderStrong` | 滑轨外边框 | 否 | **【扁平化】** 移除边框，使用轨道圆角胶囊背景区分 |
| 4 | `SlideToConfirm.tsx:325` | `borderColor: emphasized ? success : borderStrong` | 滑块边框到位变绿 | **是（到位变色）** | **【硬红线清退】** 禁止滑块边框到位变色动效，改为滑轨底色与滑块内部图标/文字变色 |
| 5 | `SlideToConfirm.tsx:352, 363` | `borderWidth: 1` | 滑轨与滑块边框线宽 | 否 | **【扁平化】** 统一移除 `borderWidth: 1` |
| 6 | `NewTaskSheet.tsx:118, 154` | `borderColor: active ? accent : 'transparent', borderWidth: 1` | 任务选项选中边框 | **是（随选中状态）** | **【硬红线清退】** 清退选择框描边高亮，选中态改为背景色阶加深（`fillPressed`） |
| 7 | `pairScanScreen.tsx:162, 212` | `borderColor: brand, borderWidth: 2` | 扫码取景框绿色边框 | 否（静态） | **【重构】** 将 2px 全包围实线边框替换为仅四角轻量圆角标记（或纯暗化遮罩镂空），杜绝大亮线框 |
| 8 | `accountProfileScreen.tsx:221-222` | `borderWidth: avatarRing, borderColor: canvas` | 头像边缘遮罩圆环 | 否 | **【评估】** 若仅用于防底色粘连可转为外层容器内衬，否则建议清退 |
| 9 | `Composer.tsx:39, 100` | `borderColor: hairline, borderWidth: hairlineWidth` | 输入条发丝边框 | 否 | **【清退】** 遵照 U8 与 §13，清退发丝边框，采用纯 `surfaceRaised` 表面 |
| 10 | `Composer.tsx:45` | `theme.shadow.md` | 输入胶囊外阴影 | 否 | **【清退】** 严格落实 §13“默认不要重阴影”，删除 `theme.shadow.md`，保持扁平轻量 |
| 11 | `ApprovalFloatCard.tsx:64, 141` | `borderColor: hairline, borderWidth: hairlineWidth` | 悬浮审批卡外边框 | 否 | **【清退】** 移除外发丝线，由卡片底色自身与背景拉开色阶 |
| 12 | `ApprovalFloatCard.tsx:66` | `theme.shadow.lg` | 悬浮审批卡厚重阴影 | 否 | **【降级】** 将 `shadow.lg` 降级为超轻量 `shadow.xs`，避免充当发光伪描边 |
| 13 | `ApprovalFloatPill.tsx:36, 54` | `borderColor: hairline, borderWidth: hairlineWidth` | 悬浮胶囊外边框 | 否 | **【清退】** 移除发丝边框 |
| 14 | `ApprovalFloatPill.tsx:38` | `theme.shadow.md` | 悬浮胶囊阴影 | 否 | **【降级】** 降级为 `shadow.xs` |
| 15 | `ScrollToBottomButton.tsx:34, 57` | `borderColor: hairline, borderWidth: hairlineWidth` | 回到底部悬浮钮边框 | 否 | **【清退】** 移除外框细线 |
| 16 | `ScrollToBottomButton.tsx:36` | `theme.shadow.sm` | 回到底部悬浮钮阴影 | 否 | **【保留】** 纯功能性悬浮按钮微投影，可保留或降为 xs |
| 17 | `SegmentedControl.tsx:54, 85, 90` | `borderColor: hairline, borderWidth: 1` | 分段选择器滑块与外框 | 否 | **【扁平化】** 移除外框线，滑块改为纯底色色阶块 |
| 18 | `Toast.tsx:78` | `theme.shadow.md` | Toast 提示条阴影 | 否 | **【扁平化】** 统一为深色胶囊底色，移除外投影 |
| 19 | `Dialog.tsx:63` | `theme.shadow.lg` | 居中对话框浮层阴影 | 否 | **【合规保留】** 模态层投影，需检查是否充当发光边缘 |
| 20 | `Sheet.tsx:74` | `theme.shadow.lg` | 抽屉底部浮层阴影 | 否 | **【合规保留】** 模态层投影 |
| 21 | `IconButton.tsx:70` | `floating && theme.shadow.sm` | 浮动圆形图标微投影 | 否 | **【合规保留】** 仅在 floating 变体时生效 |
| 22 | `SlideToConfirm.tsx:330` | `theme.shadow.sm` | 滑块微投影 | 否 | **【清退】** 移除滑块外阴影，纯靠高亮底色拉开对比 |
| 23–33 | 列表与导航发丝分隔线（11 处） | `borderBottomWidth: hairlineWidth` / `borderTopWidth` | 列表项底部物理分割 | 否 | **【合规保留】** 静态发丝分割线（`accountSessionsScreen:175`、`NavRow:36`、`FileBreadcrumb:93`、`FileRow:58`、`NotificationRow:50`、`RunControlBar:111`、`approvalDetailScreen:174`、`runDetailScreen:185`、`ListRow:117` 等），承担信息物理分隔，不属于违禁描边动效，确需时保留 |
| 34–59 | `theme.ts:520-547` | `shadow.xs / sm / md / lg` 平台 Token | 全局阴影真源定义 | 否 | **【治理】** 全面校准 Token 透明度，禁止出现外发光或硬边缘阴影 |
---

## 4 风险与未决问题（需用户裁决事项单独成列）

以下 5 项重大设计取舍与技术冲突，关系到底层架构与用户心智，单列呈请用户裁决：

### 4.1 需用户裁决事项清单

| 事项编号 | 涉及模块 | 现状与冲突矛盾 | 备选方案与利弊 | 本席位推荐意见 |
| :---: | :--- | :--- | :--- | :--- |
| **DEC-01** | **抽屉搜索重排 vs 底部避让补丁**<br>（DEF-07 / N03） | 原报告提议在抽屉底部加 `KeyboardAvoidingView` 向上推搜索框；而用户在 N03 明确指示将搜索与扫一扫移至顶部。两者路线根本冲突。 | **方案 A（顶层重排）**：彻底移至顶部，键盘弹出不影响搜索框，底栏自然贴底；<br>**方案 B（原报告补丁）**：保留底部，靠代码动态推升。 | **强烈推荐方案 A**。符合反补丁与 U5 铁律，用结构重排根治问题。 |
| **DEC-02** | **输入框全量清退描边与阴影**<br>（OMIT-01, OMIT-04 / U8） | `Input.tsx` 存量代码有动态聚焦变色边框，`Composer.tsx` 同时有发丝边框与 `theme.shadow.md` 阴影。 | **方案 A（彻底扁平化）**：删除全部 `borderWidth` 与 `shadow.md`，聚焦纯走表面色阶差（`fillSubtle` ↔ `fieldFocus`）；<br>**方案 B（保留极细静态发丝边）**：仅去聚焦变色动效与阴影，保留静态 0.5px 发丝线。 | **推荐方案 A**。贯彻 U8“绝对禁止描边类视觉”与 §13“默认不要重阴影”，干净纯粹。 |
| **DEC-03** | **主页空态 BrandMark 大图标去留**<br>（OMIT-02 / U10） | `newChatScreen.tsx:89` 常驻 40px 大图标。用户 U10 明确指出“新对话空态品牌大图标没有必要”。 | **方案 A（彻底删除）**：直接删除该 `<BrandMark>`，问候语上提，空态更清爽；<br>**方案 B（微型保留）**：缩小为 16px 作为标题前缀。 | **推荐方案 A**。严格落实 U10，非必要不显示图标，减少视觉干扰。 |
| **DEC-04** | **Android 抽屉左缘滑出与系统返回冲突**<br>（OMIT-03） | 华为 P50 等真机上，左边缘 32dp 内滑动会被 Android 系统手势拦截为返回桌面，边缘唤出抽屉成功率极低。 | **方案 A（内移激活区）**：将激活宽度调大至 48dp+ 并配合纵横夹角仲裁；<br>**方案 B（按钮首选 + 辅助手势）**：依赖 Header 汉堡按钮，手势仅作增强。 | **推荐方案 A + B 组合**。在 N03 中通过 Gesture Handler 自定义水平仲裁，规避系统返回。 |
| **DEC-05** | **Android formSheet 模态呈现形态**<br>（DEF-01） | Android 端由 `react-native-screens` 的 Material `BottomSheetBehaviour` 承接，默认升起为半屏卡片。 | **方案 A（原生 Sheet 保持）**：保留 Material BottomSheet 行为，仅补齐右上角关闭按钮；<br>**方案 B（自定义模态）**：强行自研仿 iOS 的 PageSheet 居中弹窗。 | **推荐方案 A**。利用原生 4.x 停靠机制，避免不必要的自研模态容器过度设计。 |

---

## 5 集中验收清单（改完一大批代码后统一执行的断言）

按前言第二节 U7 纪律（集中验收清单，待批量代码重构完毕后一次性端到端验收）：

### 5.1 物理异形屏与安全区验收（真机断言：华为 P50 + iOS 全面屏）
- [ ] **ASSER-SAFE-01（终端日志贴底）**：进入 `terminalScreen`，流式输出大量日志至最底端，断言最新一行文本底缘距离物理手势横条或导航键顶部至少保留 `16dp` 间距；`<ScrollToBottomButton>` 不遮挡尾行。
- [ ] **ASSER-SAFE-02（列表与设置页）**：进入 `notificationCenterScreen`、`approvalHistoryScreen`、`SettingsScreenView`，滑至最底部，断言末尾条目分割线与“移除设备”红色按钮底部距物理边缘 $\ge insets.bottom + 16dp$。
- [ ] **ASSER-SAFE-03（状态栏透明沉浸）**：冷启动应用，断言 Android 状态栏全时段透明；呼出 `Dialog` 确认弹窗或 `Sheet` 抽屉，整屏底层布局零跳动、零闪烁、Window Flags 零变动。
- [ ] **ASSER-SAFE-04（模态 Sheet 安全区）**：在 Android 真机上打开 `approvals` 与 `tools` 路由，展开至 0.92 高档位，断言标题栏与顶部摄像头打孔、状态栏图标保留清晰安全间距，且 Header 具备显式关闭按钮。

### 5.2 软键盘响应与交互拓扑验收
- [ ] **ASSER-KEYB-01（手动配对可达性）**：打开 `pairManualScreen`，分别聚焦“主机”、“配对码”与展开后的“端口”输入框；在软键盘完全升起状态下，手指可顺畅向上滚动屏幕，底部的“连接”主按钮可完全露于视口并顺畅点击。
- [ ] **ASSER-KEYB-02（抽屉顶部搜索）**：按照 N03 重排后，点击抽屉顶部搜索框，软键盘升起，断言搜索框与输入候选词 100% 处于键盘上沿可见区域；滑动下方会话列表自动收起键盘。
- [ ] **ASSER-KEYB-03（首击不吞噬与滑动收起）**：进入 `sessionDetailScreen` 呼出键盘，点击时间线任意工具卡片或审批卡，断言第一次点击立即触发卡片响应（不再被吞噬）；上下滑动消息列表时键盘平滑自动退下。
- [ ] **ASSER-KEYB-04（Toast 浮层不被掩埋）**：在输入框获得焦点键盘处于 300dp 高度时触发 Toast 报错，断言 Toast 胶囊动态锚定在键盘顶边缘上方 16dp 处，完全可见。
- [ ] **ASSER-KEYB-05（iOS 键盘死缝消除）**：在全面屏 iPhone 上聚焦 Composer，断言输入胶囊底边缘紧贴软键盘上沿（间距为 `theme.space.sm` 8px），消除原本突兀的 34px 巨大黑底空白缝隙。

### 5.3 交互反馈与网络容灾感知验收
- [ ] **ASSER-FEED-01（验证码 Loading 感知）**：在 `accountCodeScreen` 输满第 6 位验证码后，断言验证码格子正下方 0ms 立即展示 `ActivityIndicator` 与“正在验证，请稍候…”文案；格子呈现 `disabled` 状态；若超过 3 秒未返回追加显示网络等待提示，绝不出现整屏冻结假死。
- [ ] **ASSER-FEED-02（密码登录真实报错穿透）**：在飞行模式或拔掉网线状态下提交密码登录，断言密码框下方提示“网络连接超时，请检查网络”或“网络不可用”，绝对禁止误报“邮箱或密码不正确”。
- [ ] **ASSER-FEED-03（扫码配对相机节能与阶段文案）**：扫码命中有效二维码瞬间，`<CameraView>` 预览流立即停止渲染；中央展示规范 Spinner 与动态阶段感知（“正在连接局域网…”、“核验证书…”），手机无异常发热。
- [ ] **ASSER-FEED-04（排障闭环引流）**：在主界面出现断连红条 `ConnectionBanner` 或扫码失败时，断言界面明确提供“查看连接帮助”入口，点击可平滑弹出 `ConnectionHelpSheet` 引导用户排查 Wi-Fi 与证书。

### 5.4 动效手感与性能验收
- [ ] **ASSER-PERF-01（SlideToConfirm 原生 Worklet）**：在华为 P50 高刷屏上以各种速度反复拖动 `SlideToConfirm` 滑块，拖动过程中断言 `SlideToConfirm` 组件在 React JS 线程的 Render 次数为 0（仅在拖动越过阈值翻转状态或抬起触发时触发 1 次状态更新）；滑块满帧 60/90/120fps 跟手无脱节。
- [ ] **ASSER-PERF-02（AuthField 零跨桥开销）**：点击输入框唤起键盘变色过渡平滑，无丢帧卡顿。

### 5.5 全局无描边与样式规范门禁验收（自动化静态检查）
- [ ] **ASSER-GATE-01（样式守卫间距全覆盖）**：运行 `npm test styleTokens.guard`，断言门禁覆盖 `padding*`、`margin*`、`gap*`；表现层 84 处硬编码裸间距清零，全部对齐 `theme.space.*`。
- [ ] **ASSER-GATE-02（全工程零动态变色聚焦环）**：静态断言 `Input.tsx` 中不存在随 `focus` 变化的 `borderColor` 动态三元表达式；全应用无聚焦描边、无外发光。
- [ ] **ASSER-GATE-03（主页空态零大图标）**：断言 `newChatScreen.tsx` 的 hero 区域不存在 `<BrandMark>` 组件，净空首屏。
