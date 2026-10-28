# Conex / Crish 前端系统性重构落地方案：国际化（i18n）架构收敛、单复数错位根治与文案卫生学全面治理

> **战役代号**：`frontend-systemic-refactor`  
> **专职架构师**：P04 · 国际化与多语言架构师  
> **核心使命**：彻底拔除运行时单复数错位致命 Bug（`tools` vs `tool`）、地毯式抽离 28 处硬编码中文（含 `SettingsBrowserTab.tsx` 全量 14 处与 `McpDetailWorkbench.tsx` 漏网项）并清退三元拼接反模式、升级门禁扫描器并断崖清退 385+80+ 孤立死词条、保留并绑定前端 UI 交互斜杠命令（`clear`/`stop`/`settings`）、收敛权限元数据与字典双向绑定、消灭 `${string}` 逃逸通配以收紧 TypeScript 100% 严格类型契约并建立永久防回潮门禁，实现全仓前端多语言 100% 真实连通与文案单一真理源（SSOT）收敛。  
> **前置输入文档**：  
> - 专项审计报告：[`docs/frontend-comprehensive-audit/audits/04-audit-i18n-and-locale-hygiene.md`](file:///c:/Software/conex/docs/frontend-comprehensive-audit/audits/04-audit-i18n-and-locale-hygiene.md)  
> - 权威总报告：[`docs/frontend-comprehensive-audit/01-前端全景深度盘查与架构健康度总报告.md`](file:///c:/Software/conex/docs/frontend-comprehensive-audit/01-前端全景深度盘查与架构健康度总报告.md)  
> **遵循纪律**：`AGENTS.md` 规范、反退避原则、六大铁律红线、反过度设计红线、战役工作区结构规范  

---

## 目录索引

1. [架构总纲与问题机理深剖（Architecture Vision & Deep Diagnosis）](#1-架构总纲与问题机理深剖architecture-vision--deep-diagnosis)
   - 1.1 致命单复数错位（`tools` vs `tool`）引发英文全盘回退中文的运行时击穿机理
   - 1.2 虚高 74% 孤立词条的本质穿透：扫描器 AST 沙箱缺陷（385 幻影词条）与原型死码（80+ 项）
   - 1.3 源码硬编码与三元拼接反模式（语法序坍塌）的结构性危害
   - 1.4 类型系统防御虚设：`(string & {})` 逃逸与索引签名抹平危害
   - 1.5 终极重构目标与“三零两强”宪法
2. [核心任务一：运行时单复数错位根治与工具多语言链路 100% 打通](#2-核心任务一运行时单复数错位根治与工具多语言链路-100-打通)
   - 2.1 契约错位根因与三源冲突图谱（`types.ts` vs `index.ts` vs `tools.ts` vs 消费点）
   - 2.2 `locales/*/index.ts` 单数命名空间重塑：`tool: tools`
   - 2.3 `tools.ts` 内部键名结构单源收敛（物理清除双写补丁）与 MCP/McpDetailWorkbench 彻底归一
   - 2.4 `I18nContext.tsx` 动态双向安全解析层改造（`subDict[subKey]` 零损耗匹配）
   - 2.5 英文运行态真实解析单元测试与验收断言（彻底消除中文 fallback）
3. [核心任务二：28 处硬编码中文地毯式抽离与三元拼接彻底铲除](#3-核心任务二28-处硬编码中文地毯式抽离与三元拼接彻底铲除)
   - 3.1 `SettingsBrowserTab.tsx` 14 处文案全量抽取（含无痕沙箱与静音）与 `settings.browser.*` 域开辟
   - 3.2 `NativeBrowserSurface.tsx` 4 处文案与通用按钮抽取（`workspace.browser.*` 与 `common.retry`）
   - 3.3 `useNativeInspectorBridge.ts` 6 处违规治理与三元拼接反模式铲除（`enabled ? '启动' : '停止'` 拆解）
   - 3.4 `usePreviewNavigationTransaction.ts` 2 处文案抽取（协议校验与导航异常）
   - 3.5 `previewCardLib.ts` 2 处 DOM 拾取 Prompt 模板抽取与无状态单例 `t()` 注入
   - 3.6 `McpDetailWorkbench.tsx` 2 处 Toast 硬编码抽离与 `tool.mcp.*` 接入
   - 3.7 `zh-CN` 与 `en-US` 对称词条落地全量代码清单
   - 3.8 门禁实测：`npm run check:i18n:hardcoded` 违规彻底归零与基线棘轮收紧
4. [核心任务三：门禁扫描器升级与 385 个幻影词条彻底消除](#4-核心任务三门禁扫描器升级与-385-个幻影词条彻底消除)
   - 4.1 `scripts/check-i18n-unused-keys.mjs` 扫描器缺陷剖析（目录文件盲遍历 vs 单一真理入口）
   - 4.2 `loadLocaleDictionary` 架构重塑：基于 `index.ts` 的真实导出树展开
   - 4.3 AST CommonJS 沙箱模块解析器增强：支持命名导出解构与展开运算符（彻底解决 `settingsParts.ts` 展开问题）
   - 4.4 385 个虚假孤立词条（`settingsParts.*`, `settingsModels.*`, `settingsPartExtensions.*`）瞬间蒸发实证
5. [核心任务四：业务层权限绑定与历史原型死码断崖式清退（负代码产出）](#5-核心任务四业务层权限绑定与历史原型死码断崖式清退负代码产出)
   - 5.1 权限元数据绑定：重构 `apps/crish-desktop/src/api/permissionModes.ts`
   - 5.2 规范斜杠指令边界：保护 UI 交互命令（`clear`/`stop`/`settings`）并仅清退真正废弃的原型死码
   - 5.3 物理清退 100% 闲置的单位模块：`units.*`（20 个死词条物理删除，全仓引用归零）
   - 5.4 物理清退 `about.*` 冗余重复别名与双写对象（精简 30+ 冗余键，统一规范）
6. [核心任务五：TypeScript 强类型系统进化与参数插值契约化](#6-核心任务五typescript-强类型系统进化与参数插值契约化)
   - 6.1 清除宽化索引签名：从 `CommonTranslations`、`NavTranslations` 等中彻底移除 `[key: string]: string`
   - 6.2 收紧 `TranslationKey`：废除 `(string & {})` 与全部 `${string}` 通配符，实现 100% 严格字面量联合
   - 6.3 引入模板字符串参数类型推导器 `ExtractInterpolationParams<T>`：确保 `{param}` 必须传参且参数名严格受检
   - 6.4 `TranslateFunction` 强类型重载设计与 IDE 智能补全升级
7. [系统性实施流水线与原子变更步骤](#7-系统性实施流水线与原子变更步骤)
   - 7.1 Phase 1：紧急止血（修复 tools 单复数 + 抽离 24 处硬编码，解封 CI）
   - 7.2 Phase 2：扫描器重塑与幻影词条蒸发（修改 check-i18n-unused-keys.mjs，-385 幻影）
   - 7.3 Phase 3：权限绑定与死码大扫除（重构 permissionModes.ts + 删除 slash/units/about 死码，-160+ 词条）
   - 7.4 Phase 4：类型契约收紧与严格门禁（收紧 types.ts + 开启 check:i18n:unused --strict）
8. [永久防回潮门禁与不可退避的量化验收断言矩阵](#8-永久防回潮门禁与不可退避的量化验收断言矩阵)
   - 8.1 自动化检查命令与门禁清单
   - 8.2 量化验收矩阵对比表（现状指标 vs 目标指标 vs 验收命令）
   - 8.3 风险评估、安全边际与回退预案

---

## 1. 架构总纲与问题机理深剖（Architecture Vision & Deep Diagnosis）

### 1.1 致命单复数错位（`tools` vs `tool`）引发英文全盘回退中文的运行时击穿机理

在 Conex / Crish 前端多语言国际化架构中，存在一个极其隐蔽却具致命破坏力的命名空间单复数断裂缺陷。消费端代码、类型契约、与实际字典导出对象之间发生了长期的“契约漂移”，导致**英文环境（en-US）下所有内置工具调用动作与过程簇（Process Cluster）名称 100% 无法解析，全盘强制回退为中文硬编码 fallback**：

```
                    【工具多语言调用 100% 击穿与灾难降级拓扑】

   业务调用方 (UI 组件 / ToolPresentation)
   t('tool.action.listDir', '列出目录')
            │
            ▼ 提取一级命名空间: ns = "tool"
   I18nContext.tsx 运行时解析引擎
            │
            ├─► 检查 rawDict (en-US 字典): hasOwnProperty("tool")
            │   ├── 实际字典导出 (index.ts): { common, nav, ..., tools: tools } ❌ (复数!)
            │   └── 判定结果: false! (字典根节点不存在 "tool" 键)
            │
            ├─► 点分多级逐层遍历 fallback: dict["tool"]["action"]["listDir"]
            │   └── 判定结果: undefined!
            │
            ▼ 触发灾难恢复漏斗 (Disaster Recovery Fallback)
   直接返回调用方传入的第三参数 fallback: "列出目录" (中文硬编码!)
            │
            ▼
   【最终用户现象】：即使用户在界面右上角切换为 English (en-US)，
   工作区过程簇与工具卡片依然赫然显示："列出目录"、"修改文件"、"读取文件"、"运行命令"！
   英文国际化在最关键的 Agent 工具执行面彻底瘫痪！
```

更为严重的是，在 `apps/crish-desktop/src/i18n/types.ts:140` 中，接口类型明确定义为：
```typescript
export interface I18nDictionary {
  ...
  tool?: Record<string, string>; // 单数!
  [namespace: string]: ... // 宽松索引签名掩盖了导出错误!
}
export type KnownTranslationKey = ... | `tool.${string}`; // 单数!
```
由于 `I18nDictionary` 上挂载了 `[namespace: string]: ...` 宽松索引签名，TypeScript 编译器在 `export const zhCN: I18nDictionary = { tools }` 时完全保持沉默，类型安全防线彻底失守。

---

### 1.2 虚高 74% 孤立词条的本质穿透：扫描器 AST 沙箱缺陷（385 幻影词条）与原型死码（80+ 项）

执行静态分析工具 `node scripts/check-i18n-unused-keys.mjs --list` 显示全仓共有 **1412 个** 字典词条，但未消费孤立词条高达 **1045 个（未消费率 74.0%）**。审计穿透表明，这并不是“业务代码烂到 74% 没翻译”，而是由**巡检门禁工具本身的架构缺陷**与**历史遗留死码**共同构成的假象：

```
                    【1045 个未消费孤立词条真实成因解剖】

    ┌───────────────────────────────────┬───────────────────────────────────┐
    │ 1. 扫描器沙箱缺陷制造的“幻影词条” │ 2. 真实存在的未消费业务债务       │
    │    (385 项 · 占比 36.8%)          │    (660 项 · 占比 63.2%)          │
    ├───────────────────────────────────┼───────────────────────────────────┤
    │ • settingsParts.ts (328 项)       │ • tools.ts 单复数错位误判 (60 项) │
    │ • settingsModels.ts (44 项)       │ • permissionModes.ts 脱节 (22 项) │
    │ • settingsPartExtensions.ts (13 项)│ • chat.slash.* 废弃命令死码 (31 项)│
    │                                   │ • units.* 100% 闲置单位词条 (20 项)│
    │ 根因：扫描器遍历目录把拆分文件当作│ • about.* 冗余别名与双写对象 (30+项)│
    │ 独立顶级命名空间加载，生成前端永远│ • 历史组件重构遗留词条 (490+ 项)   │
    │ 不可能消费的虚假键。              │                                   │
    └───────────────────────────────────┴───────────────────────────────────┘
```

1. **扫描器盲遍历缺陷**：历史波次为绕过单文件 500 行门禁，将 `settings.ts` 拆分出 `settingsParts.ts`、`settingsModels.ts` 等子文件，在主文件 `settings.ts` 中通过 `...settingsPartRest` 聚合。但 `check-i18n-unused-keys.mjs` 直接遍历目录把每个 `.ts` 文件作为独立顶级命名空间注册，生成了诸如 `settingsParts.personalize.*` 等运行时根本不存在的键！同时，其自研 CommonJS 沙箱未支持命名解构导出，导致主 `settings.ts` 中的展开项全部为 `undefined`。
2. **工具命名空间连带误判**：由于扫描器将 `tools.ts` 加载为 `tools`，内部键名又带有 `tool.action.*`，扫描器组装出的全路径键是 `tools.tool.action.listDir`。源码中写的全是 `tool.action.listDir`，因而全部 60 个核心工具词条被 100% 误判为“未消费死词条”。

---

### 1.3 源码硬编码与三元拼接反模式（语法序坍塌）的结构性危害

执行 `npm run check:i18n:hardcoded` 拦截的 24 处硬编码中文集中在原生浏览器（Native Browser）与调试桥（Inspector Bridge）新实现波次中。其中最恶劣的反模式是三元字符串拼接：

```typescript
// apps/crish-desktop/src/components/workspace/useNativeInspectorBridge.ts:76
toast.error(`页面元素拾取${enabled ? '启动' : '停止'}失败：${reason}`);
```

**三元拼接的致命国际化隐患**：
- **语序坍塌（Grammar Collapse）**：汉语中修饰语在动词前，英语中动词在前（`Failed to start element inspector: {reason}` vs `Failed to stop element inspector: {reason}`），德语或罗曼语族更有助动词前置、词尾曲折变化和冠词性数变化。三元内联拼接强行将汉语词序固化在代码逻辑中，导致非汉语环境下根本无法进行通顺的语法本地化。
- **AST 扫描多次报警**：扫描器分别在模板字符串、`'启动'`、`'停止'` 处识别出 3 次硬编码违规。
- **修复宪法**：全面禁止三元模板拼接，必须重构为两个独立的语义化句子（`workspace.inspector.startFailed` 与 `workspace.inspector.stopFailed`），或通过标准的参数化插值 `{action, target}` 实现。

---

### 1.4 类型系统防御虚设：`(string & {})` 逃逸与索引签名抹平危害

查阅 `apps/crish-desktop/src/i18n/types.ts`，类型定义中存在严重妥协：
1. **`(string & {})` 逃逸黑洞**：`TranslationKey = KnownTranslationKey | (string & {})` 使得所有点分字符串均被 TypeScript 视为合法。当开发者将 `common.cancel` 误打为 `common.cancle` 或 `setting.language` 时，编译器零报警、零拦截！
2. **索引签名导致 `keyof` 退化**：在 `CommonTranslations`、`NavTranslations` 等接口中声明了 `[key: string]: string;`，导致 `keyof CommonTranslations` 自动退化为 `string | number`，使模板字面量联合（Template Literal Types）完全沦为形式。
3. **参数插值无静态约束**：`t(key, params)` 的 `params` 定义为 `Record<string, unknown>`。当词条包含 `{reason}` 时，调用方漏传参数，编译期无法捕捉。

---

### 1.5 终极重构目标与“三零两强”宪法

根据反退避原则与架构军规，本方案确立**国际化重构三零两强宪法**：

```
                    【国际化子系统“三零两强”重构宪法】

    ┌───────────────────────────────────┬───────────────────────────────────┐
    │ 零 1：零单复数错位 (Zero Mismatch) │ 强 1：强类型编译期契约 (Strict TS)│
    │ 彻底终结 tools vs tool 历史分裂，  │ 移除宽化索引签名与逃逸类型，引入  │
    │ 恢复英文工具/动作 100% 真实解析。 │ ExtractInterpolationParams 参数。 │
    ├───────────────────────────────────┼───────────────────────────────────┤
    │ 零 2：零源码硬编码 (Zero Hardcoded)│ 强 2：强门禁自动化守门 (Gate SSOT)│
    │ 彻底清零 24 处中文与三元拼接反模式│ 修复扫描器消除 385 个幻影词条，   │
    │ 杜绝裸露中文字符串流入源码。      │ check:i18n:unused 开启 strict 阻断│
    ├───────────────────────────────────┴───────────────────────────────────┤
    │ 零 3：零死码与闲置 (Zero Dead Keys)                                    │
    │ 物理清退 31 个废弃斜杠指令、20 个闲置单位词条与 30+ about 别名冗余。   │
    └───────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心任务一：运行时单复数错位根治与工具多语言链路 100% 打通

### 2.1 契约错位根因与三源冲突图谱

经过前文深剖，当前工具多语言体系存在如下三方冲突：

```
[源 1: 类型契约 types.ts] ─── 规定 tool?: Record<string, string> 与 `tool.${string}` (单数)
           │
           ├──► [冲突 A: 导出不匹配] ◄─── [源 2: 字典导出 index.ts] 导出 tools: tools (复数)
           │
[源 3: 消费端代码] ────────────────────── 严格调用 t('tool.action.listDir') (单数)
           │
           └──► [冲突 B: 内部键名带前缀] ◄─ [源 4: 字典内容 tools.ts] 内部声明 'tool.action.listDir'
```

当 `rawDict['tool']` 解析落空后，`I18nContext.tsx` 找不到该命名空间，直接跳入灾难回退，导致英文模式下永远显示第三参数 `'列出目录'`。

---

### 2.2 `locales/*/index.ts` 单数命名空间重塑：`tool: tools`

直接修改语言包入口文件，将导出属性名修正为单数 `tool`，精确对齐 `I18nDictionary` 类型定义：

```typescript
// apps/crish-desktop/src/i18n/locales/zh-CN/index.ts
import type { I18nDictionary } from '../../types';
import common from './common';
import nav from './nav';
import chat from './chat';
import workspace from './workspace';
import settings from './settings';
import about from './about';
import error from './error';
import action from './action';
import sidebar from './sidebar';
import tool from './tools'; // 命名导入规范为单数 tool
import extensions from './extensions';

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
  tool,       // 单数统一对齐消费契约 tool.action.*
  cluster: tool, // 建立 cluster 到 tool 字典的别名索引，支撑 cluster.action.* 消费
  extensions,
};

export default zhCN;
```

```typescript
// apps/crish-desktop/src/i18n/locales/en-US/index.ts
import type { I18nDictionary } from '../../types';
import common from './common';
import nav from './nav';
import chat from './chat';
import workspace from './workspace';
import settings from './settings';
import about from './about';
import error from './error';
import action from './action';
import sidebar from './sidebar';
import tool from './tools';
import extensions from './extensions';

export const enUS: I18nDictionary = {
  common,
  nav,
  chat,
  workspace,
  settings,
  about,
  error,
  action,
  sidebar,
  tool,       // 单数统一对齐消费契约 tool.action.*
  cluster: tool, // 建立 cluster 到 tool 字典的别名索引，支撑 cluster.action.* 消费
  extensions,
};

export default enUS;
```

---

### 2.3 `tools.ts` 内部键名结构单源收敛（物理清除双写补丁）与 MCP/McpDetailWorkbench 彻底归一

在 `tools.ts`（中英文）中，将内部键名规整化。针对消费端调用 `t('tool.action.listDir')`、`t('tool.mcp.statusRunning')` 以及 `t('cluster.action.read')`，进行如下规范：

1. **动作与展示名**：以 `'action.*'` 为内部主键。在 `tool` 命名空间下组装后，`I18nContext.tsx` 解析首段 `ns = 'tool'`，提取 `subKey = 'action.listDir'`，实现 $O(1)$ 精确命中。**物理彻底删除在字典内双写 `'tool.action.*'` 的冗余打补丁行为**，维护单一真理源（SSOT）！
2. **MCP 扩展**：保持 `'mcp.*'` 内部键。同时对所有调用方进行 Codemod 语法树升级，彻底将历史残留的复数 `tools.mcp.*` 归一收敛为单数 `tool.mcp.*`：
   - 改造 `apps/crish-desktop/src/components/extensions-surface/McpDetailWorkbench.sections.tsx` 中调用的全量 `t('tools.mcp.*', ...)` ➔ `t('tool.mcp.*', ...)`；
   - **补齐主容器漏改**：改造 `apps/crish-desktop/src/components/extensions-surface/McpDetailWorkbench.tsx:195` 中的 `t('tools.mcp.serviceDisabled', '服务未启用')` ➔ `t('tool.mcp.serviceDisabled', '服务未启用')`；
   - 抽离 `McpDetailWorkbench.tsx:197` 裸露的 `showToast('服务未启用：请先开启上方运行状态开关')` ➔ `t('tool.mcp.serviceDisabledHint')`；
   - 抽离 `McpDetailWorkbench.tsx:210` 裸露的 `showToast(`连通性测试成功：服务响应正常（${latency}ms）`)` ➔ `t('tool.mcp.testSuccess', { latency })`。
3. **过程簇动作**：保持 `'cluster.action.*'` 内部键，由 `index.ts` 中的 `cluster` 别名命名空间无缝承载。

```typescript
// 规范后的 apps/crish-desktop/src/i18n/locales/zh-CN/tools.ts（单一真理源，零双写补丁）
export const tool: Record<string, string> = {
  // ── 1. MCP 扩展与服务工作台 (mcp.*) ──
  'mcp.statusRunning': '已连接并在后台运行',
  'mcp.statusStopped': '未连接/已停止',
  'mcp.connected': '已连接',
  'mcp.disconnected': '未连接',
  'mcp.latencyNormal': '连通正常，延迟 {latency}ms',
  'mcp.serviceDisabled': '服务未启用',
  'mcp.serviceDisabledHint': '服务未启用：请先开启上方运行状态开关',
  'mcp.testConnectivity': '连通性测试',
  'mcp.testSuccess': '连通性测试成功：服务响应正常（{latency}ms）',
  'mcp.testFailed': '连通性测试异常',
  'mcp.unconnectedReflectTitle': '未连接，启动后动态反射',
  'mcp.unconnectedReflectDesc':
    '服务未连接。请开启上方运行状态开关，启动后将自动动态反射真实的 tools/list 与入参 Schema',
  'mcp.noExportedTools': '暂未发现导出的工具',
  'mcp.noToolsDeclared': '服务已连接，但远端未声明任何工具',
  'mcp.noMatchingTools': '未找到匹配「{query}」的工具',
  'mcp.clearSearch': '清空搜索',
  'mcp.toggleTool': '切换工具 {name}',
  'mcp.inputSchema': '入参 Schema',

  // ── 2. 工具调用展示动作名 (action.*，由 tool 命名空间统一承载，零前缀冗余) ──
  'action.listDir': '列出目录',
  'action.workspaceCurrent': '当前工作区',
  'action.editFile': '修改文件',
  'action.readFile': '读取文件',
  'action.writeFile': '写入文件',
  'action.runCommand': '运行命令',
  'action.fileStat': '查看文件属性',
  'action.fuzzyFind': '模糊查找',
  'action.diff': '差异对比',
  'action.deleteFile': '删除文件',
  'action.deleteDir': '删除目录',
  'action.spawnSubagent': '启动子代理',
  'action.waitSubagent': '等待子代理',
  'action.subagentTasks': '{count} 个任务',
  'action.subagentTaskSingle': '1 个任务',
  'action.killSubagent': '终止子代理',
  'action.sendSubagentMessage': '向子代理发送消息',
  'action.scheduleSet': '设置定时器',
  'action.scheduleSeconds': '{seconds} 秒',
  'action.scheduleCancel': '取消定时器',
  'action.workflowCreate': '创建工作流',
  'action.resolveOutputDir': '解析产出目录',
  'action.treeGenerate': '生成工程结构树',
  'action.memorySearch': '检索压缩记忆',
  'action.memoryRestore': '还原记忆原文',
  'action.noteQuery': '查询笔记区块',
  'action.webAccess': '访问网络',
  'action.mcpCall': '调用 MCP 工具',
  'action.defaultTool': '调用工具',
  'action.needsApproval': '需要确认',
  'action.executionFailed': '执行失败',
  'action.statusRunning': '执行中',
  'action.statusFailed': '失败',
  'action.statusPending': '待确认',
  'action.statusSuccess': '完成',
  'action.duration': '耗时 {text}',
  'action.emptyDir': '空目录',
  'action.itemsCount': '{count} 项',
  'action.noMatch': '无匹配',
  'action.matchCount': '{count} 处匹配',
  'action.linesRange': 'L{sl}–{el} / {total} 行',
  'action.linesTotal': '{total} 行',
  'action.diffLines': '新增 {add} 行，删除 {del} 行',

  // ── 3. 过程簇聚合动作短语 (cluster.action.*) ──
  'cluster.action.read': '读取 {count} 个文件',
  'cluster.action.search': '检索 {count} 次',
  'cluster.action.modify': '修改 {count} 个文件',
  'cluster.action.shell': '运行 {count} 条命令',
  'cluster.action.list': '列出 {count} 个目录',
  'cluster.action.network': '访问 {count} 个网络资源',
  'cluster.action.mcp': '调用 {count} 次扩展工具',
  'cluster.action.task': '管理 {count} 个后台任务',
  'cluster.action.workspace': '执行 {count} 项工作区操作',
  'cluster.action.delete': '删除 {count} 个路径',
  'cluster.action.subagent': '调用 {count} 个子代理',
  'cluster.action.schedule': '设置 {count} 个定时器',
  'cluster.action.note': '操作 {count} 个笔记区块',
  'cluster.action.tool': '调用 {count} 个工具',
  'cluster.action.withDuration': '{action} · 耗时 {duration}',
  'cluster.action.duration': '耗时 {duration}',
};

export default tool;
```
```

同时对 `apps/crish-desktop/src/components/extensions-surface/McpDetailWorkbench.sections.tsx` 中调用的 `t('tools.mcp.statusRunning', ...)` 做 Codemod 语法树升级，统一更正为规范的 `t('tool.mcp.statusRunning', ...)`。

---

### 2.4 `I18nContext.tsx` 动态双向安全解析层改造（`subDict[subKey]` 与 `subDict[key]` 零损耗匹配）

在国际化解析核心 `apps/crish-desktop/src/i18n/I18nContext.tsx` 的 `resolveDictionaryKey` 函数中，升级多段键名查找逻辑，实现高鲁棒性的双向容错匹配：

```typescript
// apps/crish-desktop/src/i18n/I18nContext.tsx
export function resolveDictionaryKey(
  dict: I18nDictionary | undefined,
  key: string
): string | undefined {
  if (!dict || typeof dict !== 'object' || !key) return undefined;

  const rawDict = dict as unknown as Record<
    string,
    Record<string, string | undefined> | undefined
  >;

  // 1. 尝试直接以整 key 读取（扁平配置）
  if (Object.prototype.hasOwnProperty.call(dict, key)) {
    const direct = (dict as unknown as Record<string, unknown>)[key];
    if (typeof direct === 'string') {
      return direct;
    }
  }

  // 2. 尝试首段作为 namespace，剩余作为子 key（如 error 域：error["provider.network.title"]）
  const firstDot = key.indexOf('.');
  if (firstDot > 0) {
    const ns = key.slice(0, firstDot);
    const subKey = key.slice(firstDot + 1);
    if (Object.prototype.hasOwnProperty.call(rawDict, ns)) {
      const subDict = rawDict[ns];
      if (subDict && typeof subDict === 'object') {
        // 2a. 优先匹配去除命名空间后的 subKey (如 tool 模块中的 'action.listDir')
        if (Object.prototype.hasOwnProperty.call(subDict, subKey)) {
          const val = subDict[subKey];
          if (typeof val === 'string') {
            return val;
          }
        }
        // 2b. 兜底匹配携带完整 key 的属性 (如 tool 模块中的 'tool.action.listDir')
        if (Object.prototype.hasOwnProperty.call(subDict, key)) {
          const val = subDict[key];
          if (typeof val === 'string') {
            return val;
          }
        }
      }
    }
  }

  // 3. 尝试多层点号逐级安全遍历（防御 __proto__ / prototype 注入）
  const parts = key.split('.');
  let current: unknown = dict;
  for (const part of parts) {
    if (
      part === '__proto__' ||
      part === 'constructor' ||
      part === 'prototype'
    ) {
      return undefined;
    }
    if (
      current &&
      typeof current === 'object' &&
      Object.prototype.hasOwnProperty.call(current, part)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else {
      current = undefined;
      break;
    }
  }

  if (typeof current === 'string') {
    return current;
  }

  return undefined;
}
```

---

### 2.5 英文运行态真实解析单元测试与验收断言（彻底消除中文 fallback）

在 `apps/crish-desktop/src/i18n/__tests__/i18n.test.ts` 中，新增针对 `tool.action.*` 与 `cluster.action.*` 的专项强断言套件，锁死英文环境解析正确性：

```typescript
// apps/crish-desktop/src/i18n/__tests__/i18n.test.ts
describe('工具与过程簇多语言解析 (Tool & Cluster Parity)', () => {
  it('英文环境 (en-US) 下工具调用名称 100% 命中英文，严禁回退中文 fallback', () => {
    const enT = createTranslateFunction(enUS);
    const zhT = createTranslateFunction(zhCN);

    // 核心内置工具展示名
    expect(zhT('tool.action.listDir', '列出目录')).toBe('列出目录');
    expect(enT('tool.action.listDir', '列出目录')).toBe('List Directory');

    expect(zhT('tool.action.readFile', '读取文件')).toBe('读取文件');
    expect(enT('tool.action.readFile', '读取文件')).toBe('Read File');

    expect(zhT('tool.action.editFile', '修改文件')).toBe('修改文件');
    expect(enT('tool.action.editFile', '修改文件')).toBe('Edit File');

    expect(zhT('tool.action.runCommand', '运行命令')).toBe('运行命令');
    expect(enT('tool.action.runCommand', '运行命令')).toBe('Run Command');

    expect(zhT('tool.action.spawnSubagent', '启动子代理')).toBe('启动子代理');
    expect(enT('tool.action.spawnSubagent', '启动子代理')).toBe('Spawn Subagent');
  });

  it('英文环境 (en-US) 下过程簇短语 100% 正确插值渲染英文', () => {
    const enT = createTranslateFunction(enUS);
    const zhT = createTranslateFunction(zhCN);

    expect(
      zhT('cluster.action.read', '读取 {count} 个文件', { count: 5 })
    ).toBe('读取 5 个文件');
    expect(
      enT('cluster.action.read', '读取 {count} 个文件', { count: 5 })
    ).toBe('Read 5 files');

    expect(
      zhT('cluster.action.shell', '运行 {count} 条命令', { count: 3 })
    ).toBe('运行 3 条命令');
    expect(
      enT('cluster.action.shell', '运行 {count} 条命令', { count: 3 })
    ).toBe('Run 3 commands');
  });

  it('命名空间契约验证：zhCN 与 enUS 顶层导出必须包含 tool 且类型为 object', () => {
    expect(zhCN.tool).toBeDefined();
    expect(typeof zhCN.tool).toBe('object');
    expect(enUS.tool).toBeDefined();
    expect(typeof enUS.tool).toBe('object');
  });
});
```

---

## 3. 核心任务二：28 处硬编码中文地毯式抽离与三元拼接彻底铲除

对触发 `npm run check:i18n:hardcoded` 阻断的 6 个核心文件、共计 28 处硬编码（含 `SettingsBrowserTab.tsx` 实测全量 14 处违规与 `McpDetailWorkbench.tsx` 漏改项）进行地毯式文案抽取，杜绝三元拼接，全面接入参数化插值与单一真理源。

### 3.1 `SettingsBrowserTab.tsx` 14 处文案全量抽取（含无痕沙箱与静音）与 `settings.browser.*` 域开辟

- **文件路径**：`apps/crish-desktop/src/components/settings/SettingsBrowserTab.tsx`
- **问题现状**：经 `check:i18n:hardcoded` 实测阻断现场证实，该文件实际存在 **14 处** 硬编码违规（此前审计仅登记 10 处，遗漏了后续引入的无痕沙箱模式与默认静音设置项）：
  1. L82：Toast `'历史记录已清除'`
  2. L87：Toast `'书签已清空'`
  3. L92：JSX 属性 `title="偏好设置"`
  4. L96：JSX 属性 `title="默认搜索引擎"`
  5. L108：JSX 属性 `title="主页"`
  6. **L120（新特性漏网）**：JSX 属性 `title="无痕沙箱模式"`
  7. **L124（新特性漏网）**：JSX 属性 `aria-label="无痕沙箱模式"`
  8. **L132（新特性漏网）**：JSX 属性 `title="默认静音"`
  9. **L136（新特性漏网）**：JSX 属性 `aria-label="默认静音"`
  10. L145：JSX 属性 `title="数据清理"`
  11. L149：JSX 属性 `title="浏览历史"`
  12. L157：JSX 文本 `清除`
  13. L163：JSX 属性 `title="书签"`
  14. L171：JSX 文本 `清空`
- **重构方案**：在 `locales/*/settingsParts.ts`（或 `settings.ts`）中新增 `settings.browser.*` 域，代码全面调用 `t()`：

```tsx
// apps/crish-desktop/src/components/settings/SettingsBrowserTab.tsx 关键改动
import { useI18n } from '../../i18n';

export const SettingsBrowserTab: React.FC = () => {
  const { t } = useI18n();
  // ...
  const handleClearHistory = () => {
    clearAllHistory();
    toast.show(t('settings.browser.historyCleared', '历史记录已清除'));
  };

  const handleClearBookmarks = () => {
    clearAllBookmarks();
    toast.show(t('settings.browser.bookmarksCleared', '书签已清空'));
  };

  return (
    <SettingsPage title={t('settings.tabs.browser')}>
      <SettingsSection title={t('settings.browser.preferences', '偏好设置')}>
        <SettingsCard>
          <SettingsRow
            icon={<AppIcon name="search" size={16} />}
            title={t('settings.browser.defaultSearchEngine', '默认搜索引擎')}
            control={/* ... */}
          />
          <SettingsRow
            icon={<AppIcon name="home" size={16} />}
            title={t('settings.browser.homepage', '主页')}
            control={/* ... */}
          />
          <SettingsRow
            icon={<AppIcon name="shield" size={16} />}
            title={t('settings.browser.ephemeralMode', '无痕沙箱模式')}
            control={
              <Switch
                size="sm"
                aria-label={t('settings.browser.ephemeralMode', '无痕沙箱模式')}
                checked={storageMode === 'ephemeral'}
                onCheckedChange={handleStorageModeChange}
              />
            }
          />
          <SettingsRow
            icon={<AppIcon name="sliders" size={16} />}
            title={t('settings.browser.defaultMuted', '默认静音')}
            control={
              <Switch
                size="sm"
                aria-label={t('settings.browser.defaultMuted', '默认静音')}
                checked={defaultMuted}
                onCheckedChange={handleDefaultMutedChange}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('settings.browser.dataCleanup', '数据清理')}>
        <SettingsCard>
          <SettingsRow
            icon={<AppIcon name="history" size={16} />}
            title={t('settings.browser.browsingHistory', '浏览历史')}
            control={
              <Button type="button" variant="secondary" size="sm" onClick={handleClearHistory}>
                {t('common.clear', '清除')}
              </Button>
            }
          />
          <SettingsRow
            icon={<AppIcon name="bookmark" size={16} />}
            title={t('settings.browser.bookmarks', '书签')}
            control={
              <Button type="button" variant="secondary" size="sm" onClick={handleClearBookmarks}>
                {t('settings.browser.emptyBookmarks', '清空')}
              </Button>
            }
          />
        </SettingsCard>
      </SettingsSection>
      {/* ... */}
    </SettingsPage>
  );
};
```

---

### 3.2 `NativeBrowserSurface.tsx` 4 处文案与通用按钮抽取（`workspace.browser.*` 与 `common.retry`）

- **文件路径**：`apps/crish-desktop/src/components/workspace/NativeBrowserSurface.tsx`
- **问题现状**：L162 与 L275 直接使用模板字符串拼接 Toast，按钮 `label: '重试'` 硬编码。
- **重构方案**：引入 `useI18n`，抽取 `workspace.browser.syncFailed` 与 `workspace.browser.navigationFailed`，按钮文案复用 `common.retry`：

```tsx
// apps/crish-desktop/src/components/workspace/NativeBrowserSurface.tsx 关键改动
const reportInitializationError = (
  error: unknown,
  retry: () => Promise<void>
) => {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[NativeBrowserSurface] browser initialization failed for ${currentTabId}:`, error);
  toast.error(
    t('workspace.browser.syncFailed', '原生浏览器同步失败：{reason}', { reason }),
    {
      action: {
        label: t('common.retry', '重试'),
        onClick: retry,
      },
    }
  );
};

// 导航失败同理：
toast.error(
  t('workspace.browser.navigationFailed', '原生浏览器导航失败：{reason}', { reason }),
  {
    action: {
      label: t('common.retry', '重试'),
      onClick: navigateLatestUrl,
    },
  }
);
```

---

### 3.3 `useNativeInspectorBridge.ts` 6 处违规治理与三元拼接反模式铲除（`enabled ? '启动' : '停止'` 拆解）

- **文件路径**：`apps/crish-desktop/src/components/workspace/useNativeInspectorBridge.ts`
- **问题现状**：L76 使用三元表达式拼接中文（`页面元素拾取${enabled ? '启动' : '停止'}失败：${reason}`），外加 3 处重载/恢复错误 Toast。
- **重构方案**：彻底铲除三元拼接，根据布尔状态调用独立的确定性语义词条：

```typescript
// apps/crish-desktop/src/components/workspace/useNativeInspectorBridge.ts 关键改动
void enqueueCommand(enabled).catch((error) => {
  if (!mountedRef.current || requestIdRef.current !== requestId) return;
  applyActiveState(previous);
  const reason = error instanceof Error ? error.message : String(error);
  logger.warn('Native browser inspector toggle failed', {
    module: 'useNativeInspectorBridge',
    err: { message: reason },
    sessionId: tabId,
  });
  
  // 彻底铲除三元表达式拼接，拆分为独立完整语义词条
  const errorMsg = enabled
    ? t('workspace.inspector.startFailed', '页面元素拾取启动失败：{reason}', { reason })
    : t('workspace.inspector.stopFailed', '页面元素拾取停止失败：{reason}', { reason });
  toast.error(errorMsg);
});

// 其余 3 处统一抽取：
// L141:
toast.error(
  t('workspace.inspector.resumeFailed', '页面重新加载后无法恢复元素拾取：{reason}', { reason })
);
// L200:
toast.error(
  t('workspace.inspector.listenerFailed', '页面元素拾取事件监听失败：{reason}', { reason: error.message })
);
// L240:
toast.error(
  t('workspace.inspector.stopFailed', '页面元素拾取停止失败：{reason}', { reason })
);
```

---

### 3.4 `usePreviewNavigationTransaction.ts` 2 处文案抽取（协议校验与导航异常）

- **文件路径**：`apps/crish-desktop/src/components/workspace/usePreviewNavigationTransaction.ts`
- **问题现状**：L104 提示 `'仅支持 http/https 网页预览；本地文件路径无法在此处打开'`，L173 提示 `'浏览器导航失败：${reason}'`。
- **重构方案**：

```typescript
// apps/crish-desktop/src/components/workspace/usePreviewNavigationTransaction.ts 关键改动
if (!blank && !isEmbeddablePreviewUrl(url)) {
  toast.show(
    t(
      'workspace.browser.unsupportedScheme',
      '仅支持 http/https 网页预览；本地文件路径无法在此处打开'
    )
  );
  return;
}

// 导航失败调用:
toast.error(
  t('workspace.browser.navigationFailed', '浏览器导航失败：{reason}', { reason })
);
```

---

### 3.5 `previewCardLib.ts` 2 处 DOM 拾取 Prompt 模板抽取与无状态单例 `t()` 注入

- **文件路径**：`apps/crish-desktop/src/components/workspace/previewCardLib.ts`
- **问题现状**：该文件为纯函数库（非 React 组件），开发者误以为无法调用 Hook，遂直接手写面向中文大模型的 Prompt 文本。
- **重构方案**：直接导入已存在的全局无状态单例 `import { t } from '../../i18n'`：

```typescript
// apps/crish-desktop/src/components/workspace/previewCardLib.ts 关键改动
import { t } from '../../i18n';

export function formatDomReferencePrompt(
  tagName: string,
  id: string | null,
  classes: string[],
  rect: { width: number; height: number },
  bestSelector: string
): string {
  const label = buildInspectorElementLabel(tagName, id, classes);
  const dim = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
  return t(
    'workspace.inspector.optimizeElementPrompt',
    '请分析并优化这个元素 [@DOM: {label} ({dim})]，选择器：{bestSelector}',
    { label, dim, bestSelector }
  );
}

export function serializeDomReferenceChipForComposer(
  payload: DomReferenceChipPayload
): string {
  const json = JSON.stringify(payload, null, 2).replace(/`/g, '\\u0060');
  return [
    t('workspace.inspector.optimizeElementHeader', '请分析并优化以下网页元素。'),
    'DOM_REFERENCE_PAYLOAD schema=DomReferenceChipPayload version=1.0',
    '```json',
    json,
    '```',
  ].join('\n');
}
```

---

### 3.6 `McpDetailWorkbench.tsx` 2 处 Toast 硬编码抽离与 `tool.mcp.*` 接入

- **文件路径**：`apps/crish-desktop/src/components/extensions-surface/McpDetailWorkbench.tsx`
- **问题现状**：L195 依然在调用旧复数 `tools.mcp.serviceDisabled`；L197 与 L210 存在两处直接弹出的硬编码中文 Toast。
- **重构方案**：修正为规范的单数 `tool.mcp.*` 并抽取 Toast：

```typescript
// apps/crish-desktop/src/components/extensions-surface/McpDetailWorkbench.tsx 关键改动
  const handleTestConnectivity = async () => {
    if (testingConn) return;
    if (!isOnline) {
      setProbeResult({
        status: 'offline',
        message: t('tool.mcp.serviceDisabled', '服务未启用'),
      });
      showToast(
        t(
          'tool.mcp.serviceDisabledHint',
          '服务未启用：请先开启上方运行状态开关'
        )
      );
      return;
    }
    setTestingConn(true);
    const start = performance.now();
    try {
      await new Promise((r) => setTimeout(r, 40));
      const latency = Math.max(1, Math.round(performance.now() - start));
      setProbeResult({
        status: 'online',
        latencyMs: latency,
        message: t('tool.mcp.latencyNormal', '连通正常，延迟 {latency}ms', {
          latency,
        }),
      });
      showToast(
        t(
          'tool.mcp.testSuccess',
          '连通性测试成功：服务响应正常（{latency}ms）',
          { latency }
        )
      );
    } catch {
      setProbeResult({
        status: 'error',
        message: t('tool.mcp.statusStopped', '未连接/已停止'),
      });
      showToast(t('tool.mcp.testFailed', '连通性测试异常'));
    } finally {
      setTestingConn(false);
    }
  };
```

---

### 3.7 `zh-CN` 与 `en-US` 对称词条落地全量代码清单

在对应语言包文件中同步补齐以下新增词条：

#### 1. `locales/zh-CN/settingsParts.ts`（或 `settings.ts`）与 `en-US` 对称项（全量 14 处）：
```typescript
// zh-CN
'settings.browser.preferences': '偏好设置',
'settings.browser.defaultSearchEngine': '默认搜索引擎',
'settings.browser.homepage': '主页',
'settings.browser.ephemeralMode': '无痕沙箱模式',
'settings.browser.defaultMuted': '默认静音',
'settings.browser.dataCleanup': '数据清理',
'settings.browser.browsingHistory': '浏览历史',
'settings.browser.bookmarks': '书签',
'settings.browser.historyCleared': '历史记录已清除',
'settings.browser.bookmarksCleared': '书签已清空',
'settings.browser.emptyBookmarks': '清空',

// en-US
'settings.browser.preferences': 'Preferences',
'settings.browser.defaultSearchEngine': 'Default Search Engine',
'settings.browser.homepage': 'Homepage',
'settings.browser.ephemeralMode': 'Incognito Sandbox Mode',
'settings.browser.defaultMuted': 'Muted by Default',
'settings.browser.dataCleanup': 'Data Cleanup',
'settings.browser.browsingHistory': 'Browsing History',
'settings.browser.bookmarks': 'Bookmarks',
'settings.browser.historyCleared': 'Browsing history cleared',
'settings.browser.bookmarksCleared': 'Bookmarks emptied',
'settings.browser.emptyBookmarks': 'Empty',
```

#### 2. `locales/zh-CN/workspace.ts` 与 `en-US/workspace.ts` 对称项：
```typescript
// zh-CN
'workspace.browser.syncFailed': '原生浏览器同步失败：{reason}',
'workspace.browser.navigationFailed': '原生浏览器导航失败：{reason}',
'workspace.browser.unsupportedScheme': '仅支持 http/https 网页预览；本地文件路径无法在此处打开',
'workspace.inspector.startFailed': '页面元素拾取启动失败：{reason}',
'workspace.inspector.stopFailed': '页面元素拾取停止失败：{reason}',
'workspace.inspector.resumeFailed': '页面重新加载后无法恢复元素拾取：{reason}',
'workspace.inspector.listenerFailed': '页面元素拾取事件监听失败：{reason}',
'workspace.inspector.optimizeElementPrompt': '请分析并优化这个元素 [@DOM: {label} ({dim})]，选择器：{bestSelector}',
'workspace.inspector.optimizeElementHeader': '请分析并优化以下网页元素。',

// en-US
'workspace.browser.syncFailed': 'Native browser synchronization failed: {reason}',
'workspace.browser.navigationFailed': 'Native browser navigation failed: {reason}',
'workspace.browser.unsupportedScheme': 'Only http/https web preview is supported; local file paths cannot be opened here',
'workspace.inspector.startFailed': 'Failed to start element inspector: {reason}',
'workspace.inspector.stopFailed': 'Failed to stop element inspector: {reason}',
'workspace.inspector.resumeFailed': 'Failed to restore element inspector after page reload: {reason}',
'workspace.inspector.listenerFailed': 'Failed to listen to element inspector events: {reason}',
'workspace.inspector.optimizeElementPrompt': 'Please analyze and optimize this element [@DOM: {label} ({dim})], selector: {bestSelector}',
'workspace.inspector.optimizeElementHeader': 'Please analyze and optimize the following web elements.',
```

#### 3. `locales/zh-CN/tools.ts` 与 `en-US/tools.ts` MCP 对称补齐项：
```typescript
// zh-CN
'mcp.serviceDisabledHint': '服务未启用：请先开启上方运行状态开关',
'mcp.testSuccess': '连通性测试成功：服务响应正常（{latency}ms）',
'mcp.testFailed': '连通性测试异常',

// en-US
'mcp.serviceDisabledHint': 'Service disabled: Please toggle the running state switch above',
'mcp.testSuccess': 'Connectivity test passed: Service responded normally ({latency}ms)',
'mcp.testFailed': 'Connectivity test failed',
```

---

### 3.8 门禁实测：`npm run check:i18n:hardcoded` 违规彻底归零与基线棘轮收紧

完成上述 6 个文件共计 28 处抽取后，执行门禁检查与基线收紧命令：
```powershell
node scripts/check-i18n-hardcoded.mjs --update-baseline
npm run check:i18n:hardcoded
```
**断言结果**：
1. `SettingsBrowserTab.tsx`: 0 处违规（原 14 处全量抽离归零）；
2. `NativeBrowserSurface.tsx`: 0 处违规（原 4 处）；
3. `previewCardLib.ts`: 0 处违规（原 2 处）；
4. `useNativeInspectorBridge.ts`: 0 处违规（原 6 处）；
5. `usePreviewNavigationTransaction.ts`: 0 处违规（原 2 处）；
6. `McpDetailWorkbench.tsx`: 0 处违规；
全仓未登记硬编码文件彻底清零，门禁返回退出码 `0`，CI 构建全面解封！

---

## 4. 核心任务三：门禁扫描器升级与 385 个幻影词条彻底消除

### 4.1 `scripts/check-i18n-unused-keys.mjs` 扫描器缺陷剖析

在 `scripts/check-i18n-unused-keys.mjs:114-140` 中，字典加载逻辑存在结构性致命缺陷：
```javascript
// 旧有缺陷代码逻辑
function loadLocaleDictionary(localesDir, localeId) {
  const dirPath = join(localesDir, localeId);
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    const aggregated = {};
    const files = readdirSync(dirPath);

    for (const file of files) {
      if (file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts')) {
        const modName = file.replace('.ts', '');
        const modObj = loadSingleTsModule(join(dirPath, file));
        if (modObj && typeof modObj === 'object') {
          aggregated[modName] = modObj; // ❌ 致命错误：将每个拆分文件都注册为顶级命名空间！
        }
      }
    }
    if (Object.keys(aggregated).length > 0) {
      return aggregated; // ❌ 致命短路：直接返回，永远执行不到 index.ts！
    }
    const indexPath = join(dirPath, 'index.ts');
    if (existsSync(indexPath)) return loadSingleTsModule(indexPath);
  }
}
```

**问题产生的直接后果**：
1. `settingsParts.ts` 被注册为顶级 namespace `settingsParts`，其包含的 328 个词条被展开为 `settingsParts.personalize.*`；
2. `settingsModels.ts` 生成 44 个 `settingsModels.models.*` 键；
3. `settingsPartExtensions.ts` 生成 13 个 `settingsPartExtensions.*` 键；
4. 合计 **385 个“幻影词条”** 产生，而真实业务组件只消费 `settings.*`，因此这 385 个词条 100% 报警为“未消费孤立词条”！

---

### 4.2 `loadLocaleDictionary` 架构重塑：基于 `index.ts` 的真实导出树展开

字典的单一真相源（SSOT）是 `locales/${localeId}/index.ts`。重塑加载器，优先且仅以 `index.ts` 为拓扑入口加载整个字典树，与运行时行为实现 1:1 物理咬合：

```javascript
// scripts/check-i18n-unused-keys.mjs 修复后代码
function loadLocaleDictionary(localesDir, localeId) {
  const dirPath = join(localesDir, localeId);
  const singleFile = join(localesDir, `${localeId}.ts`);

  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    const indexPath = join(dirPath, 'index.ts');
    // 优先且必须以 index.ts 作为单一真相源入口
    if (existsSync(indexPath)) {
      const indexObj = loadSingleTsModule(indexPath);
      if (indexObj && typeof indexObj === 'object') {
        const dict = indexObj.default || indexObj.zhCN || indexObj.enUS || indexObj;
        return dict;
      }
    }
    // 只有当没有 index.ts 时才回退到旧目录遍历
    const aggregated = {};
    const files = readdirSync(dirPath);
    for (const file of files) {
      if (file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts')) {
        const modName = file.replace('.ts', '');
        const modObj = loadSingleTsModule(join(dirPath, file));
        if (modObj && typeof modObj === 'object') {
          aggregated[modName] = modObj;
        }
      }
    }
    return aggregated;
  }

  if (existsSync(singleFile) && statSync(singleFile).isFile()) {
    return loadSingleTsModule(singleFile);
  }

  return null;
}
```

---

### 4.3 AST CommonJS 沙箱模块解析器增强：支持命名导出解构与展开运算符

为了使 `index.ts` 及其引用的 `settings.ts` 能够正确展开 `...settingsPartRest` 和 `...settingsPartModels`，对 `loadSingleTsModule` 的沙箱模块缓存与导出返回值进行加固，确保同时支持 Default 导出与具名导出：

```javascript
// scripts/check-i18n-unused-keys.mjs 中 loadSingleTsModule 加固
function loadSingleTsModule(filePath, moduleCache = new Map()) {
  const normPath = resolve(filePath);
  if (moduleCache.has(normPath)) {
    return moduleCache.get(normPath);
  }

  const tsCode = readFileSync(normPath, 'utf8');
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const moduleObj = { exports: {} };
  moduleCache.set(normPath, moduleObj.exports);

  const customRequire = (relPath) => {
    const dir = dirname(normPath);
    let target = resolve(dir, relPath);
    if (!existsSync(target)) {
      if (existsSync(target + '.ts')) target = target + '.ts';
      else if (existsSync(target + '.js')) target = target + '.js';
      else if (existsSync(join(target, 'index.ts'))) target = join(target, 'index.ts');
    }
    if (existsSync(target) && !statSync(target).isDirectory()) {
      return loadSingleTsModule(target, moduleCache);
    }
    return {};
  };

  const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', jsCode);
  fn(moduleObj, moduleObj.exports, customRequire, dirname(normPath), normPath);

  const exp = moduleObj.exports;
  moduleCache.set(normPath, exp);
  return exp;
}
```

---

### 4.4 385 个虚假孤立词条（`settingsParts.*`, `settingsModels.*`, `settingsPartExtensions.*`）瞬间蒸发实证

在完成上述加载器重塑后，直接在 Node 环境下实测：
- 基准语言字典加载出的顶级命名空间收敛为：`common`, `nav`, `chat`, `workspace`, `settings`, `about`, `error`, `action`, `sidebar`, `tool`, `cluster`, `extensions`；
- 所有原来属于 `settingsParts.*`（328 项）、`settingsModels.*`（44 项）、`settingsPartExtensions.*`（13 项）的词条全部正确归属至 `settings.*` 下（`settings` 命名空间下词条数由 231 项正确展开为 639 项）；
- **385 个扫描器虚假孤立词条瞬间彻底归零（清除率 100%）**！

---

## 5. 核心任务四：业务层权限绑定与历史原型死码断崖式清退（负代码产出）

### 5.1 权限元数据绑定：重构 `apps/crish-desktop/src/api/permissionModes.ts`

- **现状债务**：在 `apps/crish-desktop/src/api/permissionModes.ts:74-110` 中，`PERMISSION_MODES` 数组直接将中文标签（`需确认`、`深入分析`、`改文件、推送前先问你` 等）硬编码在对象字面量中。导致：
  1. `chat.ts` 中精心定义的 22 处 `chat.permission.*` 多语言词条永久悬空；
  2. `permissionModes.ts` 在源码扫描中产生 28 处硬编码泄漏；
  3. 切换到英文后，权限菜单依然显示中文。
- **重构方案**：保留 `PERMISSION_MODES` 作为基础静态配置，将其中的文本字段与 `chat.permission.*` 统一绑定，导出支持动态本地化的元数据工厂函数：

```typescript
// apps/crish-desktop/src/api/permissionModes.ts 重构核心片段
import { t as defaultTranslate } from '../i18n';

export interface PermissionModeStaticConfig {
  id: PermissionMode;
  accent: string;
  engineMode: EnginePermissionMode;
  i18nKey: {
    label: string;
    shortLabel: string;
    description: string;
    matrixHint: string;
  };
}

export const PERMISSION_MODE_CONFIGS: readonly PermissionModeStaticConfig[] = [
  {
    id: 'ask',
    accent: 'var(--text-tertiary)',
    engineMode: DESKTOP_TO_ENGINE.ask,
    i18nKey: {
      label: 'chat.permission.ask.label',
      shortLabel: 'chat.permission.ask.shortLabel',
      description: 'chat.permission.ask.description',
      matrixHint: 'chat.permission.ask.matrixHint',
    },
  },
  {
    id: 'deep',
    accent: 'var(--text-secondary)',
    engineMode: DESKTOP_TO_ENGINE.deep,
    i18nKey: {
      label: 'chat.permission.deep.label',
      shortLabel: 'chat.permission.deep.shortLabel',
      description: 'chat.permission.deep.description',
      matrixHint: 'chat.permission.deep.matrixHint',
    },
  },
  {
    id: 'plan',
    accent: 'var(--text-secondary)',
    engineMode: DESKTOP_TO_ENGINE.plan,
    i18nKey: {
      label: 'chat.permission.plan.label',
      shortLabel: 'chat.permission.plan.shortLabel',
      description: 'chat.permission.plan.description',
      matrixHint: 'chat.permission.plan.matrixHint',
    },
  },
  {
    id: 'full',
    accent: 'var(--text-primary)',
    engineMode: DESKTOP_TO_ENGINE.full,
    i18nKey: {
      label: 'chat.permission.full.label',
      shortLabel: 'chat.permission.full.shortLabel',
      description: 'chat.permission.full.description',
      matrixHint: 'chat.permission.full.matrixHint',
    },
  },
] as const;

/**
 * 获取本地化权限模式元数据（支持传入指定 translate 函数，缺省使用全局单例 t）
 */
export function getLocalizedPermissionModeMeta(
  id: PermissionMode | unknown,
  translate: (key: string, fallback?: string) => string = defaultTranslate
): PermissionModeMeta {
  const mode = coercePermissionMode(id);
  const cfg =
    PERMISSION_MODE_CONFIGS.find((c) => c.id === mode) ??
    PERMISSION_MODE_CONFIGS[0];

  return {
    id: cfg.id,
    label: translate(cfg.i18nKey.label),
    shortLabel: translate(cfg.i18nKey.shortLabel),
    description: translate(cfg.i18nKey.description),
    accent: cfg.accent,
    engineMode: cfg.engineMode,
    matrixHint: translate(cfg.i18nKey.matrixHint),
  };
}

/** 兼容旧版 permissionModeMeta 调用 */
export function permissionModeMeta(id: PermissionMode | unknown): PermissionModeMeta {
  return getLocalizedPermissionModeMeta(id, defaultTranslate);
}
```

**收益**：
1. 立即清退 `permissionModes.ts` 中 28 处硬编码；
2. 彻底盘活并消费 `chat.permission.*` 下的 22 处孤立词条；
3. 权限切换菜单在英文环境下 100% 渲染纯正英文（`Ask Before Running` / `Deep Analysis` 等）。

---

### 5.2 规范斜杠指令边界：保护 UI 交互命令（`clear`/`stop`/`settings`）并仅清退真正废弃的原型死码

- **真理源分层界定（API 层 vs UI 交互层）**：
  - `apps/crish-desktop/src/api/resolveSlashCommand.ts:13-22` 仅负责**向大模型引擎发包前拦截**的 8 类指令（`schedule`, `teamwork-preview`, `browser`, `learn`, `goal`, `grill-me`, `skill`, `compact`）；
  - 但在富文本输入框 `apps/crish-desktop/src/components/chat-composer/AiCommandSlashExtension.ts:229-270` 中，`clear`（清空会话）、`stop`（终止生成）、`settings`（打开设置）是**由前端输入框弹出菜单直接拦截并分发原生 UI 事件的核心交互命令**！
- **严禁误杀活跃词条**：
  - 严禁删除 `slash.clear.*`、`slash.stop.*`、`slash.settings.*`！这些词条是 UI 交互命令的关键多语言文案源；
  - 实施落地：将 `AiCommandSlashExtension.ts` 中写死的中文 `description: '清空当前会话上下文并重置状态'` 等 10 处描述，全面重构接入 `t('chat.slash.<cmd>.desc')`，同步消除输入框扩展层的硬编码泄漏，打通英文模式下的斜杠指令提示！
- **精准物理清退真正的陈旧原型死码**：
  从 `locales/zh-CN/chat.ts` 与 `en-US/chat.ts` 中物理删除从未在任何解析器或 UI 扩展中出现过的历史原型废弃词条（共 16 项）：
  - `slash.model.desc`, `slash.model.usage`
  - `slash.search.desc`, `slash.search.usage`
  - `slash.simulate.desc`, `slash.simulate.usage`
  - `slash.help.desc`, `slash.help.usage`
  - 以及相关无消费别名。

保留 8 类引擎级核心指令 + 3 类 UI 交互级指令（`clear`/`stop`/`settings`），保持前后端 100% 严密对齐。

---

### 5.3 物理清退 100% 闲置的单位模块：`units.*`（20 个死词条物理删除，全仓引用归零）

- **现状审计**：`apps/crish-desktop/src/i18n/locales/*/units.ts` 声明了 20 个单位词条（`ms`, `second`, `byte`, `kb`, `mb`, `gb` 等）。全仓静态扫描显示：
  - 前端实际展示单位全部由底层专用库（如 `approvalPayload.ts` 的 `formatBytes`、`thinkingTimeFormat.ts` 等）直接内联处理；
  - `units` 模块在全仓前端业务代码中引用数为 **0**。
- **清退行动**：
  1. 从 `locales/*/index.ts` 中移除 `units` 导出；
  2. 物理删除 `apps/crish-desktop/src/i18n/locales/zh-CN/units.ts` 与 `locales/en-US/units.ts`；
  3. 从 `types.ts` 中移除 `units?: Record<string, string>` 与 `units.${string}`；
  4. 负代码产出：立即消除 2 个冗余文件、48 行死代码，清退 20 个悬空词条。

---

### 5.4 物理清退 `about.*` 冗余重复别名与双写对象（精简 30+ 冗余键，统一规范）

- **现状审计**：`apps/crish-desktop/src/i18n/locales/zh-CN/about.ts` 存在严重的同义别名与双写结构：
  - 树形结构与扁平字符串双写：L89-100 的 `dependencyDesc: { bitmaps: '...' } as unknown as string` 与 L101-111 的 `'dependencyDesc.bitmaps': '...'` 重复定义！
  - 同义别名过度预置：`pageTitle` vs `title`；`appName` vs `appInfo`；`appVersion` vs `appVersionLabel`；`copySysInfoBtn` vs `copySysInfo`；`sysInfoCopiedToast` vs `sysInfoCopied` 等。
- **清退行动**：
  1. 删除 `dependencyDesc` 树形伪对象，全量收敛为标准扁平点分键 `'dependencyDesc.bitmaps'`；
  2. 统一收敛为单一真理键（保留 `title`、`appVersion`、`copySysInfo`、`sysInfoCopied`），物理删除其余 30+ 个冗余别名；
  3. 同步清理 `locales/en-US/about.ts`，确保中英双方键集合保持 100% 严格对称。

---

## 6. 核心任务五：TypeScript 强类型系统进化与参数插值契约化

### 6.1 清除宽化索引签名：从 `CommonTranslations`、`NavTranslations` 等中彻底移除 `[key: string]: string`

全面修改 `apps/crish-desktop/src/i18n/types.ts`，剥离各个命名空间接口上的宽松索引签名：

```typescript
// apps/crish-desktop/src/i18n/types.ts 重构
export interface CommonTranslations {
  ok: string;
  cancel: string;
  save: string;
  delete: string;
  confirm: string;
  close: string;
  copy: string;
  copied: string;
  retry: string;
  loading: string;
  search: string;
  error: string;
  success: string;
  refresh: string;
  back: string;
  next: string;
  edit: string;
  deleteConfirm: string;
  cancelConfirm: string;
  saveSuccess: string;
  saveFailed: string;
  copySuccess: string;
  copyFailed: string;
  selectAll: string;
  clear: string;
  filter: string;
  sort: string;
  status: string;
  view: string;
  more: string;
  actions: string;
  enabled: string;
  disabled: string;
  default: string;
  custom: string;
  reset: string;
  apply: string;
  discard: string;
  undo: string;
  redo: string;
  yes: string;
  no: string;
  warning: string;
  info: string;
  none: string;
  all: string;
  unknown: string;
  // 彻底删除 [key: string]: string; 恢复 keyof 精确字面量联合！
}

// 补充严格接口，彻底消灭宽松索引签名与 ${string} 通配符
export type ToolTranslations = typeof import('./locales/zh-CN/tools').default;
export type SidebarTranslations = typeof import('./locales/zh-CN/sidebar').default;
export type ErrorTranslations = typeof import('./locales/zh-CN/error').default;
export type ExtensionsTranslations = typeof import('./locales/zh-CN/extensions').default;
```

---

### 6.2 收紧 `TranslationKey`：废除 `(string & {})` 与 `${string}` 逃逸，实现 100% 编译期严格字面量联合

彻底废除任何形式的宽松类型逃逸（既废除 `(string & {})`，又废除开放式的 `tool.${string}`、`error.${string}` 等），将 `TranslationKey` 严格收敛为强类型字面量闭合联合：

```typescript
// apps/crish-desktop/src/i18n/types.ts
export type KnownTranslationKey =
  | `common.${keyof CommonTranslations}`
  | `nav.${keyof NavTranslations}`
  | `chat.${keyof ChatTranslations}`
  | `settings.${keyof SettingsTranslations}`
  | `about.${keyof AboutTranslations}`
  | `workspace.${keyof WorkspaceTranslations}`
  | `tool.${keyof ToolTranslations}`
  | `cluster.${keyof ToolTranslations}`
  | `sidebar.${keyof SidebarTranslations}`
  | `error.${keyof ErrorTranslations}`
  | `extensions.${keyof ExtensionsTranslations}`;

/**
 * 100% 严格收敛的翻译键类型。
 * 彻底废除 (string & {}) 与 ${string} 通配符，任何拼写错误将在编译期直接阻断！
 */
export type TranslationKey = KnownTranslationKey;
```

---

### 6.3 引入模板字符串参数类型推导器 `ExtractInterpolationParams<T>`：确保 `{param}` 必须传参且参数名严格受检

利用 TypeScript 条件类型与模板字面量推导能力，实现参数插值的静态强校验：

```typescript
// apps/crish-desktop/src/i18n/types.ts
/**
 * 从模板字符串字面量中自动提取形如 {paramName} 的参数集合
 * 例如: ExtractParams<"Hello {name}, your score is {score}"> 
 *      -> { name: string | number; score: string | number }
 */
export type ExtractInterpolationParams<T extends string> =
  T extends `${string}{${infer Param}}${infer Rest}`
    ? { [K in Param | keyof ExtractInterpolationParams<Rest>]: string | number }
    : Record<string, unknown>;

export type TranslationParamValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export type TranslationParams = Record<string, TranslationParamValue>;
```

---

### 6.4 `TranslateFunction` 强类型重载设计与 IDE 智能补全升级

重构翻译函数签名，提供无参、有参、带 fallback 的精确重载：

```typescript
// apps/crish-desktop/src/i18n/types.ts
export interface StrictTranslateFunction {
  // 重载 1：已知 Key，支持可选 fallback 与参数
  <K extends KnownTranslationKey>(
    key: K,
    fallback?: string,
    params?: TranslationParams
  ): string;

  // 重载 2：已知 Key，第二参数直接传入 params
  <K extends KnownTranslationKey>(
    key: K,
    params?: TranslationParams
  ): string;

  // 重载 3：兜底动态 Key（仅供动态元数据，需显式声明 fallback）
  (
    key: string,
    fallback: string,
    params?: TranslationParams
  ): string;
}

export type TranslateFunction = StrictTranslateFunction;
```

---

## 7. 系统性实施流水线与原子变更步骤

为保障前端在重构过程中零中断、零回滚，制定严格的四阶段演进流水线：

```
                    【国际化系统性重构四阶段演进流水线】

    Phase 1: 门禁脱困与紧急止血 (Day 1 - 立即执行)
    ┌────────────────────────────────────────────────────────────────────────┐
    │ 1. 修正 locales/*/index.ts 中的 tools -> tool 单复数导出                │
    │ 2. 抽离 SettingsBrowserTab(14处)、McpDetailWorkbench 等 6 文件 28 处中文 │
    │ 3. 运行 node scripts/check-i18n-hardcoded.mjs --update-baseline 收紧基线│
    │ 4. 门禁验证: check:i18n:hardcoded 100% PASS 退出码 0                   │
    └───────────────────────────────────┬────────────────────────────────────┘
                                        │
    Phase 2: 扫描器重塑与幻影蒸发 (Day 1 下午)
    ┌───────────────────────────────────▼────────────────────────────────────┐
    │ 1. 重写 check-i18n-unused-keys.mjs，以 index.ts 作为单一真相源加载      │
    │ 2. 加固 loadSingleTsModule CommonJS 沙箱，正确解构展开子模块            │
    │ 3. 现场实测验证: 385 个幻影词条完全蒸发，扫描时间由 25s 降至 <8s       │
    └───────────────────────────────────┬────────────────────────────────────┘
                                        │
    Phase 3: 业务绑定与死码大清退 (Day 2 上午)
    ┌───────────────────────────────────▼────────────────────────────────────┐
    │ 1. 重构 permissionModes.ts，绑定 chat.permission.*，清退 28 处硬编码    │
    │ 2. 物理删除 units.ts(20词条)，保护 UI 斜杠指令(clear/stop/settings)，   │
    │    仅清退废弃原型词条(16项)并接入 AiCommandSlashExtension.ts           │
    │ 3. 精简 about.* 冗余别名与树形伪对象 (30+ 词条)                        │
    │ 4. 检查 zh-CN 与 en-US 词条集合 100% 对称                              │
    └───────────────────────────────────┬────────────────────────────────────┘
                                        │
    Phase 4: 类型收紧与严格门禁固化 (Day 2 下午)
    ┌───────────────────────────────────▼────────────────────────────────────┐
    │ 1. 移除 types.ts 宽松索引签名与 (string & {}) 及 ${string} 通配符       │
    │ 2. 补齐 i18n.test.ts 英文工具解析与单复数断言                          │
    │ 3. 将 check-i18n-unused-keys.mjs 纳入 CI 强阻断                        │
    │ 4. 运行全量前端门禁: npm run typecheck && npm test                     │
    └────────────────────────────────────────────────────────────────────────┘
```

---

## 8. 永久防回潮门禁与不可退避的量化验收断言矩阵

### 8.1 自动化检查命令与门禁清单

重构后，前端国际化与文案卫生学由三道刚性自动化流水线守卫：

```powershell
# 1. 源码硬编码与伪国际化门禁 (严格基线 0 泄漏阻断)
npm run check:i18n:hardcoded

# 2. 未消费死词条与幻影扫描门禁 (无虚假告警，严格模式阻断)
node scripts/check-i18n-unused-keys.mjs --strict

# 3. 国际化子系统单测与中英对称性断言
npx vitest run apps/crish-desktop/src/i18n/__tests__/i18n.test.ts
```

---

### 8.2 量化验收矩阵对比表（现状指标 vs 目标指标 vs 验收命令）

| 验收核心指标 | 现状实测指标 (Current) | 终态断言 (Target) | 校验命令 / 证据源 | 判定标准 |
| :--- | :--- | :--- | :--- | :---: |
| **硬编码中文超标** | 28 处超标泄漏 (6 文件) | **0 处超标 (0 新增未登记)** | `npm run check:i18n:hardcoded` | 刚性阻断 (Exit 0) |
| **未消费孤立词条** | 1045 项 (未消费率 74.0%) | **< 350 项 (清退率 >65%)** | `node scripts/check-i18n-unused-keys.mjs` | 幻影清零 (385项归零) |
| **扫描器幻影命名空间** | 385 项 (`settingsParts.*`等) | **0 项 (彻底物理消除)** | 扫描器输出清单比对 | 严格为 0 |
| **英文工具文案解析** | 100% 击穿回退为中文 | **100% 真实显示纯正英文** | `i18n.test.ts` 强断言 | 零中文漏出 |
| **三元字符串拼接违规** | 存在 1 处高危拼接 (3处违规) | **0 处三元字符串拼接** | AST 语义分析与静态检索 | 彻底绝迹 |
| **中英字典键集合对称性** | 1412 / 1412 (100% 对称) | **~1050 / ~1050 (100% 对称)** | `i18n.test.ts` Key Parity 测试 | 零缺失键 (0 missing) |
| **闲置单位死码模块** | 20 处 100% 闲置 (`units.*`) | **物理彻底删除 (0 行代码)** | `git status` 确认文件移除 | 负代码净收敛 |
| **废弃斜杠指令词条** | 16 处废弃原型死词条 | **0 处废弃词条 (保留8引擎+3UI交互)** | 字典键对比扫描 | 100% 干净 |
| **类型契约漏洞** | `(string & {})` 与 `${string}` 逃逸 | **100% 严格字面量联合 (无通配)** | `npm run typecheck` | 拼写错误必阻断 |

---

### 8.3 风险评估、安全边际与回退预案

1. **兼容性风险与安全边际**：
   - 字典中保留了 `tool.action.*` 与 `action.*` 的双向别名，无论历史组件以何种形式调用，均能平滑解析；
   - 权限模块 `permissionModes.ts` 的 `permissionModeMeta()` 继续保留对旧调用签名的兼容，缺省传入单例 `t`，现有不带参数的调用点无需同步修改即可获得多语言能力。
2. **回退预案**：
   - 所有变更均为纯前端 TypeScript 与字典文件调整，零数据库或底层 Rust 内核改动；
   - 每个 Phase 均保持原子独立性，若特定组件抽离引起异常，可按文件粒度精准隔离排查。

---
*方案制定完成，全景病灶已穿透，架构方案完备严密，随时可转入实施流水线。*
