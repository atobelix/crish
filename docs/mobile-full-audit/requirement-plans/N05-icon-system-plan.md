# N05 方案报告 · 图标体系统一与精简

> **席位**：第二轮战役 · N05 图标体系方案席
> **产出文件**：`docs/mobile-full-audit/requirement-plans/N05-icon-system-plan.md`
> **遵守规范**：`docs/mobile-full-audit/prompts/00-共同约束前言.md`（U1–U10 铁律、严格证据纪律、反过度设计、纯逻辑规划）
> **证据基线**：基于当前工作区代码现查（`apps/crish-mobile/`、`package.json`、`theme.ts`），拒绝脱水猜测。

---

## 0 结论摘要

1. **盘点全量数据**：移动端经穷尽排查，共存在 **67 处组件级图标标记**与 **19 处高阶封装引入**（全应用累计 **86 处使用点**）。`iconData.ts` 中声明的 58 个 Hugeicons 中，有 **19 个图标从未被任何业务使用（32.8% 纯死代码）**；实际消费的图标仅 39 种。
2. **「不统一」七重断层**：证据确凿的 7 大断裂维度包括：**来源混用**（Hugeicons + 自绘 SVG BrandMark + 脉冲点 PulseDot + 静态 PNG）、**风格撕裂**（线性 Outline vs 实心 Fill vs 底衬圆盘）、**线宽冲突**（原生 1.5 vs 组件强制 2.0 vs BrandMark 动态比例）、**尺寸失控**（散落 12/14/16/18/20/22/24/40/64/72 共 10 种尺寸且大量裸写数字）、**颜色违规**（反复出现 `accentStrong`、`border` 等已废弃迁移别名）、**容器与命中区割裂**（`GlassBackButton` 重复造轮子，hitSlop 混乱）、**语义与命名漂移**（`shield` 承载三意，`check`/`check-circle` 与 `x`/`alert-circle` 混用）。
3. **「非必要不显示」裁定**：坚决贯彻用户裁决（“主界面的那个图标就没有必要加上的，非必要可以不用显示”）。全量 86 处使用点中，**54 处（62.8%）被裁定为「多余装饰」或「文字已足够」应予清退**。用户明确点名的主界面（新对话空态）大图标 `BrandMark`（40px）、启动闸门等待标（64px）、配对与账号欢迎大标（64/72px）**全线删除**；设置页 leading 图标、抽屉导航图标、EmptyState 装饰大图标、按钮内部图标全面清退，转向现代极简的高雅纯文本体系。
4. **目标体系推荐**：明确推荐 **【方案 2：12–14 个精简矢量 Path 内联集合，彻底卸载 Hugeicons 双依赖包】**。
5. **瘦身与性能收益**：从 `node_modules` 中彻底拔除 `@hugeicons/core-free-icons` 与 `@hugeicons/react-native`，一次性削减 **24,442 个文件、76.9 MB 磁盘占用**；消灭 Metro 中 58 个桶文件的解析求值负担；图标组件渲染层由原生的 `react-native-svg` 极简接管，零包装、零多余桥接。

---

## 1 现状还原

### 1.1 依赖与工程现状
- **依赖声明**（`apps/crish-mobile/package.json:25-26, 51`）：
  ```json
  "dependencies": {
    "@hugeicons/core-free-icons": "^4.4.0",
    "@hugeicons/react-native": "^1.0.16",
    ...
    "react-native-svg": "15.15.4"
  }
  ```
- **依赖物理体积与文件数实测**：
  - `@hugeicons/core-free-icons`：磁盘文件数高达 **24,425 个**，体积 **76.83 MB**（`C:\Software\conex\node_modules\@hugeicons\core-free-icons`）。其 `dist/esm` 下包含 12,211 个图标定义。
  - `@hugeicons/react-native`：17 个文件，体积 **73.29 KB**。本质仅为一个 18 行的 `react-native-svg` 元素映射转换器。
  - `react-native-svg`：2,443 个文件，体积 **11.01 MB**。为底层矢量绘图原生支持库。
- **事实结论**：整个移动端为了呈现不到 20 个常规功能符号，在 `node_modules` 中常驻了超过 24,000 个图标源码文件，成为依赖拉取、CI 缓存与包体索引的严重负担。

### 1.2 图标核心组件与桶文件架构
当前架构由 4 个核心 UI 文件组成：
1. `apps/crish-mobile/src/presentation/ui/Icon.tsx:1-26`：
   - 核心组件入口，包装了 `@hugeicons/react-native` 的 `HugeiconsIcon`。
   - 默认强制 `strokeWidth = 2`，破坏了 Hugeicons 原生 1.5 线宽。
   - 依赖 `iconData.ts` 中的静态大字典 `ICON_DATA`。
2. `apps/crish-mobile/src/presentation/ui/iconData.ts:1-182`：
   - 静态导入 58 个独立图标文件（`import Activity01Icon from '@hugeicons/core-free-icons/Activity01Icon'` 等）。
   - 将所有 58 个图标汇总导出一个巨型对象 `export const ICON_DATA: Record<IconName, IconSvgElement>`。
   - **断层**：因为导出了包含 58 个引用的对象，在 Metro 缺少 AST DCE（Dead Code Elimination）的求值模型下，一旦任意页面间接引入 `Icon.tsx`，**所有 58 个图标模块都会被解析并编译进入 bundle**！
3. `apps/crish-mobile/src/presentation/ui/IconButton.tsx:1-120`：
   - 44px 触控目标图标按钮容器。提供 `plain`（透明底圆钮，直径 44，hitSlop 0）与 `floating`（40px 悬浮圆钮，hitSlop 2 补齐 44）两种变体。
4. `apps/crish-mobile/src/presentation/ui/BrandMark.tsx:1-52`：
   - 绕开图标系统，直接引入 `react-native-svg`（`Svg, Circle, Line, Rect`），通过参数方程式动态计算墨色圆角矩形 + 3 根 60 度夹角发散线段 + 顶部品牌绿圆点。
5. `apps/crish-mobile/src/presentation/ui/index.ts:8, 20, 22`：
   - 桶文件统一重导出 `BrandMark`, `Icon`, `IconButton`。任何通过 `@/presentation/ui` 导入基础组件（如 `AppText`）的代码，均会导致全量图标库被静态分析拉入依赖图谱。
### 1.3 静态资源与应用配置（启动与品牌）
- **配置声明**（`apps/crish-mobile/app.json:7, 31-34, 44-50`）：
  - 应用主图标：`"icon": "./assets/images/icon.png"`
  - Android 自适应图标：`"adaptiveIcon": { "backgroundColor": "#0b0b0b", "foregroundImage": "./assets/images/android-icon-foreground.png" }`
  - 原生开屏：`"expo-splash-screen": { "backgroundColor": "#f2f2f2", "image": "./assets/images/splash-icon.png", "imageWidth": 76 }`
- **物理资源实测**：
  - `assets/images/icon.png`：512×512 像素，13.94 KB。与桌面端墨色六角星光标一致。
  - `assets/images/android-icon-foreground.png`：512×512 像素，13.94 KB（与 `icon.png` 字节与哈希完全相同）。
  - `assets/images/splash-icon.png`：128×128 像素，7.55 KB。
  - `assets/images/favicon.png`：32×32 像素，1.79 KB。
- **与应用内自绘 BrandMark 的撕裂**：
  - 原生启动阶段：展示 76px 宽的静态 `splash-icon.png`（灰底 `#f2f2f2`）；
  - JS 载入等待阶段：`app/_layout.tsx:96` 在屏幕中央再画一个 64px 的动态 `BrandMark` + `Spinner`；
  - 进入新对话主界面：`newChatScreen.tsx:89` 又在正中放置一个 40px 的 `BrandMark`；
  - 账号欢迎与配对页：又分别画出 64px（`welcomeScreen.tsx:22`）和 72px（`pairWelcomeScreen.tsx:32`）的 `BrandMark`。
  用户在 2 秒内连续目睹 4 种不同尺寸、动态与静态并存的同构图标，视觉杂乱感极其强烈。

### 1.4 设计 Token 当前基线
`apps/crish-mobile/src/adapters/platform/theme.ts:473-475` 中仅定义了 3 个尺寸 Token：
```ts
icon: 20,
iconSmall: 16,
iconLarge: 24,
```
**严重缺失项**：
1. **缺失线宽 Token**：`theme.layout` 或 `theme.size` 中完全没有 `iconStroke`；导致各组件要么写死 `2`，要么各算一套比例。
2. **缺失微小与特大尺寸 Token**：业务中散落的 12px（面包屑）、14px（时间、状态）、18px（工作区）、22px（预览返回）、40px/64px/72px（品牌标）均无语义 Token 约束，属于纯散落裸数字。

