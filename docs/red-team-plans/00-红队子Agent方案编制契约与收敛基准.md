# 红队子 Agent 方案编制契约与收敛基准 (Red Team Master Contract)

## Red Team Subagent Architecture Planning Contract, Anti-Pattern Guidelines & Convergence Baseline

> **权威与纪律说明**：本契约是红队所有方案设计子 Agent（Independent Planner / Detailed Domain Planner）在编制前端重构与收敛方案时的**最高刚性契约与必读基座 (Master Contract)**。
> **核心战役目标**：在红蓝对抗中以压倒性的架构深度、代码穿透力、严密的收敛哲学与零漏洞的逻辑设计赢得胜利！
> **防作弊最高铁律**：**红队所有 Agent 绝对严禁查看、检索、引用 `docs/frontend-review/`（蓝队隔离区）下的任何文件**。红队方案必须完全基于客观审计报告、标杆真实源码解剖、全景 Review 规范与真实代码库独立构建！
> **编码与字符集**：UTF-8 无 BOM。

---

# 一、 核心调度哲学与元契约 (Meta-Contract & Philosophy)

### 1.1 「正确性 × 收敛性」双目标函数

方案编制的唯一目标函数：

$$\mathbf{U_{\text{plan}}} = \mathcal{C}_{\text{correctness}}(\Delta) \times \mathcal{S}_{\text{convergence}}(\Delta)$$

1. **功能正确性 $\mathcal{C}_{\text{correctness}} \in \{0, 1\}$**：
   - 方案必须 100% 覆盖审计报告中指出的所有真实缺陷与功能缺失；
   - 严禁任何形式的降级、缩水或打补丁；
   - 严禁使用 `--no-verify` 绕过门禁，类型检查必须 0 报错。
2. **结构收敛性 $\mathcal{S}_{\text{convergence}}$**：
   - 推进单位是**领域概念（Domain Concepts）**，严禁按批次/波次（Batch/Round/Wave）机械切割；
   - **收敛（删除/合并重复路径）在逻辑顺序上严格先于功能增强**——一个概念已有多条路径时，必须先删到一条，再谈增强；
   - **负产出验收（Negative Code Yield）**：每条方案必须包含净删除动作，未接线标记新增必须为 0；
   - **一个概念一条路径（Single Canonical Path）**：每一个领域概念在代码库中有且仅有一条唯一主路径。

---

### 1.2 独立方案必须包含的强制章节与结构模板

每一个提交给主控的方案文档，**必须严格包含以下 6 大核心板块**，缺少任一板块直接判定为不合格退回：

```markdown
# [领域概念名称] 独立重构与收敛实施方案

## 一、 领域概念现状与路径盘点 (Current State & Paths)

- 回答核心问题：本概念在现有代码里一共有几条路径？分别位于哪些文件和组件中？
- 现有路径的缺陷、冲突与反模式分析（引用真实文件路径与代码片段）。

## 二、 目标架构与唯一主路径收敛设计 (Target Architecture & Single Truth Path)

- 回答核心问题：本方案将本概念收敛到哪条唯一合法路径（Canonical Path）？
- 架构设计、数据结构、核心接口契约与 TypeScript 类型定义。
- 借鉴标杆（AFFiNE / AppFlowy / DeepSeek-Harness）的最优原生解法与工业级设计。

## 三、 本方案要删掉什么 / 收敛什么 (The Purge & Eviction List - 强制核心章节)

- 1. 物理删除的文件清单（源码文件、废弃样式表、孤儿组件、陪葬测试）；
- 2. 物理删除的代码块与废弃接口（具体类、函数、Props、全局类名绑定）；
- 3. 彻底消除的重复路径与降级/兼容分支（清除非法别名 Store、清退冗余 Switch 分发）；
- 4. 预计净削减代码行数：-_____ 行（必须为负产出）。

## 四、 逻辑执行顺序与依赖拓扑 (Execution Flow & Dependency Graph)

- 严格遵循「先删后改」公理：删除历史死代码 -> 建立唯一基础契约 -> 业务实现对接；
- 方案内部任务单元分解，给出严格的逻辑依赖关系图（Mermaid 流程图）。

## 五、 文件域隔离与并行冲突防护 (File Scope & Parallel Safety)

- 明确本方案修改的唯一文件域清单（精确到相对路径）；
- 跨域收敛事项单列，确保与并行 Agent 的文件域互不相交。

## 六、 验收标准与断言矩阵 (Verification & Assertions)

- 功能验收断言（核心行为绿灯测试用例、CDP 9222 真机验收场景）；
- 负产出与收敛验收断言（净删除行数 >= 1、未接线标记新增 = 0、概念路径数 = 1）。
```

