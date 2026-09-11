# 专项审计报告 10：UI 规范、主题与交互 (ui-specification-and-interaction)

> **审计基准**：`apps/crish-mobile`（Expo SDK 57 / React Native 0.86 / React 19.2.3）
> **调查员**：UI 规范、主题与交互调查员
> **产出时间**：2026-09-04
> **规范依据**：
> - 仓库根目录《AGENTS.md》（§12 Tooltip/悬停提示、§13 输入框与焦点态、§14 色彩空间与现代 CSS/RN 语法、§10 项目设计约定、§7 严禁补丁与作弊、§7.1 立体验证纪律）
> - 移动端设计基线 M4（UI 规范）/ 体验基线 R2UX / 双轨热区 A1 裁决（iOS 44pt / Android 48dp）
> **审计范围**：
> - `apps/crish-mobile/src/presentation/components/ui/` (`Button.tsx`, `Dialog.tsx`, `hitTargets.ts`, `index.ts`)
> - `apps/crish-mobile/src/presentation/pair/` (`pairManualScreen.tsx`, `pairScanScreen.tsx`, `pairWelcomeScreen.tsx`, `pairingBootstrap.ts`)
> - `apps/crish-mobile/src/presentation/screens/` (`approvalListScreen.tsx`, `approvalDetailScreen.tsx`, `notificationCenterScreen.tsx`, `sessionsScreen.tsx`, `sessionDetailScreen.tsx`, `runDetailScreen.tsx`, `terminalScreen.tsx`)
> - `apps/crish-mobile/src/presentation/components/blocks/` (`ApprovalCard.tsx`, `ApprovalActionBar.tsx`, `ApprovalBadge.tsx`, `SlideToConfirm.tsx`, `EventFeed.tsx`, `EventRow.tsx`, `StreamingText.tsx`)
> - `apps/crish-mobile/src/presentation/components/dashboard/` (`QuickRunPanel.tsx`, `DashboardSkeleton.tsx`)
> - `apps/crish-mobile/src/presentation/components/files/` (`FileBrowser.tsx`, `FilePreview.tsx`, `FileBreadcrumb.tsx`, `FileRow.tsx`, `WorkspaceSwitcher.tsx`, `fileMeta.ts`)
> - `apps/crish-mobile/src/presentation/components/notifications/` (`NotificationRow.tsx`, `NotificationBadge.tsx`)
> - `apps/crish-mobile/src/presentation/components/runDetail/` (`RunControlBar.tsx`, `RunDetailHeader.tsx`, `RunDetailTimeline.tsx`)
> - `apps/crish-mobile/src/presentation/components/settings/` (`SettingsScreenView.tsx`, `SettingsThemeSelector.tsx`, `SettingsSwitchRow.tsx`, `SettingsAboutCard.tsx`, `SettingsRemoveLocalZone.tsx`, `SettingsGroup.tsx`)
> - `apps/crish-mobile/src/presentation/components/templates/` (`PlaceholderScreen.tsx`, `ProtectedPlaceholder.tsx`)
> - `apps/crish-mobile/src/adapters/platform/theme.ts` 与 `apps/crish-mobile/src/adapters/settings/themeProjection.ts`

---

## 模块架构全景

```
                               ┌───────────────────────────┐
                               │  System useColorScheme()  │
                               └─────────────┬─────────────┘
                                             │
                                             ▼
┌─────────────────────────┐      ┌─────────────────────────┐
│ themeModeStore(Zustand) │ ───> │ projectThemeTokens (纯) │
│ - mode: system|light|dark│      │ - lightTokens           │
└────────────┬────────────┘      │ - darkTokens            │
             │                   └───────────┬─────────────┘
             │                               │
             ▼                               ▼
┌──────────────────────────────────────────────────────────┐
│ useTheme() / useAppTheme() (统一出口)                    │
│ - theme.ts 单一真源 (下沉至 platform 层)                 │
│ - themeProjection.ts 兼容重导出层                        │
└────────────────────────────┬─────────────────────────────┘
                             │
       ┌─────────────────────┼─────────────────────┐
       ▼                     ▼                     ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  Atomic UI   │      │  Domain UI   │      │ Screen Views │
│ - Button     │      │ - FileBrowser│      │ - Sessions   │
│ - Dialog     │      │ - Approval*  │      │ - Approvals  │
│ - dualHitSlop│      │ - Terminal   │      │ - Settings   │
│ ⚠️ 缺失 Input│      │ - QuickRun   │      │ - PairManual │
│ ⚠️ 缺失 Tip  │      │ - EventFeed  │      │ - RunDetail  │
└──────────────┘      └──────────────┘      └──────────────┘
```

---

## 一、【AGENTS.md 合规度对照表】

对照《AGENTS.md》§12（Tooltip/悬停提示）、§13（输入框与焦点态）、§14（色彩空间与现代 CSS/RN 语法）及通用设计准则对移动端全部呈现层组件进行的专项合规核查：

