# 前端全景深度盘查报告：国际化（i18n）与文案卫生学审计

> **战役代号**：`frontend-comprehensive-audit`  
> **专职审计位**：A04 · 国际化与文案卫生学审计专家  
> **审计日期**：2026-10-27  
> **受审核心目标**：
> 1. 深入排查 `npm run check:i18n:hardcoded` 拦截的 24 处硬编码中文泄漏（涉及 5 个核心组件/Hook）；
> 2. 深入排查 `npm run check:i18n:unused` 警告的 1045 个未消费孤立词条（总词条 1412 个，未消费率高达 74%）；
> 3. 检查中文 `zh-CN` 与英文 `en-US` 之间的插值参数对称性、类型安全与运行时降级漏斗健壮性。
> **审计纪律**：纯只读实证审计，零业务代码修改，零 `--no-verify`，全部结论基于真实命令执行输出、AST 节点分析与精确到代码行级的证据链。

---

## 一、审计全景与核心结论（Executive Summary）

通过全盘执行 `npm run check:i18n:hardcoded`、`npm run check:i18n:unused` 静态巡检工具链，结合 AST 节点深度语义分析、字典运行时拓扑溯源与跨语言对称性校验，本次审计捕获并穿透了前端在国际化（i18n）子系统与文案卫生学方面的 **四大深层系统性债务**：

```
                              【前端 i18n 架构与文案卫生学审计全景】
   ┌───────────────────────────────────┬───────────────────────────────────┬───────────────────────────────────┐
   │ 1. 源码硬编码泄漏 (24 处超标)     │ 2. 孤立词条严重虚高 (74% 悬空)    │ 3. 命名空间断层导致英文失效      │
   ├───────────────────────────────────┼───────────────────────────────────┼───────────────────────────────────┤
   │ • 集中在原生浏览器与调试桥新波次  │ • 1045/1412 词条未消费 (74%)      │ • `tools` vs `tool` 单复数断层    │
   │ • SettingsBrowserTab (10 处)      │ • 385 项因门禁拆分产生的“幻影命名 │ • 60 个工具动作词条在运行时 100%  │
   │ • NativeBrowserSurface (4 处)     │   空间”（settingsParts 等）       │   无法命中字典，全靠硬编码降级    │
   │ • useNativeInspectorBridge (6 处) │ • 22 项权限词条与业务元数据脱节   │ • 英文模式下工具调用依然裸露中文  │
   │ • previewCardLib / nav (4 处)     │ • 50+ 历史原型/废弃命令死词条     │                                   │
   └───────────────────────────────────┴───────────────────────────────────┴───────────────────────────────────┘
```

### 核心结论速记

1. **新特性实现波次文案未收口，突破基线棘轮（24 处违规）**：
   在原生浏览器工作区（Native Browser Surface）、WebView2 调试桥（Native Inspector Bridge）、DOM 元素选区生成器（previewCardLib）与浏览器设置面板（SettingsBrowserTab）的实现波次中，开发者为了赶进度直接在 UI Toast、JSX 属性与 Prompt 模板中硬编码中文字符串。其中 `SettingsBrowserTab.tsx` 虽导入了 `useI18n` 却仅翻译了 Tab 标题，子表单全盘裸露；`useNativeInspectorBridge.ts` 更是使用三元表达式内联拼接中文（`enabled ? '启动' : '停止'`），严重破坏多语言语法结构。
2. **虚高 74% 的孤立词条真相：静态扫描器架构缺陷与死码并存**：
   实测 1045 个未消费词条中，**385 项（占比 36.8%）为扫描器缺陷导致的“幻影词条”**。因 `settings.ts` 超出代码行数门禁，历史波次将其拆分为 `settingsParts.ts`、`settingsModels.ts` 与 `settingsPartExtensions.ts`；但 `check-i18n-unused-keys.mjs` 未走 `index.ts` 单一真理入口，而是将每个拆分文件单独解析为独立顶级命名空间，生成了如 `settingsParts.personalize.*` 等不存在于运行时的虚假键。其余 660 项孤立词条则由三类真实债务构成：① 字典已定义但业务层使用硬编码元数据（如 `chat.permission.*` 与 `permissionModes.ts` 脱节）；② 早期原型阶段遗留的废弃命令与视图（如 `chat.slash.*` 废弃指令、`sidebar.timeGroup*`）；③ 纯装饰性过度预置（如 `units.*` 20 个单位词条 100% 闲置）。
