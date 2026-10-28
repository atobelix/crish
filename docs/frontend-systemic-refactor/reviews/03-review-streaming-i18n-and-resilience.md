# Conex / Crish 前端系统性重构方案独立评审报告：流式渲染、国际化与运行时健壮性

> **战役代号**：`frontend-systemic-refactor`  
> **报告编号**：`reviews/03-review-streaming-i18n-and-resilience.md`  
> **独立评审专家**：Reviewer R03（流式渲染、国际化与运行时健壮性独立评审席）  
> **审查方案对象**：  
> - P04 方案：[`docs/frontend-systemic-refactor/plans/04-i18n-architecture-and-locale-hygiene.md`](file:///c:/Software/conex/docs/frontend-systemic-refactor/plans/04-i18n-architecture-and-locale-hygiene.md)  
> - P07 方案：[`docs/frontend-systemic-refactor/plans/07-streaming-pipeline-and-rich-composer.md`](file:///c:/Software/conex/docs/frontend-systemic-refactor/plans/07-streaming-pipeline-and-rich-composer.md)  
> **基准参考依据**：  
> - 审计报告：[`docs/frontend-comprehensive-audit/audits/04-audit-i18n-and-locale-hygiene.md`](file:///c:/Software/conex/docs/frontend-comprehensive-audit/audits/04-audit-i18n-and-locale-hygiene.md)  
> - 审计报告：[`docs/frontend-comprehensive-audit/audits/06-audit-state-topology-stream-and-composer.md`](file:///c:/Software/conex/docs/frontend-comprehensive-audit/audits/06-audit-state-topology-stream-and-composer.md)  
> - 仓库实际源码与命令现场：`apps/crish-desktop/src/`、`packages/conversation-flow/`、`scripts/`  
> **评审原则**：零打补丁（Zero Monkey-Patching）、零硬编码（Zero Hardcoding）、不搞双轨妥协（Clean Cut & No Dual-Track）、负代码清退（Negative Code Yield）、证据确凿、言之有据、直击命门。

---

## 一、评审结论与综合裁决（Executive Summary & Verdict）

针对 P04 国际化架构方案与 P07 流式渲染/Composer 方案，评审专家 R03 进行了地毯式的代码比对、AST 校验、边界推演与运行时契约穿透。

### 综合裁决判定：【附条件通过 · 必须就地修订后方可准入施工】（Conditional Pass with Mandatory Revisions）

两个方案在宏观方向上精准命中了前期审计暴露的核心系统性债务（如 `tools` vs `tool` 运行时断裂、`ResizeObserver` 回调中读取 `el.offsetHeight` 强制回流、富文本 `slice(5, -5)` 盲切脆弱性等）。然而，在**微观落地代码、边界完备性、真理源唯一性以及部分关键假设**上，两份方案均暴露出了不可忽视的**设计盲区、自相矛盾、甚至是伪收敛反模式**：

```
                    【R03 独立评审综合健康度打分与风险雷达】
                    
                     彻底杜绝“打补丁” [82分]
                             ▲
                             │
     向下兼容彻底清退 ───────┼─────── 国际化与硬编码闭环
         [80分]              │           [76分] (发现4处漏网+指令误删)
                             │
                             ├─────── 虚拟滚动与推流帧率
                             │           [85分] (发现Effect惊群隐患)
                             ▼
                     富文本与浮层生命周期
                         [78分] (发现自相矛盾挂载代码)
```

### 核心命门缺陷速览（Top Critical Deficiencies）

1. **【P04 致命硬编码漏网 · 阻塞项】`SettingsBrowserTab.tsx` 实际超标 14 处，方案仅按 10 处抽取，遗漏 4 处新特性中文**：  
   实机运行 `node scripts/check-i18n-hardcoded.mjs` 现场显示，`SettingsBrowserTab.tsx` 当前违规数为 14 处（基线为 0）。P04 方案沿袭了审计初期的陈旧数字（10 处），**完全遗漏了 `title="无痕沙箱模式"`、`aria-label="无痕沙箱模式"`、`title="默认静音"`、`aria-label="默认静音"` 4 处硬编码**！若按 P04 方案原样实施，门禁检查必将再次失败阻断（Exit Code 1）。
2. **【P04 概念混淆与误杀死码 · 阻塞项】错误清退正在活跃运行的 3 个前端 UI 斜杠命令词条**：  
   P04 误将 `resolveSlashCommand.ts`（只处理发往后端引擎的 8 个命令）当做斜杠命令的全部真理源，主张从 `chat.ts` 中物理删除所谓 31 个“废弃”斜杠词条。然而，源码检索证实，`AiCommandSlashExtension.ts` 中 `clear`、`stop`、`settings` 是**在前端 UI 拦截分发并真实消费的核心交互命令**，其描述当前全为硬编码中文！P04 误将其列为死码清退，不仅破坏了现存 UI 功能的语义支撑，更堵死了后续对富文本斜杠菜单的国际化改造路径。
3. **【P04 命名空间改动遗漏 · 阻塞项】`McpDetailWorkbench.tsx` 主文件残留 `tools.mcp.*` 复数调用与硬编码中文**：  
   P04 仅规划对子模块 `McpDetailWorkbench.sections.tsx` 进行 Codemod 改为 `tool.mcp.*`，却**遗漏了主容器 `McpDetailWorkbench.tsx:195`** 的 `t('tools.mcp.serviceDisabled')` 与 L197 的 `showToast('服务未启用：请先开启上方运行状态开关')`。此遗漏将导致英文环境下该界面再次击穿。
4. **【P04 严格类型半途而废 · 警告项】`TranslationKey` 依然保留 6 个命名空间的 `${string}` 逃逸通配符**：  
   P04 宣称彻底废除 `(string & {})` 逃逸，但在其给出的 `KnownTranslationKey` 中，`error.${string}`、`action.${string}`、`tool.${string}`、`cluster.${string}`、`sidebar.${string}`、`extensions.${string}` 依然是宽泛的 `${string}`！开发者书写 `t('tool.action.typoName')` 依然无法在编译期得到任何类型检查报错。
5. **【P07 自相矛盾与伪禁令 · 阻塞项】一边设卡禁止裸调 `document.body.appendChild`，一边在实现方案中手写裸调代码**：  
   P07 在 §3.5 与 §6.2 大张旗鼓制定了“禁止在富文本扩展中裸调 `document.body.appendChild`”的 AST 门禁，却在其 §4.5 给出的 `SlashExtension.ts` 落地代码中（L989），赫然写着 `document.body.appendChild(component.element)`！该方案若落地，首当其冲被自己制定的 AST 门禁脚本阻断。
6. **【P07 布局 Effect 伪解耦 · 阻塞项】`useStickToBottomFollow` 依赖项依然包含高频变化的 `scrollTop`**：  
   P07 试图消除 `vs` 扁平对象引用抖动带来的下游惊群，但它在重构 `useStickToBottomFollow` 的依赖数组时，**把每帧滚动都在更新的 `scrollTop` 标量塞入了 `useLayoutEffect` 的依赖项中**！导致用户在用鼠标滚轮滚动时，每一像素的滚动都会触发 `useLayoutEffect` 同步重跑并重新读取 `container.scrollHeight` 与 `clientHeight`，并未真正消灭布局 Effect 惊群。
7. **【P07 工具入参 LRU 缓存无界驻留 · 警告项】`ToolArgsLruCache` 缺乏大文本尺寸拦截，存在内存暴涨隐患**：  
   P07 设计了容量为 256 的字符串 LRU 缓存，以原始参数字符串为 Key。但智能体在执行 `write_file`、`edit_file` 或批处理时，单次参数字符串可高达数百 KB 至数 MB。若无最大单项字符阈值保护，256 项大参数缓存将导致百兆级内存滞留。
8. **【P07 单块 AST 序列化代码围栏与数学公式缺陷 · 警告项】`serializeBlockNode` 无法保真 4 反引号代码块与 LaTeX 公式**：  
   P07 提出的 `serializeBlockNode` 仅通过三元运算符判断 `includes('```') ? '````' : '```'`，遇到包含 4 个反引号的嵌套 Markdown 时闭合围栏发生坍塌；同时完全未实现对行内数学公式（`inlineMath`）与块级公式（`mathBlock`）的映射支持。

---

## 二、详细审查维度一：彻底杜绝“打补丁”与猴子补丁审查

### 2.1 P04 方案打补丁行为深度审查

#### 1. 字典内部双写键名（Double-Key Patching 反模式）
- **现场证据**：P04 在 §2.3（第 304-390 行）给出改造后的 `tools.ts` 代码，其中为了同时兼容组件调用的 `tool.action.*` 和 `action.*`，竟然在同一个字典文件里把 50 余个词条全部双写定义了两遍：
  ```typescript
  'action.listDir': '列出目录',
  'tool.action.listDir': '列出目录',
  'action.readFile': '读取文件',
  'tool.action.readFile': '读取文件',
  // ... 整整 50+ 处双写！
  ```
- **架构质问**：在单复数已经明确收敛为 `tool`、且 `index.ts` 已经规范导出 `tool` 的前提下，为什么要在 `tools.ts` 内部双写两遍？
  在 `I18nContext.tsx` 中，多段键名解析已经实现了 `firstDot` 切分（`ns = key.slice(0, firstDot)`，`subKey = key.slice(firstDot + 1)`）。当传入 `tool.action.listDir` 时，`ns` 为 `tool`，`subKey` 已经精确为 `action.listDir`！在 `tool` 命名空间内部，标准的局部键就应当是 `action.listDir`！
  在字典中手工双写一份带有 `tool.` 前缀的冗余键，本质上是在用**脏数据冗余**来弥补历史调用解析器的不确定性，严重违反了“单一真理源（SSOT）”和“拒绝打补丁”铁律。
- **裁决指令**：彻底清除 `tools.ts` 内的双写键！`tools.ts` 内部必须统一收敛为单一的 `'action.*'` 命名体系；`I18nContext.tsx` 严格使用 `subDict[subKey]` 进行 $O(1)$ 读取，彻底废除双向键冗余补丁。

#### 2. 类型定义宽化逃逸（Type Widening Loophole）
- **现场证据**：P04 在 §6.2（第 1217-1236 行）声称“彻底废除宽松类型逃逸”，但其类型定义中：
  ```typescript
  export type KnownTranslationKey =
    | `common.${keyof CommonTranslations}`
    | `nav.${keyof NavTranslations}`
    | `chat.${keyof ChatTranslations}`
    | `settings.${keyof SettingsTranslations}`
    | `about.${keyof AboutTranslations}`
    | `workspace.${keyof WorkspaceTranslations}`
    | `error.${string}`       // ❌ 宽松通配符
    | `action.${string}`      // ❌ 宽松通配符
    | `tool.${string}`        // ❌ 宽松通配符
    | `cluster.${string}`     // ❌ 宽松通配符
    | `sidebar.${string}`     // ❌ 宽松通配符
    | `extensions.${string}`; // ❌ 宽松通配符
  ```
- **危害剖析**：`tool.${string}` 意味着 TypeScript 编译器对 `t('tool.action.nonExistent')` 或 `t('tool.mcp.typo_key')` 毫无感知，直接放行。这只是把原本的全局 `(string & {})` 缩小为了局部 `${string}`，并未达到“拼写错误编译期强拦截”的承诺。
- **裁决指令**：为 `tool`、`cluster`、`sidebar`、`action` 补充严格的 TypeScript 接口定义（或直接从 `typeof zhCN.tool` 自动递归推导字面量联合），彻底消灭 `${string}` 通配符。

---

### 2.2 P07 方案打补丁行为深度审查

#### 1. 表面立规矩、内部走后门：`document.body.appendChild` 挂载矛盾
- **现场证据**：
  - P07 在 §3.5 宣称：“禁止直接操作 `document.body`：所有由 Tiptap `Suggestion` 扩展创建的弹出式 DOM 节点，禁止直接裸调 `document.body.appendChild`”；
  - P07 在 §6.2 设立门禁：“AST 门禁：检测禁止在富文本扩展中裸调 `document.body.appendChild`”；
  - 但在 P07 §4.5（第 987-990 行）给出的实际实施代码中，写的却是：
    ```typescript
    if (component.element && typeof document !== 'undefined') {
      // 挂载至 body ❌ 依然直调原生 DOM！
      document.body.appendChild(component.element);
      // 向 LayerStackManager 注册应用级浮层
      unregisterLayer = layerStackService.register({ ... });
    }
    ```
- **质问与根因**：既然已经接入了 `LayerStackManager`，浮层的 DOM 宿主就应当是应用级的统一容器（如 `LayerStackService` 维护的 Portal Root 或受管挂载槽），或者是让 React 组件通过标准 `createPortal` 挂载在受控节点上。
  直接裸调 `document.body.appendChild` 并在其后补一句 `layerStackService.register`，本质上是在用命令式胶水打补丁，不仅让自研的 AST 门禁沦为笑话，而且依然破坏了 React 树与桌面窗口层叠上下文的隔离性。
- **裁决指令**：在 `LayerStackService` 中提供标准的浮层挂载点容器获取原语（例如 `layerStackService.getMountContainer('popover')`），或者由 `ReactRenderer` 将节点挂载至受管的 `#crish-popover-portal` 专有根节点，彻底剔除 `document.body.appendChild`。

#### 2. 代码围栏的盲目三目补丁（Hardcoded Backtick Ternary）
- **现场证据**：P07 在 `markdownSerializer.ts:121` 中保留了：
  ```typescript
  const fence = codeText.includes('```') ? '````' : '```';
  ```
- **漏洞复现**：当用户在 Composer 中粘贴包含 4 个反引号的代码块（例如在撰写关于 Markdown 语法的说明时，引用了一个带围栏的代码块：```` ```bash echo 1``` ````）：
  - `codeText` 包含 ````；
  - `codeText.includes('```')` 为 `true`；
  - `fence` 依然取 `'````'`（4 个反引号）；
  - 输出结果的外层围栏是 4 个反引号，内层也是 4 个反引号，解析器根据 CommonMark 规则会在内层反引号处提前闭合代码块，造成后续所有文本语法碎裂！
- **裁决指令**：严禁三目猜测，改用确定性的 AST 正则动态度量：
  ```typescript
  const matches = codeText.match(/`+/g);
  const maxBackticks = matches ? Math.max(...matches.map((m) => m.length)) : 0;
  const fence = '`'.repeat(Math.max(3, maxBackticks + 1));
  ```

---

## 三、详细审查维度二：国际化单复数致命 Bug、硬编码漏网之鱼与死码清退完整性（P04 深度解剖）

### 3.1 致命硬编码 4 处漏网实证现场（`SettingsBrowserTab.tsx`）

在开发环境控制台使用 `node scripts/check-i18n-hardcoded.mjs` 实测拦截信息：
```text
[check-i18n-hardcoded] FAIL: 源码硬编码中文超出基线棘轮（只降不升）：
  [check-i18n-hardcoded] 源码硬编码中文 · apps/crish-desktop/src/components/settings/SettingsBrowserTab.tsx · 当前 14 处 · 基线阈值 0 (新文件未登记)
```

审查比对表：P04 提取清单 vs 真实代码现场：

| 行号 | AST 节点 | 源码当前内容 | P04 方案是否覆盖 | 漏网严重度 | 修复拟定键名 (`settings.browser.*`) |
| :--- | :--- | :--- | :---: | :---: | :--- |
| `82` | `StringLiteral` | `'历史记录已清除'` | ✅ 已覆盖 | - | `settings.browser.historyCleared` |
| `87` | `StringLiteral` | `'书签已清空'` | ✅ 已覆盖 | - | `settings.browser.bookmarksCleared` |
| `92` | `JsxAttribute` | `title="偏好设置"` | ✅ 已覆盖 | - | `settings.browser.preferences` |
| `96` | `JsxAttribute` | `title="默认搜索引擎"` | ✅ 已覆盖 | - | `settings.browser.defaultSearchEngine` |
| `108` | `JsxAttribute` | `title="主页"` | ✅ 已覆盖 | - | `settings.browser.homepage` |
| **`120`** | **`JsxAttribute`** | **`title="无痕沙箱模式"`** | ❌ **漏网** | **阻塞** | **`settings.browser.ephemeralMode`** |
| **`124`** | **`JsxAttribute`** | **`aria-label="无痕沙箱模式"`** | ❌ **漏网** | **阻塞** | **`settings.browser.ephemeralMode`** |
| **`132`** | **`JsxAttribute`** | **`title="默认静音"`** | ❌ **漏网** | **阻塞** | **`settings.browser.defaultMuted`** |
| **`136`** | **`JsxAttribute`** | **`aria-label="默认静音"`** | ❌ **漏网** | **阻塞** | **`settings.browser.defaultMuted`** |
| `145` | `JsxAttribute` | `title="数据清理"` | ✅ 已覆盖 | - | `settings.browser.dataCleanup` |
| `149` | `JsxAttribute` | `title="浏览历史"` | ✅ 已覆盖 | - | `settings.browser.browsingHistory` |
| `157` | `JsxText` | `清除` | ✅ 已覆盖 | - | `common.clear` |
| `163` | `JsxAttribute` | `title="书签"` | ✅ 已覆盖 | - | `settings.browser.bookmarks` |
| `171` | `JsxText` | `清空` | ✅ 已覆盖 | - | `settings.browser.emptyBookmarks` |

**审计裁决**：
P04 方案在第三轮必须就地补充上述 4 处词条定义与消费替换，将抽取清单从 10 处扩展至 14 处，确保执行 `check:i18n:hardcoded` 时违规数真正归零。

---

### 3.2 `McpDetailWorkbench.tsx` 漏改复数调用与硬编码现场

P04 方案在 §2.3 仅提及了 `McpDetailWorkbench.sections.tsx`，评审专家对全仓代码检索证实：
在主容器 `apps/crish-desktop/src/components/extensions-surface/McpDetailWorkbench.tsx` 中：
- 第 195 行：
  ```typescript
  message: t('tools.mcp.serviceDisabled', '服务未启用'),
  ```
  依然在使用旧的复数 `tools.mcp.*`！
- 第 197 行：
  ```typescript
  showToast('服务未启用：请先开启上方运行状态开关');
  ```
  直接裸露手写中文 Toast！
- 第 210 行：
  ```typescript
  showToast(`连通性测试成功：服务响应正常（${latency}ms）`);
  ```
  裸露模板字符串！

**审计裁决**：
必须将 `McpDetailWorkbench.tsx` 纳入 P04 方案的改造文件清单：
1. 将 `t('tools.mcp.serviceDisabled', ...)` 更正为 `t('tool.mcp.serviceDisabled', ...)`；
2. 将第 197 行抽取为 `t('tool.mcp.serviceDisabledHint', '服务未启用：请先开启上方运行状态开关')`；
3. 将第 210 行抽取为 `t('tool.mcp.testSuccess', '连通性测试成功：服务响应正常（{latency}ms）', { latency })`。

---

### 3.3 正在运行的前端斜杠指令被误列为“废弃死码”深度纠偏

#### 缺陷根因解剖
P04 方案在 §5.2 提出：从 `locales/*/chat.ts` 中物理删除所谓的 31 个废弃斜杠命令词条，包含 `slash.clear.*`、`slash.stop.*`、`slash.settings.*`，理由是“真实斜杠命令解析器 `resolveSlashCommand.ts` 仅支持 8 类指令”。

**然而，代码事实如下**：
- `resolveSlashCommand.ts` 处于 API 层，它的职责是：当用户**在输入框输入文本并按下回车发送**给 AI 模型时，判定该指令是否需要拦截（如 `/goal` 改写 prompt，`/schedule` 弹窗）；
- 但在编辑器交互层 `apps/crish-desktop/src/components/chat-composer/AiCommandSlashExtension.ts:229-270` 中：
  ```typescript
  // clear 命令：在输入框内输入 / 唤出菜单，点击后直接在前端清空会话
  {
    id: 'clear',
    title: 'clear',
    description: '清空当前会话上下文并重置状态', // ❌ 硬编码中文
    iconName: 'eraser',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      dispatchUiEvent('clear-current-session', target);
    },
  },
  // stop 命令：点击后直接在前端终止正在进行的流式生成
  {
    id: 'stop',
    title: 'stop',
    description: '停止当前正在生成的回答或运行中的任务', // ❌ 硬编码中文
    iconName: 'cancel-circle',
    command: ({ editor, range }) => {
      dispatchUiEvent('stop-generation', target);
    },
  },
  // settings 命令：点击后直接打开设置弹窗
  {
    id: 'settings',
    title: 'settings',
    description: '打开工作台设置中心（模型、快捷键、插件与通用偏好）', // ❌ 硬编码中文
    iconName: 'settings',
    command: ({ editor, range }) => {
      openSettings();
    },
  }
  ```
  这三个命令**根本不需要发往后端引擎**，在输入框弹出菜单被选中的瞬间，就已经在前端分发 UI 事件完成了操作！

#### 误删死码的灾难性后果
若听信 P04 的方案将 `slash.clear.desc`、`slash.stop.desc`、`slash.settings.desc` 物理删除：
1. 活跃的 UI 特性文案在多语言字典中直接“蒸发”；
2. `AiCommandSlashExtension.ts` 中裸露的手写中文永远无法接入国际化；
3. 用户在英文模式下敲击 `/`，弹出的菜单中，`clear`、`stop`、`settings` 将赫然显示中文描述，造成界面中英文混杂！

#### 裁决纠偏指令
1. **立即撤销对 `clear`、`stop`、`settings` 词条的删除计划**；
2. 仅允许物理清退从未在任何前端扩展和解析器中出现的陈旧原型死码：`slash.model.*`、`slash.search.*`、`slash.simulate.*`、`slash.help.*`；
3. 将 `AiCommandSlashExtension.ts` 中的 `description` 与 `chat.slash.*` 建立动态绑定（通过 `t()` 动态消费），顺道彻底消灭该文件中的 10 处中文硬编码！

---

## 四、详细审查维度三：虚拟滚动零回流测高、推流帧率与两级记忆化（P07 深度解剖）

### 4.1 动态测高 `extractEntryBlockSize` 边界安全性与降级审查

#### 1. 跨浏览器与测试环境的 `borderBoxSize` 结构异构
`extractEntryBlockSize` 的当前实现：
```typescript
if (entry.borderBoxSize && entry.borderBoxSize.length > 0) {
  const blockSize = entry.borderBoxSize[0]?.blockSize;
  if (typeof blockSize === 'number' && Number.isFinite(blockSize) && blockSize > 0) {
    return Math.round(blockSize);
  }
}
```
**隐患点**：在部分早期标准（或某些无头测试运行时的特定 Mock）中，`borderBoxSize` 是单个对象而非数组（`entry.borderBoxSize.blockSize`）。若此时 `entry.borderBoxSize.length` 为 `undefined`，代码会意外跳过判断。
**强化裁决**：
```typescript
const borderBox = Array.isArray(entry.borderBoxSize)
  ? entry.borderBoxSize[0]
  : (entry.borderBoxSize as unknown as ResizeObserverSize | undefined);
const blockSize = borderBox?.blockSize;
if (typeof blockSize === 'number' && Number.isFinite(blockSize) && blockSize > 0) {
  return Math.round(blockSize);
}
```

#### 2. `contentRect.height` 降级的内边距（Padding）塌陷隐患
- 在无头单元测试（jsdom）或极端环境降级至 `entry.contentRect.height` 时，`contentRect` 仅测量 Content Box，不包含元素的 Padding 和 Border。
- 对话流消息行（Message Row）普遍带有 `padding-top` 与 `padding-bottom`（如 16px）。若直接返回 `Math.ceil(entry.contentRect.height)`，会导致测高值偏小 16~32px，在长列表虚拟滚动中引起明显的视口计算偏差与跳动。
**裁决指引**：在单元测试与 Mock 基建中，确保全局 `ResizeObserverMock` 提供的 entries 携带准确的 `borderBoxSize` 数组，杜绝脱水降级带来的几何误差。

---

### 4.2 `useVirtualScroll` 扁平字面量 memo 包装与 `useStickToBottomFollow` 惊群审查

#### 1. 伪解耦现场还原
P07 在 §4.2 规划的 `useStickToBottomFollow` 依赖项为：
```typescript
  }, [
    messages,
    totalHeight,
    containerRef,
    viewportHeight,
    scrollTop, // ❌ 致命错误：把高频滚动的标量放入了依赖数组！
    performProgrammaticScroll,
    isAnchorLocked,
    isAtBottomRef,
    setIsAtBottom,
    observedTopRef,
    isSessionSwitch,
    initialScroll,
  ]);
```

#### 2. 物理执行链路剖析（每帧重跑推演）
1. 用户转动滚轮，触发容器的原生滚动；
2. `container.onscroll` 派发事件，`useVirtualScroll` 内的 `onScroll` 回调执行；
3. `onScroll` 执行 `setScrollTop(el.scrollTop)`，触发 React 状态更新；
4. 状态更新引起组件重新渲染，`useStickToBottomFollow` 检查依赖项；
5. 由于 `scrollTop` 改变（`prevScrollTop !== nextScrollTop`），`useLayoutEffect` **无条件执行**；
6. `useLayoutEffect` 内部同步读取 `container.scrollHeight` 和 `container.clientHeight`；
7. 结论：**P07 所谓的解耦完全破产！只要用户在滚动，每一帧依然在强制触发 `useLayoutEffect` 同步读取几何属性！**

#### 3. 架构根因与单一真理修正
`useStickToBottomFollow` 的核心使命只有一条：**当内容发生变化（`messages` 或 `totalHeight` 改变），且当前处于贴底状态（`isAtBottomRef.current === true`）时，将容器平滑推向最新底部。**
它**根本不应该**在用户主动滚动时被动触发！
用户主动滚动时的底部状态维护，本来就由 `onScroll` 中的 `isAtBottomRef` 负责维护。
**强制修正裁决**：
1. **立即从 `useLayoutEffect` 的依赖项中物理剔除 `scrollTop`**！
2. `scrollTop` 在 Effect 内部若需读取，直接通过传入的 `containerRef.current.scrollTop` 获取最新物理标量；
3. 依赖项严格收敛为：`[messages, totalHeight, viewportHeight, isSessionSwitch, initialScroll]`。在用户滚动或进行文本交互时，该 Effect 的触发次数严格为 0！

---

### 4.3 叙事流 WeakMap 记忆化与 `ToolArgsLruCache` 内存无界驻留审查

#### 1. `ToolArgsLruCache` 大文本爆炸漏洞
P07 在 §4.3 中设计的 LRU 缓存：
```typescript
class ToolArgsLruCache {
  private readonly max: number;
  private readonly map = new Map<string, ExtractedToolArgs>();
  // ...
  set(key: string, val: ExtractedToolArgs): void { ... }
}
const argsLruCache = new ToolArgsLruCache(256);
```
- **内存模型推演**：
  - 智能体在 `writeFile`、`editFile` 或执行返回大 JSON 的工具时，`argsStr` 长度经常在 50KB ~ 500KB 之间；
  - `Map<string, ExtractedToolArgs>` 以 `raw = argsStr.trim()` 为 Key，`val.rawObject` 又持有反序列化后的完整 JS 对象树；
  - 256 项大参数堆积：$256 \times (500\text{KB字符串} + 1\text{MB对象树}) \approx 384\text{MB}$！
  - 严重拖累 V8 垃圾回收，可能直接诱发轻量客户端或长寿命窗口的 OOM 崩溃！

#### 2. 修正裁决
引入大参数阈值熔断机制：
```typescript
// 超过 16KB 的超大参数字符串不进入全局持久 LRU，避免驻留巨型 AST
const MAX_CACHEABLE_ARG_LENGTH = 16 * 1024;

export function parseToolArgsSafe(argsStr?: string | null): ExtractedToolArgs {
  if (!argsStr || !argsStr.trim()) return { props: {}, isObject: false };
  const raw = argsStr.trim();
  
  if (raw.length > MAX_CACHEABLE_ARG_LENGTH) {
    return extractNormalizedProps(parseJsonSafe(raw), raw);
  }
  
  const cached = argsLruCache.get(raw);
  if (cached) return cached;
  // ...
}
```

---

## 五、详细审查维度四：富文本 Composer 语法序列化保真度与浮层孤儿 DOM 泄漏（P07 深度解剖）

### 5.1 单块 Markdown AST 序列化保真度三大硬伤

P07 提出的 `serializeBlockNode(node: JSONContent): string` 成功废除了 `slice(5, -5)` 盲切，这是正确的方向。但在语法树保真度上存在三大致命硬伤：

#### 1. Fenced 代码块多重反引号碰撞（Collision in Code Blocks）
- CommonMark 规范（§4.5 Fenced code blocks）明确指出：
  *“The closing code fence must have at least as many backticks as the opening code fence, and the opening fence must be longer than any sequence of backticks in the code block.”*
- P07 代码：`const fence = codeText.includes('```') ? '````' : '```';`
- 当代码块包含 ```` 时，外层依然输出 ````，反引号碰撞导致 Markdown 语法破碎。

#### 2. 行内与块级数学公式支持为 0（KaTeX / LaTeX Dropout）
- 依据仓库根目录 `AGENTS.md` 规范，Conex / Crish 明确支持渲染 LaTeX 数学公式；
- 在 `markdownSerializer.ts` 中：
  - `serializeInline` 仅处理了 `bold`, `italic`, `strike`, `code`, `link`，遇到公式节点（如 `math` mark 或 `inlineMath` node）直接丢失；
  - `serializeBlockNodes` 仅处理了标题、段落、代码、引用、列表和分割线，对 `mathBlock` / `displayMath` 节点直接进入 `default` 分支导致内容丢失。

#### 3. 列表项多段落悬挂缩进（Loose List Items Indentation）
- 当列表项内包含多个段落时，后续段落必须带 2 空格或 4 空格的缩进，且段落间必须以空行分隔；
- P07 方案在 `serializeItemContent` 中直接使用 `lines.push(...text.split('\n'))`，导致多个段落挤压在同一行或紧邻换行，反序列化时被 Markdown 解析器判定为软换行，造成用户编辑内容结构损坏。

---

### 5.2 `SlashExtension.ts` 浮层生命周期与孤儿 DOM 残留审查

#### 1. 架构违规：直调 `document.body.appendChild`
如第一节所述，P07 在 §4.5 落地代码依然保留了 `document.body.appendChild(component.element)`，这属于架构违规，必须改走受控挂载容器。

#### 2. 突发卸载时的销毁竞态（Unmount Race Condition）
- P07 在 `TiptapEditorField.tsx` 的清理 Effect 中加入了：
  ```typescript
  if (slashSuggestionKey.getState(view.state)?.active) {
    exitSuggestion(view, slashSuggestionKey);
  }
  ```
- **致命漏洞**：当用户突然关闭分栏（Leaf）、或者切换会话销毁 Editor 实例时，`editor.destroy()` 通常先于或并发于组件清理 Effect。一旦 `view.state` 为 null 或视图已被 ProseMirror 内部销毁，`exitSuggestion(view)` 会直接抛出 `Cannot read properties of null` 异常被 catch 吞噬！
- 结果：`exitSuggestion` 失败，ProseMirror 未派发 `onExit`，而注册在 `document.body` 上的 `component.element`（即弹出菜单）在 DOM 中变成无法被清理的**永久孤儿 DOM**！
- **防御闭环裁决**：
  必须将浮层的物理注销权交给 `LayerStackManager`，在 `TiptapEditorField` 卸载时，直接以浮层 ID 调用 `layerStackService.unregister(slashLayerId)`，无论编辑器视图是否存活，中枢均保证物理 DOM 节点被 100% 移除！

#### 3. 漏掉提及建议插件（`MentionSuggestionExtension`）
- `SlashExtension.ts` 内部同时导出了 `SlashSuggestionExtension` 和 `MentionSuggestionExtension`；
- P07 仅给斜杠菜单增加了注册逻辑，未对提及建议插件实施相同的 `LayerStackManager` 托管，留下了半边死角。

---

## 六、详细审查维度五：不必要向下兼容与包袱彻底清退审查

根据 Conex / Crish 架构宪法中的“不搞双轨妥协”与“架构净收敛”原则，评审专家对两份方案的向下兼容策略提出如下刚性审查意见：

| 方案 | 审查发现的不必要向下兼容 / 历史包袱 | 评审专家判定 | 清退裁决与终极动作 |
| :--- | :--- | :---: | :--- |
| **P04** | `types.ts` 保留 `[namespace: string]: ...` 宽松索引签名与 `${string}` | ❌ 妥协反模式 | 彻底清除宽松索引签名，强制采用全量字面量联合，编译期刚性阻断拼写错误 |
| **P04** | `tools.ts` 中为了向下兼容组件直接传 `action.*`，保留了 50+ 处双写键 | ❌ 冗余打补丁 | 彻底清除前缀双写，字典内仅保留单一 `'action.*'`，由运行时解析层统一寻址 |
| **P04** | `locales/*/index.ts` 导出 `cluster: tool` 别名 | ⚠️ 临时过渡 | 方案必须明确标记为过渡别名，在后续波次将过程簇词条完全归一收敛 |
| **P07** | `twoTierBlockEditorCache.ts` 历史使用的 `SENTINEL_HR_NODE` 哨兵截断 | ❌ 彻底废除 | 方案执行物理删除，严禁在任何备用分支保留 `wrapped.slice(5, -5)` 代码 |
| **P07** | `messageVirtualizerMeasure.ts` 读取 `el.offsetHeight` 作为兜底 | ❌ 严禁妥协 | 彻底物理移除 `el.offsetHeight`，任何测高调用 100% 依赖盒模型 |
| **P07** | `TiptapEditorField.tsx` 原生 capture 监听 `keydown` Esc 逃逸补丁 | ❌ 冗余外围补丁 | 彻底交由 `LayerStackManager` 统一 LIFO 栈顶捕获，删除组件外围手动挂载的捕获监听 |

---

## 七、架构缺陷清单与严重度评级（Defect Matrix）

| 缺陷编号 | 归属方案 | 严重度评级 | 缺陷描述与物理现场 | 诱因与直接危害 |
| :--- | :---: | :---: | :--- | :--- |
| **DEF-01** | **P04** | 🔴 **Blocking** | `SettingsBrowserTab.tsx` 实际超标 14 处，方案遗漏 4 处无痕/静音中文 | 门禁 `check:i18n:hardcoded` 依然无法跑通，CI 持续阻断 |
| **DEF-02** | **P04** | 🔴 **Blocking** | 误将前端 UI 活跃命令 `clear`/`stop`/`settings` 列为废弃死码清退 | 破坏正在运行的前端斜杠菜单，加剧多语言不一致 |
| **DEF-03** | **P04** | 🔴 **Blocking** | `McpDetailWorkbench.tsx:195` 漏改复数 `tools.mcp.*` 且漏抽硬编码 | 英文环境下 MCP 工作台文案击穿，依然显示中文 |
| **DEF-04** | **P07** | 🔴 **Blocking** | §4.5 实施代码依然手写 `document.body.appendChild`，违背自身门禁 | 自相矛盾，首当其冲被 `check-no-raw-body-mount.mjs` 拦截 |
| **DEF-05** | **P07** | 🔴 **Blocking** | `useStickToBottomFollow` 依赖项包含 `scrollTop`，滚轮滑动每帧惊群 | 滚轮滑动每帧重新触发 `useLayoutEffect`，回流性能优化打折 |
| **DEF-06** | **P04** | 🟡 **Warning** | `KnownTranslationKey` 依然保留 6 个命名空间的 `${string}` 逃逸通配 | 类型宽化逃逸，无法拦截 `tool.*` 等核心命名空间的键名拼写错误 |
| **DEF-07** | **P04** | 🟡 **Warning** | `tools.ts` 内部双写 50+ 个带 `tool.` 前缀的冗余键 | 冗余数据打补丁，破坏单一真理源契约 |
| **DEF-08** | **P07** | 🟡 **Warning** | `ToolArgsLruCache` 缺乏大参数长度上限熔断，存在百兆内存膨胀隐患 | 长时间运行的大文件读写工具调用会引发 V8 堆内存暴涨 |
| **DEF-09** | **P07** | 🟡 **Warning** | `serializeBlockNode` 围栏反引号固定为 3/4 个，且缺失公式节点映射 | 遇到 4 反引号 Markdown 或 LaTeX 公式时，序列化语法碎裂或丢字 |
| **DEF-10** | **P07** | 🟡 **Warning** | `TiptapEditorField` 突发卸载时 Suggestion 退出异常导致孤儿 DOM 泄漏 | ProseMirror 视图销毁竞态导致浮层无法清理，长期累积脏节点 |

---

## 八、第三轮方案就地修改操作指引与代码重构靶向图谱

为确保 Reviewer R03 在第三轮修改完善时能够准确无误地落刀，特制定如下精确到代码块的操作指引：

### 8.1 P04 方案靶向修订指引（`plans/04-i18n-architecture-and-locale-hygiene.md`）

#### 1. 扩充 `SettingsBrowserTab.tsx` 提取清单至 14 处
在 P04 的 §3.1 与 §3.6 中，补全以下新增词条：
- `settings.browser.ephemeralMode`: `无痕沙箱模式` (en-US: `Incognito Sandbox Mode`)
- `settings.browser.defaultMuted`: `默认静音` (en-US: `Muted by Default`)
并在代码清单中展示对 `title` 和 `aria-label` 的同时替换。

#### 2. 将 `McpDetailWorkbench.tsx` 纳入改造范围并纠正复数调用
在 P04 的 §2.3 与 §3 中，追加对 `apps/crish-desktop/src/components/extensions-surface/McpDetailWorkbench.tsx` 的改造：
- 将 L195 的 `tools.mcp.serviceDisabled` 替换为 `tool.mcp.serviceDisabled`；
- 提取 L197 与 L210 的硬编码 Toast 中文至 `tool.mcp.*` 命名空间。

#### 3. 修正斜杠命令死码清退清单，保护活跃 UI 指令
修改 P04 的 §5.2：
- 严禁删除 `slash.clear.*`、`slash.stop.*`、`slash.settings.*`、`slash.goal.*`、`slash.compact.*`、`slash.schedule.*`、`slash.browser.*`、`slash.teamwork.*`、`slash.learn.*`、`slash.grillMe.*`；
- 明确仅物理清退真正的陈旧原型死码：`slash.model.*`、`slash.search.*`、`slash.simulate.*`、`slash.help.*`；
- 在实施步骤中追加：将 `AiCommandSlashExtension.ts` 接入 `t('chat.slash.*')` 动态消费。

#### 4. 收紧 `TranslationKey`，消灭 `${string}` 通配符
修改 P04 的 §6.2：
- 严格声明 `ToolTranslations`、`ClusterTranslations`、`SidebarTranslations` 接口；
- 从 `KnownTranslationKey` 中移除 `${string}`，实现真正的全字面量联合校验。

#### 5. 清理 `tools.ts` 内部双写冗余键
修改 P04 的 §2.3 代码清单，剔除所有带 `tool.` 前缀的重复声明，仅保留标准的 `'action.*'`、`'mcp.*'`、`'cluster.action.*'`。

---

### 8.2 P07 方案靶向修订指引（`plans/07-streaming-pipeline-and-rich-composer.md`）

#### 1. 物理铲除 `SlashExtension.ts` 中的 `document.body.appendChild`
修改 P07 的 §4.5：
- 废除在扩展内部直接调用 `document.body.appendChild` 的行为；
- 改为通过 `layerStackService.getPortalRoot('popover')` 或挂载至系统统一的受控浮层宿主节点，确保与架构契约 100% 咬合。

#### 2. 彻底解耦 `useStickToBottomFollow`，剔除 `scrollTop` 依赖
修改 P07 的 §4.2：
- 从 `StickToBottomFollowParams` 契约和 `useLayoutEffect` 依赖数组中彻底删除 `scrollTop`；
- 在 Effect 内部需要判断时，统一直接读取 `containerRef.current.scrollTop`；
- 终态依赖数组严格限定为：
  ```typescript
  [
    messages,
    totalHeight,
    containerRef,
    viewportHeight,
    performProgrammaticScroll,
    isAnchorLocked,
    isAtBottomRef,
    setIsAtBottom,
    observedTopRef,
    isSessionSwitch,
    initialScroll,
  ]
  ```

#### 3. 为 `ToolArgsLruCache` 增加单项容量安全阈值
修改 P07 的 §4.3：
- 在 `parseToolArgsSafe` 中引入 `MAX_CACHEABLE_ARG_LENGTH = 16 * 1024`；
- 大于 16KB 的大参数跳过 LRU 缓存，直接解析返回，阻断内存泄漏。

#### 4. 升级 `serializeBlockNode` 为严格 CommonMark 反引号计数与公式映射
修改 P07 的 §4.4：
- 采用正则计算动态反引号数量，生成严格无碰撞的闭合围栏；
- 在 `serializeInline` 与 `serializeBlockNodes` 中追加对 `math`、`inlineMath` 和 `mathBlock` 的 AST 序列化分支。

#### 5. 完善 Suggestion 突发卸载防御与统一接入
修改 P07 的 §4.5：
- 将浮层注册移入 `createSuggestionRenderer` 公共工厂，同时覆盖斜杠建议与提及建议；
- 依靠 `layerStackService.unregister(id)` 作为最终兜底清理屏障，确保在编辑器崩溃或突发卸载时孤儿 DOM 物理清零。

---

*独立评审报告编写完毕，事实确凿，证据链完备，已锁定全部修订靶点。*