| 条款编号 | 规范核心准则 | 移动端合规现状 | 判定 | 涉及主要文件与行号 | 关键缺陷表现 |
| :--- | :--- | :--- | :---: | :--- | :--- |
| **§12 Tooltip / 悬停提示** | 必须使用项目自定义 `<Tooltip>` 组件，避免浏览器原生默认气泡，提供圆角胶囊与主题色柔和提示。 | **完全缺失**。移动端无任何 Tooltip / 悬浮气泡 / 长按提示组件。 | ❌ **严重不合规** | `presentation/components/ui/index.ts:1-6` | 截断文本（如会话标题、文件路径、事件长文案）在末尾显示 `…` 后用户无任何手段查看完整内容；图标按钮仅有读屏 `accessibilityLabel`，普通视觉用户缺乏任何提示。 |
| **§13 输入框阴影** | 默认不要重阴影：输入框、搜索框、composer 默认不得添加厚重 `box-shadow`。 | **合格**。两处输入框均未添加任何 `shadowColor` 或 `elevation`，保持扁平。 | ✅ **合规** | `pairManualScreen.tsx:393`<br>`QuickRunPanel.tsx:245` | 输入框保持平整线框结构，无重投影。 |
| **§13 激活边框与焦点对比度** | 禁止粗、深、实心黑边；边框只比背景略深；焦点变化须可见但柔软（约 6% 混合量级，对比度上限约 10%）。 | **分化严重**。<br>- `pairManualScreen` 合规落地；<br>- `QuickRunPanel` **完全遗漏焦点态**。 | ⚠️ **部分违规** | `pairManualScreen.tsx:68-69, 274`<br>`QuickRunPanel.tsx:109` | `QuickRunPanel` 的 `quickrun-input` 无 `onFocus`/`onBlur` 处理，聚焦时边框恒定为静态细线 `theme.hairline`，完全没有焦点感知。 |
| **§13 原子 Input 封装** | 输入框应当具备统一的原子组件约束与单一真理抽象。 | **完全缺失**。`components/ui/` 未提供 `Input` 组件，各业务页面重复造轮子。 | ❌ **严重违规** | `components/ui/index.ts:1`（注释写了但未实现） | `pairManualScreen` 与 `QuickRunPanel` 各自编写原生 `TextInput` 样式，逻辑分散且行为不一致。 |
| **§14 色彩空间规范** | 优先 HSLA / 斜杠透明度；避免散落旧式 `rgba(...)`；杜绝组件硬编码色值。 | **大量违背**。<br>1. Token 板残留 Hex / 旧式 rgba；<br>2. 业务组件多处硬编码 Hex。 | ❌ **严重违规** | `theme.ts:22-38, 49-66`<br>`fileMeta.ts:118-126`<br>`WorkspaceSwitcher.tsx:209`<br>`PlaceholderScreen.tsx:37` | `fileMeta.ts` 硬编码 5 个 Hex 文件类型图标色；`theme.ts` 存在 `#111111`、`rgba(85,85,85,0.7)`；`WorkspaceSwitcher` 遮罩硬编码 `'rgba(0,0,0,0.45)'`。 |
| **§10 杜绝过时原生样式** | 自研轻量组件，避免跨平台原生宿主差异与平台陈旧外观。 | **部分违背**。混用了原生 `Modal` 与原生 `Switch`。 | ⚠️ **部分违规** | `WorkspaceSwitcher.tsx:12, 67`<br>`SettingsSwitchRow.tsx:7, 60` | `Dialog.tsx` 明确指出“自研 overlay，不用 RN Modal 避免平台宿主差异”，但 `WorkspaceSwitcher` 却引入了 RN 原生 `Modal`；`SettingsSwitchRow` 裸用平台原生 `Switch`。 |
| **A1 触控热区准则** | 双轨热区：iOS 44pt 视觉下限，Android 48dp 命中热区；小元素必须补足 `dualHitSlop`。 | **多处遗漏**。核心工具存在，但大量交互元素与按钮漏设 `dualHitSlop`。 | ❌ **严重违规** | `EventFeed.tsx:202`<br>`QuickRunPanel.tsx:158`<br>`FilePreview.tsx:46`<br>`terminalScreen.tsx:147` 等 | 详见第三章，共计 16 处触控尺寸不足且未设 hitSlop 的违规点。 |

---

## 二、【焦点态 / 色彩 / 热区缺陷】深度审计

### 2.1 输入框与焦点态审计

#### 1. `pairManualScreen.tsx` 的焦点态实现（良好参考，但存在局部硬编码）
- **实现位置**：`apps/crish-mobile/src/presentation/pair/pairManualScreen.tsx:68-70, 238-245, 274, 294`
- **代码实现**：
  ```tsx
  // 焦点边框（R2UX §13：焦点态须可见但柔软——hairlineStrong 向 textPrimary
  // 混入约 6%，不取深黑实线；token 面无焦点专用项，本处按规范量级落地）
  const FOCUS_BORDER_LIGHT = 'hsl(35,10%,81%)';
  const FOCUS_BORDER_DARK = 'hsl(0,0%,23%)';

  const themeMode = useThemeMode((s) => s.mode);
  const systemScheme = useColorScheme();
  const effectiveDark =
    themeMode === 'dark' || (themeMode === 'system' && systemScheme === 'dark');
  const focusBorder = effectiveDark ? FOCUS_BORDER_DARK : FOCUS_BORDER_LIGHT;
  ```