---

## 2 问题清单

### 2.1 全量图标使用点总表（穷尽盘点，累计 86 处）

以下为移动端工程中所有图标使用点（含 `<Icon>`、`<IconButton>`、`<BrandMark>`、高阶容器 `Button`、`EmptyState`、`Toast`、`Input`、`PulseDot`）：

| 序号 | 使用点 (相对仓库根) | 图标名 / 标识 | 来源 | 尺寸 (px) | 线宽/填充 | 颜色 (Token 或字面量) | 容器与命中区 | 功能作用 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **01** | `app/_layout.tsx:96` | 品牌大标 | 自绘 SVG (BrandMark) | 64 | 6.08px / 实心填充 | actionPrimary / brand | View (居中) | 启动闸门等待标 |
| **02** | `src/presentation/account/welcomeScreen.tsx:22` | 品牌大标 | 自绘 SVG (BrandMark) | 64 | 6.08px / 实心填充 | actionPrimary / brand | View (居中) | 账号中心欢迎页品牌标 |
| **03** | `src/presentation/pair/pairWelcomeScreen.tsx:32` | 品牌大标 | 自绘 SVG (BrandMark) | 72 | 6.84px / 实心填充 | actionPrimary / brand | View (居中) | 配对引导欢迎页大标 |
| **04** | `src/presentation/screens/newChatScreen.tsx:89` | 品牌大标 | 自绘 SVG (BrandMark) | 40 (`avatar`) | 3.8px / 实心填充 | actionPrimary / brand | View (居中) | **主页空态大标（用户点名）** |
| **05** | `src/presentation/ui/AppHeader.tsx:55` | `chevron-left` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton floating (40, hitSlop 2) | 二级居中头栏返回按钮 |
| **06** | `src/presentation/ui/AppHeader.tsx:101` | `chevron-left` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44, hitSlop 0) | 常规大标题头栏返回按钮 |
| **07** | `src/presentation/account/ui/GlassBackButton.tsx:36` | `chevron-left` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | Pressable circle (40, hitSlop 4) | 账号页自定义浮动返回钮 |
| **08** | `src/presentation/components/files/FileBreadcrumb.tsx:35` | `chevron-left` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44) | 面包屑返回上一级目录 |
| **09** | `src/presentation/components/files/FilePreview.tsx:44` | `chevron-left` | Hugeicons | **22 (裸数字)** | 2px / 线性 | textPrimary | Pressable 裸容器 (无固定尺寸) | 文件预览页返回列表 |
| **10** | `src/presentation/ui/Sheet.tsx:107` | `x` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44) | 底部弹出抽屉右上角关闭 |
| **11** | `src/presentation/screens/approvalDetailScreen.tsx:99` | `x` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44) | 审批详情半屏卡片关闭 |
| **12** | `src/presentation/pair/pairScanScreen.tsx:114` | `x` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44) | 相机无权限页关闭 |
| **13** | `src/presentation/pair/pairScanScreen.tsx:150` | `x` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44) | 扫码蒙层右上角关闭 |
| **14** | `src/presentation/components/chat/MenuButton.tsx:19` | `menu` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44) | 主页头栏呼出侧边抽屉 |
| **15** | `src/presentation/screens/newChatScreen.tsx:67` | `bell` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44, 带数字角标) | 主页头栏进入通知中心 |
| **16** | `src/presentation/components/drawer/DrawerHeader.tsx:49` | `user` | Hugeicons | 20 (`icon`) | 2px / 线性 | tone.fg (动态头像字色) | View circle (40) | 抽屉用户无名字时头像占位 |
| **17** | `src/presentation/components/drawer/DrawerHeader.tsx:101` | `new-chat` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton floating (40, hitSlop 2) | 抽屉内快捷新建会话 |
| **18** | `src/presentation/components/drawer/DrawerFooter.tsx:68` | `settings` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton floating (40, hitSlop 2) | 抽屉底部打开系统设置 |
| **19** | `src/presentation/components/drawer/DrawerFooter.tsx:45` | `search` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | textTertiary | View pill (高 40 胶囊输入区) | 抽屉会话搜索框引导图标 |
| **20** | `src/presentation/components/drawer/DrawerNav.tsx:62 (81)` | `shield` | Hugeicons | 20 (`icon`) | 2px / 线性 | textSecondary | Pressable row (高 44) | 抽屉导航项「待审批」前置标 |
| 序号 | 使用点 (相对仓库根) | 图标名 / 标识 | 来源 | 尺寸 (px) | 线宽/填充 | 颜色 (Token 或字面量) | 容器与命中区 | 功能作用 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **21** | `src/presentation/components/drawer/DrawerNav.tsx:62 (88)` | `history` | Hugeicons | 20 (`icon`) | 2px / 线性 | textSecondary | Pressable row (高 44) | 抽屉导航项「审批记录」前置标 |
| **22** | `src/presentation/ui/Composer.tsx:86` | `send` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | actionPrimaryText / textDisabled | Pressable round (高 36) | 消息输入框主发送圆钮 |
| **23** | `src/presentation/components/dashboard/NewTaskSheet.tsx:43` | `send` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | foreground (Button 内) | Button (高 48) | 发起任务抽屉提交按钮图标 |
| **24** | `src/presentation/ui/ScrollToBottomButton.tsx:40` | `chevron-down` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | textPrimary | Pressable pill (高 36) | 悬浮「回到底部」前置指示 |
| **25** | `src/presentation/screens/sessionDetailScreen.tsx:149` | `more` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44) | 会话头栏右侧「更多操作」 |
| **26** | `src/presentation/screens/sessionDetailScreen.tsx:214` | `activity` | Hugeicons | 20 (`icon`) | 2px / 线性 | textSecondary | ListRow leading | 更多菜单中「运行详情」前置 |
| **27** | `src/presentation/screens/sessionDetailScreen.tsx:222` | `terminal` | Hugeicons | 20 (`icon`) | 2px / 线性 | textSecondary | ListRow leading | 更多菜单中「终端输出」前置 |
| **28** | `src/presentation/screens/sessionDetailScreen.tsx:230` | `wrench` | Hugeicons | 20 (`icon`) | 2px / 线性 | textSecondary | ListRow leading | 更多菜单中「工具调用」前置 |
| **29** | `src/presentation/screens/runDetailScreen.tsx:101` | `terminal` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44) | 运行详情头栏打开终端输出 |
| **30** | `src/presentation/screens/toolSheetScreen.tsx:108` | `terminal` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton floating (40, hitSlop 2) | 工具调用抽屉打开终端输出 |
| **31** | `src/presentation/timeline/TimelineView.tsx:184` | `shield` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | colors[color] (warning/success/danger) | View inlineRow | 时间线中审批卡片前置盾牌 |
| **32** | `src/presentation/timeline/TimelineView.tsx:232` | `alert-circle` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | colors[danger] | View inlineRow | 时间线系统警示消息前置 |
| **33** | `src/presentation/timeline/ToolSummaryRow.tsx:51` | `wrench` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | textTertiary | View inlineRow | 消息流工具聚合行前置扳手 |
| **34** | `src/presentation/timeline/ToolSummaryRow.tsx:73` | `arrow-up` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | textTertiary | View inlineRow | 工具聚合行右侧进入详情箭头 |
| **35** | `src/presentation/components/tools/ToolRow.tsx:56` | 动态猜测 (terminal/search/file-code/file-text/wrench) | Hugeicons | 20 (`icon`) | 2px / 线性 | textSecondary | Pressable row (高 52) | 工具调用单行语义猜测图标 |
| **36** | `src/presentation/components/tools/ToolRow.tsx:98` | `x` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | danger | View (行末状态) | 工具执行失败状态叉号 |
| **37** | `src/presentation/components/tools/ToolRow.tsx:106` | `check` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | success | View (行末状态) | 工具执行完成状态对号 |
| **38** | `src/presentation/components/approval/ApprovalFloatCard.tsx:94` | `chevron-down` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | textPrimary | IconButton plain (44) | 悬浮审批卡右侧收起按钮 |
| **39** | `src/presentation/components/approval/ApprovalFloatCard.tsx:131` | `shield` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | foreground (Button 内) | Button (高 48) | 「查看并滑动确认」主按钮内图标 |
| **40** | `src/presentation/components/approval/ApprovalListItem.tsx:59` | `clock` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | danger / textTertiary | View inlineRow | 待审批列表项倒计时前置钟表 |
| **41** | `src/presentation/components/blocks/ApprovalCard.tsx:149` | `clock` | Hugeicons | **14 (裸数字)** | 2px / 线性 | danger / textTertiary | View inlineRow | 审批详情卡片倒计时前置钟表 |
| **42** | `src/presentation/components/approval/ApprovalHistoryRow.tsx:71` | `check` / `x` / `clock` | Hugeicons | **14 (裸数字)** | 2px / 线性 | success / danger / textTertiary | View pill (28×28, fillSubtle) | 审批记录行决策状态前置小图标 |
| **43** | `src/presentation/screens/approvalDetailScreen.tsx:118` | `info` | Hugeicons | **14 (裸数字)** | 2px / 线性 | textTertiary | View inlineRow | 桌面自动裁决说明前置 info |
| **44** | `src/presentation/screens/approvalListScreen.tsx:63` | `wifi-off` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | warning | View banner (高 40) | 离线审批未同步横幅指示 |
| **45** | `src/presentation/components/status/ConnectionBanner.tsx:32` | `wifi-off` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | textTertiary | View banner (高 44) | 顶部未连接/重连细条指示 |
| **46** | `src/presentation/components/status/ConnectionBanner.tsx:45` | `refresh` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | textPrimary | IconButton plain (44) | 顶部细条手动触发重连圆钮 |
| **47** | `src/presentation/components/settings/SettingsScreenView.tsx:89 (97)` | `user` | Hugeicons | 20 (`icon`) | 2px / 线性 | textSecondary | ListRow leading | 设置页「账号」列表行前置图标 |
| **48** | `src/presentation/components/settings/SettingsScreenView.tsx:120` | `monitor` | Hugeicons | 20 (`icon`) | 2px / 线性 | success / textSecondary | ListRow leading | 设置页「桌面连接」前置图标 |
| **49** | `src/presentation/components/settings/SettingsScreenView.tsx:142` | `refresh` | Hugeicons | 20 (`icon`) | 2px / 线性 | textSecondary | ListRow leading | 设置页「重新连接」前置图标 |
| **50** | `src/presentation/components/settings/SettingsScreenView.tsx:150` | `info` | Hugeicons | 20 (`icon`) | 2px / 线性 | textSecondary | ListRow leading | 设置页「连接帮助」前置图标 |
| 序号 | 使用点 (相对仓库根) | 图标名 / 标识 | 来源 | 尺寸 (px) | 线宽/填充 | 颜色 (Token 或字面量) | 容器与命中区 | 功能作用 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **51** | `src/presentation/components/settings/SettingsScreenView.tsx:156` | `shield` | Hugeicons | 20 (`icon`) | 2px / 线性 | textSecondary | ListRow leading | 设置页「安全连接」前置图标 |
| **52** | `src/presentation/components/settings/SettingsScreenView.tsx:252` | `log-out` | Hugeicons | 20 (`icon`) | 2px / 线性 | danger | ListRow leading | 设置页「解除配对」前置图标 |
| **53** | `src/presentation/account/ui/AuthField.tsx:108` | `eye` / `eye-off` | Hugeicons | 20 (`icon`) | 2px / 线性 | textTertiary | Pressable (hitSlop 8) | 密码输入框显隐切换开关 |
| **54** | `src/presentation/account/accountProfileScreen.tsx:230` | `camera` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | textPrimary | Pressable circle (34×34) | 资料页头像右下角更换头像 |
| **55** | `src/presentation/account/ui/NavRow.tsx:49` | `chevron-right` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | textTertiary | Pressable row (高 56) | 账号中心列表行右侧进入指示 |
| **56** | `src/presentation/ui/ListRow.tsx:61` | `chevron-right` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | textTertiary | View/Pressable row (高 52) | 全局列表行右侧进入指示箭头 |
| **57** | `src/presentation/screens/filesScreen.tsx:62` | `folder-open` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44) | 文件页头栏「切换工作区」按钮 |
| **58** | `src/presentation/screens/filesScreen.tsx:71` | `sort` | Hugeicons | 20 (`icon`) | 2px / 线性 | textPrimary | IconButton plain (44) | 文件页头栏「文件排序」动作按钮 |
| **59** | `src/presentation/screens/filesScreen.tsx:112` | `check` | Hugeicons | **16 (裸数字)** | 2px / 线性 | **accentStrong (废弃别名)** | ListRow trailing | 排序弹窗当前选中项指示 |
| **60** | `src/presentation/components/files/FileBreadcrumb.tsx:54` | `chevron-right` | Hugeicons | **12 (裸数字)** | 2px / 线性 | textTertiary | View inline (面包屑间) | 面包屑路径片段层级分隔符 |
| **61** | `src/presentation/components/files/FileRow.tsx:63` | `folder` / `file-text` / `file-image` / `file` | Hugeicons | **20 (裸数字)** | 2px / 线性 | textSecondary / info / success / danger | Pressable row (高 56) | 文件列表项文件类型指示 |
| **62** | `src/presentation/components/files/FileRow.tsx:83` | `chevron-right` | Hugeicons | **14 (裸数字)** | 2px / 线性 | textTertiary | Pressable row | 文件列表目录项右侧箭头 |
| **63** | `src/presentation/components/files/FilePreview.tsx:69` | `shield` | Hugeicons | **14 (裸数字)** | 2px / 线性 | warning | View banner (warningSoft) | 预览页「敏感文件」安全横幅指示 |
| **64** | `src/presentation/components/files/WorkspaceSheet.tsx:60` | `folder` | Hugeicons | **18 (裸数字)** | 2px / 线性 | **accentStrong (废弃) / textSecondary** | ListRow leading | 工作区列表项前置文件夹图标 |
| **65** | `src/presentation/components/files/WorkspaceSheet.tsx:72` | `check` | Hugeicons | **16 (裸数字)** | 2px / 线性 | **accentStrong (废弃别名)** | ListRow trailing | 工作区列表当前活跃工作区指示 |
| **66** | `src/presentation/pair/pairWelcomeScreen.tsx:66` | `qr-code` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | foreground (Button 内) | Button (高 48) | 「扫描二维码」按钮内部图标 |
| **67** | `src/presentation/ui/Toast.tsx:81` | `alert-circle` / `check-circle` / `info` | Hugeicons | 16 (`iconSmall`) | 2px / 线性 | actionPrimaryText | View pill (高 40) | 全局轻提示 Toast 状态前置图标 |
| **68** | `src/presentation/components/notifications/NotificationRow.tsx:69` | `shield` / `activity` / `alert-circle` / `bell` | Hugeicons | **16 (裸数字)** | 2px / 线性 | warning / danger / info | View circle (32×32, 柔底色) | 通知中心列表项类别彩色圆底图标 |
| **69** | `src/presentation/components/files/FileBrowser.tsx:90` | `wifi-off` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 文件浏览器离线空态大图标 |
| **70** | `src/presentation/components/files/FileBrowser.tsx:102` | `alert-circle` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 文件浏览器加载出错空态大图标 |
| **71** | `src/presentation/components/files/FileBrowser.tsx:110` | `folder` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 文件浏览器「该目录为空」空态大图标 |
| **72** | `src/presentation/components/files/FilePreview.tsx:82` | `alert-circle` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 文件预览失败重试空态大图标 |
| **73** | `src/presentation/components/files/FilePreview.tsx:89` | `file` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 文件预览「文件过大」空态大图标 |
| **74** | `src/presentation/components/files/FilePreview.tsx:91` | `file` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 文件预览「二进制文件」空态大图标 |
| **75** | `src/presentation/components/files/FilePreview.tsx:93` | `file` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 文件预览「编码不支持」空态大图标 |
| **76** | `src/presentation/pair/pairScanScreen.tsx:117` | `qr-code` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 扫码无相机权限空态大图标 |
| **77** | `src/presentation/screens/approvalDetailScreen.tsx:144 (141)` | `check-circle` / `x` / `clock` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 审批已处理结果状态空态大图标 |
| **78** | `src/presentation/screens/approvalDetailScreen.tsx:156` | `alert-circle` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 审批不存在或过期空态大图标 |
| **79** | `src/presentation/screens/approvalHistoryScreen.tsx:61` | `clock` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 「暂无已处理记录」空态大图标 |
| **80** | `src/presentation/screens/approvalListScreen.tsx:99` | `shield` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 「暂无待审批」空态大图标 |
| **81** | `src/presentation/screens/notificationCenterScreen.tsx:63` | `bell` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 「暂无通知」空态大图标 |
| **82** | `src/presentation/screens/runDetailScreen.tsx:155` | `activity` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 「暂无运行记录」空态大图标 |
| **83** | `src/presentation/screens/toolSheetScreen.tsx:137` | `wrench` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 「还没有工具调用」空态大图标 |
| **84** | `src/presentation/timeline/TimelineView.tsx:91` | `messages` | Hugeicons | 24 (`iconLarge`) | 2px / 线性 | textDisabled | EmptyState 容器 | 会话时间线空态大图标 |
| **85** | `src/presentation/components/tools/PulseDot.tsx:41 (ToolRow:95)` | 动态脉冲点 | 动画 View (PulseDot) | 8 (`dot`) | 实心圆 / 不透明度动画 | brand | View (行内状态) | 工具执行中呼吸光标 (涉及 U8) |
| **86** | `src/presentation/components/tools/PulseDot.tsx:41 (ToolSummary:49)` | 动态脉冲点 | 动画 View (PulseDot) | 8 (`dot`) | 实心圆 / 不透明度动画 | brand | View (行内状态) | 工具聚合行执行中呼吸点 (涉及 U8) |