3. **致命命名空间单复数错位：`tools` 运行时字典 100% 击穿**：
   在 `types.ts` 中定义的消费契约为 `tool.${string}`（单数），组件代码（如 `toolPresentationModel.ts`）严格调用 `t('tool.action.listDir', '列出目录')`；但在 `locales/zh-CN/index.ts` 与 `en-US/index.ts` 中，该模块却被导出为 `tools`（复数）！导致运行时点分查找 `rawDict['tool']` 彻底落空（返回 `undefined`），全靠调用处传入的第三参数 fallback 兜底。**这直接导致英文环境（en-US）下，工具调用与过程簇名称依然强制显示中文硬编码 fallback，英文国际化彻底失效！**
4. **表面 100% 对称下的类型安全隐患**：
   `zh-CN` 与 `en-US` 在词条数量（1412 键）与插值占位符（`{param}`）上保持了表面 100% 结构对称。但类型契约存在严重漏洞：`TranslationKey` 使用 `(string & {})` 逃逸，导致拼写错误无编译期报错；各命名空间接口包含 `[key: string]: string` 索引签名，抹平了严格键联合；插值参数类型松散为 `Record<string, unknown>`，缺少必填变量的静态约束。

---

## 二、24 处硬编码中文泄漏深度解剖与提取方案

### 2.1 门禁阻断命令现场与违规文件清单

在终端使用 `pwsh` 执行硬编码检测门禁：
```powershell
npm run check:i18n:hardcoded
```

**真实阻断日志输出**：
```text
[check-i18n-hardcoded] FAIL: 源码硬编码中文超出基线棘轮（只降不升）：
  [check-i18n-hardcoded] 源码硬编码中文 · apps/crish-desktop/src/components/settings/SettingsBrowserTab.tsx · 当前 10 处 · 基线阈值 0 (新文件未登记) · 正确做法: 将中文抽取至 i18n 字典并使用 t('key') 消费
  [check-i18n-hardcoded] 源码硬编码中文 · apps/crish-desktop/src/components/workspace/NativeBrowserSurface.tsx · 当前 4 处 · 基线阈值 0 (新文件未登记) · 正确做法: 将中文抽取至 i18n 字典并使用 t('key') 消费
  [check-i18n-hardcoded] 源码硬编码中文 · apps/crish-desktop/src/components/workspace/previewCardLib.ts · 当前 2 处 · 基线阈值 1 (超出配额) · 正确做法: 将新增中文抽取至 i18n 字典
  [check-i18n-hardcoded] 源码硬编码中文 · apps/crish-desktop/src/components/workspace/useNativeInspectorBridge.ts · 当前 6 处 · 基线阈值 0 (新文件未登记) · 正确做法: 将中文抽取至 i18n 字典并使用 t('key') 消费
  [check-i18n-hardcoded] 源码硬编码中文 · apps/crish-desktop/src/components/workspace/usePreviewNavigationTransaction.ts · 当前 2 处 · 基线阈值 0 (新文件未登记) · 正确做法: 将中文抽取至 i18n 字典并使用 t('key') 消费
```

---

### 2.2 逐文件、逐行分析与 AST 违规节点溯源

#### 1. `apps/crish-desktop/src/components/settings/SettingsBrowserTab.tsx`（10 处违规）

- **所属领域**：设置面板 · 浏览器偏好与数据清理设置页
- **未接入原因**：开发人员在接入该设置页时引入了 `useI18n`，但仅在 `L69` 使用了 `t('settings.tabs.browser')`，后续表单项结构直接复制了中文原型文本，未在 `locales/*/settings.ts` 中开辟 `settings.browser.*` 域。
- **违规详情表**：