- **对比度核算**：
  - 浅色模式：基线边框 `hairlineStrong` 为 `hsl(35,10%,86%)`，焦点边框 `FOCUS_BORDER_LIGHT` 为 `hsl(35,10%,81%)`，亮度仅加深 5%，对文本色 `textPrimary`（`#111111`）的加深混入量级约为 **5.8%**，完美处于 AGENTS.md §13 规定的“3%~6% 柔和混入，上限不超过 10%”红线之内。
  - 深色模式：基线边框 `hairlineStrong` 为 `hsl(0,0%,18%)`，焦点边框 `FOCUS_BORDER_DARK` 为 `hsl(0,0%,23%)`，亮度提亮 5%，混入量级约 **5%**。
  - 扁平度：无 `box-shadow` / `elevation`，无粗黑实线黑环，边框宽度恒定为 1。
- **架构缺陷**：
  - 该优秀实践仅作为局部常量定义在单个屏幕内，未能提升至 `theme.ts`（例如 `theme.focusBorder`）或沉淀为公共组件。
  - 需手动在组件内维护 `focusedField` 状态（`focusedField === 'host'`, `focusedField === 'code'`），代码侵入性高。

#### 2. `QuickRunPanel.tsx` 的焦点态缺失（严重缺陷）
- **实现位置**：`apps/crish-mobile/src/presentation/components/dashboard/QuickRunPanel.tsx:102-120`
- **代码实现**：
  ```tsx
  <TextInput
    testID="quickrun-input"
    style={[
      styles.input,
      {
        backgroundColor: theme.bgSecondary,
        color: theme.textPrimary,
        borderColor: theme.hairline,
      },
    ]}
    placeholder="输入任务描述，发起 run"
    placeholderTextColor={theme.textTertiary}
    value={vm.prompt}
    onChangeText={vm.setPrompt}
    editable={vm.connected && !vm.busy}
    returnKeyType="send"
    onSubmitEditing={vm.submit}
    maxLength={4096}
  />
  ```
- **缺陷分析**：
  - **零焦点反馈**：未挂载 `onFocus` 或 `onBlur` 事件，未配置任何聚焦边框高亮。在真实手机端输入时，光标虽然闪烁，但输入框容器边缘没有任何视觉反馈（border 始终为微弱的 `theme.hairline`）。
  - **禁用态未弱化**：在未连接（`!vm.connected`）或忙碌（`vm.busy`）时，虽然通过 `editable` 锁死了键盘，但输入框本身的背景色和边框透明度没有任何变化（只有提交按钮加了 `submitDisabled: { opacity: 0.5 }`），导致用户误以为输入框可以点击。

#### 3. 原子 `Input` 组件的彻底缺席
- `apps/crish-mobile/src/presentation/components/ui/index.ts` 声明：
  ```ts
  // 原子组件（M4 §3.7 清单：Button/Input/Card/Badge/Chip/ListRow/…，自研轻量不引三方库）
  export { default as Button } from './Button';
  export { default as Dialog } from './Dialog';
  ```
- 目录内仅存在 `Button.tsx` 与 `Dialog.tsx`。缺少 `Input.tsx`，导致输入框的边框克制逻辑、禁用态视觉、焦点动效、高度规范在各处各自为政或彻底遗漏。

---

### 2.2 色彩空间与设计 Token 规范审计

#### 1. Token 基线定义分析（`theme.ts`）
- `apps/crish-mobile/src/adapters/platform/theme.ts` 在 R2-05 中已将大部分背景和语义色迁移至 `hsl(...)`，但仍违反 §14“优先 HSLA / 斜杠透明度，避免散落旧式 rgba(r,g,b,a) 与 Hex”：
  ```ts
  // lightTokens 残留非 HSLA:
  textPrimary: '#111111',               // ⚠️ 应为 hsl(0 0% 7%)
  textSecondary: '#555555',             // ⚠️ 应为 hsl(0 0% 33%)
  textTertiary: 'rgba(85,85,85,0.7)',   // ❌ 应为 hsl(0 0% 33% / 0.7)
  textOnAccent: '#ffffff',              // ⚠️ 应为 hsl(0 0% 100%)
  textOnDanger: '#ffffff',              // ⚠️ 应为 hsl(0 0% 100%)
  backdrop: 'rgba(0,0,0,0.45)',         // ❌ 应为 hsl(0 0% 0% / 0.45)

  // darkTokens 残留非 HSLA:
  textPrimary: '#f0f0f0',               // ⚠️ 应为 hsl(0 0% 94%)
  textSecondary: '#a3a3a3',             // ⚠️ 应为 hsl(0 0% 64%)
  textTertiary: 'rgba(163,163,163,0.62)', // ❌ 应为 hsl(0 0% 64% / 0.62)
  backdrop: 'rgba(0,0,0,0.45)',         // ❌ 应为 hsl(0 0% 0% / 0.45)
  ```

#### 2. 组件内硬编码颜色逃逸（严重违规点）
1. **`fileMeta.ts:115-128` 硬编码 5 种 Hex 图标颜色**：
   ```ts
   export function fileKindColor(kind: FileKind): string {
     switch (kind) {
       case 'text': return '#2F6FEB';
       case 'image': return '#2E9E5B';
       case 'pdf': return '#D64545';
       case 'table': return '#E08A00';
       case 'binary': return '#7A7A7A';
     }
   }
   ```
   - 彻底脱离了 `useTheme()` 体系，未注入深色模式适配，违背《AGENTS.md》§10“组件禁止硬编码色值/间距，一律经 useTheme() 取 token”的红线！