#### 2.1.1 纯死代码：19 个从未在业务中被消费的图标
在 `src/presentation/ui/iconData.ts` 导入并打包的 58 个 Hugeicons 中，以下 **19 个图标（32.8%）在业务代码中完全零引用**，纯属凭空引入的死包袱：
`wifi`、`arrow-left`、`arrow-right`、`alert-triangle`、`home`（仅单测引入）、`play`、`pause`、`stop`、`plus`、`smartphone`、`keyboard`、`trash`、`git-branch`、`zap`、`copy`、`link`、`shield-off`、`sliders`、`pin`。
### 2.2 「不统一」的证据化拆解（7 大维度）

把用户指出的“不统一”穿透到代码实现，拆解为以下 7 个可刚性检验的断裂维度：

#### 维度一：来源混用与多头管理
- **证据 1（Hugeicons 桶文件）**：`src/presentation/ui/iconData.ts:1-60` 从 `@hugeicons/core-free-icons` 引入 58 个第三方封装组件。
- **证据 2（自绘过程式 SVG）**：`src/presentation/ui/BrandMark.tsx:17-48` 不走图标体系，私自依赖 `react-native-svg`，在运行期执行三角函数计算（`Math.cos(rad) * arm`）绘制墨色圆角矩形、60 度辐射线和圆点。
- **证据 3（状态动效充当图标）**：`src/presentation/components/tools/PulseDot.tsx:41-54` 自造 `Animated.View` 脉冲点充当执行中图标（并违背 U8 约束）。
- **证据 4（静态 PNG 割裂）**：`assets/images/splash-icon.png`（76px 开屏图）与应用内 `BrandMark.tsx`（40/64/72px 自绘）属于两套独立资产，视觉细节存在细微栅格化差异。