| 行号:列号 | AST 节点类型 | 源码当前内容 | 语义说明 | 拟定 i18n 键名 (`settings.browser.*`) |
| :--- | :--- | :--- | :--- | :--- |
| `60:16` | `StringLiteral` | `'历史记录已清除'` | Toast 成功提示 | `settings.browser.historyCleared` |
| `65:16` | `StringLiteral` | `'书签已清空'` | Toast 成功提示 | `settings.browser.bookmarksCleared` |
| `70:24` | `JsxAttribute` | `title="偏好设置"` | 分组区块标题 | `settings.browser.preferences` |
| `74:13` | `JsxAttribute` | `title="默认搜索引擎"` | 设置行标题 | `settings.browser.defaultSearchEngine` |
| `86:13` | `JsxAttribute` | `title="主页"` | 设置行标题 | `settings.browser.homepage` |
| `99:24` | `JsxAttribute` | `title="数据清理"` | 分组区块标题 | `settings.browser.dataCleanup` |
| `103:13` | `JsxAttribute` | `title="浏览历史"` | 设置行标题 | `settings.browser.browsingHistory` |
| `111:17` | `JsxText` | `清除` | 操作按钮文本 | `common.clear` 或 `settings.browser.clear` |
| `117:13` | `JsxAttribute` | `title="书签"` | 设置行标题 | `settings.browser.bookmarks` |
| `125:17` | `JsxText` | `清空` | 操作按钮文本 | `settings.browser.emptyBookmarks` |

---

#### 2. `apps/crish-desktop/src/components/workspace/NativeBrowserSurface.tsx`（4 处违规）

- **所属领域**：原生浏览器工作区 · Webview2 挖洞镂空容器与几何渲染表面
- **未接入原因**：底层基础设施组件，重点在生命周期与 Win32 Airspace 毛玻璃适配。开发者捕获到错误时直接通过 `toast.error` 输出中文模板字符串与按钮文字，未挂载国际化 Hook。
- **违规代码证据**：
  ```typescript
  // apps/crish-desktop/src/components/workspace/NativeBrowserSurface.tsx:155-160
  toast.error(`原生浏览器同步失败：${reason}`, {
    action: {
      label: '重试', // L157: PropertyAssignment
      onClick: retry,
    },
  });

  // apps/crish-desktop/src/components/workspace/NativeBrowserSurface.tsx:268-273
  toast.error(`原生浏览器导航失败：${reason}`, {
    action: {
      label: '重试', // L270: PropertyAssignment
      onClick: navigateLatestUrl,
    },
  });
  ```
- **提取与重构规范**：
  - `workspace.browser.syncFailed`: `原生浏览器同步失败：{reason}` (en-US: `Native browser synchronization failed: {reason}`)
  - `workspace.browser.navigationFailed`: `原生浏览器导航失败：{reason}` (en-US: `Native browser navigation failed: {reason}`)
  - 按钮文字复用全局通用词条：`t('common.retry')`。

---

#### 3. `apps/crish-desktop/src/components/workspace/previewCardLib.ts`（2 处违规）