2. **`WorkspaceSwitcher.tsx:209` 遮罩底色硬编码**：
   ```tsx
   backdrop: {
     position: 'absolute',
     top: 0, left: 0, right: 0, bottom: 0,
     backgroundColor: 'rgba(0,0,0,0.45)', // ❌ 未使用 theme.backdrop
   }
   ```
3. **`SlideToConfirm.tsx:359` 阴影颜色硬编码**：
   ```tsx
   thumb: {
     shadowColor: '#000000', // ⚠️ 未使用设计 token
     shadowOpacity: 0.12,
   }
   ```
4. **`PlaceholderScreen.tsx:37` 纯硬编码无主题**：
   ```tsx
   description: {
     fontSize: 13,
     color: '#555555', // ❌ 未引入 useTheme，纯静态 Hex
   }
   ```

---

### 2.3 触控热区（dualHitSlop）全面排查（iOS 44pt / Android 48dp）

#### 1. 双轨热区机制评估
- 工具实现：`presentation/components/ui/hitTargets.ts`。
  - 单边补足：`padToTarget(visual, target) = Math.ceil((target - visual) / 2)`。
  - iOS 目标 `44pt`，Android 目标 `48dp`。
  - 纯函数单测覆盖完备（`hitTargets.test.ts` 100% 覆盖）。

#### 2. 交互元素热区与 hitSlop 覆盖普查表（全量盘点）

