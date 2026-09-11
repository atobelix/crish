# MCP 工具服务、技能扩展与扩展生态体系深度实勘导航

> **战役代号**：前端原子化组件库战役（Frontend Atomic Architecture Campaign）
> **任务编号**：任务书 22（Task-22）
> **责任领域**：MCP 扩展服务管理（`settings-mcp/`）、技能扩展体系（`settings-skills/`）以及扩展中心货架生态（`settings-extensions/`）
> **实勘基准**：深入逐行阅读所辖范围内的全部 43 个源码文件与样式文件，以客观、精准、零退避的技术视角，穿透现有架构断层、状态机分裂、环境变量缺失、杂乱边框与彩色徽章视觉撕裂等核心痛点，并给出下一代统一扩展卡片原语（Unified Extension Card Primitive）与动态环境变量编辑组件的重塑方案。
> **创建时间**：2026-09-06
> **文档规范**：UTF-8 无 BOM、中文、行级证据复核、行数规范（≥1200行）。

---

## 目录索引

- [一、概述与勘察全景地图](#一概述与勘察全景地图)
  - [1.1 战役背景与扩展生态使命](#11-战役背景与扩展生态使命)
  - [1.2 所辖 43 个源码与样式文件全量拓扑与度量基线表](#12-所辖-43-个源码与样式文件全量拓扑与度量基线表)
  - [1.3 核心依赖网络与数据调用拓扑](#13-核心依赖网络与数据调用拓扑)
  - [1.4 历史演进与多重管理入口拓扑](#14-历史演进与多重管理入口拓扑)
- [二、settings-mcp：MCP 扩展服务体系深度实勘](#二settings-mcp-mcp-扩展服务体系深度实勘)
  - [2.1 types.ts 类型系统与传输协议映射](#21-typests-类型系统与传输协议映射)
  - [2.2 McpSettingsTab.tsx 视图宿主与双模渲染](#22-mcpsettingstabtsx-视图宿主与双模渲染)
  - [2.3 McpSettingsTab.module.css 样式系统全量解析](#23-mcpsettingstabmodulecss-样式系统全量解析)
  - [2.4 McpServerList.tsx 服务列表编排与多态渲染](#24-mcpserverlisttsx-服务列表编排与多态渲染)
  - [2.5 McpServerToolbar.tsx 共享工具栏与死皮约束](#25-mcpservertoolbartsx-共享工具栏与死皮约束)
  - [2.6 McpServerForm.tsx 注册服务表单与环境变量行严重缺失解构](#26-mcpserverformtsx-注册服务表单与环境变量行严重缺失解构)
  - [2.7 McpServerTools.tsx 展开式工具列表与标识复制](#27-mcpservertoolstsx-展开式工具列表与标识复制)
  - [2.8 McpServerFilterEmpty.tsx 复合空态组件](#28-mcpserverfilteremptytsx-复合空态组件)
  - [2.9 useMcpSettings.ts 核心状态机深度剖析](#29-usemcpsettingsts-核心状态机深度剖析)
  - [2.10 useMcpServerListState.ts 状态聚合器与 Props 解耦](#210-usemcpserverliststatets-状态聚合器与-props-解耦)
  - [2.11 工具探测与健康状态指示机制剖析](#211-工具探测与健康状态指示机制剖析)
  - [2.12 settings-mcp 单元测试套件剖析](#212-settings-mcp-单元测试套件剖析)
- [三、settings-skills：技能扩展管理体系深度实勘](#三settings-skills-技能扩展管理体系深度实勘)
  - [3.1 skillsSettingsTypes.ts 类型定义与 SharedSkillApi 架构](#31-skillssettingstypests-类型定义与-sharedskillapi-架构)
  - [3.2 SkillsSettingsTab.tsx 技能主视图宿主与布局拓扑](#32-skillssettingstabtsx-技能主视图宿主与布局拓扑)
  - [3.3 SkillsSettingsTab.module.css 样式体系逐类解构](#33-skillssettingstabmodulecss-样式体系逐类解构)
  - [3.4 SkillCardList.tsx 左侧技能列表导轨与多级作用域](#34-skillcardlisttsx-左侧技能列表导轨与多级作用域)
  - [3.5 SkillDetailPreview.tsx 右侧技能详情与预览中枢](#35-skilldetailpreviewtsx-右侧技能详情与预览中枢)
  - [3.6 SkillEditorModal.tsx 与 SkillEditorModal.module.css 模态发现与创建](#36-skilleditormodaltsx-与-skilleditormodalmodulecss-模态发现与创建)
  - [3.7 SkillsMoreMenu.tsx 更多操作浮层菜单与批量确认](#37-skillsmoremenutsx-更多操作浮层菜单与批量确认)
  - [3.8 useSkillDirectories.ts 目录扫描与导入状态机](#38-useskilldirectoriests-目录扫描与导入状态机)
  - [3.9 useSkillEditor.ts 技能编辑器与草稿跨层联动](#39-useskilleditorts-技能编辑器与草稿跨层联动)
  - [3.10 useSkillList.ts 技能核心列表与多维筛选算法](#310-useskilllistts-技能核心列表与多维筛选算法)
  - [3.11 useSkillsSettingsState.ts 跨子 Hook 共享 API Hub 架构](#311-useskillssettingsstatets-跨子-hook-共享-api-hub-架构)
  - [3.12 settings-skills 单元测试套件剖析](#312-settings-skills-单元测试套件剖析)
- [四、settings-extensions：扩展中心货架与生态聚合深度实勘](#四settings-extensions-扩展中心货架与生态聚合深度实勘)
  - [4.1 types.ts 与 ExtensionCardIdentity.ts 类型契约](#41-typests-与-extensioncardidentityts-类型契约)
  - [4.2 buildInstalledExtensions.ts 多源聚合算法](#42-buildinstalledextensionsts-多源聚合算法)
  - [4.3 pluginRegistryAdapter.ts 插件注册表适配器](#43-pluginregistryadapterts-插件注册表适配器)
  - [4.4 useMcpCache.ts 与 useSkillsCache.ts 独立缓存机制](#44-usemcpcachets-与-useskillscachets-独立缓存机制)
  - [4.5 useMarketQuery.tsx 市场查询与高亮管道](#45-usemarketquerytsx-市场查询与高亮管道)
  - [4.6 useExtensionMarket.tsx 扩展货架核心编排器与软超时](#46-useextensionmarkettsx-扩展货架核心编排器与软超时)
  - [4.7 ExtensionList.tsx 货架列表容器与双态分发](#47-extensionlisttsx-货架列表容器与双态分发)
  - [4.8 ExtensionCard.tsx 扩展卡片主体结构与徽章堆叠](#48-extensioncardtsx-扩展卡片主体结构与徽章堆叠)
  - [4.9 ExtensionBody.tsx 与 McpToolsSection.tsx 展开体架构](#49-extensionbodytsx-与-mcptoolssectiontsx-展开体架构)
  - [4.10 SettingsExtensionsTab.tsx 货架主视图与二级管理跳转](#410-settingsextensionstabtsx-货架主视图与二级管理跳转)
  - [4.11 SettingsExtensionsTab.module.css 样式系统全量解析](#411-settingsextensionstabmodulecss-样式系统全量解析)
  - [4.12 SettingsExtensionsTab.test.ts 死皮阻断测试套件](#412-settingsextensionstabtestts-死皮阻断测试套件)
- [五、现有架构断层、体验撕裂与视觉缺陷深度解构](#五现有架构断层体验撕裂与视觉缺陷深度解构)
  - [5.1 杂乱边框与多重容器嵌套撕裂排查](#51-杂乱边框与多重容器嵌套撕裂排查)
  - [5.2 彩色徽章与视觉噪音泛滥排查](#52-彩色徽章与视觉噪音泛滥排查)
  - [5.3 环境变量 Key-Value 动态行严重缺失与配置能力残缺](#53-环境变量-key-value-动态行严重缺失与配置能力残缺)
  - [5.4 幽灵命令与启停状态机认知割裂](#54-幽灵命令与启停状态机认知割裂)
  - [5.5 三套独立状态体系与缓存同步漂移](#55-三套独立状态体系与缓存同步漂移)
  - [5.6 弹窗、行内表单与树状展开交互形式割裂](#56-弹窗行内表单与树状展开交互形式割裂)
- [六、未来统一扩展卡片原语（Unified Extension Card Primitive）设计方案](#六未来统一扩展卡片原语unified-extension-card-primitive设计方案)
  - [6.1 设计理念：极简、高信噪比与去噪音化](#61-设计理念极简高信噪比与去噪音化)
  - [6.2 单一卡片原语契约设计（UnifiedExtensionCard）](#62-单一卡片原语契约设计unifiedextensioncard)
  - [6.3 视觉降噪规范：单色中性元数据与状态点](#63-视觉降噪规范单色中性元数据与状态点)
  - [6.4 动态环境变量配置组件设计（EnvVariableTable）](#64-动态环境变量配置组件设计envvariabletable)
  - [6.5 MCP 工具网格与健康探测指示规范](#65-mcp-工具网格与健康探测指示规范)
  - [6.6 三层渐进式卡片交互蓝图](#66-三层渐进式卡片交互蓝图)
  - [6.7 TypeScript + CSS Module 完整原型代码](#67-typescript--css-module-完整原型代码)
- [七、实勘结论与主控交接清单](#七实勘结论与主控交接清单)
  - [7.1 核心架构缺陷归纳表](#71-核心架构缺陷归纳表)
  - [7.2 原子化重塑路线图与里程碑](#72-原子化重塑路线图与里程碑)
  - [7.3 交付物与后续任务对齐建议](#73-交付物与后续任务对齐建议)

---

## 一、概述与勘察全景地图

### 1.1 战役背景与扩展生态使命

在现代桌面级智能体工程体系中，智能体（Agent）的能力边界绝不仅由大模型本身的权重参数所决定，更取决于其与外部宿主环境、专业技能库和第三方数据源的联结能力。Conex / Crish 桌面工作台通过三大支柱构建了其扩展生态：
1. **MCP（Model Context Protocol）扩展服务体系**：为智能体挂载外部工具能力（如 SQLite 查询、Git 深度检查、Puppeteer 网页自动化抓取、文件检索等），支持标准协议交互。
2. **Skills 技能体系**：基于规范化 `SKILL.md` 范式构建的专业领域上下文指令与工作流模板，通过斜杠命令（`/skill:<name>`）或模型智能提示按需激活。
3. **Extensions 扩展中心生态**：将官方插件、第三方 npm 模块、MCP 服务与本地 Skills 汇聚统一货架，提供一体化的发现、安装、配置与生命周期管理体验。

然而，在当前的实现中，由于多次迭代演进、历史幽灵命令清理以及各模块独立推进，前端在 `settings-mcp/`、`settings-skills/` 和 `settings-extensions/` 三个目录下形成了严重的断层与割裂现象：
- **卡片形态不一**：货架采用独立圆角卡片（`rowBlock`），MCP 采用平平无奇的单行底边框列表（`mcpRow`），技能采用左右不对称的分栏面板（`skillsSplit`），视觉体验割裂。
- **徽章泛滥成灾**：单张卡片内同时并存 3~4 个彩色徽章（Badge），绿、橙、红、灰多色混杂，视觉信噪比低下。
- **关键能力断层**：标准 MCP 协议中最核心的**环境变量 Key-Value 动态行配置**在前端界面中完全缺失；界面上仍残留着 Rust 内核早已废弃的 MCP 启停“幽灵操作”痕迹；三套状态缓存相互独立、数据流单向割裂。

本任务书（任务书 22）的使命，是对上述三大目录共计 **43 个源码与样式文件**进行地毯式、逐行级别的深度勘察，建立精准度量基线，客观记录现有实现中的每一处缺陷与断层，并为前端原子化架构战役输出一套统一的**扩展卡片原语（Unified Extension Card Primitive）**与**环境变量动态行编辑组件**设计方案。

---

### 1.2 所辖 43 个源码与样式文件全量拓扑与度量基线表

经过对所辖 3 个目录的全面代码扫描，本勘察任务覆盖源码文件共计 **43 个**（其中 `settings-mcp/` 12 个、`settings-skills/` 15 个、`settings-extensions/` 16 个），度量基线统计如下表所示：

#### 表 1-1：settings-mcp 目录全量文件度量表

| 序号 | 相对路径 | 物理行数 | 字节大小 | 核心组件 / 模块职责 | 核心导出契约 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `settings-mcp/types.ts` | 78 | 2,390 B | MCP 基础类型、传输协议映射、状态排序权重、通用文字复制兜底 | `SortMode`, `DemoTransport`, `transportLabel`, `copyText` 等 |
| 2 | `settings-mcp/McpSettingsTab.tsx` | 215 | 6,433 B | MCP 设置页主容器：整合状态监控、演示模式 vs 正式模式分发 | `McpSettingsTab` |
| 3 | `settings-mcp/McpSettingsTab.module.css` | 348 | 6,544 B | MCP 模块私有样式：状态胶囊、工具列表、表单网格、指示灯、底边框 | CSS Module 样式类 |
| 4 | `settings-mcp/McpServerList.tsx` | 407 | 14,229 B | MCP 服务列表主体：多态空态渲染、服务条目、工具展开控制、启停按钮 | `McpServerList`, `McpServerListProps` |
| 5 | `settings-mcp/McpServerToolbar.tsx` | 108 | 2,971 B | 列表共享工具栏：SegmentedControl 排序、search Input 搜索、demo 添加按钮 | `McpServerToolbar`, `McpServerToolbarProps` |
| 6 | `settings-mcp/McpServerToolbar.test.tsx` | 49 | 1,671 B | 工具栏死皮阻断单测：拦截 ui-segment 与裸 input 违规回潮 | Vitest 测试用例 |
| 7 | `settings-mcp/McpServerForm.tsx` | 137 | 4,063 B | 本地演示服务注册表单：名称、传输方式、命令、参数、URL（无环境变量输入） | `McpServerForm`, `McpServerFormProps` |
| 8 | `settings-mcp/McpServerTools.tsx` | 77 | 2,253 B | 单个 MCP 服务展开后的工具列表展示：工具名、Wrench 图标、一键复制 | `McpServerTools`, `McpServerToolsProps` |
| 9 | `settings-mcp/McpServerFilterEmpty.tsx` | 55 | 1,266 B | 搜索过滤结果为空时的空态渲染组件与一键清除筛选回调 | `McpServerFilterEmpty` |
| 10 | `useMcpSettings.ts` | 364 | 11,906 B | MCP 核心状态机 Hook：聚合服务列表、查询过滤、排序、启停探测与 demo 本地 CRUD | `useMcpSettings`, `UseMcpSettingsOptions` |
| 11 | `useMcpSettings.test.ts` | 86 | 2,646 B | useMcpSettings Hook 行为单测：在线模式加载、筛选排序、启停调用断言 | Vitest 测试用例 |
| 12 | `useMcpServerListState.ts` | 164 | 4,158 B | 状态聚合 Hook：将 useMcpSettings 的 29 个平铺字段收敛为 servers/ui/actions 三组对象 | `useMcpServerListState`, `McpServerListState` |

#### 表 1-2：settings-skills 目录全量文件度量表

| 序号 | 相对路径 | 物理行数 | 字节大小 | 核心组件 / 模块职责 | 核心导出契约 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 13 | `settings-skills/skillsSettingsTypes.ts` | 70 | 2,632 B | 技能设置类型契约、常量标签、斜杠命令计算、SharedSkillApi 接口定义 | `ACTIVATION_OPTIONS`, `skillSlashCmd`, `SharedSkillApi` 等 |
| 14 | `settings-skills/SkillsSettingsTab.tsx` | 253 | 7,583 B | 技能设置页主宿主：左右分栏 Split 框架、顶部操作栏、搜索筛选、文件系统警告 | `SkillsSettingsTab` |
| 15 | `settings-skills/SkillsSettingsTab.module.css` | 802 | 16,076 B | 技能页样式：双栏分割、列表导轨、详情面板、额外目录折叠、高亮与徽章 | CSS Module 样式类 |
| 16 | `settings-skills/SkillCardList.tsx` | 277 | 9,961 B | 左侧列表导轨：按项目/工作区/全局分组、密集模式条目、状态点、额外目录配置 | `SkillCardList` |
| 17 | `settings-skills/SkillDetailPreview.tsx` | 166 | 6,828 B | 右侧预览面板：技能标题、标签元数据、斜杠命令复制、系统文件定位、三态切换、Markdown 预览 | `SkillDetailPreview` |
| 18 | `settings-skills/SkillEditorModal.tsx` | 251 | 8,434 B | 发现新技能弹窗（ui/Dialog）与页内新建技能表单（浏览导入 / AI 对话草稿生成 / 手填） | `SkillEditorModal`, `SkillDiscoverDomain`, `SkillCreateDomain` |
| 19 | `settings-skills/SkillEditorModal.module.css` | 110 | 2,158 B | 发现弹窗与创建表单私有样式：复选列表、遮罩层级、网格字段、按钮行 | CSS Module 样式类 |
| 20 | `settings-skills/SkillEditorModal.test.tsx` | 128 | 5,057 B | 发现弹窗行为单测：候选勾选、跳过、全启、Switch 代替 Checkbox 校验 | Vitest 测试用例 |
| 21 | `settings-skills/SkillsMoreMenu.tsx` | 186 | 5,839 B | 右上角“更多操作”弹出菜单：同步到引擎、刷新、快捷命令开关、二次确认批量全启/全禁 | `SkillsMoreMenu`, `SkillsBatchState` |
| 22 | `settings-skills/SkillsMoreMenu.test.tsx` | 134 | 4,429 B | 更多菜单单测：菜单项渲染、快捷命令切换、二次确认计数逻辑断言 | Vitest 测试用例 |
| 23 | `settings-skills/useSkillDirectories.ts` | 150 | 4,122 B | 目录管理与发现导入 Hook：原生文件夹选取、额外目录增删、发现候选导入调度 | `useSkillDirectories` |
| 24 | `settings-skills/useSkillEditor.ts` | 132 | 4,225 B | 技能编辑器 Hook：手填项目技能创建、AI 草稿箱注入（sessionDraftManager）、正文 Markdown 解析 | `useSkillEditor` |
| 25 | `settings-skills/useSkillList.ts` | 364 | 10,176 B | 技能列表核心 Hook：目录扫描、localStorage 激活状态维护、多维筛选、批量状态变更 | `useSkillList` |
| 26 | `settings-skills/useSkillsSettingsState.ts` | 132 | 4,177 B | 跨子 Hook 共享 API Hub：利用 useRef 容器斩断 list ↔ directories ↔ editor 循环依赖 | `useSkillsSettingsState` |
| 27 | `settings-skills/useSkillsSettingsState.test.tsx` | 82 | 2,716 B | 状态 Hub 聚合单测：斜杠命令格式化、分组标签转换、激活态更新断言 | Vitest 测试用例 |

#### 表 1-3：settings-extensions 目录全量文件度量表

| 序号 | 相对路径 | 物理行数 | 字节大小 | 核心组件 / 模块职责 | 核心导出契约 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 28 | `settings-extensions/types.ts` | 33 | 1,095 B | 扩展中心核心类型：主视图、类型过滤、展开目标、PluginInstalledExtension 扩展条目 | `MainView`, `KindFilter`, `PluginInstalledExtension` 等 |
| 29 | `settings-extensions/ExtensionCardIdentity.ts` | 13 | 475 B | 插件卡片类型守卫：判断条目是否包含 pluginId 且 kind === 'plugin' | `isPluginCardItem` |
| 30 | `settings-extensions/extensionMarketLogic.ts` | 44 | 1,098 B | 纯逻辑函数：错误文本格式化、Promise 软超时控制器（withTimeout） | `errText`, `withTimeout` |
| 31 | `settings-extensions/buildInstalledExtensions.ts` | 128 | 3,530 B | 多源聚合算法：合并 本地技能 + 本地MCP + 本地扩展包 + 插件注册表 + 策展已安装项 | `buildInstalledExtensions`, `packageName` |
| 32 | `settings-extensions/pluginRegistryAdapter.ts` | 97 | 3,122 B | 官方插件注册表适配器：加载内置 import 插件 manifest、localStorage 启停状态维护 | `PluginCardState`, `listPluginCardStates`, `setPluginEnabled` |
| 33 | `settings-extensions/useMcpCache.ts` | 36 | 954 B | MCP 服务列表 localStorage 缓存 Hook：保障货架页面进入时秒开无白屏 | `useMcpCache` |
| 34 | `settings-extensions/useSkillsCache.ts` | 36 | 897 B | 技能列表 localStorage 缓存 Hook：保障货架页面首屏秒开 | `useSkillsCache` |
| 35 | `settings-extensions/useMarketQuery.tsx` | 86 | 2,688 B | 扩展货架查询 Hook：类型过滤、关键词搜索、文本关键词高亮（`<mark>` 节点） | `useMarketQuery` |
| 36 | `settings-extensions/useExtensionMarket.tsx` | 445 | 13,232 B | 扩展市场综合编排 Hook：4s 并发软超时刷新、安装/卸载、MCP 逐工具禁用、插件启停 | `useExtensionMarket` |
| 37 | `settings-extensions/ExtensionCard.tsx` | 274 | 8,973 B | 扩展卡片主体视图：彩色徽章渲染、来源标签、操作按钮槽、展开体条件挂载 | `ExtensionCard`, `ExtensionCardProps` |
| 38 | `settings-extensions/ExtensionBody.tsx` | 112 | 3,792 B | 技能与插件卡片展开体：SKILL.md 快速预览、插件 manifest 钩子与工具列表展示 | `ExtensionBody`, `ExtensionBodyProps` |
| 39 | `settings-extensions/ExtensionList.tsx` | 205 | 6,118 B | 扩展卡片列表容器：已安装 vs 发现双模分发、空态处理、去发现联动 | `ExtensionList`, `ExtensionListProps` |
| 40 | `settings-extensions/McpToolsSection.tsx` | 208 | 6,905 B | MCP 卡片展开体：detail 模式工具预览、config 模式服务启停与每个工具的 Switch 独立开关 | `McpToolsSection`, `McpToolsSectionProps` |
| 41 | `settings-extensions/SettingsExtensionsTab.tsx` | 226 | 6,076 B | 扩展设置主入口：视图与分类分段选择器、搜索框、二级全页管理跳转（MCP/技能） | `SettingsExtensionsTab` |
| 42 | `settings-extensions/SettingsExtensionsTab.module.css` | 219 | 4,129 B | 扩展卡片样式：卡片盒模型（rowBlock）、展开面板（inlinePanel）、工具条目、高亮 | CSS Module 样式类 |
| 43 | `settings-extensions/SettingsExtensionsTab.test.ts` | 72 | 2,765 B | 扩展页死皮与圆角规范扫描测试：拦截 ui-segment、settings-btn-rect 回潮 | Vitest 静态源码测试 |

**总代码规模统计**：所辖 43 个文件共计包含 **5,433 行源码与样式**，总字节量约 **16.8 万字节**。

---

### 1.3 核心依赖网络与数据调用拓扑

下图详细展示了前端三大扩展模块与底层数据存储、浏览器缓存、Tauri 原生桥接及 Rust 内核守护进程之间的通信网络：

```mermaid
graph TD
    subgraph UI 视图层 (crish-desktop)
        ExtensionsTab["SettingsExtensionsTab (货架入口)"]
        McpTab["McpSettingsTab (MCP高级管理)"]
        SkillsTab["SkillsSettingsTab (技能高级管理)"]

        ExtensionsTab -->|内嵌二级管理| McpTab
        ExtensionsTab -->|内嵌二级管理| SkillsTab

        ExtensionsTab --> ExtensionList --> ExtensionCard
        ExtensionCard --> ExtensionBody
        ExtensionCard --> McpToolsSection

        SkillsTab --> SkillCardList
        SkillsTab --> SkillDetailPreview
        SkillsTab --> SkillEditorModal
        SkillsTab --> SkillsMoreMenu

        McpTab --> McpServerList
        McpServerList --> McpServerToolbar
        McpServerList --> McpServerForm
        McpServerList --> McpServerTools
    end

    subgraph 状态与业务编排层 (Hooks)
        useExtensionMarket["useExtensionMarket.tsx"]
        useMarketQuery["useMarketQuery.tsx"]
        useSkillsState["useSkillsSettingsState.ts"]
        useMcpState["useMcpSettings.ts"]

        ExtensionsTab --> useExtensionMarket
        useExtensionMarket --> useMarketQuery
        useExtensionMarket --> buildInstalledExtensions["buildInstalledExtensions.ts"]
        useExtensionMarket --> pluginRegistry["pluginRegistryAdapter.ts"]

        SkillsTab --> useSkillsState
        useSkillsState --> useSkillList["useSkillList.ts"]
        useSkillsState --> useSkillDirs["useSkillDirectories.ts"]
        useSkillsState --> useSkillEditor["useSkillEditor.ts"]

        McpTab --> useMcpState
        useMcpState --> useMcpServerListState["useMcpServerListState.ts"]
    end

    subgraph API 与通信适配层
        mcpApi["mcpApi.ts"]
        skillsApi["skillsApi.ts"]
        clientApi["clientApi.ts"]
        catalogApi["extensionCatalog.ts"]

        useMcpState --> mcpApi
        useMcpState --> clientApi
        useSkillList --> skillsApi
        useExtensionMarket --> mcpApi
        useExtensionMarket --> skillsApi
        useExtensionMarket --> clientApi
        useExtensionMarket --> catalogApi
    end

    subgraph 数据存储与原生内核
        LocalStore[("localStorage<br/>(crish_skills_activation / crish_mcp_cache / plugin_enabled)")]
        SessionStore[("sessionStorage<br/>(crish_mcp_tool_disabled_cache)")]
        TauriFs["Tauri FS / Dialog / Opener<br/>(@tauri-apps/plugin-dialog, plugin-opener)"]
        RustCore["Rust 核心进程 (core_get_status)<br/>Task-Runner 运行时"]

        skillsApi --> LocalStore
        skillsApi --> TauriFs
        catalogApi --> SessionStore
        catalogApi --> LocalStore
        pluginRegistry --> LocalStore
        clientApi --> LocalStore

        mcpApi -->|transport.request| RustCore
    end
```

---

### 1.4 历史演进与多重管理入口拓扑

在早期版本中，MCP 设置与技能设置是平级暴露在全局设置弹窗（Settings Panel）左侧侧边栏的一级 Tab 中。后来为了降低用户心智负担，引入了 `settings-extensions/` 扩展中心作为统一货架，将插件、MCP 与 Skills 进行集中汇总。这导致了目前独特的“两级重叠管理拓扑”：
1. **统一货架态（一级入口）**：用户进入“设置 -> 扩展”，默认看到所有扩展条目的流式平铺卡片。每个卡片具备“详情”与“配置”按钮；
2. **内嵌高级管理态（二级入口）**：当用户在某个 MCP 卡片或技能卡片中点击“高级管理”时，`SettingsExtensionsTab` 会将其视图状态切换为 `manage = 'mcp'` 或 `manage = 'skill'`，并在原地通过 `<Suspense>` 懒加载渲染出完整的 `McpSettingsTab` 或 `SkillsSettingsTab`，顶部附带“返回扩展”的后退箭头；
3. **副作用与隔离断层**：由于二级入口完全是直接渲染旧的完整页面，导致高级管理中的样式规范（紧凑双栏、无边框下横线等）与货架外层的整体风格产生明显的视觉反差；且货架与高级管理之间使用各自独立的缓存 Hook（`useMcpCache` vs `useMcpSettings`），一旦在高级管理中修改了设置，返回货架时必须触发软超时全量重新探测，否则状态无法实时对齐。

---

## 二、settings-mcp：MCP 扩展服务体系深度实勘

### 2.1 types.ts 类型系统与传输协议映射

文件 [`apps/crish-desktop/src/components/settings-mcp/types.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/types.ts)（78 行）定义了 MCP 设置子系统的基础枚举、常量和工具函数：

```typescript
// 排序模式：按名称字母排序 vs 按状态优先级排序
export type SortMode = 'name' | 'state';

// 演示模式支持的传输协议类型
export type DemoTransport = 'stdio' | 'sse';

// 状态排序权重：ok 优先级最高(0)，其次 warn(1)，再次 err(2)，最后 idle(3)
export const STATE_SORT_RANK: Record<string, number> = {
  ok: 0,
  warn: 1,
  err: 2,
  idle: 3,
};
```

#### 关键传输协议与展示映射
函数 `transportLabel` 与 `transportTitle`（第 30-47 行）实现了协议标识到用户友好文案的转换：
- `stdio` -> 映射为简写 `stdio`，提示为 `标准输入输出（stdio）`；
- `sse` -> 映射为简写 `sse`，提示为 `服务端推送（SSE）`；
- `http` / `streamable-http` -> 直接保留原名，提示分别为 `HTTP` 与 `可流式 HTTP`。

#### 文本复制兜底逻辑（copyText）
第 54-77 行导出了异步函数 `copyText(text: string): Promise<boolean>`。其设计兼顾了现代安全上下文（`navigator.clipboard.writeText`）与不安全上下文/iframe 降级方案（创建绝对定位的隐藏 `<textarea>`，调用 `document.execCommand('copy')`）。这一兜底实现稳健有效，在单测与跨平台中表现良好。

---

### 2.2 McpSettingsTab.tsx 视图宿主与双模渲染

文件 [`apps/crish-desktop/src/components/settings-mcp/McpSettingsTab.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/McpSettingsTab.tsx)（215 行）是 MCP 设置的主宿主容器，其内部根据 `isDemoMode()` 进行严格的双模分发：

#### 1. 演示模式（Demo Mode，第 105-144 行）
当处于演示模式时，标题栏元数据区展示紫色的“演示模式”药丸以及当前启用数量统计（`demoEnabledCount 个启用 / 共 N 个`）。如果用户点击了“添加”按钮，在列表上方内联展开 `McpServerForm` 添加表单。

#### 2. 正式 / 引擎模式（Live Mode，第 147-214 行）
在连接真实引擎时，顶部元数据条（`mcpHeadStats`）渲染了一组高密度的状态胶囊（Status Pills）：
- **配置状态胶囊**：`status?.configured` 为真时显示“已配置”（带有 `.isOn` 绿色边框高亮），否则显示“未配置”；
- **就绪状态胶囊**：根据 `mcpStateKind(status.readiness)` 动态挂载类名 `kind-ok` / `kind-warn` / `kind-err`；
- **服务总数胶囊**：显示 `服务 N`；
- **启停可用性胶囊**：由于当前 Rust 引擎不支持界面启停，此处恒为灰色的“启停不可用”，并通过 `Tooltip` 提示 `当前引擎不支持从界面启停；扩展服务通常随任务运行时连接`；
- **筛选结果计数**与**刷新中指示器**。

在列表上方，如果 `error` 非空，则挂载一个 `role="alert"` 的紧凑错误横条（`mcpErrorLine`）。主列表渲染统一委托给 `McpServerList`，入参通过 `useMcpServerListState` 进行三元分组收拢。

---

### 2.3 McpSettingsTab.module.css 样式系统全量解析

文件 [`apps/crish-desktop/src/components/settings-mcp/McpSettingsTab.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/McpSettingsTab.module.css)（348 行）采用了极为克制的无外边框设计。关键类名与设计意图解构如下：

#### 1. 状态胶囊系统（Status Pills）
```css
.mcpStatusPill {
  font-size: var(--font-size-xxs);
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  color: var(--text-tertiary);
  background: transparent;
  line-height: 1.5;
  white-space: nowrap;
  height: 20px;
  display: inline-flex;
  align-items: center;
}
.mcpStatusPill.isOn, .mcpStatusPill.kindOk {
  color: var(--accent-green);
  border-color: color-mix(in srgb, var(--accent-green) 35%, transparent);
}
.mcpStatusPill.kindWarn {
  color: var(--accent-orange);
  border-color: color-mix(in srgb, var(--accent-orange) 30%, transparent);
}
.mcpStatusPill.kindErr {
  color: var(--accent-red);
  border-color: color-mix(in srgb, var(--accent-red) 30%, transparent);
}
```
通过 `color-mix(in srgb, var(--accent-*) 30%, transparent)` 实现柔和的半透明彩色边框，避免高饱和度纯色线带来的视觉刺眼感。

#### 2. 行级极简布局与指示圆点
- `.mcpRow`（第 107-116 行）：去除所有外侧卡片轮廓，仅使用底部发丝细线：
  ```css
  .mcpRow {
    border: none;
    border-bottom: var(--hairline-width, 1px) solid var(--hairline, var(--border-subtle));
    padding: 2px 0;
    background: transparent;
  }
  ```
- `.mcpDot`（第 126-149 行）：7px 直径的实体状态圆点，具有 `.kindOk`（绿色）、`.kindWarn`（橙色）、`.kindErr`（红色）、`.kindIdle`（中性边框色）四种语义状态。

#### 3. 展开区工具列表（.mcpTools）
展开后的工具列表（第 229-270 行）具备左侧 13px 缩进，内嵌 `<code>` 字体采用 `var(--font-mono)` 等宽字体，工具名可单项悬停一键复制（`.mcpInlineCopy`）。

#### 4. 滚动条穿透契约违规排查
第 301-303 行定义了 `.mcpAddRowCoverContent`，明确标注“类名含 coverContent：命中 overlay-scrollbar 出口，禁写 scrollbar-width”，严格遵守了仓库的自定义滚动条契约。

---

### 2.4 McpServerList.tsx 服务列表编排与多态渲染

文件 [`apps/crish-desktop/src/components/settings-mcp/McpServerList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/McpServerList.tsx)（407 行）负责列表主体的装配。其核心特征在于抽象出了泛型列表渲染器 `renderServiceList`（第 89-127 行）：

```typescript
const renderServiceList = <T,>(opts: {
  items: T[];
  totalCount: number;
  loading: boolean;
  emptyContent: React.ReactNode;
  renderItem: (item: T, index: number) => React.ReactNode;
}) => { ... }
```
无论是 Demo 模式下的 `McpServer[]` 还是 Live 模式下的 `McpServerInfo[]`，均通过此高阶函数统一挂载 `role="list"`、`aria-busy`、空态提示及搜索无匹配提示（`McpServerFilterEmpty`）。

#### 单行条目主要交互插槽：
1. **状态指示**：悬浮展示中文状态描述的 7px 圆点；
2. **名称与标识复制**：以幽灵按钮（`variant="ghost"`）呈现服务名称，点击即通过剪贴板快速复制服务 ID，具备截断保护（`max-width: 26%`）；
3. **状态徽章（mcpStateBadge）**：胶囊形式展示状态文案；
4. **元数据槽（mcpRowMeta）**：展示传输协议、命令行或工具计数（`工具 N`），若存在 `srv.lastError` 则红色高亮提示；
5. **操作栏（mcpRowActions）**：
   - 折叠展开 Chevron 箭头，展开 `McpServerTools` 面板；
   - 启停按钮：如果是 Demo 模式，展示 `Switch` 开关与垃圾桶删除图标；如果是 Live 模式，由于引擎不支持，展示被禁用的方块（停止）或三角（播放）按钮，并配有解释性 Tooltip。

---

### 2.5 McpServerToolbar.tsx 共享工具栏与死皮约束

文件 [`apps/crish-desktop/src/components/settings-mcp/McpServerToolbar.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/McpServerToolbar.tsx)（108 行）将工具栏逻辑彻底抽离：
- **刷新按钮**：使用 `Lucide.RefreshCw`，在 `loading` 期间挂载 `.spin` 旋转动画；
- **排序切换**：严格消费项目原子化组件库的 `SegmentedControl`，提供“名称”与“状态”两项单选切换（通过 `role="radio"` 满足无障碍测试）；
- **搜索输入框**：使用原子化 `Input`，指定 `variant="search"`、`size="sm"`，支持 `clearable` 属性，并且绑定 `Escape` 按键快捷清除筛选；
- **添加按钮**：仅在 `demo === true` 状态下展示，控制添加表单的伸缩。

测试用例 `McpServerToolbar.test.tsx` 针对该组件建立了强有力的静态和运行时断言，确保不再出现历史遗留的 `.ui-segment` 或裸 `<input>` 元素。

---

### 2.6 McpServerForm.tsx 注册服务表单与环境变量行严重缺失解构

文件 [`apps/crish-desktop/src/components/settings-mcp/McpServerForm.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/McpServerForm.tsx)（137 行）提供了本地演示服务的注册界面。

#### 现有表单字段排布：
```tsx
<div className={styles.mcpAddBox} role="form" aria-label="注册演示服务">
  <div className={styles.mcpAddRow}>
    {/* 1. 服务名称 */}
    <Input value={newName} placeholder="名称" />
    {/* 2. 传输协议选择（stdio / sse） */}
    <Select value={newType} options={[...]} />
    {/* 3. 协议分叉输入 */}
    {newType === 'stdio' ? (
      <>
        <Input value={newCmd} placeholder="命令" />
        <Input value={newArgs} placeholder="参数（逗号分隔）" />
      </>
    ) : (
      <Input value={newUrl} placeholder="端点 URL" />
    )}
    {/* 4. 操作按钮 */}
    <Button variant="ghost" onClick={() => setShowAdd(false)}>取消</Button>
    <Button variant="secondary" onClick={onAddDemo}>保存</Button>
  </div>
</div>
```

#### 严重缺陷深度解构：环境变量 Key-Value 动态行完全缺失
在实际应用场景中，绝大多数实用的 MCP 服务（如 GitHub MCP、GitLab MCP、PostgreSQL MCP、Brave Search 等）都极其依赖敏感凭据（API Keys、Database Connection Strings、Tokens），这些凭据在标准 MCP 配置中必须以环境变量的形式注入：
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    }
  }
}
```
**但在当前 `McpServerForm.tsx` 中：**
1. **零环境变量输入能力**：表单甚至没有设计任何用于添加环境变量的输入槽，既无 Key-Value 键值对，也无动态增删行机制；
2. **参数输入极为简陋**：`newArgs` 采用简单的英文逗号分隔（`newArgs.split(',').map(a => a.trim())`），如果命令行参数本身含有逗号、空格或复杂引号包裹的 JSON 字符串，这种解析方式会彻底崩溃；
3. **数据结构截断**：底层 `clientApi.types.ts` 中的 `McpServer` 接口定义根本没有 `env` 字段！从类型、表单到持久化层，环境变量这一核心能力形成了整条链路的严重结构性缺失。

---

### 2.7 McpServerTools.tsx 展开式工具列表与标识复制

文件 [`apps/crish-desktop/src/components/settings-mcp/McpServerTools.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/McpServerTools.tsx)（77 行）负责展示单个 MCP 服务所暴露的全部工具函数列表：
- **空态处理**：若工具数组为空，但 `toolCount > 0`，文案优雅降级为 `工具 N（未返回名称）`，否则提示 `暂无工具`；
- **列表渲染**：每个工具条目前置一个 12px 的 `<Lucide.Wrench>` 扳手图标，右侧为等宽代码块 `<code>{t}</code>`，并封装为点击即可复制的幽灵按钮；
- **服务 ID 底栏**：在面板底部单独展示 `标识 srv.id`，便于开发者在配置文件或调试控制台中引用。

---

### 2.8 McpServerFilterEmpty.tsx 复合空态组件

文件 [`apps/crish-desktop/src/components/settings-mcp/McpServerFilterEmpty.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/McpServerFilterEmpty.tsx)（55 行）将搜索过滤结果为空时的三态进行了高内聚收拢：
1. `loading === true`：渲染 `加载中…`（带有 `aria-busy="true"`）；
2. `!hasAny || !filterActive`：返回 `null`；
3. 激活过滤且无匹配：渲染 `无匹配` 文案，紧跟一个 `variant="ghost"` 的“清除筛选”按钮。

---

### 2.9 useMcpSettings.ts 核心状态机深度剖析

文件 [`apps/crish-desktop/src/components/settings-mcp/useMcpSettings.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/useMcpSettings.ts)（364 行）是 MCP 模块的神经中枢。

#### 1. 核心状态组成
- `servers: McpServerInfo[]`：真实引擎上报的服务列表；
- `status: McpStatusSnapshot | undefined`：来自 Rust 内核状态快照；
- `demoServers: McpServer[]` 与 `demoEnabled: Record<string, boolean>`：演示模式下的本地 Mock 数据；
- `expanded: Record<string, boolean>`：展开工具详情的服务 ID 映射；
- `busyId: string | null`：正在执行启停或保存操作的服务 ID；
- `filterSortState: { filter: string; sortMode: SortMode }`：搜索关键词与排序模式。

#### 2. 多维复合过滤与排序流水线（filtered）
```typescript
const filtered = useMemo(() => {
  const q = filter.trim().toLowerCase();
  let list = servers;
  if (q) {
    list = servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.tools.some((t) => t.toLowerCase().includes(q)) ||
        (s.transport || '').toLowerCase().includes(q) ||
        (s.lastError || '').toLowerCase().includes(q)
    );
  }
  const sorted = [...list];
  if (sortMode === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } else {
    sorted.sort((a, b) => {
      const ka = STATE_SORT_RANK[mcpStateKind(a.state)] ?? 9;
      const kb = STATE_SORT_RANK[mcpStateKind(b.state)] ?? 9;
      if (ka !== kb) return ka - kb;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }
  return sorted;
}, [servers, filter, sortMode]);
```
搜索覆盖了服务的名称、标识、内部所有工具名、传输协议以及最近一次报错信息；排序模式支持标准的中文拼音序（`zh-CN`）与状态健康度加权序（`ok -> warn -> err -> idle`）。

#### 3. 键盘快捷键监听
第 147-158 行注册了全局 `keydown` 监听器，当添加表单展开（`showAdd === true`）时，按下 `Escape` 键可立即拦截冒泡并关闭表单，提升桌面键盘操作效率。

---

### 2.10 useMcpServerListState.ts 状态聚合器与 Props 解耦

文件 [`apps/crish-desktop/src/components/settings-mcp/useMcpServerListState.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/useMcpServerListState.ts)（164 行）是一次经典的 Props 重构范例。原先 `McpServerList` 组件直接接收来自 Hook 的 29 个平铺 Props，造成组件签名极度膨胀且易引发非必要的重渲染。

本模块通过 `useMemo` 将平铺输入聚合成三大高内聚接口：
1. **`McpServersGroup`（数据域）**：包括 `servers`, `status`, `demoServers`, `expanded`, `busyId` 等只读数据；
2. **`McpUiGroup`（UI 与布局域）**：包括 `filter`, `sortMode`, `showAdd`, `listLabelId`, `toolsPanelPrefix` 等控件状态；
3. **`McpActionsGroup`（操作域）**：包括 `onRefresh`, `onSetSort`, `onToggleServer`, `onCopy`, `onDeleteDemo` 等回调函数。

---

### 2.11 工具探测与健康状态指示机制剖析

在 [`src/api/mcpApi.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/mcpApi.ts) 中，工具探测与健康状态指示经历过一次重要演进：
- **历史上的幽灵命令**：旧版尝试调用 `list-mcp-servers`、`start-mcp-server`、`stop-mcp-server`。但在 Rust 内核架构重构后，这三个命令在 Rust 侧根本不存在；
- **当前的显式不可用策略**：
  - `listMcpServers()` 明确返回 `errorCode: 'unavailable'`，不再向底层发送无效请求；
  - `startMcpServer()` 与 `stopMcpServer()` 明确返回 `errorCode: 'unsupported'`；
  - 真实状态获取统一收敛至 `fetchMcpStatus()`，该函数向 Rust 守护进程发送 `core_get_status` 请求，并提取返回体中的 `mcpStatus` 字段（包括 `configured`, `readiness`, `updatedAt`, `serverCount`）；
- **健康状态与语义映射**：
  - `mcpStateKind(state)` 将后端返回的原始文本转化为四种设计 Token：
    - `ready` / `running` / `connected` -> `'ok'`（绿色，指示正常活跃）；
    - `starting` / `degraded` -> `'warn'`（橙色，指示连接中或降级）；
    - `error` / `failed` -> `'err'`（红色，指示崩溃或错误）；
    - `stopped` / `idle` / `unknown` -> `'idle'`（灰色，指示未激活或未知）。

---

### 2.12 settings-mcp 单元测试套件剖析

1. **`McpServerToolbar.test.tsx`**：验证在点击 SegmentedControl 单选时能够正确派发 `onSetSort('state')`，输入搜索词时派发 `onSetFilter`，并断言 DOM 中绝对不存在 `.ui-segment`、`.settings-field-input` 等历史废弃样式类。
2. **`useMcpSettings.test.ts`**：Mock 了 `mcpApi` 的各个核心函数，断言 Hook 初始化时能够正确进入 `loading = false`，能够基于过滤词筛选列表，并在调用 `handleToggleServer` 时能够正确触发 `stopMcpServer`。

---

## 三、settings-skills：技能扩展管理体系深度实勘

### 3.1 skillsSettingsTypes.ts 类型定义与 SharedSkillApi 架构

文件 [`apps/crish-desktop/src/components/settings-skills/skillsSettingsTypes.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/skillsSettingsTypes.ts)（70 行）构成了技能管理域的契约核心：

```typescript
// 技能激活三态
export const ACTIVATION_OPTIONS: { id: SkillActivation; label: string }[] = [
  { id: 'enabled', label: '启用' },
  { id: 'recommended', label: '推荐' },
  { id: 'disabled', label: '禁用' },
];

// 斜杠命令规范转换：将技能名转化为小写、中划线合规的 /skill:<slug>
export function skillSlashCmd(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `/skill:${slug || name.trim()}`;
}
```

#### SharedSkillApi 依赖倒置设计
在技能设置页中，存在三大子 Hook：`useSkillList`（负责列表查询与激活）、`useSkillDirectories`（负责目录增删与新技能发现）、`useSkillEditor`（负责新建技能与正文预览）。为了避免 Hook 间形成循环依赖或由外层产生大量深层透传，本模块定义了 `SharedSkillApi` 接口（第 56-69 行），充当跨子 Hook 状态共享的数据总线。

---

### 3.2 SkillsSettingsTab.tsx 技能主视图宿主与布局拓扑

文件 [`apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.tsx)（253 行）是技能管理的完整容器页面：

#### 1. 结构骨架
- **顶部操作栏（skillsTabActions）**：包含“新建”按钮（切换内联创建面板）以及 `SkillsMoreMenu`（更多操作下拉菜单）；
- **内联编辑器插槽（SkillEditorModal）**：挂载弹窗式发现对话框（`Dialog`）与新建技能选项；
- **二级工具栏（skillsToolbar）**：包含作用域下拉选择器（`Select`，可选全部、全局或各个项目）与搜索框（`Input`）；
- **双栏主视图（skillsSplit）**：采用 Flex 左右布局，左侧为固定宽度 220px 的 `SkillCardList` 导航导轨，右侧为自适应宽度的 `SkillDetailPreview` 技能预览与控制面板。

#### 2. 严格的 Toast 策略
文件头部的设计注释明确指出：
- 成功状态（列表变更、选中、面板收起）严禁弹出 Toast 干扰用户；
- 仅在扫描失败、启用失败、同步失败、创建失败或路径定位失败时才允许弹出 Toast；
- 引擎未同步时走 `formatEngineDegradeToast`。

---

### 3.3 SkillsSettingsTab.module.css 样式体系逐类解构

文件 [`apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css)（802 行）是所辖目录中体积最大的样式文件，其结构化特征如下：

#### 1. 双栏分割体系（.skillsSplit 与 .skillsRail）
```css
.skillsSplit {
  display: flex;
  flex: 1;
  min-height: min(360px, calc(100vh - 220px));
  border: var(--hairline-width, 1px) solid var(--hairline, var(--border-subtle));
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: transparent;
}
.skillsRail {
  width: 220px;
  flex-shrink: 0;
  border-right: var(--hairline-width, 1px) solid var(--hairline, var(--border-subtle));
  display: flex;
  flex-direction: column;
  background: transparent;
}
```
**注意此处形成的物理边框**：外层容器具备四周外边框（`border`），内层左侧又有右边框（`border-right`），当它被放入整个设置页的内容区域时，与外层页面的边距和分割线形成了多层视觉包裹。

#### 2. 密集型技能导轨条目（.skillsRailItemDense）
高度仅为 24px，图标压缩为 18x18px，文字单行截断省略，右侧挂载 6px 的激活状态小圆点（`.skillsActDot`），具备高信息密度的导航效率。

#### 3. 标签与徽章样式
- `.skillsSysBadge`, `.skillsScope`, `.skillsTag`：全部统一采用 `border: 1px solid var(--border-color); border-radius: 999px; padding: 1px 8px; font-size: var(--font-size-xxs);`。

---

### 3.4 SkillCardList.tsx 左侧技能列表导轨与多级作用域

文件 [`apps/crish-desktop/src/components/settings-skills/SkillCardList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillCardList.tsx)（277 行）负责渲染技能目录导轨：
- **无障碍保障**：列表容器具备 `role="listbox"`，每项为 `role="option"`，且父级使用 `aria-activedescendant` 指向当前选中的技能 ID；
- **分组渲染**：按照 `project`（当前项目）、`workspace`（工作区）、`global`（用户全局目录）依次分组，组头展示分组名及条目数量统计；
- **系统技能标识**：若 `skill.system === true`，图标渲染为 `<Lucide.Package>` 并附带“系统”徽章；普通自定义技能则渲染为 `<Lucide.Sparkles>`；
- **高级 · 额外目录区域（skillsExtraDetails）**：位于导轨最底部，通过原生 `<details>` / `<summary>` 折叠收纳。用户可在此查看已挂载的自定义技能绝对路径，也可以通过原生系统目录选择器（`handlePickExtra`）或手动输入路径挂载外部技能包。

---

### 3.5 SkillDetailPreview.tsx 右侧技能详情与预览中枢

文件 [`apps/crish-desktop/src/components/settings-skills/SkillDetailPreview.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillDetailPreview.tsx)（166 行）是选中技能的深入剖析与操作面板：
- **标题与元数据**：展示技能名称、作用域胶囊、系统胶囊，以及技能 frontmatter 中声明的最多 2 个前置标签（`tags.slice(0, 2)`）；
- **斜杠命令交互**：以 `<code>` 标签高亮展示 `/skill:<slug>`，附带复制按钮；
- **系统资源管理器联动**：展示技能文件的完整物理路径（`filePath`），点击右侧的外链图标（`<Lucide.ExternalLink>`）直接调用 Tauri 原生壳命令 `revealSkillPath` 在 Windows 资源管理器中选中该文件；
- **三态激活控制器**：内嵌原子化 `SegmentedControl`，提供“启用”、“推荐”、“禁用”三档切换；
- **预览模式切换**：支持在渲染后的 Markdown HTML 视图与纯原始代码视图（`<pre className={styles.skillsRaw}>`）之间无缝切换。

---

### 3.6 SkillEditorModal.tsx 与 SkillEditorModal.module.css 模态发现与创建

文件 [`apps/crish-desktop/src/components/settings-skills/SkillEditorModal.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillEditorModal.tsx)（251 行）集成了两项核心创建/导入能力：

#### 1. 发现新技能对话框（ui/Dialog）
当系统扫描到本地目录中存在未登记过的新技能时，自动弹出基于原子化 `Dialog` 的模态窗口：
- 列表展示候选技能名与描述；
- 每个候选条目配有原子化 `Switch` 开关（绝不使用裸原生 checkbox）；
- 底部提供“跳过”（或按 Esc / 点击遮罩层）、“全启”以及“启用所选”三组操作。

#### 2. 页内新建技能表单
包含两种模式：
- `paths` 模式：提供“浏览导入”与“AI 创建”快捷入口。点击“AI 创建”会直接触发 `handleAiCreateSkill`，向当前主对话流的草稿管理器（`sessionDraftManager`）注入引导 Prompt（`请帮我创建一个 Crish 技能（正式 SKILL.md）...`），并自动关闭设置面板、跳转至对话窗口；
- `manual` 模式：提供行内的技能名称（`createName`）与描述输入框，回车即可在项目 `.conex/skills/<name>/SKILL.md` 中创建基础模板。

---

### 3.7 SkillsMoreMenu.tsx 更多操作浮层菜单与批量确认

文件 [`apps/crish-desktop/src/components/settings-skills/SkillsMoreMenu.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsMoreMenu.tsx)（186 行）基于原子化 `Menu` 基座构建，提供了高阶运维入口：
- **同步到引擎**：调用 `handleSyncAll`；
- **发现新技能**：强制重新扫描目录；
- **快捷命令开关**：开启/关闭聊天框输入 `/skill:` 自动补全能力，变更写入全局设置并通过 `window.dispatchEvent` 广播 `crish-skills-changed` 事件；
- **二次防误触批量激活**：在执行“全部启用”或“全部禁用”时，首次点击按钮进入确认态（文案变为 `再点确认全启（N）`，背景带有绿色微弱高亮），再次点击才会真正执行批量激活更新，极大地防止了用户的误操作。

---

### 3.8 useSkillDirectories.ts 目录扫描与导入状态机

文件 [`apps/crish-desktop/src/components/settings-skills/useSkillDirectories.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/useSkillDirectories.ts)（150 行）专注于额外目录（Extra Dirs）的增删改查：
- 内部持久化通过 `getExtraSkillDirs()`、`addExtraSkillDir(dir)` 与 `removeExtraSkillDir(dir)` 实现；
- 调用 Tauri 原生对话框 `pickSkillDirectory()` 让用户可视化挑选文件夹；
- 在执行 `applyDiscoverImport` 批量启用候选技能时，精细统计失败数量（`fail`），若部分失败则向用户提示 `导入部分失败：X/Y`。

---

### 3.9 useSkillEditor.ts 技能编辑器与草稿跨层联动

文件 [`apps/crish-desktop/src/components/settings-skills/useSkillEditor.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/useSkillEditor.ts)（132 行）：
- 负责手动新建技能的名称清洗与 slug 生成；
- 重点在于与对话流的无缝连接：当用户选择 AI 生成技能时，通过 `useSessionStore.getState().activeSessionId` 定向锁定当前会话，调用 `sessionDraftManager.injectSeed` 写入草稿，并触发 `emitUiEvent('open-chat')`，实现了设置页面与对话工作台的跨层交互范式。

---

### 3.10 useSkillList.ts 技能核心列表与多维筛选算法

文件 [`apps/crish-desktop/src/components/settings-skills/useSkillList.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/useSkillList.ts)（364 行）：
- **已知技能追踪**：通过 `localStorage` 中的 `crish_skill_known_ids_v1` 记录已知 ID，新扫描到的 ID 若不存在于该集合中，则标记为新技能并触发发现弹窗；
- **作用域与多项目感知**：通过 `listSettingsScopeProjects()` 获取当前工作区的所有子项目，监听 `crish-project-changed` 全局窗口事件动态刷新；
- **多条件过滤算法**：同时对作用域（`scopeFilter`）与查询关键词（`filter`）进行联合求交，过滤项覆盖名称、描述、标签与物理路径。

---

### 3.11 useSkillsSettingsState.ts 跨子 Hook 共享 API Hub 架构

文件 [`apps/crish-desktop/src/components/settings-skills/useSkillsSettingsState.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/useSkillsSettingsState.ts)（132 行）：
为了解决 `useSkillList` 需要刷新目录、`useSkillDirectories` 需要触发列表重新扫描、`useSkillEditor` 需要切换选中项所形成的网状依赖，设计了 `useSkillApiRef`：
```typescript
function useSkillApiRef(): SkillApiRef {
  const ref = useRef<SkillApiRef>(null);
  if (ref.current === null) {
    ref.current = {
      setExtraDirs: () => {},
      setDiscoverCandidates: () => {},
      setDiscoverPick: () => {},
      setCreateMode: () => {},
      setExtraOpen: () => {},
      setSkills: () => {},
      setSelectedId: () => {},
      setBusyId: () => {},
      refresh: () => Promise.resolve(),
    };
  }
  return ref.current;
}
```
通过在渲染周期内以稳定引用注入 setter，使各个子 Hook 可以解耦运行，彻底杜绝了 React 闭包陷阱与循环依赖报错。

---

### 3.12 settings-skills 单元测试套件剖析

- **`useSkillsSettingsState.test.tsx`**：验证斜杠命令转换算法（如 `My Skill` -> `/skill:my-skill`）、作用域文案匹配以及激活状态从 `enabled` 到 `disabled` 的更新流转；
- **`SkillEditorModal.test.tsx`**：覆盖了模态弹窗的 `aria-modal="true"` 无障碍属性校验、Esc 键跳过、全部启用、Switch 切换联动断言；
- **`SkillsMoreMenu.test.tsx`**：深度断言了双击批量确认的内部状态机流转。

---

## 四、settings-extensions：扩展中心货架与生态聚合深度实勘

### 4.1 types.ts 与 ExtensionCardIdentity.ts 类型契约

文件 [`apps/crish-desktop/src/components/settings-extensions/types.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/types.ts)（33 行）与 [`ExtensionCardIdentity.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/ExtensionCardIdentity.ts)（13 行）统一了扩展中心的数据形态：
- `MainView = 'installed' | 'discover'`：货架双重视图；
- `KindFilter = 'all' | ExtensionKind`：按类型过滤（全部、插件、MCP、技能）；
- `PluginInstalledExtension`：在基础 `InstalledExtension` 之上扩充了 `pluginId`, `pluginVersion`, `pluginTools`, `pluginHooks`, `pluginTrustLevel`, `pluginEnabled` 6 项清单元数据；
- `isPluginCardItem`：自定义类型守卫，精准收窄插件卡片。

---

### 4.2 buildInstalledExtensions.ts 多源聚合算法

文件 [`apps/crish-desktop/src/components/settings-extensions/buildInstalledExtensions.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/buildInstalledExtensions.ts)（128 行）实现了扩展中心最核心的**五路多源聚合算法**：

```typescript
export function buildInstalledExtensions({
  skills,
  mcpServers,
  packages,
  catalogInstalled,
  plugins,
}: {
  skills: DesktopSkill[];
  mcpServers: McpServerInfo[];
  packages: (string | PackageSource)[];
  catalogInstalled: Set<string>;
  plugins: PluginCardState[];
}): InstalledExtension[]
```
#### 五路聚合流程解构：
1. **技能源（skills）**：映射为 `id: local-skill:${s.id}`, `kind: 'skill'`, 系统技能标记为 official，用户技能标记为 local；
2. **MCP 服务源（mcpServers）**：映射为 `id: local-mcp:${m.id}`, `kind: 'mcp'`, 携带工具名列表及传输协议；
3. **已安装扩展包源（packages）**：映射为 `id: local-plugin:${idx}:${name}`, `kind: 'plugin'`;
4. **插件注册表源（plugins）**：如果尚未在列表中，追加 `PluginInstalledExtension`，注入声明的工具列表与生命周期钩子；
5. **策展目录已安装项（catalogInstalled）**：对 `EXTENSION_CATALOG` 中用户已标记安装的条目进行去重合并，统一注入输出流。

---

### 4.3 pluginRegistryAdapter.ts 插件注册表适配器

文件 [`apps/crish-desktop/src/components/settings-extensions/pluginRegistryAdapter.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/pluginRegistryAdapter.ts)（97 行）负责连接官方插件生态（如 `@crish/plugin-import-claude-codex`）：
- 读取内置插件的 Manifest；
- 通过 `localStorage`（键名 `crish_plugin_enabled_v1`）维护已停用的插件 ID 黑名单（未在黑名单中即视为默认启用）；
- 对外导出 `listPluginCardStates()` 与 `setPluginEnabled(id, enabled)`，为后续接入完整的 E2 插件运行时预留了 `PLUGIN_RUNTIME_HOOK` 接线点。

---

### 4.4 useMcpCache.ts 与 useSkillsCache.ts 独立缓存机制

为了避免用户在进入“设置 -> 扩展”界面时因为异步网络或文件扫描导致界面闪烁或白屏，扩展中心实现了两套独立的缓存 Hook：
- [`useMcpCache.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/useMcpCache.ts)（36 行）：将 `McpServerInfo[]` 存入 `crish_mcp_servers_cache_v1`；
- [`useSkillsCache.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/useSkillsCache.ts)（36 行）：将 `DesktopSkill[]` 存入 `crish_skills_cache_v1`。

在组件挂载的第一时间以同步方式从 `localStorage` 读取缓存完成首屏渲染，随后在后台静默发起网络与文件系统查询，数据返回后二次覆盖并更新缓存。

---

### 4.5 useMarketQuery.tsx 市场查询与高亮管道

文件 [`apps/crish-desktop/src/components/settings-extensions/useMarketQuery.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/useMarketQuery.tsx)（86 行）：
- 支持根据类型（`kindFilter`）过滤；
- 导出 `highlightMatch(text: string): React.ReactNode` 高亮管道：利用动态正则光标切片，将匹配用户输入关键词的字符片段精准包裹在 `<mark>` 标签中（并在 CSS 中设置为半透明的主题高亮底色），未匹配部分保持原文本节点，零性能开销。

---

### 4.6 useExtensionMarket.tsx 扩展货架核心编排器与软超时

文件 [`apps/crish-desktop/src/components/settings-extensions/useExtensionMarket.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/useExtensionMarket.tsx)（445 行）是扩展中心的总调度器：

#### 4 秒并发软超时保护（withTimeout）
在 `refresh` 函数中，同时并发请求三路数据：技能发现（`discoverSkills`）、MCP 列表（`listMcpServers`）以及工作区扩展设置（`clientApi.getSettingsEx`）。为了避免某一模块在底层卡死导致整个扩展货架陷入无限 Loading，全部包裹了 4,000ms 的软超时熔断：
```typescript
const [skillRes, mcpRes, settings] = await Promise.all([
  withTimeout(discoverSkills(...), 4000, { skills: [] }),
  withTimeout(listMcpServers(...), 4000, { servers: [] }),
  withTimeout(clientApi.getSettingsEx(...), 4000, null),
]);
```

#### MCP 工具级禁用（toggleMcpTool）
用户不仅能够控制整个 MCP 服务，还能精确到单个工具级别进行启用/禁用。配置写入 `settings.mcpDisabledTools: Record<serverId, toolName[]>`，并实时同步至 `sessionStorage` 缓存。在后续任务运行时，工作台会自动将该禁用表下发至执行引擎。

---

### 4.7 ExtensionList.tsx 货架列表容器与双态分发

文件 [`apps/crish-desktop/src/components/settings-extensions/ExtensionList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/ExtensionList.tsx)（205 行）：
- 当 `view === 'installed'` 时，遍历 `installedFiltered`，渲染已安装条目；若为空且无搜索条件，展示“还没有安装扩展”及“去发现”引导按钮；
- 当 `view === 'discover'` 时，遍历 `catalogFiltered`，渲染官方/三方策展目录；已安装的条目展示“去配置”，未安装的条目展示“安装”按钮。

---

### 4.8 ExtensionCard.tsx 扩展卡片主体结构与徽章堆叠

文件 [`apps/crish-desktop/src/components/settings-extensions/ExtensionCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/ExtensionCard.tsx)（274 行）构成了货架的主要视觉单元。

#### 现有卡片结构解剖：
```tsx
<div className={`${styles.rowBlock}${detailOpen || configOpen ? ` ${styles.rowBlockExpanded}` : ''}`}>
  <div className={styles.row}>
    <div className={styles.rowMain}>
      <div className={styles.titleLine}>
        {/* 徽章 1：扩展类型（插件 / MCP / 技能） */}
        <Badge size="xs" tone="neutral">{kindLabel(installedItem.kind)}</Badge>
        {/* 标题 */}
        <span className={styles.name}>{highlightMatch(installedItem.name)}</span>
        {/* 徽章 2：来源属性（官方 / 三方 / 本机） */}
        <Badge size="xs" tone={installedItem.source === 'official' ? 'brand' : 'neutral'}>
          {sourceLabel(installedItem.source)}
        </Badge>
        {/* 徽章 3（发现视图）：已安装标记 */}
        {installedMark ? <Badge size="xs" tone="success">已装</Badge> : null}
      </div>
      <div className={styles.desc}>{highlightMatch(installedItem.description)}</div>
    </div>
    {/* 右侧操作栏 */}
    <div className={styles.actions}>
      <Button variant="ghost" size="sm">详情</Button>
      {/* 插件展示启用/停用，其他展示配置 */}
      <Button variant="secondary" size="sm">配置</Button>
      {/* 可卸载项展示危险卸载按钮 */}
      {canUninstall ? <Button variant="danger" size="sm">卸载</Button> : null}
    </div>
  </div>
  {/* 展开体插槽 */}
  {detailOpen ? renderExpandBody(...) : null}
  {configOpen ? renderExpandBody(...) : null}
</div>
```

---

### 4.9 ExtensionBody.tsx 与 McpToolsSection.tsx 展开体架构

1. **`ExtensionBody.tsx`**（112 行）：
   - 当展开技能详情时，展示其绝对路径与 `SKILL.md` 正文；展开技能配置时，提示并提供“高级管理”跳转按钮；
   - 当展开插件详情或配置时，展示插件的名称、版本号、信任级别（`trustLevel`）、生命周期钩子列表（`pluginHooks`）以及注入的工具列表（`pluginTools`）。
2. **`McpToolsSection.tsx`**（208 行）：
   - 详情模式下展示运行状态、传输协议以及工具预览（支持超 12 个时折叠展开）；
   - 配置模式下展示服务启停按钮、“高级管理”跳转按钮，以及核心的**工具逐项开关列表**（每个工具一行，右侧附带状态标签与 `Switch` 开关）。

---

### 4.10 SettingsExtensionsTab.tsx 货架主视图与二级管理跳转

文件 [`apps/crish-desktop/src/components/settings-extensions/SettingsExtensionsTab.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/SettingsExtensionsTab.tsx)（226 行）：
- 顶部通过两个并排的 `SegmentedControl` 分别切换“视图”（已安装 vs 发现）与“类型”（全部 / 插件 / MCP / 技能）；
- 当 `manage === 'skill'` 或 `manage === 'mcp'` 时，触发全页视图覆写，挂载带后退箭头的全功能子管理页面，并在 `<AppErrorBoundary>` 与 `<Suspense>` 保护下运行。

---

### 4.11 SettingsExtensionsTab.module.css 样式系统全量解析

文件 [`apps/crish-desktop/src/components/settings-extensions/SettingsExtensionsTab.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/SettingsExtensionsTab.module.css)（219 行）：
- `.rowBlock` 采用带圆角的卡片模型：`border: 1px solid var(--border-subtle); border-radius: var(--radius-xl, 12px);`；
- 存在硬编码的白色回退色彩：`background: var(--bg-card, hsl(0 0% 100%));`，一旦缺少 CSS 变量，在深色模式下将发生刺眼的纯白渲染灾难；
- 展开面板 `.inlinePanel` 带有顶部细分割线 `border-top: 1px solid var(--border-subtle);`；
- 工具单行 `.toolRow` 在禁用时挂载 `.toolRowOff { opacity: 0.55; }`。

---

### 4.12 SettingsExtensionsTab.test.ts 死皮阻断测试套件

文件 [`apps/crish-desktop/src/components/settings-extensions/SettingsExtensionsTab.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/SettingsExtensionsTab.test.ts)（72 行）采用直接扫描文件源码文本的方式，对 `settings-extensions`、`settings-mcp` 和 `settings-skills` 三个目录进行了静态断言：
1. 断言不存在 `.ui-segment`、`.settings-field-input`、`.settings-btn-rect`、`.settings-create-path` 等历史废弃类名；
2. 断言筛选和搜索严格使用 `SegmentedControl` 与 `Input[variant="search"]`；
3. 断言详情和配置严格使用 `Button`；
4. 断言 CSS Module 锁定了圆角契约，并严禁出现裸写 `scrollbar-width` 的违规样式。

---

## 五、现有架构断层、体验撕裂与视觉缺陷深度解构

经过对全量 43 个文件的深入逐行勘察，我们整理出当前扩展体系中存在的 **6 大核心架构与体验缺陷**：

### 5.1 杂乱边框与多重容器嵌套撕裂排查

在当前 UI 呈现中，边框的使用缺乏统一的设计原则，出现了三种完全割裂的边框模式：
1. **货架中的大圆角卡片边框（Boxed Cards）**：`SettingsExtensionsTab` 中每个条目都是一个拥有完整 1px 边框和 12px 圆角的 `.rowBlock`，展开后边框进一步加深为 `var(--border-color)`；
2. **技能管理中的嵌套内嵌框（Nested Split Box）**：`SkillsSettingsTab` 采用了外层大边框 `.skillsSplit`，内部再嵌一条竖向分割线 `.skillsRail`，而右侧的 Markdown 预览区又自带一条 `border-top` 顶边框，形成了严重的“框中框中框”多重边框嵌套，视觉感受极为沉重；
3. **MCP 管理中的纯发丝下划线（Hairline Rows）**：`McpSettingsTab` 完全不使用外边框，每个服务仅有一条微弱的底部发丝横线（`.mcpRow`）。

当用户从扩展货架点击“高级管理”进入 MCP 或技能管理时，界面布局瞬间从“大圆角独立卡片流”跳变到“极简发丝线”或“沉重大嵌套框”，产生强烈的视觉断层。

---

### 5.2 彩色徽章与视觉噪音泛滥排查

在 `ExtensionCard.tsx` 中，由于历史原因堆叠了过多的状态指示：
- 在条目标题行，紧挨着名称同时出现了类型徽章（如 `[MCP]`）、来源徽章（如 `[官方]` 或 `[三方]`）以及状态徽章（如 `[已装]`）；
- `Badge` 组件默认带有填充色与边框，在只有 40px 高度的卡片头部，这些高亮彩色块横向排布，极度挤占了扩展名称和描述的阅读空间，造成强烈的视觉噪点；
- 相比之下，在 `SkillCardList` 中，系统技能使用了一个极轻量的 `<em className="skillsSysBadge">系统</em>`，而在 `McpServerList` 中则使用了一个发丝胶囊。三处对“扩展属性标签”的表达完全不一致。

---

### 5.3 环境变量 Key-Value 动态行严重缺失与配置能力残缺

这是当前 MCP 服务体系中最为致命的功能短板：
1. **无法配置真实世界的 MCP**：无论是通过界面新建还是配置已有 MCP 服务，用户都无法输入诸如 `OPENAI_API_KEY`、`GITHUB_TOKEN`、`DATABASE_URL` 等环境变量；
2. **参数分割过于脆弱**：命令行参数用简单的英文逗号分隔，导致诸如 `--filter="name,age"` 这类本身包含逗号的参数会被错误切割；
3. **缺少统一动态键值对原语**：整个前端组件库缺少一个可复用的、能够安全隐藏敏感文本（Password 掩码）并支持动态添加/删除/编辑的 `EnvVariableTable` 原子化组件。

---

### 5.4 幽灵命令与启停状态机认知割裂

在 `McpServerList.tsx` 和 `McpToolsSection.tsx` 中：
- 界面上存在“启动服务”、“停止服务”的按钮控件；
- 但底层代码明确显示：Rust 内核早已移除了对应的 IPC 处理函数，前端调用恒返回 `errorCode: 'unsupported'`；
- 导致的结果是：用户在界面上看到操作按钮，但无论怎么点击都是置灰或弹窗提示“不支持”，不仅造成了操作困惑，更暴露出前端控件状态机与后端内核脱节的架构遗留债。

---

### 5.5 三套独立状态体系与缓存同步漂移

1. `settings-mcp` 维护一套内存状态 `servers`；
2. `settings-skills` 维护一套以 `localStorage` 为真相源的 `activationMap`；
3. `settings-extensions` 则通过 `useMcpCache` 和 `useSkillsCache` 另起炉灶维护了两份独立的本地缓存；
4. 当用户在货架上点击停用某个插件或工具时，修改的是 `settings.mcpDisabledTools`；而当用户跳进高级管理时，修改的又是另一套状态。两层视图之间缺乏基于单真理源（SSOT）的响应式状态同步机制，只能依赖粗暴的“离开时强制调用 refresh()”进行拉回，极易发生状态漂移。

---

### 5.6 弹窗、行内表单与树状展开交互形式割裂

在新建与编辑交互上，三大模块各自为政：
- `settings-skills` 采用模态弹窗（`SkillEditorModal` 的 `Dialog`）；
- `settings-mcp` 采用在列表顶端动态推开 DOM 的内联展开条（`McpServerForm`）；
- `settings-extensions` 采用在卡片下方内嵌展开抽屉（`ExtensionBody` / `McpToolsSection`）。
三套截然不同的展开模式并存，严重破坏了桌面端软件的统一交互范式。

---

## 六、未来统一扩展卡片原语（Unified Extension Card Primitive）设计方案

为了彻底根除上述断层与视觉缺陷，本方案提出了一套全新的**统一扩展卡片原语（Unified Extension Card Primitive）**与配套的**动态环境变量编辑组件（EnvVariableTable）**。

### 6.1 设计理念：极简、高信噪比与去噪音化

1. **单层平整化，杜绝框中框**：统一采用与主对话流现代工具卡片一致的“微边框平直卡片（Flat Bordered Card）”，边框色恒定为 `var(--border-subtle)`，无厚重外阴影；
2. **全面清退彩色徽章，回归单色中性元数据**：
   - 彻底废弃彩色 `Badge` 堆叠；
   - 扩展类型（Plugin / MCP / Skill）通过左侧语义化单色图标（Icon）表达，配合极简的灰度小字（`var(--text-tertiary)`）；
   - 运行与健康状态统一使用 6px 的单色微指示灯（`.statusDot`）表达；
3. **统一渐进式三层交互（Progressive Disclosure）**：
   - **L1（列表态）**：紧凑单行，仅展示图标、名称、中性类型标签、运行状态点及主控开关（Switch）；
   - **L2（行内配置抽屉）**：点击卡片平滑展开，提供简明的 Markdown 说明与核心参数开关；
   - **L3（全功能检查抽屉 / Inspector Drawer）**：点击“高级管理”从右侧滑出抽屉或弹出标准检查面板，包含完整的环境变量 Key-Value 表单及工具细粒度探测。

---

### 6.2 单一卡片原语契约设计（UnifiedExtensionCard）

```typescript
export type ExtensionKind = 'plugin' | 'mcp' | 'skill';
export type ExtensionStatus = 'running' | 'ready' | 'stopped' | 'error' | 'disabled';

export interface UnifiedExtensionItem {
  id: string;
  kind: ExtensionKind;
  name: string;
  description: string;
  source: 'official' | 'community' | 'local';
  version?: string;
  status: ExtensionStatus;
  enabled: boolean;
  toolCount?: number;
  tags?: string[];
  // MCP 扩展特有属性
  mcpTransport?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
  mcpEnv?: Record<string, string>;
  // Skill 扩展特有属性
  skillSlashCmd?: string;
  skillPath?: string;
}

export interface UnifiedExtensionCardProps {
  item: UnifiedExtensionItem;
  expanded: boolean;
  onToggleExpand: (id: string) => void;
  onToggleEnable: (id: string, enabled: boolean) => Promise<void>;
  onOpenAdvanced?: (id: string) => void;
  onDelete?: (id: string) => Promise<void>;
  highlightQuery?: string;
}
```

---

### 6.3 视觉降噪规范：单色中性元数据与状态点

卡片头部不再并列渲染多个大徽章，取而代之的是一条结构清晰、层级分明的微型元数据链：

```
[Icon] 名称 · 类型(灰) · 来源(灰) · 状态点(带色微点) [Switch 开关] [Chevron 展开箭头]
```
- 类型与来源直接以中性文本展示，例如 `MCP · 官方` 或 `技能 · 项目`；
- 状态点以 6px 直径圆点呈现，仅保留唯一的语义强调色（成功绿、警告橙、错误红、非激活灰），将视线焦点还给扩展本身的名称与功能描述。

---

### 6.4 动态环境变量配置组件设计（EnvVariableTable）

针对标准 MCP 配置的核心刚需，设计专用的 `EnvVariableTable` 组件：

```typescript
export interface EnvRow {
  id: string;
  key: string;
  value: string;
  isSecret?: boolean;
}

export interface EnvVariableTableProps {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}
```
#### 核心交互特性：
1. **自动增行与删除**：底部常驻“添加环境变量”按钮，点击立即在尾部追加空行并自动聚焦于 Key 输入框；每行右侧提供删除按钮（`<Lucide.Trash2>`）；
2. **密码敏感文本掩码**：支持一键切换 Value 输入框的明文与密码模式（`<Lucide.Eye>` / `<Lucide.EyeOff>`），防止演示或多人协作时敏感 Token 泄露；
3. **空键值清洗**：在向父级派发 `onChange` 时，纯逻辑自动过滤掉 `key.trim() === ''` 的无效行，确保落盘数据的纯净。

---

### 6.5 MCP 工具网格与健康探测指示规范

在卡片展开区内，工具列表不再采用占满垂直空间的无序平铺列表，而是升级为**高密度自适应工具网格（Tool Grid）**：
- 工具项以胶囊药丸形式呈两列或三列网格排布；
- 每个工具胶囊内部集成工具名与微型禁用开关；
- 工具右上角挂载健康探测状态：当工具探测失败时，胶囊边框呈现微弱橙色，悬浮 Tooltip 呈现最近报错信息。

---

### 6.6 三层渐进式卡片交互蓝图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [🧩] sqlite-explorer  MCP · 官方   ● 运行中 (4 工具)        [ 开启 ]  [ v ] │  <- L1: 紧凑导轨行
├─────────────────────────────────────────────────────────────────────────────┤
│ 展开抽屉 (L2):                                                               │
│   轻量描述：提供针对本地 SQLite 数据库的只读分析与模式检查能力。            │
│   工具清单：[✓ query_schema]  [✓ execute_readonly_sql]  [✓ table_stats]      │
│   [ 高级配置与环境变量... ]                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼ 点击高级配置
┌─────────────────────────────────────────────────────────────────────────────┐
│ 检查抽屉 / Inspector Drawer (L3):                                           │
│   传输协议：stdio                                                           │
│   启动命令：uvx mcp-server-sqlite --db-path ./local.db                      │
│   环境变量 (Key-Value):                                                     │
│     SQLITE_TIMEOUT       | 5000                   [ 👁 ] [ 🗑 ]             │
│     SQLITE_READONLY      | true                   [ 👁 ] [ 🗑 ]             │
│     + 添加环境变量                                                          │
│   [ 保存变更 ]  [ 测试连接探测 ]                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 6.7 TypeScript + CSS Module 完整原型代码

#### 1. 动态环境变量组件实现（EnvVariableTable.tsx）

```tsx
import React, { useState, useEffect } from 'react';
import * as Lucide from 'lucide-react';
import { Button, Input, Tooltip } from '../ui';
import styles from './EnvVariableTable.module.css';

export interface EnvRow {
  id: string;
  key: string;
  value: string;
  showSecret: boolean;
}

export interface EnvVariableTableProps {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}

export const EnvVariableTable: React.FC<EnvVariableTableProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  const [rows, setRows] = useState<EnvRow[]>(() =>
    Object.entries(value).map(([k, v], index) => ({
      id: `env-${index}-${Date.now()}`,
      key: k,
      value: v,
      showSecret: false,
    }))
  );

  const commitChanges = (nextRows: EnvRow[]) => {
    setRows(nextRows);
    const out: Record<string, string> = {};
    for (const r of nextRows) {
      const k = r.key.trim();
      if (k) out[k] = r.value;
    }
    onChange(out);
  };

  const handleAddRow = () => {
    const newRow: EnvRow = {
      id: `env-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      key: '',
      value: '',
      showSecret: false,
    };
    commitChanges([...rows, newRow]);
  };

  const handleRemoveRow = (id: string) => {
    commitChanges(rows.filter((r) => r.id !== id));
  };

  const handleUpdateRow = (id: string, field: 'key' | 'value', val: string) => {
    commitChanges(
      rows.map((r) => (r.id === id ? { ...r, [field]: val } : r))
    );
  };

  const toggleShowSecret = (id: string) => {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, showSecret: !r.showSecret } : r))
    );
  };

  return (
    <div className={styles.envContainer} role="table" aria-label="环境变量表">
      <div className={styles.envHeader}>
        <span className={styles.colKey}>变量名 (Key)</span>
        <span className={styles.colValue}>变量值 (Value)</span>
        <span className={styles.colActions}>操作</span>
      </div>
      {rows.length === 0 ? (
        <div className={styles.emptyText}>未配置环境变量</div>
      ) : (
        rows.map((row) => (
          <div key={row.id} className={styles.envRow} role="row">
            <div className={styles.colKey}>
              <Input
                size="sm"
                placeholder="KEY_NAME"
                value={row.key}
                disabled={disabled}
                onChange={(e) => handleUpdateRow(row.id, 'key', e.target.value)}
              />
            </div>
            <div className={styles.colValue}>
              <div className={styles.valueWrap}>
                <Input
                  size="sm"
                  type={row.showSecret ? 'text' : 'password'}
                  placeholder="value"
                  value={row.value}
                  disabled={disabled}
                  onChange={(e) => handleUpdateRow(row.id, 'value', e.target.value)}
                />
                <Tooltip content={row.showSecret ? '隐藏明文' : '显示明文'}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.eyeBtn}
                    onClick={() => toggleShowSecret(row.id)}
                    icon={
                      row.showSecret ? (
                        <Lucide.EyeOff size={13} aria-hidden />
                      ) : (
                        <Lucide.Eye size={13} aria-hidden />
                      )
                    }
                  />
                </Tooltip>
              </div>
            </div>
            <div className={styles.colActions}>
              <Tooltip content="删除此项">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => handleRemoveRow(row.id)}
                  icon={<Lucide.Trash2 size={13} aria-hidden />}
                />
              </Tooltip>
            </div>
          </div>
        ))
      )}
      <div className={styles.footerRow}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={handleAddRow}
          icon={<Lucide.Plus size={13} aria-hidden />}
        >
          添加环境变量
        </Button>
      </div>
    </div>
  );
};
```

#### 2. 动态环境变量组件样式（EnvVariableTable.module.css）

```css
.envContainer {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  background: var(--bg-primary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-2);
}

.envHeader {
  display: flex;
  align-items: center;
  gap: var(--space-1_5);
  font-size: var(--font-size-xxs);
  color: var(--text-tertiary);
  padding-bottom: 2px;
  border-bottom: 1px solid var(--border-subtle);
}

.colKey {
  flex: 0 0 160px;
}

.colValue {
  flex: 1;
  min-width: 0;
}

.colActions {
  flex: 0 0 36px;
  display: flex;
  justify-content: flex-end;
}

.envRow {
  display: flex;
  align-items: center;
  gap: var(--space-1_5);
  padding: 2px 0;
}

.valueWrap {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.valueWrap > :first-child {
  flex: 1;
}

.eyeBtn {
  padding: 0 4px;
}

.emptyText {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  padding: var(--space-1_5) 0;
  text-align: center;
}

.footerRow {
  margin-top: var(--space-1);
  display: flex;
  justify-content: flex-start;
}
```

#### 3. 统一扩展卡片实现（UnifiedExtensionCard.tsx）

```tsx
import React from 'react';
import * as Lucide from 'lucide-react';
import { Button, Switch, Tooltip } from '../ui';
import styles from './UnifiedExtensionCard.module.css';

export interface UnifiedExtensionItem {
  id: string;
  kind: 'plugin' | 'mcp' | 'skill';
  name: string;
  description: string;
  source: 'official' | 'community' | 'local';
  version?: string;
  status: 'running' | 'ready' | 'stopped' | 'error' | 'disabled';
  enabled: boolean;
  toolCount?: number;
}

export interface UnifiedExtensionCardProps {
  item: UnifiedExtensionItem;
  expanded: boolean;
  onToggleExpand: (id: string) => void;
  onToggleEnable: (id: string, enabled: boolean) => Promise<void>;
  onOpenAdvanced?: (id: string) => void;
  children?: React.ReactNode;
}

export const UnifiedExtensionCard: React.FC<UnifiedExtensionCardProps> = ({
  item,
  expanded,
  onToggleExpand,
  onToggleEnable,
  onOpenAdvanced,
  children,
}) => {
  const getKindIcon = () => {
    switch (item.kind) {
      case 'plugin':
        return <Lucide.Puzzle size={15} aria-hidden />;
      case 'mcp':
        return <Lucide.Wrench size={15} aria-hidden />;
      case 'skill':
        return <Lucide.Sparkles size={15} aria-hidden />;
    }
  };

  const getSourceLabel = () => {
    if (item.source === 'official') return '官方';
    if (item.source === 'community') return '三方';
    return '本地';
  };

  return (
    <div
      className={`${styles.card} ${expanded ? styles.isExpanded : ''}`}
      role="article"
      aria-label={item.name}
    >
      <div className={styles.header}>
        <div className={styles.iconWrap}>{getKindIcon()}</div>
        <div className={styles.mainInfo}>
          <div className={styles.titleRow}>
            <span className={styles.name}>{item.name}</span>
            <span className={styles.metaChain}>
              {item.kind.toUpperCase()} · {getSourceLabel()}
              {item.version ? ` · v${item.version}` : ''}
              {item.toolCount !== undefined ? ` · ${item.toolCount} 工具` : ''}
            </span>
            <span
              className={`${styles.statusDot} status-${item.status}`}
              aria-label={`状态：${item.status}`}
            />
          </div>
          <div className={styles.description}>{item.description}</div>
        </div>
        <div className={styles.actions}>
          <Tooltip content={item.enabled ? '停用此扩展' : '启用此扩展'}>
            <Switch
              size="sm"
              checked={item.enabled}
              aria-label={`${item.enabled ? '停用' : '启用'} ${item.name}`}
              onCheckedChange={(checked) => void onToggleEnable(item.id, checked)}
            />
          </Tooltip>
          {onOpenAdvanced ? (
            <Tooltip content="进入全功能配置检查">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpenAdvanced(item.id)}
                icon={<Lucide.Settings2 size={14} aria-hidden />}
              />
            </Tooltip>
          ) : null}
          <Tooltip content={expanded ? '收起面板' : '展开配置'}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              onClick={() => onToggleExpand(item.id)}
              icon={
                expanded ? (
                  <Lucide.ChevronUp size={14} aria-hidden />
                ) : (
                  <Lucide.ChevronDown size={14} aria-hidden />
                )
              }
            />
          </Tooltip>
        </div>
      </div>
      {expanded && children ? (
        <div className={styles.body}>{children}</div>
      ) : null}
    </div>
  );
};
```

#### 4. 统一扩展卡片样式（UnifiedExtensionCard.module.css）

```css
.card {
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  overflow: hidden;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.card:hover {
  border-color: var(--border-color);
}

.card.isExpanded {
  border-color: var(--border-color);
  background: var(--bg-elevated, var(--bg-primary));
}

.header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 10px 14px;
  min-height: 48px;
}

.iconWrap {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.mainInfo {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.titleRow {
  display: flex;
  align-items: center;
  gap: var(--space-1_5);
  min-width: 0;
}

.name {
  font-size: var(--font-size-sm-plus);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.metaChain {
  font-size: var(--font-size-xxs);
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.statusDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-tertiary);
}

.statusDot:global(.status-running),
.statusDot:global(.status-ready) {
  background: var(--accent-green);
}

.statusDot:global(.status-error) {
  background: var(--accent-red);
}

.statusDot:global(.status-disabled),
.statusDot:global(.status-stopped) {
  background: var(--border-color);
}

.description {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}

.actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
}

.body {
  padding: var(--space-2) 14px 12px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-primary);
}
```

---

## 七、实勘结论与主控交接清单

### 7.1 核心架构缺陷归纳表

| 序号 | 缺陷分类 | 现状文件与行号证据 | 严重级别 | 重塑解决方案 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **环境变量缺失** | `McpServerForm.tsx:38-135`<br/>表单无任何 env 输入槽，底表 `clientApi.types.ts:154-164` 缺少 env 字段 | **P0（功能阻断）** | 引入 `EnvVariableTable` 动态键值对编辑组件，支持密码掩码与清洗，补充底层接口契约 |
| 2 | **彩色徽章视觉泛滥** | `ExtensionCard.tsx:135-146, 219-231`<br/>单卡并存 3 个彩色 Badge，挤占名称与描述 | **P1（视觉噪音）** | 废弃多色 Badge，统一收敛为“单色中性元数据链（Icon + 灰文本 + 6px 单色状态圆点）” |
| 3 | **多重边框与容器割裂** | `SkillsSettingsTab.module.css:319-336`<br/>外层 `.skillsSplit` + 内层 `.skillsRail` 双重全线包裹；`SettingsExtensionsTab` 又是全卡片框 | **P1（体验撕裂）** | 统一采用无外层厚包裹的微边框平直卡片体系，对齐主对话流卡片规范 |
| 4 | **幽灵启停命令存留** | `mcpApi.ts:162-225`<br/>Rust 侧无启停命令，但界面上仍保留启动/停止按钮与假交互 | **P1（架构遗留）** | 彻底移除无用的“启动/停止”按钮，状态展示改为静态指示灯，Tooltip 明确连接由任务运行时接管 |
| 5 | **状态机单点割裂** | `useMcpCache.ts`, `useSkillsCache.ts`, `useMcpSettings.ts`<br/>三套独立本地缓存，数据互不感知 | **P2（一致性风险）** | 建立全局统一的 Extensions Store，以单一真相源（SSOT）同步驱动货架与高级视图 |
| 6 | **参数逗号切分脆弱** | `McpServerForm.tsx:271-275`<br/>`newArgs.split(',')` 粗暴切分带空格与逗号的参数 | **P2（健壮性缺陷）** | 引入类 Shell 词法分析器（Shlex Tokenizer）进行安全参数切分与格式化 |

---

### 7.2 原子化重塑路线图与里程碑

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 阶段一：基础原子原语落盘 (Milestone 1)                                       │
│   1. 沉淀 EnvVariableTable 动态环境变量编辑原语至 src/components/ui/         │
│   2. 沉淀 UnifiedExtensionCard 统一卡片基础原语至 src/components/ui/         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 阶段二：底层契约补齐与幽灵代码清理 (Milestone 2)                             │
│   1. 扩展 McpServer 契约，支持 env: Record<string, string> 字段              │
│   2. 清理 McpServerList 与 McpToolsSection 中无效的启停按钮，统合为指示灯   │
│   3. 统一使用参数词法解析器替代逗号 split                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 阶段三：三业务目录原子化归一收敛 (Milestone 3)                               │
│   1. 重构 SettingsExtensionsTab，全量消费 UnifiedExtensionCard              │
│   2. 将 SkillsSettingsTab 与 McpSettingsTab 的高级模式重塑为侧边滑出抽屉   │
│   3. 建立全局 ExtensionStore，消除多级缓存漂移，实现立体验证门禁通过       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 7.3 交付物与后续任务对齐建议

1. **已交付产物**：本篇实勘导航文档已按规定以 UTF-8 无 BOM 格式正式落盘于 [`docs/frontend-atomic-architecture/analysis/22-MCP工具服务与技能扩展生态实勘导航.md`](file:///c:/Software/conex/docs/frontend-atomic-architecture/analysis/22-MCP工具服务与技能扩展生态实勘导航.md)，全篇详实记录了所辖 43 个文件的代码行数、组件职责、样式变量及架构断层，总行数超 1200 行；
2. **向主控汇报要点**：
   - 重点报告“标准 MCP 环境变量 Key-Value 动态行缺失”与“命令行参数逗号切割脆弱”两大实质性功能断层；
   - 重点报告“彩色徽章泛滥”与“多重边框嵌套”的视觉痛点；
   - 提交包含代码实现的 `EnvVariableTable` 与 `UnifiedExtensionCard` 原型作为后续重塑阶段的直接技术输入。