- **所属领域**：工作区预览 · DOM 拾取结构化 Prompt 序列化与 Chip 构造纯函数
- **未接入原因**：纯工具模块（非 React 组件）。开发者误以为 Prompt 指令只需面向中文大模型，且认为非组件环境无法调用 Hook，遂直接硬编码。但实际上仓库中导出了全局单例 `t()`（`apps/crish-desktop/src/i18n/useI18n.ts:57`），完全支持在无状态工具中执行。
- **违规代码证据**：
  ```typescript
  // apps/crish-desktop/src/components/workspace/previewCardLib.ts:98
  return `请分析并优化这个元素 [@DOM: ${label} (${dim})]，选择器：${bestSelector}`;

  // apps/crish-desktop/src/components/workspace/previewCardLib.ts:142
  return [
    '请分析并优化以下网页元素。',
    'DOM_REFERENCE_PAYLOAD schema=DomReferenceChipPayload version=1.0',
    '```json',
    json,
    '```',
  ].join('\n');
  ```
- **提取与重构规范**：
  - 引入单例 `import { t } from '../../i18n'`；
  - `workspace.inspector.optimizeElementPrompt`: `请分析并优化这个元素 [@DOM: {label} ({dim})]，选择器：{bestSelector}` (en-US: `Please analyze and optimize this element [@DOM: {label} ({dim})], selector: {bestSelector}`)；
  - `workspace.inspector.optimizeElementHeader`: `请分析并优化以下网页元素。` (en-US: `Please analyze and optimize the following web elements.`)。

---

#### 4. `apps/crish-desktop/src/components/workspace/useNativeInspectorBridge.ts`（6 处违规）

- **所属领域**：原生浏览器工作区 · 元素拾取与 CDP 调试事件总线桥接 Hook
- **未接入原因**：在处理 IPC 异常时，为了代码紧凑使用了三元表达式拼接字符串（`enabled ? '启动' : '停止'`），被 AST 扫描器精准识别为 3 处违规（模板串 + '启动' + '停止'），外加 3 处重载/监听异常 Toast。
- **违规代码证据**：
  ```typescript
  // apps/crish-desktop/src/components/workspace/useNativeInspectorBridge.ts:75 (计 3 处)
  toast.error(`页面元素拾取${enabled ? '启动' : '停止'}失败：${reason}`);

  // apps/crish-desktop/src/components/workspace/useNativeInspectorBridge.ts:139
  toast.error(`页面重新加载后无法恢复元素拾取：${reason}`);

  // apps/crish-desktop/src/components/workspace/useNativeInspectorBridge.ts:198
  toast.error(`页面元素拾取事件监听失败：${error.message}`);

  // apps/crish-desktop/src/components/workspace/useNativeInspectorBridge.ts:238
  toast.error(`页面拾取停止失败：${reason}`);
  ```
- **提取与重构规范**（杜绝三元表达式拼接，拆分为确定性动词键）：
  - `workspace.inspector.startFailed`: `页面元素拾取启动失败：{reason}` (en-US: `Failed to start element inspector: {reason}`)
  - `workspace.inspector.stopFailed`: `页面元素拾取停止失败：{reason}` (en-US: `Failed to stop element inspector: {reason}`)
  - `workspace.inspector.resumeFailed`: `页面重新加载后无法恢复元素拾取：{reason}` (en-US: `Failed to restore element inspector after page reload: {reason}`)
  - `workspace.inspector.listenerFailed`: `页面元素拾取事件监听失败：{reason}` (en-US: `Failed to listen to element inspector events: {reason}`)

---

#### 5. `apps/crish-desktop/src/components/workspace/usePreviewNavigationTransaction.ts`（2 处违规）

- **所属领域**：工作区预览 · 预览导航事务与状态回滚状态机
- **未接入原因**：协议校验失败与导航异常直接由 Hook 触发 UI 提示，未注入 `useI18n`。
- **违规代码证据**：
  ```typescript
  // apps/crish-desktop/src/components/workspace/usePreviewNavigationTransaction.ts:104
  toast.show('仅支持 http/https 网页预览；本地文件路径无法在此处打开');

  // apps/crish-desktop/src/components/workspace/usePreviewNavigationTransaction.ts:173
  toast.error(`浏览器导航失败：${reason}`);
  ```
- **提取与重构规范**：
  - `workspace.browser.unsupportedScheme`: `仅支持 http/https 网页预览；本地文件路径无法在此处打开` (en-US: `Only http/https web preview is supported; local file paths cannot be opened here`)
  - 复用 `workspace.browser.navigationFailed`: `浏览器导航失败：{reason}`。

---

## 三、1045 个未消费孤立词条深层穿透与成因分类

执行全量词条消费扫描：
```powershell
node scripts/check-i18n-unused-keys.mjs --list
```
实测统计：全仓 `zh-CN` 字典共有 **1412 个** 词条，其中被检测为已消费的仅 **367 个**，未消费词条高达 **1045 个（未消费率 74.0%）**。

### 3.1 孤立词条模块分布实证数据

通过编写 AST 字典加载器对未消费词条进行全域聚合，模块分布如下：

```
                     【1045 个未消费词条之模块分布柱状图】
  settingsParts          ██████████████████████████████████ 328 (31.4%) [100% 悬空]
  settings (主文件)      ███████████████████████ 231 (22.1%) [90.9% 悬空]
  chat                   ████████████████ 162 (15.5%) [83.5% 悬空]
  about                  ██████ 60 (5.7%) [58.8% 悬空]
  tools                  ██████ 60 (5.7%) [81.1% 悬空]
  sidebar                █████ 50 (4.8%) [55.6% 悬空]
  settingsModels         ████ 44 (4.2%) [100% 悬空]
  common                 ███ 33 (3.2%) [54.1% 悬空]
  nav                    ███ 27 (2.6%) [84.4% 悬空]
  units                  ██ 20 (1.9%) [100% 悬空]
  settingsPartExtensions █ 13 (1.2%) [100% 悬空]
  workspace              █ 13 (1.2%) [14.8% 悬空]
  extensions             ▎ 4 (0.4%) [5.3% 悬空]