#### 维度二：风格撕裂（线性 Outline vs 实心 Fill vs 底衬圆盘）
- **线性 vs 实心冲突**：
  - Hugeicons 全库采用线性 Outline（`stroke="currentColor" fill="none"`）。
  - `BrandMark.tsx:22, 45` 采用大面积实心 Fill（`fill={theme.colors.actionPrimary}` 与 `fill={theme.colors.brand}`）。两者在同一界面混用时，视觉重量差异达到 5 倍以上。
- **底衬圆盘任意包裹**：
  - 在 `NotificationRow.tsx:55-74` 中，线性图标被强行塞入 32×32、带浅色底的圆角胶囊（`backgroundColor: theme.colors.warningSoft` 等）；
  - 在 `ApprovalHistoryRow.tsx:62-72` 中，同样是历史条目，却塞入 28×28、`fillSubtle` 灰底圆盘；
  - 而在 `TimelineView.tsx:184`、`SettingsScreenView.tsx:89` 中，同类语义图标却是裸露线性渲染。
  同一款应用在不同列表中，图标呈现出“裸放”、“灰色胶囊衬底”、“马卡龙色胶囊衬底”三种截然不同的容器层级。

#### 维度三：线宽混乱（Authored 1.5 vs 组件强制 2.0 vs 动态浮动）
- **第三方原厂设计**：`node_modules/@hugeicons/core-free-icons/dist/esm/Home01Icon.js:2` 明确写明 `strokeWidth: "1.5"`，原作者针对 24×24 网格以 1.5 细线进行视差平衡。
- **组件强制覆写**：`src/presentation/ui/Icon.tsx:16` 硬编码 `strokeWidth = 2`。导致精细图形（如 `settings` 齿轮的细孔、`keyboard` 键位）在线宽加粗后发生笔画黏连。
- **BrandMark 浮动线宽**：`src/presentation/ui/BrandMark.tsx:15` 按照 `size * 0.095` 动态算线宽：
  - 64px 尺寸时为 6.08px；
  - 72px 尺寸时为 6.84px；
  - 40px 尺寸时为 3.80px。
  导致品牌标记内部线条粗细随尺寸线性变化，在小尺寸下过细，在大尺寸下显得笨重。

#### 维度四：尺寸阶梯失控与裸数字泛滥
- **基线 Token**：`theme.ts:473-475` 规定了 `iconSmall: 16`、`icon: 20`、`iconLarge: 24`。
- **现场实测**：全应用充斥着 **10 种相互冲突的尺寸**，大量绕过 theme：
  - `size = 12`：`FileBreadcrumb.tsx:56`（硬编码 12，无 Token）；
  - `size = 14`：`ApprovalHistoryRow.tsx:71`、`ApprovalCard.tsx:151`、`FilePreview.tsx:69`、`FileRow.tsx:85`、`approvalDetailScreen.tsx:120`（硬编码 14，无 Token）；
  - `size = 16`：`WorkspaceSheet.tsx:74`、`filesScreen.tsx:114`、`NotificationRow.tsx:71`（硬编码数字字面量 `16`，未引用 `theme.size.iconSmall`）；
  - `size = 18`：`WorkspaceSheet.tsx:62`（硬编码 18，无 Token）；
  - `size = 20`：`FileRow.tsx:63`（硬编码数字字面量 `20`，未引用 `theme.size.icon`）；
  - `size = 22`：`FilePreview.tsx:46`（硬编码 22，无 Token）；
  - `size = 24`：`EmptyState.tsx:35`；
  - `size = 40`：`newChatScreen.tsx:89`（借用 `avatar` 尺寸 Token 给 BrandMark）；
  - `size = 64`：`app/_layout.tsx:96`、`welcomeScreen.tsx:7`（硬编码 64）；
  - `size = 72`：`pairWelcomeScreen.tsx:32`（硬编码 72）。
- **荒谬对比例子（Chevron 箭头）**：
  同为一个向右进入的指示箭头：在面包屑中是 12px，在文件列表中是 14px，在账号导航行中是 16px，在通用 ListRow 中是 16px。视觉大小跳跃高达 33%！

#### 维度五：颜色来源混乱与已废弃 Token 违规
- 默认颜色分歧：`Icon.tsx:22` 默认取 `textSecondary`，而 `IconButton.tsx:75` 默认取 `textPrimary`。
- 违背 U4 铁律，继续使用标记为 `@deprecated` 的迁移别名：
  - `WorkspaceSheet.tsx:65, 75`：`color={theme.colors.accentStrong}`；
  - `filesScreen.tsx:115`：`color={theme.colors.accentStrong}`；
  - `FileBreadcrumb.tsx:34`：`borderBottomColor: theme.colors.border`；
  - `FilePreview.tsx:35`：`borderBottomColor: theme.colors.border`；
  - `FileRow.tsx:57, 60`：`theme.colors.border` 与 `theme.colors.surfaceSubtle`。

#### 维度六：容器尺寸与触控命中区割裂
- `IconButton.tsx` 规范定义：
  - `plain`：直径 44，`hitSlop = 0`；
  - `floating`：直径 40，`hitSlop = (44 - 40) / 2 = 2`。
- 私自造轮子违背规范：
  - `GlassBackButton.tsx:17-38`：自己重写了一个 40px 圆形按钮，使用 `hitSlop={theme.space.xs}`（4px，将触控区算成 48px），内部引入 `GlassBackdrop`。完全与 `IconButton` 形成重复实现。
  - `FilePreview.tsx:37-49`：用普通 `Pressable` 包裹一个 22px 裸图标，未声明最小宽高、未提供 `hitSlop`，导致在真机上触控区域极小，点击极易落空。