| 序号 | 所在组件 / 屏幕 | 交互元素 (testID / Role) | 视觉尺寸 (高×宽) | 是否设 dualHitSlop | 实际命中热区 (iOS / Android) | 合规判定 | 根因与改进措施 |
| :---: | :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| 1 | `Button.tsx` | 原子按钮 (Pressable) | `minHeight: 44` (宽度自适应) | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | Android 平台 M3 规范要求热区 48dp，应在 Android 下将 `minHeight` 设为 48 或补足 hitSlop。 |
| 2 | `FileBreadcrumb.tsx` | 返回按钮 `files-back` | 36 × 36 | **是** `dualHitSlop(36, 36)` | 44pt / 48dp | ✅ **完全合规** | 模范实现，双轨计算补足。 |
| 3 | `FileBreadcrumb.tsx` | 面包屑段 `crumb` | `minHeight: 44` | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | Android 未达到 48dp。 |
| 4 | `FileBrowser.tsx` | 排序 Chip (`sort-*`) | `minHeight: 32` | **是** `dualHitSlop(32)` | 44pt / 48dp | ✅ **完全合规** | 模范实现。 |
| 5 | `FileBrowser.tsx` | 密度切换 `density-toggle` | `minHeight: 32` | **是** `dualHitSlop(32)` | 44pt / 48dp | ✅ **完全合规** | 模范实现。 |
| 6 | `FileBrowser.tsx` | 状态重试按钮 `files-retry` | `minHeight: 40` | **是** `dualHitSlop(40)` | 44pt / 48dp | ✅ **完全合规** | 模范实现。 |
| 7 | `FileRow.tsx` | 文件列表行 | `height: 44/48/56` | 否 | 44pt / **44dp (当密度为44时) ❌** | ⚠️ **低密度下 Android 短缺** | 密度为 44 时在 Android 平台未达到 48dp。 |
| 8 | `FilePreview.tsx` | 返回按钮 `preview-back` | 36 × 36 | **否 ❌** | **36pt ❌ / 36dp ❌** | ❌ **严重违规** | 视觉 36×36 且完全未设置 hitSlop，同款 `FileBreadcrumb` 拥有而此处遗漏！ |
| 9 | `FilePreview.tsx` | 重试与加载更多 `preview-retry` | `minHeight: 40` | **否 ❌** | **40pt ❌ / 40dp ❌** | ❌ **严重违规** | 高度 40dp，未补足到 44/48。 |
| 10 | `WorkspaceSwitcher.tsx` | 关闭按钮 `workspace-close` | 32 × 32 | **是** `dualHitSlop(32, 32)` | 44pt / 48dp | ✅ **完全合规** | 模范实现。 |
| 11 | `WorkspaceSwitcher.tsx` | 重试按钮 `workspace-retry` | `minHeight: 40` | **是** `dualHitSlop(40)` | 44pt / 48dp | ✅ **完全合规** | 模范实现。 |
| 12 | `WorkspaceSwitcher.tsx` | 工作区列表项 `workspace-item` | `minHeight: 56` | 否 | 56pt / 56dp | ✅ **完全合规** | 超过 48dp，无需 hitSlop。 |
| 13 | `SettingsAboutCard.tsx` | 重试刷新 `settings-about-refresh` | `minHeight: 28` | **是** `dualHitSlop(28)` | 44pt / 48dp | ✅ **完全合规** | 模范实现。 |
| 14 | `SettingsThemeSelector.tsx` | 主题分段项 `setting-theme-*` | `minHeight: 44` | **是** `dualHitSlop(44)` | 44pt / 48dp | ✅ **完全合规** | 针对 Android 专门补足了 4dp。 |
| 15 | `SettingsSwitchRow.tsx` | 原生开关行 | `minHeight: 48` | 否 | 48pt / 48dp | ✅ **完全合规** | 超过 48dp。 |
| 16 | `SettingsRemoveLocalZone.tsx` | 移除本机按钮 | `minHeight: 44` (Button) | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | 继承 Button 属性。 |
| 17 | `EventFeed.tsx` | 过滤 Chip (`feed-filter-*`) | `minHeight: 32` | **否 ❌** | **32pt ❌ / 32dp ❌** | ❌ **严重违规** | 注释明确写了“44pt 触控热区”，但实际代码完全遗漏了 `hitSlop`！极易误触。 |
| 18 | `EventRow.tsx` | 事件行 (仅展示) | `height: 56` | - | - | - | 非交互行。 |
| 19 | `QuickRunPanel.tsx` | 发起任务按钮 | `minHeight: 44` | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | Android 平台缺 4dp。 |
| 20 | `QuickRunPanel.tsx` | 会话选择 Chip (`quickrun-session-*`) | `minHeight: 36` | **否 ❌** | **36pt ❌ / 36dp ❌** | ❌ **严重违规** | 横向滚动的会话标签高度仅 36dp，无 hitSlop，在移动端很难精确点中。 |
| 21 | `QuickRunPanel.tsx` | 查看详情链接 `quickrun-open-run` | `minHeight: 44` | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | - |
| 22 | `SessionRow.tsx` | 会话行 `session-row-*` | `minHeight: 72` | 否 | 72pt / 72dp | ✅ **完全合规** | 超过 48dp。 |
| 23 | `ApprovalBadge.tsx` | 审批角标 (嵌入在行内可点) | `minHeight: 28` | **硬编码 8 ❌** | 44pt / **44dp ❌** | ❌ **严重违规** | 写死 `hitSlop={8}`，iOS 达到 44pt，但 Android 仍差 4dp，未接入 `dualHitSlop(28)`。 |
| 24 | `approvalListScreen.tsx` | 已处理入口 `history-entry` | `minHeight: 44, minWidth: 44` | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | - |
| 25 | `approvalListScreen.tsx` | 重试按钮 `approval-retry` | `minHeight: 44, minWidth: 64` | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | - |
| 26 | `approvalDetailScreen.tsx` | 返回按钮 `header-back` | `minHeight: 44, minWidth: 44` | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | - |
| 27 | `approvalDetailScreen.tsx` | 结果/空态返回 `stateBack` | `minHeight: 44, minWidth: 120` | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | - |
| 28 | `SlideToConfirm.tsx` | 滑轨滑块 (Thumb) | 44 × 44 | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | Android 平台命中热区下限为 48dp，44dp 滑块偏紧。 |
| 29 | `notificationCenterScreen.tsx`| 返回按钮 `header-back` | `minHeight: 44, minWidth: 44` | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | - |
| 30 | `notificationCenterScreen.tsx`| 全部已读 `mark-all-read` | `minHeight: 44, minWidth: 44` | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | - |
| 31 | `NotificationRow.tsx` | 通知行 | `minHeight: 72` | 否 | 72pt / 72dp | ✅ **完全合规** | 超过 48dp。 |
| 32 | `sessionDetailScreen.tsx` | 返回按钮 `header-back` | `minHeight: 44` (无 minWidth) | 否 | **<44pt ❌ / <48dp ❌** | ❌ **严重违规** | 仅设置 `minHeight: 44, paddingRight: 8`，宽度随文字，极窄。 |
| 33 | `sessionDetailScreen.tsx` | 回到底部 `session-back-to-bottom` | `minHeight: 36` | **是** `dualHitSlop(36)` | 44pt / 48dp | ✅ **完全合规** | 模范实现。 |
| 34 | `runDetailScreen.tsx` | 返回按钮 `run-detail-back` | `minHeight: 44` (无 minWidth) | 否 | **<44pt ❌ / <48dp ❌** | ❌ **严重违规** | 宽度不足且无 hitSlop。 |
| 35 | `runDetailScreen.tsx` | 打开终端 `run-detail-open-terminal` | `minHeight: 40` | **是** `dualHitSlop(40)` | 44pt / 48dp | ✅ **完全合规** | 模范实现。 |
| 36 | `runDetailScreen.tsx` | 回到底部 `run-back-to-bottom` | `minHeight: 36` | **是** `dualHitSlop(36)` | 44pt / 48dp | ✅ **完全合规** | 模范实现。 |
| 37 | `RunDetailTimeline.tsx` | 加载更早 `run-timeline-load-more` | `minHeight: 40` | **否 ❌** | **40pt ❌ / 40dp ❌** | ❌ **严重违规** | 视觉 40dp 且漏设 hitSlop。 |
| 38 | `terminalScreen.tsx` | 返回按钮 `header-back` | `minHeight: 44` (无 minWidth) | 否 | **<44pt ❌ / <48dp ❌** | ❌ **严重违规** | 宽度不足且无 hitSlop。 |
| 39 | `terminalScreen.tsx` | 回到底部 `terminal-back-to-bottom` | `minHeight: 36` | **否 ❌** | **36pt ❌ / 36dp ❌** | ❌ **严重违规** | 同款在 sessionDetail 和 runDetail 都加了 `dualHitSlop(36)`，此处遗漏！ |
| 40 | `pairWelcomeScreen.tsx` | 操作按钮 (Button) | `minHeight: 44` | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | - |
| 41 | `pairScanScreen.tsx` | 返回按钮 (Button) | `minHeight: 44` | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | - |
| 42 | `pairManualScreen.tsx` | 返回按钮 `backBtn` | 44 × 44 | 否 | 44pt / **44dp ❌** | ⚠️ **Android 短缺 4dp** | - |

