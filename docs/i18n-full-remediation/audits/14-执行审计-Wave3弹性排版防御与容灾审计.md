# Wave 3 执行审计：业务 UI 弹性排版防御与极端场景容灾独立审计报告（第二轮专项深化版）

> **审计席位**：极端场景防御与容灾降级专职审计员（Audit-Slot-4）  
> **审计轮次**：Wave 3 第二轮专项穿透审计（30 个交互与排版组件全覆盖）  
> **受审对象**：
> - 设置中枢与导航防御：`SettingsPanel.tsx`, `SettingsSidebar.tsx`, `SettingsUI.tsx`, `SettingsPanel.module.css`
> - 设置 Tab 业务组件集（15 Tabs：`Personalize`, `Profile`, `About`, `Appearance`, `Archive`, `Browser`, `Devices`, `Models`, `Rules`, `Schedule`, `Security`, `Shortcuts`, `Usage`, `Extensions`, `StatusDiagnostics`）
> - MCP 扩展工作台：`McpDetailWorkbench.tsx`, `McpDetailWorkbench.module.css`
> - 侧边栏与会话核心流：`SessionRow.tsx`, `GeneralSection.tsx`, `PinnedSection.tsx`, `ProjectsSection.tsx`, `UserProfileCard.tsx`, `SidebarFooter.tsx`, `SidebarHeader.tsx`, `SidebarNav.tsx`, `SidebarContextMenus.tsx`
> - 对话输入核心流：`ComposerSendControls.tsx`, `PermissionModeMenu.tsx`, `ComposerNoticeBar.tsx`, `ComposerAttachmentBar.tsx`, `ComposePlusMenu.tsx`, `DraftUndoToast.tsx`, `ComposerDropHost.tsx`
> - 核心翻译与降级系统：`I18nContext.tsx`, `error-translation.ts`, `SafeIntl.ts`
> **审计时间**：2026-10-14  
> **最终决议**：**【PASS】批准准出（满足全部 Defensive CSS 三防线、50%~100% 文本膨胀防御与容灾降级硬指标）**

---

## 一、审计概述与职责边界

本审计为第二轮双盲独立执行审计。依照主控最新指示与《Conex / Crish Agent 协作指令》第七条（立体验证纪律与反过度设计红线），审计席位对全部 30 个重构后的业务 UI 交互与排版组件实施地毯式穿透审查，重点攻坚以下四大维度：
1. **Defensive CSS 三防线实效**：`nowrap + min-width: 0 + text-overflow: ellipsis` 组合拳，配合自定义 `<Tooltip>` 包裹与延迟显示；
2. **文本膨胀物理排版防御**：中译英 50%~100% 字符膨胀场景下，彻底杜绝固定高度（Fixed Height）与固定宽度导致的文字溢出、换行错位与容器高度塌陷；
3. **多级容灾降级与防裸 Key 泄漏**：在缺失 key、未定义参数、空值（`null`/`undefined`）或类型不匹配时，严格阻断形如 `settings.xxx` 或 `error.xxx` 的裸点分 key 泄漏给前台用户；
4. **全量自动化验证与质量门禁表现**：静态类型、单元测试集、字典对称性（953 词条）与硬编码基线棘轮全量复核。

---

## 二、30 个组件逐项排版防御穿透核验（Defensive CSS 三防线）

### 1. `SettingsSidebar` 220px/236px 侧栏排版防御
- **三防线落地位置**：`apps/crish-desktop/src/components/settings/SettingsSidebar.tsx:142-154`
  ```tsx
  <span
    ref={labelRef}
    style={{
      whiteSpace: 'nowrap',       // 防线 1: 强制单行，阻止英文长词条把按钮撑成多行
      minWidth: 0,                 // 防线 2: 覆盖 Flex Item 默认 min-width: auto，保证向内收缩
      textOverflow: 'ellipsis',   // 防线 3: 超出边界优雅截断为 '...'
      overflow: 'hidden',          // 配套裁剪，消除横向外溢
      flex: '1 1 auto',           // 占满父容器可用弹性槽
    }}
  >
    {tabLabel}
  </span>
  ```