```

---

### 3.2 孤立词条成因深度归因（四大核心病灶）

#### 病灶 1：门禁脚本静态加载机制缺陷制造 385 个“幻影词条”（占比 36.8%）

- **涉及模块**：`settingsParts` (328)、`settingsModels` (44)、`settingsPartExtensions` (13)。
- **机制还原**：
  1. 为了通过代码行数门禁（`check-line-counts.mjs`），历史波次将 `settings.ts` 拆分出三个子模块：`settingsParts.ts`、`settingsModels.ts`、`settingsPartExtensions.ts`。在主文件 `settings.ts:300-301` 中使用对象展开运算符（`...settingsPartRest, ...settingsPartModels`）聚合。
  2. 但门禁脚本 `scripts/check-i18n-unused-keys.mjs:122-130` 使用了遍历目录文件的方式收集字典：
     ```javascript
     for (const file of files) {
       if (file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts')) {
         const modName = file.replace('.ts', '');
         const modObj = loadSingleTsModule(join(dirPath, file));
         if (modObj) aggregated[modName] = modObj; // 错误地将 settingsParts 注册为顶级 namespace！
       }
     }
     ```
  3. 扫描器将拆分文件按文件名展开，构建了诸如 `settingsParts.personalize.title`、`settingsModels.models.title` 等顶级键；而在真实前端代码中，组件只可能调用 `t('settings.personalize.title')`，永远不可能消费带有 `settingsParts` 前缀的键！
  4. 此外，脚本中的 `loadSingleTsModule` 自定义 CommonJS 沙箱未正确处理命名导出解构，导致 `settings.ts` 中的 `...settingsPartRest` 展开为 `undefined`，进而导致本应归属在 `settings.*` 下的真实词条丢失。
- **审计裁决**：这 385 个词条**不是业务死码**，而是**门禁巡检工具架构缺陷造成的虚假告警**！

#### 病灶 2：字典已定义，但业务层使用独立硬编码元数据（脱节型孤立）

- **典型案例 1：权限模式文案脱节（`chat.permission.*` 共 22 处悬空）**
  - 在 `apps/crish-desktop/src/i18n/locales/zh-CN/chat.ts:78-100` 中，完整定义了四种权限模式的多语言文案：
    - `'permission.ask.label': '需确认'`
    - `'permission.ask.description': '改文件、推送前先问你'`
    - `'permission.plan.label': '计划'` 等；
  - 但在业务层 `apps/crish-desktop/src/api/permissionModes.ts:74-110` 中，`PERMISSION_MODES` 数组直接将上述中文硬编码在对象字面量中，UI 组件直接读取 `mode.label`，从未通过 `t('chat.permission.*')` 消费字典！
  - **后果**：`chat.ts` 词条永久悬空；同时 `permissionModes.ts` 在 AST 扫描中产生 28 处硬编码泄漏！
- **典型案例 2：外观与设置 Schema 脱节（`settings.appearance.*` 共 39 处悬空）**
  - 在 `locales/zh-CN/settings.ts:59-100` 中，详细预置了 `appearance.themeTitle`、`appearance.uiDensityTitle` 等文案；
  - 但 `apps/crish-desktop/src/components/settings/useAppearanceSchema.ts:90-100` 定义 Schema 时，直接手写 `title: '主题模式'`、`title: '主题与外观'`，未传入 `SettingsSchemaRenderer` 原生支持的 `titleKey` 与 `descKey`！

#### 病灶 3：早期原型波次过度预置与废弃特性遗留（死码型孤立）

- **典型案例 1：废弃的斜杠命令（`chat.slash.*` 31 处悬空）**
  - `chat.ts:105-135` 预置了 `slash.clear`、`slash.model`、`slash.branch`、`slash.fork`、`slash.export`、`slash.simulate`、`slash.help` 的中英文描述；
  - 但真实斜杠命令解析器 `apps/crish-desktop/src/api/resolveSlashCommand.ts:13-22` 仅支持 `schedule`、`teamwork-preview`、`browser`、`learn`、`goal`、`grill-me`、`skill`、`compact`。上述词条完全是早期原型废弃物。
- **典型案例 2：未落地的侧栏时间分组与会话操作（`sidebar.*` 50 处悬空）**
  - `sidebar.ts` 中定义了 `timeGroupToday`（今天）、`timeGroupYesterday`（昨天）、`timeGroupPast7Days`、`renameSession`、`deleteSessionConfirm`；
  - 源码检索确认，侧栏会话列表从未实现按时间跨度自动分折叠槽的功能，也未消费这些词条。
- **典型案例 3：100% 闲置的独立单位模块（`units.*` 20 处悬空）**
  - `units.ts` 定义了 `ms`、`second`、`bytes`、`kb`、`mb` 等 20 个时间与存储单位；
  - 但前端格式化代码（如 `apps/crish-desktop/src/api/approvalPayload.ts:205` 的 `formatBytes`）直接硬编码 `'KB'`、`'MB'`、`'未知'`，`units` 模块在全仓引用数为 0。

#### 病灶 4：别名冗余与过度设计（重复型孤立）

- **典型案例：`about.*` 模块（60 处悬空）**
  - 存在大量同义异名键：`pageTitle` vs `title`；`appName` vs `appInfo`；`appVersion` vs `appVersionLabel`；`copySysInfo` vs `copySysInfoBtn` vs `copySysInfoSuccess` vs `sysInfoCopied` vs `sysInfoCopiedToast`；
  - 存在 10 个为第三方库编写的专属本地化介绍：`dependencyDesc.bitmaps`、`dependencyDesc.cssparser`、`dependencyDesc.lightningcss` 等，而界面仅展示 crates.io 原始包名。

---

## 四、运行时致命断层：`tools` vs `tool` 单复数缺陷

### 4.1 缺陷机理与证据链

在国际化运行时解析引擎 `apps/crish-desktop/src/i18n/I18nContext.tsx` 中，多段 key 的解析逻辑如下：

```typescript
// apps/crish-desktop/src/i18n/I18nContext.tsx:106-121
const firstDot = key.indexOf('.');
if (firstDot > 0) {
  const ns = key.slice(0, firstDot); // 取点号前缀作为命名空间
  const subKey = key.slice(firstDot + 1);
  if (Object.prototype.hasOwnProperty.call(rawDict, ns)) {
    const subDict = rawDict[ns];
    if (subDict && typeof subDict === 'object') {
      if (Object.prototype.hasOwnProperty.call(subDict, subKey)) {
        return subDict[subKey];
      }
    }
  }
}
```

**断层链条推演**：
1. **类型契约（单数）**：`apps/crish-desktop/src/i18n/types.ts:140` 规定键为 `tool.${string}`，其接口字段也是 `tool?: Record<string, string>`；
2. **业务调用（单数）**：`apps/crish-desktop/src/api/tool-presentation/toolPresentationModel.ts:317` 调用 `t('tool.action.listDir', '列出目录')`；
3. **字典导出（复数）**：`apps/crish-desktop/src/i18n/locales/zh-CN/index.ts:15-28`：
   ```typescript
   export const zhCN: I18nDictionary = {
     common,
     nav,
     chat,
     workspace,
     settings,
     about,
     error,
     action,
     sidebar,
     tools, // 导出键名为复数 tools！
     units,
     extensions,
   };
   ```
4. **内部键名（单数）**：`apps/crish-desktop/src/i18n/locales/zh-CN/tools.ts:21`：
   ```typescript
   export const tools: Record<string, string> = {
     'tool.action.listDir': '列出目录',
     ...
   };
   ```

**运行时行为实测**：
当传入 key 为 `'tool.action.listDir'` 时：
- `ns` 解析为 `'tool'`；
- 检查 `rawDict` 是否包含属性 `'tool'` → **结果为 `false`（字典中仅有 `'tools'`）**；
- 回退至多层点号查找 `dict['tool']['action']['listDir']` → **依然为 `undefined`**；
- 降级漏斗判定未命中，**直接返回第三参数 fallback `'列出目录'`**！

```
【工具国际化调用击穿示意图】
调用方: t('tool.action.listDir', '列出目录')
   │
   ▼ 提取命名空间: ns = "tool"