---

## 三、【空态 / 错误态完备度与死卡片排查】

### 3.1 全屏幕四态（加载中 / 错误态 / 空态 / 数据态）矩阵普查

根据移动端设计基线（M4 §5.9），屏幕与业务容器必须完整覆盖 **加载中 (Loading)、错误态 (Error)、空态 (Empty)、数据态 (Data)** 四态，禁止呈现白屏、空白卡片或未处理的异常：

| 业务屏幕 / 容器 | 加载态 (Loading) | 错误态 (Error) | 空态 (Empty) | 数据态 (Data) | 触控按压反馈 (Pressed) | 完备度等级 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **`approvalListScreen`** | ✅ 菊花居中 (首帧) | ✅ 横幅提示 + 重试按钮 | ✅ 标题 + 解释副文案 | ✅ 列表渲染 | ❌ **审批卡外层 Pressable 无任何 pressed 反馈** | ⚠️ **B (交互体验差)** |
| **`approvalDetailScreen`**| ⚠️ 依赖外部透传，无局部骨架 | ⚠️ 仅收敛为结果态或空态 | ✅ 目标不存在/已过期提示 + 返回 | ✅ 详情卡 + 底部操作栏 | ⚠️ 卡片无按压态，返回按钮有反馈 | ⚠️ **B (四态弱化)** |
| **`sessionsScreen`** | ❌ **完全缺失加载态** | ❌ **完全缺失错误态** | ✅ 暂无会话文案 | ✅ FlatList + SessionRow | ✅ 行具有 `bgTertiary` 按压反馈 | ❌ **C (严重缺陷)** |
| **`sessionDetailScreen`**| ⚠️ 依赖事件流窗口 | ⚠️ 无独立整页错误态 | ✅ 空事件流占位 | ✅ 时间线虚拟列表 | ⚠️ 回到底部按钮有反馈，返回按钮无 | ⚠️ **B (四态弱化)** |
| **`runDetailScreen`** | ⚠️ 依赖事件流窗口 | ⚠️ 头部显示红色错误原因 | ✅ 暂无事件空态 | ✅ 头部 + 控制条 + 时间线 | ⚠️ 返回按钮无按压反馈 | ⚠️ **B (四态弱化)** |
| **`terminalScreen`** | ⚠️ 依赖行缓冲 | ⚠️ 状态点呈现红色，无全局错误态 | ✅ 暂无输出占位 | ✅ 等宽虚拟列表 | ❌ 回到底部悬浮条无按压反馈 | ⚠️ **B (四态弱化)** |
| **`notificationCenterScreen`**| ✅ `!hydrated` 菊花占位 | ❌ **完全缺失错误态** | ✅ 暂无通知文案 | ✅ FlatList + NotificationRow | ✅ 行具有 `bgTertiary` 按压反馈 | ⚠️ **B (缺失错误态)** |
| **`FileBrowser`** | ✅ `loading` 状态行 | ✅ 错误码转译 + 重试按钮 | ✅ 目录为空 + 刷新按钮 | ✅ 虚拟化文件列表 | ✅ 行与控制条全量 pressed 反馈 | 🏆 **A (设计模范)** |
| **`FilePreview`** | ✅ `loading` 菊花占位 | ✅ 错误码转译 + 重试按钮 | ✅ 3 类不支持占位卡片 | ✅ 带行号等宽代码流 | ✅ 按钮具有按压透明度反馈 | 🏆 **A (设计模范)** |
| **`WorkspaceSwitcher`** | ✅ `loading` 文本占位 | ✅ 错误码转译 + 重试按钮 | ✅ 引导在桌面添加工作区 | ✅ 工作区列表项 | ✅ 具有 pressed 透明度反馈 | 🏆 **A (设计模范)** |
| **`SettingsScreenView`** | ⚠️ 本地只读无加载 | ✅ AboutCard 内置错误 + 重试 | ⚠️ 静态列表无需空态 | ✅ 分组开关与选择器 | ✅ 原生 Switch + Chip 反馈 | ✅ **A- (较好)** |
| **`QuickRunPanel`** | ⚠️ 按钮置忙 ActivityIndicator | ✅ 错误码转译文案 | ⚠️ 静态面板无需空态 | ✅ 完整表单与推荐列表 | ❌ **Chips 无任何 pressed 反馈** | ⚠️ **B (交互体验差)** |
| **`pairWelcomeScreen`** | ⚠️ 静态引导 | ⚠️ 无网络错误态 | ⚠️ 静态引导 | ✅ 引导文案与入口 | ✅ 按钮具有 pressed 反馈 | ⚠️ **B (四态弱化)** |
| **`pairScanScreen`** | ❌ 无 | ❌ 无 | ❌ 仅显示“即将推出” | ❌ 无数据 | ✅ 返回按钮有反馈 | ❌ **D (纯死页面)** |
| **`pairManualScreen`** | ⚠️ 连接中按钮菊花 | ✅ `pair-error` 错误横幅 | ⚠️ 静态表单 | ✅ 表单与连接按钮 | ✅ 按钮具有 pressed 反馈 | ✅ **A- (较好)** |
| **`PlaceholderScreen`** | ❌ 无 | ❌ 无 | ❌ 静态占位 | ❌ 无 | ❌ 无 | ❌ **D (纯死层)** |