---

# 二、 必读资产与输入基准矩阵 (Mandatory Reading Assets)

编制方案前，子 Agent 必须深入精读以下官方权威输入资产（全部位于 `docs/` 目录下）：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              红队方案设计子 Agent 必读输入文献矩阵                                       │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│  【基座军规】                                                                                           │
│  • `docs/agent-roles/review/frontend-review.md` (1338行全景 Master Review 规范、12大反模式与红线)       │
│                                                                                                        │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  【前置白盒审计报告 (27 份)】                                                                           │
│  • 架构基础审计：`docs/frontend-architecture-review/01~05.md`                                          │
│  • 全景业务审计：`docs/frontend-architecture-review/full-sweep/01~16.md`                                │
│  • 深潜专项审计：`docs/frontend-architecture-review/deep-dives/01~06.md`                                │
│                                                                                                        │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  【标杆深度源码解剖报告 (9 份)】 (docs/frontend-benchmarking/deep-dives/)                              │
│  • 01-AFFiNE原子组件与同心几何源码解剖.md (1817行)  • 02-AFFiNE浮层中枢与防重入互斥源码解剖.md (1104行)  │
│  • 03-AFFiNE沉浸顶栏与Resize隔离源码解剖.md (1163行)  • 04-AFFiNE_BlockSuite纯CSS悬浮源码解剖.md (1283行)│
│  • 05-AppFlowy文件树与状态Badge源码解剖.md (1760行)  • 06-AppFlowy紧凑Diff视图源码解剖.md (1639行)       │
│  • 07-AppFlowy双轨滚动链与防死锁源码解剖.md (1488行)  • 08-DSH声明式SlotMap微内核源码解剖.md (961行)     │
│  • 09-DSH工作流状态机与生命周期隔离源码解剖.md (1149行)                                                 │
│                                                                                                        │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  【标杆工程美学深度赏析专著 (13 份)】 (docs/frontend-benchmarking/design-appreciation/)                │
│  • 01~07: AFFiNE 原子系统 / 沉浸顶栏 / BlockSuite / 浮层拓扑 / DND动效 / 现代色彩 / 多态画布赏析       │
│  • 08~11: AppFlowy 呼吸感文件树 / 紧凑Diff / 滚轮手势弹性分栏 / 微徽章与极简指示赏析                   │
│  • 12~13: DeepSeek-Harness 微内核SlotMap拓扑 / 3-Lane协同流与极简时间线赏析                            │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

# 三、 必须全量消灭的 12 大核心反模式 (AP-01 ~ AP-12)

任何方案必须对以下 12 项反模式建立防线，严禁在方案中引入以下病态代码：

1. **AP-01 伪门面广播**：严禁 `export const useSessionStore = useLayoutStore;`，必须物理拆分独立 Store 实例；
2. **AP-02 几何断裂与药丸通胀**：严禁普通控件滥用 `9999px` 胶囊圆角，严格遵循 $R_o = R_i + P$ 同心几何；
3. **AP-03 双层控制栏堆叠**：严禁 44px 顶栏 + 30px TabBar 堆叠，收敛为 36px~40px 沉浸单层顶栏；
4. **AP-04 高度归零回流环**：严禁 `el.style.height = '0px'` 强制回流，改用 CSS `field-sizing: content`；
5. **AP-05 动量黑洞死锁**：严禁内嵌分栏滥用 `overscroll-behavior: contain` 截断滚轮，必须保障滚动链连通；
6. **AP-06 逻辑与虚拟双重切片**：严禁虚拟滚动上层套用 `.slice()` 数组截断；
7. **AP-07 幽灵样式地层沉积**：严禁保留死全局 CSS，单个 CSS Module 严格限 400 行；
8. **AP-08 白板生命周期污染**：严禁全局 Git 状态越界入侵空白草稿会话，空态必须设立绝对门闩；
9. **AP-09 JS 驱动 Hover 雪崩**：严禁长文档滑动触发 React `setState`，必须由纯 CSS `:hover` 与 DOM 直写驱动；
10. **AP-10 浮层深层嵌套与通胀**：严禁 Z-Index 恶性通胀至 100,000，必须遵循 7 级标准标尺（$\le 9000$）；
11. **AP-11 孤儿资产沉没**：严禁保留已废弃的旧组件与死测试，必须 `git rm` 物理清退；
12. **AP-12 静态 Switch 分流**：严禁核心容器使用静态 `switch(panelId)`，必须采用声明式 `ViewRegistry` 动态分发。