I18nContext.tsx
   │
   ├─► 检查 zhCN 字典: hasOwnProperty("tool") ──► ❌ 失败! 字典里只有 "tools"
   │
   ├─► 检查 enUS 字典: hasOwnProperty("tool") ──► ❌ 失败! 字典里只有 "tools"
   │
   ▼ 触发 Disaster Recovery 降级漏斗
强制回退到调用方传入的 fallback: "列出目录" (中文硬编码)
   │
   ▼
【灾难后果】即使用户将界面切换为 English (en-US)，工具调用依旧显示中文 "列出目录"！
```

**门禁扫描连锁反应**：
`check-i18n-unused-keys.mjs` 收集到的是 `tools.tool.action.listDir`（带双重前缀）；扫描器在源码中搜索该字符串，而源码全写的是 `tool.action.listDir`，因而导致 `tools.ts` 中全部 **60 个** 核心工具与过程簇词条被 100% 误判为“未消费孤立词条”！

---

## 五、中英文对称性、插值参数与类型安全校验

### 5.1 字典对称性与插值参数校验结果

执行 AST 跨语言校验脚本：
- **键集合对称性**：
  - `zh-CN` 总词条数：1412 个
  - `en-US` 总词条数：1412 个
  - 缺失键数量：0（双方 100% 拥有完全相同的键集合）；
- **动态插值参数对称性**：
  - 对全量 1412 个词条提取形如 `{param}` 的占位符并逐一比对；
  - 变量名不匹配或缺失数量：**0 项**（参数命名完全对称）。

### 5.2 语法与多语言卫生学潜在缺陷

1. **缺少复数规则支持（Pluralization Flaw）**：
   在 `chat.ts:46` 中：
   - zh-CN: `'composer.attachmentCountAria': '附件，共 {count} 个'`
   - en-US: `'composer.attachmentCountAria': 'Attachments, {count} total'`
   当前系统仅有简单的字符串正则替换（`interpolate`），没有接入标准 `Intl.PluralRules`。在英文环境下，当 `count = 1` 时无法渲染 `'1 attachment'`，只能使用妥协性的静态复数描述。
2. **三元表达式拼接违背语言序结构**：
   在 `useNativeInspectorBridge.ts:75` 中使用 `页面元素拾取${enabled ? '启动' : '停止'}失败`。这种直接在模板内部嵌入局部动词的做法，在英文或德文等具有不同词序、倒装或助动词前置的语系中无法直接翻译，必须重构为完整的独立语义句子。

### 5.3 类型系统防御虚设与逃逸风险

查阅 `apps/crish-desktop/src/i18n/types.ts`：
```typescript
// apps/crish-desktop/src/i18n/types.ts:131-147
export type KnownTranslationKey =
  | `common.${keyof CommonTranslations}`
  | `nav.${keyof NavTranslations}`
  | `chat.${keyof ChatTranslations}`
  | `settings.${keyof SettingsTranslations}`
  | `about.${keyof AboutTranslations}`
  | `workspace.${keyof WorkspaceTranslations}`
  | `error.${string}`
  | `action.${string}`
  | `tool.${string}`
  | `units.${string}`
  | `sidebar.${string}`;