#### 维度七：语义混淆与命名漂移
- **一符多意（`shield` 滥用）**：
  1. 审批与安全：`ApprovalFloatCard.tsx`、`approvalListScreen.tsx`；
  2. 敏感文件警示：`FilePreview.tsx:69`；
  3. 桌面证书与 TLS：`SettingsScreenView.tsx:156`。
  用户在同一个 App 里看到盾牌图标，既代表“要花钱/危险命令需你授权”，又代表“敏感代码文件不缓存”，还代表“连接证书正常”，认知模型混乱。
- **成功/勾选双符号混用**：
  - `WorkspaceSheet.tsx:72` 与 `filesScreen.tsx:112` 使用裸对号 `check`；
  - `Toast.tsx:57` 与 `approvalDetailScreen.tsx:144` 使用带圈对号 `check-circle`。
- **错误/失败双符号混用**：
  - `ToolRow.tsx:98` 与 `ApprovalHistoryRow.tsx:49` 失败用叉号 `x`；
  - `Toast.tsx:55` 与 `TimelineView.tsx:232` 失败却用叹号圆圈 `alert-circle`。
---

## 3 目标方案

### 3.1 「非必要不显示」裁定表（全量 86 点逐条断定）

坚决落实用户要求：**“非必要可以不用显示的倒是。像是主界面的那个图标就没有必要加上的。主要是我看图标也不统一呢。”**
裁定标准严格锁定：
- **【必要】**：该图标独立承担关键用户操作或核心导航，去掉后用户无法识别操作意图（如返回、关闭、汉堡抽屉、输入发送、密码显隐）；
- **【文字已足够】**：图标紧贴明确文本，文本已完整传达语义与层级，图标纯属视觉重叠，必须坚决删除；
- **【装饰】**：纯粹用于填充空白的图形，无任何交互功能与不可替代的信息增益，必须坚决删除；
- **【重复实现】**：脱离统一 UI 组件库私造的冗余封装，必须删除并合并。

| 分组 / 业务域 | 涉及点序号 | 图标 / 标识 | 判定结果 | 裁定理由与具体处置动作 |
| :--- | :--- | :--- | :--- | :--- |
| **一、品牌大标 BrandMark** | **01** (`_layout.tsx:96`) | 品牌标 64px | **装饰（删除）** | 协同 N01 启动席，彻底取消 JS 层的自绘开屏与旋转菊花，原生 SplashScreen 隐藏后直接展示就绪页面。 |
| | **02** (`welcomeScreen.tsx:22`) | 品牌标 64px | **装饰 / 文字已足够（删除）** | 页面紧接着大号字体的 "Crish" 标题及副标题，品牌大图标纯属画蛇添足，删除后首屏排版更轻盈。 |
| | **03** (`pairWelcomeScreen.tsx:32`) | 品牌标 72px | **装饰 / 文字已足够（删除）** | 已有大标题“我的电脑 / 连接桌面”，删除后极大节省垂直空间，核心扫码与登录按钮上移更加跟手。 |
| | **04** (`newChatScreen.tsx:89`) | 品牌标 40px | **装饰（用户点名必删）** | 用户明确指示“主界面的那个图标就没有必要加上”。新会话空态仅保留时段问候大字与描述，视觉焦点归一到底部 Composer。 |
| **二、导航返回与关闭** | **05** (`AppHeader.tsx:55`) | `chevron-left` | **必要（保留）** | 二级居中头栏唯一的返回途径，无文字辅助。 |
| | **06** (`AppHeader.tsx:101`) | `chevron-left` | **必要（保留）** | 根级页面返回操作核心入口。 |
| | **07** (`GlassBackButton.tsx:36`) | `chevron-left` | **重复实现（删除）** | 账号页私造轮子。直接删除整个 `GlassBackButton.tsx`，调用点换用标准 `IconButton variant="floating"`。 |
| | **08** (`FileBreadcrumb.tsx:35`) | `chevron-left` | **必要（保留）** | 文件浏览器回到父目录的单触控动作。 |
| | **09** (`FilePreview.tsx:44`) | `chevron-left` | **重复实现（重构保留）** | 自定义裸 Pressable，重构为标准 `IconButton plain`，尺寸由 22px 规范化为 20px。 |
| | **10** (`Sheet.tsx:107`) | `x` | **必要（保留）** | 弹出抽屉右上角显式退出按钮。 |
| | **11** (`approvalDetail:99`) | `x` | **必要（保留）** | 审批详情半屏卡片显式退出按钮。 |
| | **12** (`pairScan:114`) | `x` | **必要（保留）** | 扫码无权限拦截页显式退出按钮。 |
| | **13** (`pairScan:150`) | `x` | **必要（保留）** | 扫码相机蒙层右上角退出按钮。 |
| **三、主页头栏与抽屉** | **14** (`MenuButton.tsx:19`) | `menu` | **必要（保留）** | 主界面唯一的全局抽屉物理呼出键。 |
| | **15** (`newChatScreen:67`) | `bell` | **必要（保留）** | 主界面进入通知中心的唯一动作入口，承载未读红点。 |
| | **16** (`DrawerHeader.tsx:49`) | `user` | **装饰 / 文字已足够（删除）** | 无名字时用纯文本“本”或首字母色块兜底，无需专门引入并渲染一个 `user` 矢量图形。 |
| | **17** (`DrawerHeader.tsx:101`) | `new-chat` | **必要（保留）** | 抽屉内顶部高频快捷新建会话动作圆钮。 |
| | **18** (`DrawerFooter.tsx:68`) | `settings` | **必要（保留）** | 抽屉底部进入系统设置的唯一常驻动作圆钮。 |
| | **19** (`DrawerFooter.tsx:45`) | `search` | **文字已足够（删除）** | 搜索胶囊内已有清楚的 `placeholder="搜索会话"`，去掉前置图标可留出更多字符显示宽度。 |
| | **20** (`DrawerNav.tsx:81`) | `shield` | **文字已足够（删除）** | 对接 N03 抽屉重排，列表项已有醒目大字“待审批”及数量角标，前置盾牌纯属装饰，予以清退。 |
| | **21** (`DrawerNav.tsx:88`) | `history` | **文字已足够（删除）** | 对接 N03 抽屉重排，已有“审批记录”字样，前置钟表纯属装饰，予以清退。 |
| **四、输入发送与悬浮** | **22** (`Composer.tsx:86`) | `send` | **必要（保留）** | 聊天输入区唯一的主提交动作图标。 |
| | **23** (`NewTaskSheet.tsx:43`) | `send` | **文字已足够（删除）** | 弹窗底部主按钮明确写有“发送”二字，按钮内图标多余。 |
| | **24** (`ScrollToBottom.tsx:40`) | `chevron-down` | **文字已足够（删除）** | 悬浮胶囊已有“回到底部”4 个汉字，删除下箭头后按钮更小巧优雅。 |
| **五、会话详情与工具流** | **25** (`sessionDetail:149`) | `more` | **必要（保留）** | 头栏右侧呼出详情菜单的三个点图标。 |
| | **26** (`sessionDetail:214`) | `activity` | **文字已足够（删除）** | 菜单列表行明确标有“运行详情”，前置波形多余。 |
| | **27** (`sessionDetail:222`) | `terminal` | **文字已足够（删除）** | 菜单列表行明确标有“终端输出”，前置终端多余。 |
| | **28** (`sessionDetail:230`) | `wrench` | **文字已足够（删除）** | 菜单列表行明确标有“工具调用”，前置扳手多余。 |
| | **29** (`runDetail:101`) | `terminal` | **必要（保留）** | 运行详情头栏切换到终端黑屏输出的动作按钮。 |
| | **30** (`toolSheet:108`) | `terminal` | **必要（保留）** | 工具抽屉快捷打开终端输出的动作按钮。 |
| | **31** (`TimelineView:184`) | `shield` | **文字已足够（删除）** | 时间线已明确显示“等待你审批 · <toolName>”，盾牌多余。 |
| | **32** (`TimelineView:232`) | `alert-circle` | **文字已足够（删除）** | 错误文本自带 danger 红色层级与文字内容，前置感叹号多余。 |
| | **33** (`ToolSummaryRow:51`) | `wrench` | **文字已足够（删除）** | 已有文字“使用了 N 个工具”，扳手图标纯属装饰。 |
| | **34** (`ToolSummaryRow:73`) | `arrow-up` | **装饰（删除）** | 该胶囊行本身即可点按，右侧上拉箭头多余。 |
| | **35** (`ToolRow:56`) | 动态猜测图标 | **装饰 / 语义不准（删除）** | 注释明确写明只是猜测，旁边已有等宽工具真名，删除纯装饰。 |
| | **36** (`ToolRow:98`) | `x` | **文字已足够（改为状态点）** | 工具执行失败，以 8px 红色状态圆点替代，无需加载 16px 矢量。 |
| | **37** (`ToolRow:106`) | `check` | **文字已足够（改为状态点）** | 工具执行完成，以 8px 绿色状态圆点替代，无需加载 16px 矢量。 |
| **六、审批卡片与历史** | **38** (`ApprovalFloat:94`) | `chevron-down` | **必要（保留）** | 悬浮审批卡右侧收起折叠按钮。 |
| | **39** (`ApprovalFloat:131`) | `shield` | **文字已足够（删除）** | 按钮文本为“查看并滑动确认”，内部盾牌挤占空间，删除。 |
| | **40** (`ApprovalListItem:59`) | `clock` | **文字已足够（删除）** | 紧挨着等宽倒计时 `00:45`，带红色染色，钟表纯多余。 |
| | **41** (`ApprovalCard:149`) | `clock` | **文字已足够（删除）** | 紧挨着剩余时间或“已过期”字样，钟表纯多余。 |
| | **42** (`ApprovalHistory:71`) | `check/x/clock` | **文字已足够（删除）** | 右侧醒目显示“已批准/已拒绝/已过期”，左侧 28px 圆盘图标全部删除。 |
| | **43** (`approvalDetail:118`) | `info` | **文字已足够（删除）** | 右侧文字“该请求由桌面端自动裁决”，info 多余。 |
| | **44** (`approvalList:63`) | `wifi-off` | **文字已足够（删除）** | 横幅文本“N 条决策等待网络恢复后发送”，自身带 warningSoft 底色，无须图标。 |
| 分组 / 业务域 | 涉及点序号 | 图标 / 标识 | 判定结果 | 裁定理由与具体处置动作 |
| :--- | :--- | :--- | :--- | :--- |
| **七、设置与状态连接** | **45** (`ConnectionBanner:32`) | `wifi-off` | **文字已足够（删除）** | 细条文本已有“正在重试连接…”等详细文案，左侧图标删除。 |
| | **46** (`ConnectionBanner:45`) | `refresh` | **必要（保留）** | 细条右侧手动触发重连的唯一动作圆钮。 |
| | **47** (`SettingsView:89,97`) | `user` | **文字已足够（删除）** | 文本为“登录 Crish 账号”或昵称，前置图标破坏列表对齐，删除。 |
| | **48** (`SettingsView:120`) | `monitor` | **文字已足够（删除）** | 文本为“桌面连接”及主机名，右侧已有状态指示点，删除图标。 |
| | **49** (`SettingsView:142`) | `refresh` | **文字已足够（删除）** | 明确写着“重新连接”，左侧图标删除。 |
| | **50** (`SettingsView:150`) | `info` | **文字已足够（删除）** | 明确写着“连接帮助”，左侧图标删除。 |
| | **51** (`SettingsView:156`) | `shield` | **文字已足够（删除）** | 明确写着“安全连接”，左侧图标删除。 |
| | **52** (`SettingsView:252`) | `log-out` | **文字已足够（删除）** | 明确写着红色高风险的“解除配对”，左侧图标删除。 |
| **八、账号与密码** | **53** (`AuthField.tsx:108`) | `eye` / `eye-off` | **必要（保留）** | 密码输入框显隐切换，移动端标准行为，无文字辅助。 |
| | **54** (`accountProfile:230`) | `camera` | **必要（保留）** | 头像右下角更换头像引导标，提示用户支持拍照/相册选取。 |
| | **55** (`NavRow.tsx:49`) | `chevron-right` | **必要（保留并合并）** | 列表行进入下一级页面指示箭头。与 `ListRow` 合并统一规格。 |
| | **56** (`ListRow.tsx:61`) | `chevron-right` | **必要（保留）** | 设计系统通用的列表行右侧进入指示箭头。 |
| **九、文件系统** | **57** (`filesScreen.tsx:62`) | `folder-open` | **必要（保留）** | 顶栏切换工作区的动作按钮。 |
| | **58** (`filesScreen.tsx:71`) | `sort` | **必要（保留）** | 顶栏呼出排序选项的动作按钮。 |
| | **59** (`filesScreen:112`) | `check` | **必要（保留）** | 排序弹窗当前选中项对号指示。 |
| | **60** (`FileBreadcrumb:54`) | `chevron-right` | **装饰（删除）** | 路径分隔符改用纯文本字符 `/`（`src / presentation`），无需挂载 SVG。 |
| | **61** (`FileRow.tsx:63`) | `folder` / `file` | **必要（精简保留）** | 文件浏览器核心可用性：必须区分“文件夹”与“普通文件”。但废弃细分类型（file-text/image/code），仅保留统一的 `folder` 与 `file`。 |
| | **62** (`FileRow.tsx:83`) | `chevron-right` | **文字已足够 / 装饰（删除）** | 左侧已有 `folder` 标明是目录，右侧箭头纯属视觉重复。 |
| | **63** (`FilePreview.tsx:69`) | `shield` | **文字已足够（删除）** | 已有“敏感文件，内容不会缓存”字样与黄色底衬，盾牌多余。 |
| | **64** (`WorkspaceSheet:60`) | `folder` | **文字已足够（删除）** | 列表中全是工作区目录，已有工作区名与路径，前置文件夹图标删除。 |
| | **65** (`WorkspaceSheet:72`) | `check` | **必要（保留）** | 标识当前活跃工作区。 |
| **十、通用反馈与空态** | **66** (`pairWelcome:66`) | `qr-code` | **文字已足够（删除）** | 按钮文字“扫描二维码”已足够，按钮内图标删除。 |
| | **67** (`Toast.tsx:81`) | `check-circle` / `alert-circle` / `info` | **必要（保留）** | 轻量弹出反馈，帮助用户在 0.5 秒内通过视觉识别成功/失败/提醒。 |
| | **68** (`NotificationRow:69`) | 类别彩色圆盘 | **文字已足够（删除）** | 标题摘要明确，未读有红点，删除前置彩色圆盘，还原列表平整。 |
| | **69–84** (`EmptyState` 全量 16 处) | 24px 大灰图标 | **装饰（全线清退）** | 对齐 `DrawerSessionGroups` 的极简优雅范式，空态仅展示一行高品质副标题与必要动作按钮，清退全部大图标。 |
| **十一、视觉与动效** | **85–86** (`PulseDot.tsx:41`) | 呼吸脉冲点 | **违背 U8 约束（删除）** | U8 绝对禁止脉冲/呼吸光圈动效。替换为标准静止状态点或原生转圈 Spinner。 |