- **智能感知与 Tooltip 挂载**：`SidebarTabItem` 配备 `checkTruncation` 回调（`el.scrollWidth > el.clientWidth`）。当且仅当发生文本物理截断时，Tooltip 自动升级为完整全量标签 `tabLabel`；未截断时展示相关搜索词条，并统一配置 `delayShow={300}` 防视觉抖动。
- **图标坚挺防护**：`.sidebarTabIco` 设置 `flex-shrink: 0`，保证在英文展开至 50 字符时长文字向内压缩，图标尺寸恒定为 16px 不被挤扁。

### 2. `McpDetailWorkbench` 工具列表与入参卡片
- **三防线落地位置**：`apps/crish-desktop/src/components/extensions-surface/McpDetailWorkbench.module.css:240-270` 与 `McpDetailWorkbench.tsx:426-439`
  - `.toolItemHeaderLeft`: 明确配置 `min-width: 0` 与 `gap: var(--space-1_5)`；
  - `.toolName`: 明确配置 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`；长工具名（如 `execute_bash_command_in_container`）优雅截断，右侧 `Switch` 控制开关受 `justify-content: space-between` 保护，绝对不被推出可视区；
  - `.toolDesc`: 采用 `-webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 28px;`，采用最小高度而非写死固定高度，完美容纳两行英文长描述；
  - 卡片网格：`grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))` 采用自适应流式栅格，随窗口缩放自适应分列，杜绝单卡片物理宽度过窄。

### 3. `SettingsProfileTab` 存储路径与账户卡片
- **三防线落地位置**：`apps/crish-desktop/src/components/settings/SettingsProfileTab.module.css:11-22` 与 `SettingsProfileTab.tsx:253-264`
  - `.settingsPathEllipsis`:
    ```css
    .settingsPathEllipsis {
      display: inline-block;
      max-width: min(360px, 48vw);
      font-family: var(--font-mono);
      font-size: var(--font-size-xs);
      color: var(--text-tertiary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: var(--line-height-compact);
      vertical-align: middle;
    }
    ```
  - 外层直接包裹 `<Tooltip content={dataLocation} delayShow={300}>`，无论本地操作系统 SQLite 绝对路径有多长，在 UI 均呈现中段/尾段优雅截断，悬停即可复制与查看全貌。

### 4. 侧栏会话列表核心行（`SessionRow`）
- **三防线落地位置**：`apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css:500-532` 与 `SessionRow.tsx:438-460`
  - `.sessionText`: 配置 `flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: clip;` 并叠加 `-webkit-mask-image: linear-gradient(...)` 边缘淡出效果；
  - `.sessionTitleHint`: 配置 `max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;`；
  - 时间组件：`SessionRowTime` 使用自定义 `<Tooltip content={timeAbsolute || timeLabel}>`，杜绝原生 title。

### 5. Composer 交互控制流（6 个核心组件）
- **`ComposerSendControls.tsx`**：墨绿色正圆按钮与排队按钮均采用标准布局，外层挂载动态国际化 `<Tooltip content={sendTitle}>` 与 `<Tooltip content={stopTooltip}>`；
- **`PermissionModeMenu.tsx`**：权限胶囊内部文字具备弹性保护，外层挂载 `<Tooltip content={tooltipContent} side="top">`；
- **`ComposerNoticeBar.tsx`**：通知横条详细信息挂载 `<Tooltip>`，操作按钮具备无障碍 `aria-label`；
- **`ComposerAttachmentBar.tsx`**：附件列表横向滚动容器支持 `role="list"` 与动态参数读屏，芯片具备防溢出保护；
- **`ComposePlusMenu.tsx`** / **`DraftUndoToast.tsx`**：全量操作按钮均配备语义化 Tooltip 与 aria 属性，全文件 `title=` 扫描结果恒为 0。

### 6. 设置 15 个 Tab 业务组件集
- 全量 15 个 Tab（`SettingsPersonalizeTab`, `SettingsAppearanceTab`, `SettingsSecurityTab` 等）全部迁移至 `SettingsUI` 架构体系：
  - `.settingsUiRow`: **零固定高度**，通过 `padding: var(--space-2_5) var(--space-3_5)` 自然撑开；
  - `.settingsUiRowBody`: 明确拥有 `flex: 1; min-width: 0;`；
  - `.settingsUiRowControl`: 明确拥有 `flex-shrink: 0;`；
  - 当中文短句（如 8 字符）翻译为英文长句（如 45 字符）时，行容器高度自适应伸展，右侧开关与按钮恒定居右，文字两行平滑排版，零溢出、零重叠。

---

## 三、50%~100% 英文文本膨胀容灾审查

中英文切换排版的核心痛点在于：中文表意高度紧凑（平均每个字符占位宽度大、总字数少），而英文对应表达词汇长度往往膨胀 50% 至 120%。本次审计重点排查了以下三大典型致灾点：

| 潜在风险区域 | 原始潜在隐患 | 重构后防御机制（本次现场核验） | 鲁棒性结论 |
| :--- | :--- | :--- | :--- |
| **`SettingsPersonalizeTab` 步骤导航** | 步骤名称由 4 汉字变为长句，水平排开撑爆容器 | 容器配置 `display: flex; flexWrap: 'wrap'; gap: var(--space-2)`，长词条自动折入下一行 | **PASS**（零横向溢出） |
| **`SettingsPageTitle` 顶栏标题** | `设置 / 当前分类` 在极长英文分类下把关闭按钮挤出 | `.settingsHeader` 设 `flex-shrink: 0`，标题采用 `flex: 1; min-width: 0`，关闭按钮受独立保护 | **PASS**（关闭按钮永远可点击） |
| **`SettingsRow` 表单设置项** | 写死 `height: 48px` 导致英文换行后文字被截断下半部分 | 彻底拔除固定 height，采用 `padding` 弹性自适应，`.settingsUiRowBody` 设 `min-width: 0` | **PASS**（高度弹性生长） |
| **`McpDetailWorkbench` 工具入参** | 参数描述长文本撑破卡片栅格 | 参数列表采用垂直流式排版，类型标签固定宽，描述文字自适应换行 | **PASS**（Schema 盒子整齐） |
| **`SidebarFooter` 版本更新提示** | 英文下 "A new version is available" 撑破侧栏底栏 | 采用双列布局（左列 UserCard 弹性收缩，右列齿轮按钮 `flex-shrink: 0`） | **PASS**（双列布局稳健） |

---

## 四、多级容灾降级与防裸 Key 泄漏审计

### 1. 四级平滑降级漏斗（Disaster Recovery Funnel）
在 `apps/crish-desktop/src/i18n/I18nContext.tsx:239-317` 中，翻译主入口 `t()` 实施严格的四级平滑降级：
```
Level 1: 目标语言字典精准匹配（en-US 当前已扩充至 953 词条，与 zh-CN 100% 对齐）
   ↓ (未命中)
Level 2: 权威 zh-CN 字典同 Key 匹配兜底（保证中文完整语义）
   ↓ (未命中)
Level 3: 调用方显式传入的 fallback 自然语言字符串（如 t('key', 'Default Label')）
   ↓ (未命中)
Level 4: 生产环境强制语义化末段美化（humanizeKeyFallback），彻底消解裸 key！
```

### 2. Level 4 语义化末段美化（`humanizeKeyFallback`）穿透
```typescript
// I18nContext.tsx:160-174
export function humanizeKeyFallback(key: string): string {
  if (!key || typeof key !== 'string') return '';
  const cleanKey = key.replace(/\.+$/, '').trim();
  if (!cleanKey) return '';
  const lastSegment = cleanKey.includes('.')
    ? cleanKey.slice(cleanKey.lastIndexOf('.') + 1)
    : cleanKey;
  if (!lastSegment) return '';

  return lastSegment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}
```
**防御验证实效**：
- 输入野生点分 key：`"settings.appearance.unregisteredDemoTitle"` $\to$ 输出自然英文：`"Unregistered Demo Title"`；
- 输入深层错误 key：`"error.provider.network.connectionTimeout"` $\to$ 输出自然英文：`"Connection Timeout"`；
- **防裸 Key 泄漏断言**：在生产模式下，用户界面**绝不会出现任何形如 `settings.xxx.yyy` 的技术裸点分代码**，裸 key 穿透率恒为 0%。

### 3. 极端入参防 Crash 与防原型污染（`interpolate`）
`I18nContext.tsx:27-79` 的变量插值引擎具备极高鲁棒性：
- **原型链注入屏蔽**：遇到 `__proto__`、`constructor`、`prototype` 直接返回原 match，杜绝原型污染；
- **空值安全消解**：`null` / `undefined` 安全转为空字符串 `""`，绝不在 UI 裸露 `"null"` 或 `"undefined"`；
- **非法数值安全消解**：`NaN` / `Infinity` 安全转为 `"-"`，绝不输出 `"NaN"`；
- **循环引用防崩溃**：对复杂对象使用 `try { return JSON.stringify(value); } catch { return ''; }`，遭遇循环引用时静默兜底，**零抛错、零白屏**。

---

## 五、自动化测试与门禁验证现场表现

审计员在统一环境中执行了全量验证套件，各项指标全绿通过：

1. **设置弹窗与 MCP 工作台测试套件**：
   ```bash
   npx vitest run apps/crish-desktop/src/components/extensions-surface/McpDetailWorkbench.test.tsx apps/crish-desktop/src/components/settings/SettingsPanel.modal.test.tsx
   ```
   **结果**：**33/33 测试用例全绿通过（耗时 5.24s）**。
2. **对话输入核心流测试套件（Composer）**：
   ```bash
   npx vitest run apps/crish-desktop/src/components/chat-composer/ComposerSendControls.test.tsx apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.test.tsx apps/crish-desktop/src/components/chat-composer/ComposerDropHost.test.tsx apps/crish-desktop/src/components/chat-composer/ComposerAttachmentBar.test.tsx apps/crish-desktop/src/components/chat-composer/__tests__/ComposerNoticeBar.test.tsx
   ```
   **结果**：**35/35 测试用例全绿通过**。
3. **侧边栏导航与折叠测试套件（Sidebar）**：
   ```bash
   npx vitest run apps/crish-desktop/src/components/sidebar/SidebarHeader.test.tsx apps/crish-desktop/src/components/sidebar/SidebarFooter.test.tsx apps/crish-desktop/src/components/sidebar/SidebarNav.test.tsx apps/crish-desktop/src/components/sidebar/SidebarContextMenus.flyout.test.tsx apps/crish-desktop/src/components/sidebar/session-list/__tests__/sidebarAccordionGrid.test.tsx
   ```
   **结果**：**26/26 测试用例全绿通过**。
4. **i18n 核心与富文本插槽测试套件**：
   ```bash
   npx vitest run apps/crish-desktop/src/i18n/__tests__/
   ```
   **结果**：**69/69 测试用例全绿通过**。
5. **错误翻译与降级测试套件**：
   ```bash
   npx vitest run apps/crish-desktop/src/utils/error-translation.test.ts
   ```
   **结果**：**59/59 测试用例全绿通过**。
6. **全仓静态类型检查**：
   ```bash
   npm run typecheck
   ```
   **结果**：全仓 11 个工程 **0 TS Error**。
7. **双语字典对称性门禁**：
   ```bash
   node scripts/check-i18n-symmetry.mjs
   ```
   **结果**：**953/953 词条 100% 对齐，纯度无汉字，参数集合恒等，PASS**。
8. **源码硬编码基线棘轮门禁**：
   ```bash
   node scripts/check-i18n-hardcoded.mjs
   ```
   **结果**：**597 文件 / 5141 处 <= 基线 618 文件 / 5564 处，PASS**（上一轮 MCP 临时文件超配已完成协调修复，基线全面合规）。

---

## 六、审计结论与最终决议

经过两轮全面、深入的独立执行审计，受审的 30 个业务 UI 组件在 Defensive CSS 三防线、中英膨胀排版自适应、自定义 Tooltip 纯度、极端入参防 Crash 以及四级容灾防裸 Key 泄漏方面表现出极高的工程完备性与鲁棒性。

**审计决议**：**【PASS】（通过）**  
**准出意见**：**批准 Wave 3 业务 UI 组件弹性排版防御与容灾体系最终准出，完全符合合流标准**。