export type TranslationKey = KnownTranslationKey | (string & {});
```

**三大类型安全隐患**：
1. **`(string & {})` 破坏静态检查**：类型联合中包含 `(string & {})`，使得 TypeScript 编译器将 `TranslationKey` 宽化为接受任意普通字符串。当开发者在 `t('settings.not_exist_key')` 发生拼写错误时，编译器不会产生任何警告或报错！
2. **索引签名导致 `keyof` 退化**：在 `CommonTranslations`、`NavTranslations` 等接口定义中均保留了 `[key: string]: string;` 兜底索引签名，导致 `keyof CommonTranslations` 直接退化为 `string | number`，使模板字面量联合类型彻底失效。
3. **插值参数未强类型化**：`t(key, params)` 中的 `params` 类型定义为 `type TranslationParams = Record<string, unknown>`。当词条中含有 `{reason}` 或 `{count}` 时，调用方漏传参数，TypeScript 无法在编译期进行任何拦截。

---

## 六、整改方案与演进路线图（Remediation Roadmap）

为彻底根治上述国际化债务与文案卫生隐患，制定 **分阶段、渐进式、低风险** 的治理路线：

```
                    【国际化与文案卫生学整改路线图】
  ┌────────────────────────────────────────────────────────────────────────┐
  │ Wave 1: 门禁与阻断修复 (即刻可做 · 零破坏性)                           │
  │ • 修复 check-i18n-unused-keys.mjs，统一通过 index.ts 加载，消除 385 个 │
  │   幻影词条误报                                                         │
  │ • 修正 index.ts 中 tools -> tool 的单复数错位，打通工具英文翻译链路   │
  │ • 提取 SettingsBrowserTab / NativeBrowserSurface 等 24 处硬编码文案    │
  │ • 运行 npm run check:i18n:hardcoded --update-baseline 消除违规阻断     │
  └───────────────────────────────────┬────────────────────────────────────┘
                                      │
  ┌───────────────────────────────────▼────────────────────────────────────┐
  │ Wave 2: 业务层文案归一与死码清退 (架构净收敛)                          │
  │ • 重构 permissionModes.ts，彻底消除 28 处硬编码，消费 chat.permission │
  │ • 清退 chat.slash.* 废弃命令词条 (31 项) 与 sidebar.timeGroup (5 项)   │
  │ • 梳理 about.* 冗余别名，精简 30+ 重复键                               │
  │ • 将 units.* (20 项) 与 SafeIntl / formatBytes 工具函数绑定            │
  └───────────────────────────────────┬────────────────────────────────────┘
                                      │
  ┌───────────────────────────────────▼────────────────────────────────────┐
  │ Wave 3: 类型契约强化与端到端自动化门禁                                 │
  │ • 移除 types.ts 中的 (string & {})，引入基于 zh-CN 字典自动推导的      │
  │   严格递归 Key 类型（StrictTranslationKey）                            │
  │ • 支持编译期检查参数插值（ExtractInterpolationParams<T>）             │
  │ • 将 check:i18n:unused 加入 CI 强阻断（开启 --strict 模式）            │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## 七、审计结论与验收标准速查表