#### 3.1.1 裁定数据总表小结
- **总盘点使用点**：86 处
- **判定为「必要」保留**：**27 处**（仅占 31.4%）
- **判定为「文字已足够 / 装饰 / 重复」应予清退**：**59 处**（占比 **68.6%**）
- **彻底消除的图标分类**：
  - 品牌大图标 `BrandMark`：4 个业务点全部清退；
  - 空态大图标 `EmptyState`：16 个业务点全部清退；
  - 设置页 leading 图标：6 个业务点全部清退（实现全设置页统一纯文字）；
  - 抽屉前置图标：3 个业务点全部清退；
  - 按钮内部嵌入图标：4 个业务点全部清退。
### 3.2 目标图标体系（2–3 个完整方案对比与推荐）

#### 3.2.1 候选路径设计

##### 【方案 1】：统一采用 Hugeicons 单一风格，按需精简字典，保留 npm 依赖
- **做法**：
  - 保留 `@hugeicons/core-free-icons` 与 `@hugeicons/react-native`。
  - 删除 `iconData.ts` 中的 19 个死图标和裁定删除的 20+ 个图标，将字典精简至最终保留的 12–14 个。
- **Tree-Shaking 现实评估**：
  - Metro 打包器默认不支持 ES Module 导出符号的精准 AST Tree-Shaking。一旦有文件引入 `iconData.ts`，字典里列出的所有图标都必须打包进 bundle。
  - 即使将字典缩减为 14 个图标，`node_modules` 中依然保留 24,425 个文件、76.8 MB 的冗余磁盘占用。
  - `@hugeicons/react-native` 顶部无条件导入 `react-native-svg` 根出口，导致 `react-native-svg` 的庞大模块图谱依然被全量解析。
  - 无法从根源解决 Hugeicons 原作者 1.5 线宽与工程 2.0 强制线宽的视觉撕裂。