---

### 3.2 缺失态严重风险剖析

1. **`sessionsScreen.tsx:34-45`：冷启动数据闪烁（Flash of Empty State）**
   - 现状：组件直接判断 `if (sessions.length === 0) return <EmptyView />`。
   - 风险：在手机端冷启动时，底层 SQLite 或 Auth 水合需要 50~200ms。在此微秒窗口内，`sessions` 数组初始为空。用户每次打开应用都会先看到刺眼的“暂无会话”空态，随后列表骤然弹出，产生严重视觉闪烁与心理挫败感。
   - 改进方案：引入 `hydrated` 状态守卫（与 `notificationCenterScreen` 一致），水合中展示骨架或菊花。
2. **`notificationCenterScreen.tsx` 与 `sessionsScreen.tsx` 错误态完全真空**
   - 当持久化文件损坏、SQLite 查询失败或内存越界时，组件无捕获横幅，错误被静默吞没，页面陷入永久假死或显示错误的空态。

---

### 3.3 “死卡片”与无反馈交互排查

在移动设备触摸屏上，物理按压反馈（Opacity 微降或背景色变化）是确认操作被系统感知的核心体验准则。审计发现多处无反馈的“死卡片”与“死交互”：

1. **`approvalListScreen.tsx:165-174`：审批卡外层点击无反馈（死卡片质感）**
   ```tsx
   {rows.map(({ item, remainingMs }) => (
     <Pressable
       key={item.request.toolCallId}
       testID={`approval-row-${item.request.toolCallId}`}
       accessibilityRole="button"
       accessibilityLabel={`查看审批：${item.request.toolName}`}
       onPress={() => onOpenItem(item.request.toolCallId)}
       // ❌ 缺失任何 style={({ pressed }) => ...} 样式！
     >
       <ApprovalCard item={item} remainingMs={remainingMs} />
     </Pressable>
   ))}
   ```
   - 用户在手机端点击巨大的审批卡片时，卡片背景色和透明度没有任何毫秒级响应，手感犹如点击了一张静态死图片，极易导致用户因怀疑未点中而反复重复点击。
2. **`approvalListScreen.tsx:199-231`：已处理历史行纯静态**
   - 历史行被渲染为纯 `<View>`，无法点击，无法查看该历史审批的详细参数或执行结果，沦为信息死胡同。
3. **`QuickRunPanel.tsx:158-216`：会话快速选择 Chips 无按压响应**
   - `styles.chip` 仅定义了静态边框和选中态，未在 `style` 传入 `({ pressed })` 回调。点击 Chip 时同样没有任何微透明度反馈。
4. **`EventFeed.tsx:202-224`：FilterChip 无按压响应**
   - 过滤条的三个 Chip 点击切换时无 pressed 动画。
5. **`terminalScreen.tsx:147-161`：“回到底部”悬浮胶囊无按压态**
   - `sessionDetailScreen` 与 `runDetailScreen` 中的同款悬浮条均有按压响应，此处为疏漏遗留。
6. **`SessionRow.tsx:150`：嵌套 Pressable 事件穿透与冲突**
   - `SessionRow` 外层是 `Pressable`（进入会话详情），右侧内部嵌入了 `ApprovalBadge`（如果设置了 `onPress` 则也是 `Pressable`，进入审批列表）。
   - 在 React Native 中，若未在内层 `onPress` 阻止冒泡或隔离手势响应，点击角标时会同时触发角标与整行的两个点击事件，造成同时打开审批列表和会话详情两个页面的路由冲突混乱！

---

## 四、【重复与死层（Redundancy & Dead Layers）】

### 4.1 返回按钮样式的多头割裂（7 处重复实现）

系统中没有任何统一的 `HeaderBackButton` 或 `NavBar` 原子组件，全仓 7 个主要屏幕各自手工实现了返回按钮，尺寸、间距、内边距与热区严重分裂：

```
[返回按钮割裂现状]
├── FileBreadcrumb.tsx:120       --> 36×36, dualHitSlop(36, 36) [合规]
├── FilePreview.tsx:251          --> 36×36, 零 hitSlop [严重违规]
├── WorkspaceSwitcher.tsx:240    --> 32×32 (✕), dualHitSlop(32, 32) [合规]
├── pairManualScreen.tsx:378     --> 44×44, 零 hitSlop [Android 缺 4dp]
├── approvalDetailScreen.tsx:182 --> 44×44, 零 hitSlop [Android 缺 4dp]
├── notificationCenter.tsx:133   --> 44×44, 零 hitSlop [Android 缺 4dp]
└── session/run/terminalScreen   --> minHeight:44, paddingRight:8 (无 minWidth, 零 hitSlop) [严重违规]
```