---

# 四、 首批物理清剿与死代码删除基线 (Baseline Purge List: 9,296 行)

方案中涉及以下模块时，必须将其列入**首批物理删除清单**：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          坚决物理删除清单 (Purge List)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. 物理删除 styles/settings/ 下全部 6 个文件 (累计 7,263 行)                │
│     - settings-base.css (2554行)      - settings-models.css (2550行)        │
│     - settings-plugins.css (1039行)   - settings-advanced.css (691行)       │
│     - settings-usage.css (221行)      - settings-extensions.css (208行)     │
│  2. 物理删除 styles/panels.css 原型样式表 (748 行)                          │
│  3. 物理删除 components/bg-tasks/ 孤儿组件及其测试 (804 行)                  │
│     - BgTaskCard.tsx (262行)          - BgTaskActions.tsx (115行)           │
│     - BgTaskCard.module.css (192行)   - 对应 .test.tsx (360行)              │
│  4. 物理删除 components/files/FileTree.tsx 冗余包装 (9 行)                  │
│  5. 物理删除 services/ServiceRegistry.ts 空转 DI 容器 (58 行)                │
│  6. 物理删除 services/CrossTabCoordinator.ts 无消费僵尸心跳 (147 行)         │
│  7. 物理删除 services/config-schema.ts 严重漂移遗留配置 (37 行)              │
│  8. 物理删除 components/card-panel/ 下遗留重定向桩 (52 行)                   │
│     - SettingsLegacyRedirect.tsx (24行) - PlanLegacyRedirect.tsx (28行)     │
├─────────────────────────────────────────────────────────────────────────────┤
│  合计物理削减无用代码：9,296 行                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

同时，必须在方案中规划：

1. 在 80+ 处 TSX 节点中彻底剥离 `className={`${styles.mrdModelRow} mrd-model-row`}` 等全局类名绑定；
2. 清除跨 5 层透传的 `onShowToast`，收敛为 `useToast()` Context 单例。

---

# 五、 7 大深层难题与标准工业级解法指引

| 难题代号                          | 痛点现象                                                      | 病理根因                                              | 标杆工业级标准解法                                                                                     |
| :-------------------------------- | :------------------------------------------------------------ | :---------------------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| **难题 1: 总览文件树**            | 36 个改动文件拥挤在 280px 限高盒中，`basename` 丢失目录       | 路径粗暴截断、死板固定高度限高、`<em>` 裸文字渲染     | 纯函数 `buildGitTree` 树状折叠 + 4px 微圆角 `GitStatusBadge` 胶囊 + 3 色增删条 + `flex: 1` 弹性视口    |
| **难题 2: 差异对比视图**          | 双行 Header 浪费 76px，15% 刺眼红绿底色，黄色警告横幅破坏沉浸 | 结构臃肿、缺乏词法高亮、过度警告提示                  | 34px 紧凑单行 Header + 5.5% 柔和低反差色板 + 词法级 Intraline Diff 分词高亮引擎 + 彻底消除警告横幅     |
| **难题 3: 四击关闭 Bug**          | 浮层菜单需要连点 4 次才能关闭                                 | Radix 外点检测、Trigger `onClick` 取反与 Tooltip 竞争 | `modal={false}` 非模态默认 + Trigger 50ms 防重入冷却状态锁 + 浮层激活态 Tooltip 全局静默互斥           |
| **难题 4: 供应商级联选择**        | 二级飞出菜单 Hover 闪退，预置服务商 Key 输入框不渲染          | CSS BFC 裁剪、缺少安全三角区、`custom-` 前缀硬编码    | Radix `DropdownMenu.Sub` + Safe Triangle 射线检测算法 + 全量开放凭据表单消除前缀限制                   |
| **难题 5: 设置页 8px 灰槽与重刷** | 全屏模态右下暴露泥泞灰槽，滚动条悬空缩进，修改配置全屏重刷    | 错误继承浮岛卡片样式、滚动条未贴边、粗粒度订阅大对象  | 全贴合无缝双栏（0 margin, 0 radius）+ 滚动条极右贴边（$X=W$）+ 主题/密度直写 DOM 属性（React 0 重绘）  |
| **难题 6: 窗口缩放卡顿**          | 拖拽窗口严重掉帧（15~25 fps），出现 200ms 主线程冻结          | rAF 每帧轮询坐标、解冻防抖调用 `flushSync` 同步冻结   | 窗口 Resize 期间「Zero-JS」休眠 + 拔除 rAF 轮询 + 废除 `flushSync` + `contain: strict` 与 GPU 图层隔离 |
| **难题 7: 新会话空态污染**        | 新建空白草稿会话突兀弹出「18 个文件变更」悬浮胶囊             | 粗暴读取全局工作区 Git 单例、缺乏状态层级隔离与门闩   | 会话 Diff 纯函数派生（`selectSessionDiffFiles`）+ `ChatStatusRibbons` 增加 `!onEmptySurface` 绝对门闩  |