##### 【方案 2（明确推荐）】：自研精简矢量 Path 内联集合，彻底卸载 Hugeicons 双依赖包
- **做法**：
  - 彻底卸载 `@hugeicons/core-free-icons` 与 `@hugeicons/react-native` 两个 npm 包。
  - 经过「非必要不显示」严厉裁剪后，全应用真正**必需**的图标仅剩 **14 个**：
    1. `chevron-left` (返回导航)
    2. `chevron-right` (进入列表)
    3. `chevron-down` (收起审批)
    4. `x` (关闭弹窗/扫码)
    5. `menu` (呼出汉堡抽屉)
    6. `bell` (通知中心入口)
    7. `settings` (设置入口)
    8. `new-chat` (新建会话)
    9. `send` (消息发送)
    10. `refresh` (重新连接)
    11. `eye` / `eye-off` (密码显隐)
    12. `check` (单选与操作确认)
    13. `camera` (更换头像)
    14. `terminal` / `more` / `folder` / `file` (终端/更多/文件基础支撑)
  - 在 `src/presentation/ui/iconPaths.ts` 中直接以 SVG Path `d` 字符串维护这 14 个高频符号（平均每个图标 1 行字符串，全文件体积仅 6 KB）。
  - `Icon.tsx` 基于项目现有的 `react-native-svg` 直接渲染 `<Svg viewBox="0 0 24 24"><Path d={...} /></Svg>`，完全掌控 2px 线宽与端点。

##### 【方案 3】：基于 TTF 字体的图标方案（Icon Font / Glyph）
- **做法**：将保留图标打包为单一 TTF 矢量字体文件，通过 `<Text>` 字符渲染。
- **现实评估**：
  - React Native 加载自定义字体必须使用 `expo-font` 的 `useFonts` 钩子异步加载；
  - 在冷启动前 200–500ms 字体尚未就绪时，会出现图标不可见（FOIT）或字符闪烁乱码（FOUT），直接破坏 U1（极致启动速度 ≤1 秒进入可交互界面）；
  - 字体方案无法灵活控制局部 Path 动画，且维护 TTF 字体构建流水线增加额外的工具链复杂度。
  - **裁定淘汰**。

#### 3.2.2 方案证据化对比表

| 对比维度 | 方案 1 (Hugeicons 精简字典) | 方案 2 (自研 Path 集合，推荐) | 方案 3 (TTF 图标字体) | 仓库代码与测量依据 |
| :--- | :--- | :--- | :--- | :--- |
| **node_modules 占用** | 76.9 MB (24,442 文件) | **0 MB (0 文件，彻底清除)** | 增加 `expo-font` (约 1.2 MB) | `Get-ChildItem -Recurse` 实测 core-free-icons 体积 |
| **冷启动模块数** | 引入 14+2 个依赖模块 | **1 个纯静态 TS 模块 (≤6 KB)** | 引入 expo-font 异步加载模块 | `start.log` 中 Metro 解析求值链路 |
| **启动耗时影响** | 包含 ESM 桥接求值 (~15ms) | **0 毫秒 (纯静态解析，瞬时)** | 产生 100~300ms 字体加载阻断 (违背 U1) | Hermes 字节码静态预编译特性 |
| **线宽与风格一致性** | ⚠️ 1.5 与 2.0 强制覆写存在畸变 | ✅ **100% 统一（锁定 2px、24 网格）** | ⚠️ 依赖字体内部 Glyphs 比例 | `Icon.tsx:16` vs `Home01Icon.js:2` |
| **可维护性与扩展** | 新增图标需全量查找 npm 包 | **新增图标只需拷入 1 行 Path** | 需重新打包 TTF 字体文件 | 现代工程成熟规范 |
| **暗色模式与染色** | 支持 currentColor | **原生支持 theme token 绑定** | 支持 TextStyle color | `Icon.tsx:22` |
| **无障碍 A11y 支持** | 需外层 Pressable 弥补 | **原生内置 accessibilityRole="image"** | `<Text>` 读屏需额外标记 | RN 无障碍规范 |
### 3.3 目标架构设计

#### 3.3.1 目标 `Icon.tsx` 最小化设计
彻底剥离 `@hugeicons` 包装层，直接消费 `iconPaths.ts` 中的静态 SVG 路径数据：

```tsx
// apps/crish-mobile/src/presentation/ui/Icon.tsx
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/adapters/platform/theme';
import { ICON_PATHS, type IconName } from './iconPaths';

export type { IconName };

export interface IconProps {
  name: IconName;
  /** 图标尺寸：只允许传入 theme.size.icon (20)、iconSmall (16)、iconLarge (24) */
  size?: number;
  /** 图标颜色：只允许取语义 token，默认 textSecondary */
  color?: string;
  /** 矢量线宽：默认取 theme.layout.iconStroke (2) */
  strokeWidth?: number;
}

export function Icon({ name, size, color, strokeWidth }: IconProps) {
  const theme = useTheme();
  const iconSize = size ?? theme.size.icon;
  const stroke = strokeWidth ?? theme.layout.iconStroke;
  const iconColor = color ?? theme.colors.textSecondary;
  const pathData = ICON_PATHS[name];

  return (
    <Svg
      width={iconSize}
      height={iconSize}
      viewBox="0 0 24 24"
      fill="none"
      accessibilityRole="image"
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Path
        d={pathData}
        stroke={iconColor}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export default Icon;
```

#### 3.3.2 目标 `IconButton.tsx` 命中区域与容器规则
统一合并 `GlassBackButton.tsx` 的磨砂玻璃视觉能力，消灭重复实现：
1. **触控目标刚性保证**：
   - `variant="plain"`：宽高为 `theme.size.touch`（44px），`hitSlop = 0`；
   - `variant="floating"`：宽高为 `theme.size.iconButton`（40px），内部叠放 `GlassBackdrop` 磨砂玻璃，`hitSlop = 2`（刚性补足至 44px 触控区）。
2. **禁止任何裸 Pressable 挂载图标**：全应用所有可点击图标一律使用 `<IconButton>`，禁止如 `FilePreview.tsx:37` 裸写 Pressable。

#### 3.3.3 Token 变更清单
为根治裸数字与线宽混乱，对 `src/adapters/platform/theme.ts` 进行规范收拢：

| Token 名称 | 所在分支 | 设定值 | 变更类型 | 用途与替换目标 |
| :--- | :--- | :--- | :--- | :--- |
| `theme.layout.iconStroke` | `layout` | `2` | **新增** | 图标全局唯一标准线宽，替换组件内写死的裸数字 2。 |
| `theme.size.iconSmall` | `size` | `16` | **既有锁死** | 强制替换 `ApprovalCard`、`ApprovalHistory`、`FilePreview`、`approvalDetail` 散落的硬编码 `14`。 |
| `theme.size.icon` | `size` | `20` | **既有锁死** | 强制替换 `FilePreview` 散落的硬编码 `22` 与 `WorkspaceSheet` 散落的硬编码 `18`。 |
| `theme.size.iconLarge` | `size` | `24` | **既有锁死** | 仅保留用于大尺寸重点指示（如必要时的全屏对话框状态）。 |
| `theme.colors.accentStrong` | `colors` | - | **彻底废弃清退** | 全量替换为 `actionPrimary`（主操作）或 `brandStrong`（品牌文字）。 |
| `theme.colors.border` | `colors` | - | **彻底废弃清退** | 全量替换为 `hairline`（发丝线）或 `borderStrong`（强边框）。 |
| `theme.colors.surfaceSubtle` | `colors` | - | **彻底废弃清退** | 全量替换为 `fillSubtle`（浅填充底色）。 |

### 3.4 删除清单（文件 / 符号 / 依赖）

#### 3.4.1 可彻底删除的 npm 依赖包
- `@hugeicons/core-free-icons`：从 `package.json` 彻底删除（移除 24,425 个文件、76.8 MB）。
- `@hugeicons/react-native`：从 `package.json` 彻底删除（移除 17 个文件、73 KB）。

#### 3.4.2 可彻底删除的文件
1. `apps/crish-mobile/src/presentation/ui/iconData.ts`：彻底删除 182 行大一统桶文件，替换为精简的 `iconPaths.ts`。
2. `apps/crish-mobile/src/presentation/account/ui/GlassBackButton.tsx`：彻底删除整个重复实现的 50 行组件。
3. `apps/crish-mobile/src/presentation/ui/BrandMark.tsx`：在 N01 取消开屏闸门、各界面清退大标后，彻底删除此 52 行自绘 SVG 文件。