- **治理代价**：每次调整导航规范（如适配 Android 48dp 或更新返回图标），需手动修改 7~8 个文件，极易漏改，架构严重欠收敛。

---

### 4.2 4 个未落地死路由与 `PlaceholderScreen` 死层

- **死层文件**：
  - `apps/crish-mobile/src/presentation/components/templates/PlaceholderScreen.tsx`
  - `apps/crish-mobile/src/presentation/components/templates/ProtectedPlaceholder.tsx`
- **挂载路由**：
  - `apps/crish-mobile/app/diagnostics.tsx`（诊断页）
  - `apps/crish-mobile/app/tasks.tsx`（任务页）
  - `apps/crish-mobile/app/approval-history.tsx`（审批历史页）
  - `apps/crish-mobile/app/usage.tsx`（用量页）
- **问题分析**：
  - 这 4 个路由在 Expo Router 中全部指向 `ProtectedPlaceholder`，页面只显示灰色居中文案，没有任何真实功能。
  - 更严重的是，`PlaceholderScreen` 内部硬编码了 `#555555`，完全没有注入 `useTheme()`，深色模式下背景与文字对比度坍塌。
  - 这种“骨架期占位”长期留在生产源码树中，属于典型的未收口死层。

---

### 4.3 扫码配对死页面（`pairScanScreen.tsx`）
- `apps/crish-mobile/src/presentation/pair/pairScanScreen.tsx`：
  - 页面仅有一句文案：“扫码功能即将推出，请使用手动输入”及一个返回按钮。
  - 属于未完工的半成品占位，直接暴露在用户配对引导首页（`pairWelcomeScreen`）的主按钮区中，形成体验断崖。

---

### 4.4 主题引用双轨中转残留（`themeProjection.ts`）
- **现状**：
  - 架构下沉后，所有主题单例与计算均位于 `adapters/platform/theme.ts`。
  - 但 `adapters/settings/themeProjection.ts` 仍然保留，其内容仅仅是 `export { ... } from '@/adapters/platform/theme'`。
  - 结果导致上层组件出现两派代码风格：一派从 `platform/theme` 引入 `useTheme`，一派从 `settings/themeProjection` 引入 `useAppTheme`。
  - 同一工程内存在同名别称，造成不必要的维护认知心智负担。

---

## 五、整改建议与行动项（Actionable Roadmap）

按优先级排列的整改落地路线：

### 5.1 P0：核心 UI 规范与触控红线修复（合规性）
1. **封装原子 `Input` 组件**：
   - 在 `presentation/components/ui/` 新建 `Input.tsx`，将 `pairManualScreen` 的克制焦点边框计算逻辑（~6% 混合度，浅色 `hsl(35,10%,81%)` / 深色 `hsl(0,0%,23%)`）固化在原子组件内；
   - 支持 `onFocus`/`onBlur` 自动边框过渡；
   - 支持统一的 `disabled` 半透明置灰样式；
   - 替换 `pairManualScreen` 与 `QuickRunPanel` 的手工原生 `TextInput`。
2. **清除 `fileMeta.ts` 硬编码 Hex 颜色**：
   - 将 5 种文件图标颜色接入 `theme.ts`（如 `theme.colorInfo`, `theme.colorSuccess`, `theme.colorError`, `theme.colorWarning`, `theme.textSecondary`），杜绝 Hex 逃逸。
3. **补齐关键 16 处 `dualHitSlop` 遗漏**：
   - 重点补全 `EventFeed` 的 `FilterChip`、`QuickRunPanel` 的会话 Chips、`FilePreview` 的返回按钮、`terminalScreen` 的回到底部按钮。
   - 在 Android 平台将基础返回按钮与按钮的最小尺寸全面对齐 48dp。

### 5.2 P1：交互体验与四态闭环（体验升级）
1. **消除“死卡片”感知**：
   - 为 `approvalListScreen` 的审批卡外层 `Pressable` 补充 `pressed && { opacity: 0.85 }` 或高亮背景；
   - 为 `QuickRunPanel` 的 Chips 补充按压态；
   - 处理 `SessionRow` 内部嵌套 `ApprovalBadge` 的点击冒泡防护。
2. **补全冷启动与全局错误态**：
   - 在 `sessionsScreen` 增加 `hydrated` 状态守卫，避免冷启动空态闪烁；
   - 在 `notificationCenterScreen` 增加网络/存储错误兜底横幅与重试机制。

### 5.3 P2：架构净收敛与死层清退（架构优雅）
1. **提炼统一 `HeaderBackButton` 原子组件**：
   - 统一步伐：尺寸 44×44（Android 自动扩展至 48dp 热区）、内置按压反馈、统一图标字形与间距，一次性替换全仓 7 处重复实现。
2. **清退或收口 4 大死路由占位**：
   - 为 `PlaceholderScreen` 补全 `useTheme()` 支持；或正式清退未落地的深链占位路由，收拢路由树。
3. **统一 Theme 单一真理出口**：
   - 逐步收拢 `themeProjection.ts`，将所有屏幕统一迁移为直接从 `@/adapters/platform/theme` 消费 `useTheme()`。