---

# 六、 15 项黄金自检清单 (Reviewer 15 Golden Self-Inspection Checklist)

所有方案在提交评审前必须逐项自检并满足以下 15 条准则：

- [ ] **[C-01 纯净原子]** 是否 100% 消费原子组件库？是否存在裸 `<button>`, `<input>`, `<select>`, `<textarea>`？
- [ ] **[C-02 同心圆角]** 圆角是否满足 $R_{\text{outer}} = R_{\text{inner}} + \text{Padding}$？是否存在 9999px 药丸圆角滥用？
- [ ] **[C-03 浮层防重入]** 下拉菜单是否为非模态？Trigger 是否具备 50ms 关闭状态锁？是否存在四击关闭 Bug？
- [ ] **[C-04 Tooltip 互斥]** 是否杜绝原生 `title` 属性？浮层展开时 Tooltip 是否处于静默休眠态？
- [ ] **[C-05 Z-Index 标尺]** 是否严格遵循 7 层 Z-Index 标尺（$\le 9000$）？是否存在魔术数字？
- [ ] **[C-06 零 Important]** 业务样式表中是否存在 `!important`？死样式表是否已物理删除？
- [ ] **[C-07 Token 回退]** CSS 变量回退值是否为主题中立？深浅色模式切换是否出现白底白字盲文？
- [ ] **[C-08 滚动链连贯]** 是否在内嵌分栏中误加 `overscroll-behavior: contain` 导致滚轮死锁？
- [ ] **[C-09 Store 物理隔离]** Store 是否完成物理分拆？是否存在 `useSessionStore = useLayoutStore` 伪门面？
- [ ] **[C-10 呈现层 0 重绘]** 主题/密度切换是否直写 DOM 属性？React 全树重绘次数是否为 0？
- [ ] **[C-11 微内核分发]** 工作区叶子节点是否通过 `ViewRegistry` 声明式渲染？是否消灭了 `switch (panelId)`？
- [ ] **[C-12 费茨定律贴边]** 全屏面板主滚动条是否贴在物理极右边缘（$X = W_{\text{screen}}$）？是否根除右下 8px 泥泞断层？
- [ ] **[C-13 Resize 零 JS]** 窗口缩放期间 JS 是否休眠？是否拔除 rAF 坐标轮询？是否清除了 `flushSync`？
- [ ] **[C-14 悬停零状态]** 列表与块悬浮把手是否由纯 CSS `:hover` 驱动？鼠标划过是否 0 次 React 重绘？
- [ ] **[C-15 空态纯净门闩]** 新对话空态是否设立生命周期门闩？是否阻断了全局 Git 变更胶囊的越界污染？

---

> **结语誓言**：
> 红队全体子 Agent 必须以此契约为唯一行动指南，以扎实的代码证据、清晰的收敛路径、彻底的死代码清剿与极致的用户体验，制定出无懈可击的前端系统重构总方案！