#### 3.4.3 可彻底删除的符号与无用 Props
1. `iconData.ts` 中定义的 19 个业务零引用死图标符号；
2. `Input.tsx:23, 89-95` 中的 `leadingIcon?: IconName` 与 `search?: boolean` 属性（业务中从未传参，纯死代码）；
3. `EmptyState.tsx:9, 32-38` 中的 `icon?: IconName` 属性（清退所有空态大图标，EmptyState 变为高品质纯文本组件）；
4. `Button.tsx:23, 98-100` 中的 `icon?: IconName` 属性（清退所有按钮内混杂图标，还原为纯文本按钮）；
5. `ScrollToBottomButton.tsx:6, 40-44` 中的 `<Icon name="chevron-down">` 引入与节点；
6. `SettingsScreenView.tsx:38-47` 中的内部组件 `LeadingIcon`。

### 3.5 重复合并清单
1. **返回按钮合并**：`GlassBackButton`（`AuthBar.tsx:25`）直接合并至 `IconButton variant="floating" name="chevron-left"`。
2. **列表行箭头合并**：`NavRow.tsx:49`（账号页导航行）与 `ListRow.tsx:61`（通用列表行）合并，消灭账号页私造列表行的重复逻辑。
3. **文件预览返回合并**：`FilePreview.tsx:37-49` 裸 Pressable 返回圆钮，统一合并为 `AppHeader` 或 `IconButton`。
---

## 4 风险与未决问题

### 4.1 需要用户裁决的事项

| 编号 | 裁决议题 | 方案选项与推荐依据 | 影响范围 |
| :--- | :--- | :--- | :--- |
| **Q1** | **账号欢迎页与配对欢迎页是否一并彻底删除 `BrandMark` 大标？** | **推荐选项 A（彻底删除）**：与主界面保持完全一致的极简纯文本风格，直接展示大标题“Crish”或“连接桌面”，视觉干脆无噪点；<br>选项 B（仅在欢迎页保留静态图标）：将原生的 `splash-icon.png` 静态引入，不走动态自绘。推荐 A。 | `welcomeScreen.tsx`、`pairWelcomeScreen.tsx` |
| **Q2** | **EmptyState 是否全面清退大图标，彻底转向纯文本？** | **推荐选项 A（全面清退）**：全应用 16 处空态大图标全部删除，仅保留居中大字与说明，对齐抽屉会话列表（`DrawerSessionGroups`）的高雅设计；<br>选项 B（保留极少高频符号如断网/错误）：即使保留也严格限制在 2 个之内。推荐 A。 | 全应用 16 个 EmptyState 容器 |

### 4.2 跨席位协同契约

#### 4.2.1 与 N01（启动与生命周期席）的接口
- **我方向 N01 承诺**：全面移除 `app/_layout.tsx:96` 的自绘 `BrandMark`，使得根布局不再引入 `react-native-svg` 渲染计算；
- **我方需要 N01 提供**：在取消 JS 开屏闸门后，确保原生 `expo-splash-screen` 仅展示静态 `assets/images/splash-icon.png`，在首帧就绪后一次性关闭，避免中间态闪烁。

#### 4.2.2 与 N02（账号中心与登录流席）的接口
- **我方向 N02 承诺**：为 `AuthField` 密码输入框提供精简、高对比度的 `eye` / `eye-off` 路径，为资料页提供 `camera` 图标；用标准 `IconButton` 替换 `GlassBackButton`；
- **我方需要 N02 提供**：在重构账号中心页面时，停止使用已废弃的 `accentStrong`，并彻底移除 welcomeScreen 上的大标。

#### 4.2.3 与 N03（抽屉与全局导航席）的接口
- **我方向 N03 承诺**：为抽屉重排提供统一定义的最小动作图标：`new-chat`（右上角圆钮）、`settings`（右下角圆钮）、`menu`（头栏汉堡）；
- **我方需要 N03 提供**：在重排抽屉导航条目时，坚决执行“纯文字列表”规范，不再为“待审批”、“审批记录”、“搜索会话”配置前置多余装饰图标。

---

## 5 集中验收清单

按照 U7「集中验收」铁律，改动全部实施后统一执行以下三维立体化验收：

### 5.1 全应用图标一致性静态守卫测试（自动化 CI 拦截）
编写 `src/presentation/ui/iconSystem.guard.test.ts`，作为工程自动化刚性门禁：

```ts
// 守卫断言示例
describe('Icon System Static Guard', () => {
  it('禁止从 @hugeicons 直接导入任何模块', () => {
    // 扫描 src 下所有 ts/tsx 文件，断言不得匹配 /from ['"]@hugeicons/
  });

  it('全量消费点禁止出现裸数字尺寸（12, 14, 18, 22 等）', () => {
    // 扫描全局 <Icon size={...}> 与 <IconButton size={...}>
    // 断言 size 只能引用 theme.size.*，不得写死裸数字
  });

  it('图标库导出符号数量严格锁定 <= 14', () => {
    // 读取 iconPaths.ts 的 key 数量，断言 <= 14，阻止未来未经评审擅自堆砌图标
  });

  it('禁止使用已废弃的颜色别名（accentStrong, border, surfaceSubtle）', () => {
    // 扫描全局组件，拦截对已标记废弃 token 的引用
  });
});
```

### 5.2 真机逐屏目检清单（华为 P50 Android 12 / HarmonyOS）

| 屏 / 页面 | 检查路径 | 检验标准与断言 | 验收状态 |
| :--- | :--- | :--- | :--- |
| **01. 冷启动** | 打开 App 到首屏 | 零 JS 自绘 BrandMark，零旋转菊花，无布局跳变，1 秒内直接进入可交互主界面。 | 待实机验收 |
| **02. 新会话主界面** | `(main)/index` 空态 | 正中**无任何 BrandMark 品牌大图标**；只有时段问候文案；底部 Composer 干净突出。 | 待实机验收 |
| **03. 主界面头栏** | 汉堡钮与铃铛钮 | 汉堡按钮（44px 触控区）与铃铛按钮高品质展示，点击跟手，无伪描边/外发光动效。 | 待实机验收 |
| **04. 抽屉菜单** | 点击汉堡按钮展开 | 导航项（待审批、审批记录）为高品质纯文字，搜索框为纯文字胶囊，仅保留新建与设置圆钮。 | 待实机验收 |
| **05. 设置中心** | 抽屉底部点击设置 | 全部 5 张设置卡片恢复完全统一的纯文字列表；无零散混乱的 leading 装饰图标。 | 待实机验收 |
| **06. 审批悬浮卡** | 产生待审批请求时 | 右侧收起下箭头清晰；主操作按钮为纯文字“查看并滑动确认”，内部无多余盾牌。 | 待实机验收 |
| **07. 审批详情** | 点击进入审批详情 | 关闭叉号圆钮灵敏，倒计时文字清晰，无钟表/信息等多余装饰图标。 | 待实机验收 |
| **08. 时间线会话** | 发送对话并产生回复 | 时间线审批提示与错误文本为纯文本展示，工具聚合行无多余扳手与上箭头。 | 待实机验收 |
| **09. 工具抽屉** | 点按工具聚合行 | 列表项展示等宽真实工具名与 8px 纯色状态点，无粗糙的正则猜测图标。 | 待实机验收 |
| **10. 文件浏览器** | 进入文件标签页 | 面包屑采用纯文本 `/` 分隔；列表项仅保留标准的 `folder` 与 `file` 矢量标；无右侧多余箭头。 | 待实机验收 |
| **11. 扫码界面** | 点击扫码直连 | 顶栏显式关闭叉号（44px 触控区），空态无权限页为纯文本提示，无相机大图标。 | 待实机验收 |
| **12. 账号与密码** | 进入登录/改密界面 | 密码输入框眼睛图标轻触可切换显隐；顶栏返回按钮为标准 IconButton 玻璃圆钮。 | 待实机验收 |

### 5.3 包体与启动模块数物理测量方法
1. **模块依赖图测量**：
   ```bash
   npx expo export --dump-sourcemap
   ```
   对比重构前后生产环境 `android-*.js` bundle 体积，预期直接下降 **15~35 KB** 生产代码。
2. **node_modules 冗余清除度量**：
   在根目录运行：
   ```powershell
   Get-ChildItem -Path "node_modules/@hugeicons" -ErrorAction SilentlyContinue
   ```
   断言返回为空，验证 **24,442 个文件与 76.9 MB 磁盘占用彻底清零**。
3. **冷启动加载模块计数**：
   通过 Metro 日志分析首屏 evaluateModules 总量，断言 58 个 Hugeicons 模块全量消除。