| 检查维度 | 现状实测指标 | 行业/仓库标准 | 状态 | 核心修复动作 |
| :--- | :--- | :--- | :---: | :--- |
| **硬编码中文泄漏** | 24 处超标阻断 | 0 处违规（严格棘轮） | ❌ **FAIL** | 提取至 `settings.browser.*` 与 `workspace.browser.*`，杜绝三元拼接 |
| **未消费死词条率** | 1045 / 1412 (74.0%) | 预置可容忍，发布需 <5% | ⚠️ **WARN** | 修复扫描器加载机制（-385 幻影）；清退废弃原型词条并接入权限元数据 |
| **运行时字典连通性** | `tools` 模块 100% 击穿 | 100% 字典命中，禁止裸露 fallback | ❌ **FAIL** | 在 `locales/*/index.ts` 中统一单数 `tool: tools`，对齐 `types.ts` |
| **中英键与参数对称** | 1412 / 1412 (100%) | 100% 严格一致 | ✅ **PASS** | 保持当前对称性；后续引入 ICU Plural 规则 |
| **类型安全与约束** | `(string & {})` 逃逸 | 强类型联合与参数校验 | ⚠️ **WARN** | 移除宽松签名，从基准字典自动提取常量键集合 |

---
*报告生成完毕，所有引证均已核对源码与命令执行现场。*
