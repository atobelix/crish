# 多 Agent 方案校准重塑任务书与专用提示词体系（6 大专属席位版）

> **文档标识**：`docs/file-tree-and-attachments-architecture/detailed-plans/00-calibration-task-prompts.md`  
> **任务性质**：以已完成真实源码逐行核验落地的两份权威方案（`06-final-best-plan-alpha.md` 与 `07-final-best-plan-beta.md`）为基准，按照 Conex 协同纪律（每轮派发 5–12 个子 Agent，单 Agent 单文档独占极致精细化作业），部署 **6 大专业席位子 Agent**，一对一全面重塑与就地更新此前多 Agent 编写的 5 份分维施工详案（`detailed-plans/01` 至 `05`）与战役总方案（`00-master-plan.md`）。  
> **架构结构**：第一部分至第四部分为 6 位 Agent 必须严格共同恪守的外部通用总纲；第五部分至第十部分为分别派发给 6 位 Agent 的高精度独占执行提示词（每个提示词均独立超过 600 字，精准锁定文件、行号、算法契约、AST 骨架与负向断言要求）。

---

# 【提示词外部公共总纲与共同底线】

## 一、权威输入基准与单一真实源（SSOT）

受派 Agent 开展工作时，必须严格依托以下两类资产，杜绝主观臆造：
1. **📘 权威落地方案 Alpha**：[`docs/file-tree-and-attachments-architecture/independent-plans/06-final-best-plan-alpha.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/independent-plans/06-final-best-plan-alpha.md)  
   - 包含 3,957 行经过 9 大源码文件逐行核验的完整代码与推导；
   - 确立了 W3C 原生 `scrollend` 事件驱动的平滑位移停泊确认与焦点守护机制；
   - 提供了 11 个重构模块 100% 完整展开的生产级 TypeScript / CSS 代码。
2. **📙 权威落地方案 Beta**：[`docs/file-tree-and-attachments-architecture/independent-plans/07-final-best-plan-beta.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/independent-plans/07-final-best-plan-beta.md)  
   - 包含 3,795 行经过真实 IPC 与样式核验的完整代码；
   - 严密推导了祖先盒模型 3 级高度链物理方程与 0px/50px/300px/2000px 4 大极限高度代数证明；
   - 严密推导了 W3C Compositing & Blending Level 1 层叠上下文隔离舱防穿透偏序定理。
3. **💻 真实物理源码与样式**（唯一硬件物理真相）：
   - `apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx`
   - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`
   - `apps/crish-desktop/src/api/filePanelOpener.ts`
   - `apps/crish-desktop/src/api/workspaceFsApi.ts`
   - `apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts`
   - `apps/crish-desktop/src/components/files/FileTreeView.tsx`
   - `apps/crish-desktop/src/components/files/FileTreeView.test.tsx`
   - `apps/crish-desktop/src/components/files/FilesCard.tsx`
   - `apps/crish-desktop/src/components/files/FileBreadcrumb.tsx`
   - `apps/crish-desktop/src/components/files/FileActions.tsx`
   - `apps/crish-desktop/src/components/files/FilesCard.module.css`
   - `apps/crish-desktop/src/components/files/__tests__/FileBreadcrumb.test.tsx`
   - `apps/agent-workbench/src-tauri/src/fs_commands/mod.rs`
   - `apps/agent-workbench/src-tauri/src/command_manifest.rs`
   - `apps/crish-desktop/src/styles/tokens.css`
   - `apps/crish-desktop/src/styles/z-index.css`

---

## 二、架构原则与纯逻辑规划准则（反退避铁律）

1. **纯逻辑规划与依赖拓扑**：方案只谈逻辑依赖、任务单元、文件域与验收断言；**绝对不谈**工期、人天、人员安排；所有技术问题在逻辑上一律同权，严禁使用 P0/P1 业务优先级砍项或搞所谓 MVP 阉割；
2. **直击根本，杜绝退避与补丁**：严禁以“实现复杂”、“时间不够”、“业界普遍做法”劝退彻底重构；严禁使用基于坐标测距的魔术数字延时补偿（如 `setTimeout(..., 200)`），必须用原生、精确、O(1) 或标准事件（如 `scrollend`）驱动；
3. **架构净收敛**：重构必须是物理彻底切除，清退所有死代码与历史双轨岛屿，实现单一事实源（SSOT）。

---

## 三、四大严禁行为与负向红线（零容忍）

1. **严禁功能伪连通（Zero Fake Connectivity）**：
   - 严禁仅编写独立纯函数或空转组件却未在真实宿主调用链生效；
   - 严禁在真实调用处传递 Default/None/空配置/空回调；
   - 严禁出现带有 `#[allow(dead_code)]` 或零真实调用的死快照与未连通路由。
2. **严禁多轨并存与给旧岛续命（Zero Dual-Track & Zero Legacy Shims）**：
   - 单一概念必须收敛至唯一权威源（SSOT）。严禁将新规范数据倒灌/双写回旧存储介质；
   - 彻底物理切除 `cwd` 状态、`setCwd`、`goUp` 与顶栏“上级目录 ↰”按钮；
   - 严禁保留 `@deprecated cwd?: string`、`cwd: _cwd` 或 `refresh(_ignoredDir?: string)` 等任何欺骗性兼容 Shim 掩盖旧轨；
   - 物理切除 `ChatMessageRow.module.css` 中 61 行废弃旧类（`.userImages`, `.userAttachmentChip` 等）与 `ChatUserMessageRow.tsx` 中的废弃 JSX，严禁使用 `display: none` 敷衍留存。
3. **严禁幽灵契约与截肢式降级（Zero Ghost Contracts & Zero Amputation）**：
   - 跨层通信（IPC/API）必须与底层主注册表严格 1:1 对齐，严禁调用未注册命令；
   - 彻底切除前端 `workspaceFsApi.ts` 透传给底层 Rust 的 `workspaceRoot` 幽灵参数（底层 `workbench_list_directory` 真实签名仅为 `(app, path)`）；
   - 严禁编写以丢弃关键配置/字段为代价的“破坏性容错回退”，严禁在 `Promise.allSettled` 或 `catch` 块中静默吞咽核心异常。
4. **严禁虚构 Token 与样式欺骗（Zero Pseudo-Tokens & Zero Box-Model Illusions）**：
   - UI 必须 100% 遵从 Design Tokens，严禁发明不存在的伪变量（如 `--z-pinned-bar`，收敛为权威 Token `var(--z-sticky, 10)`）；
   - 严禁任何裸 Hex，所有存量裸色一律清洗为标准语法（如 `hsl(0 0% 100%)`）；
   - 呼吸脉冲动画全量收敛至系统标杆翡翠绿 `hsl(160 84% 36%)`；
   - 涉及滚动/粘性/层叠布局时，必须穿透检查祖先 3 级盒模型高度链与 W3C Stacking Context，在 `.filesBody` 注入 `isolation: isolate; z-index: var(--z-base, 0)` 原生隔离舱，杜绝分割线穿透顶栏。

---

## 四、产品真存活五大物理闭环物证体系（交付唯一依据）

严禁将“模块内自测绿灯”、“类型检查无报错”或“文档声明完成”作为交付依据，必须具备五大真实存活物证：
1. **触发端物证（Trigger Evidence）**：用户在气泡中点击 58×58 卡片，`e.stopPropagation()` 成功拦截冒泡（长气泡绝不折叠跳变），安全工作区路径被精准提取；
2. **传输端物证（Transport Evidence）**：`filePanelOpener.ts` 无论分流至何宿主无条件向 `window` 派发 `crish-open-file` 广播事件并设置 `pendingOpenPath`；IPC 出站负载仅为严格的 `{ path }`，零幽灵字段；
3. **介质端物证（Storage & State Evidence）**：工作区根目录永久锚定在 `getWorkspacePath()`；`useFileNavigation` 内部零 `cwd` 变量；`expanded` 字典键 100% 规范化（小写驱动器、无尾斜杠）；
4. **消费端物证（Consumer & Viewport Evidence）**：左侧目录树祖先真实在 DOM 挂载展开（`aria-expanded="true"`）；虚拟视口在 W3C 原生 `scrollend` 驱动下精准停泊在代数居中坐标；目标 DOM 节点在进入虚拟窗口后准确获得焦点与 1.4s 翡翠绿脉冲；纯附件消息下方空气泡在 DOM 中彻底为 `null`；
5. **负向断言物证（Negative Assertion Evidence）**：自动化测试中必须包含 6 大刚性负向断言（NEG-01 至 NEG-06），证明旧数据、旧属性、旧类名被物理切除且绝不回潮。

### 6 大刚性负向断言对照表
- **NEG-01**：`expect((nav as any).cwd).toBeUndefined()` 与 `expect((props as any).cwd).toBeUndefined()`（拦截 `cwd` 回潮）；
- **NEG-02**：`expect(container.querySelector('.userAttachmentChip')).toBeNull()`（拦截旧药丸胶囊回潮）；
- **NEG-03**：`expect(container.querySelector('.userImages')).toBeNull()`（拦截旧堆叠大图回潮）；
- **NEG-04**：`expect(container.querySelector('.filesBcFlyoutSearch')).toBeNull()`（拦截旧外边框搜索框回潮）；
- **NEG-05**：`expect(container.querySelector('input[type="search"]')).toBeNull()`（拦截原生 search 带叉输入框回潮）；
- **NEG-06**：`expect(container.querySelector('.userBubble')).toBeNull()`（纯附件消息下方空气泡在 DOM 中彻底销毁为 `null`）。

---

# 【6 大专属席位独立派发提示词清单（每份独立提示词字数均超 600 字）】

## 五、Agent 1：战役总方案首席架构师提示词（责任文档：`00-master-plan.md`）

```markdown
你是一名资深全栈系统架构师与战役总方案专家。当前任务是作为【战役总方案重构首席架构师】，依据前面已校准验证的权威方案（06-final-best-plan-alpha.md 与 07-final-best-plan-beta.md）以及真实生产源码，全面重塑与就地更新本次战役的最高权威总纲方案：
📁 独占责任目标文件：c:\Software\conex\docs\file-tree-and-attachments-architecture\00-master-plan.md

【前置必读的权威落地资产与真实源码】
- 权威方案 Alpha：docs/file-tree-and-attachments-architecture/independent-plans/06-final-best-plan-alpha.md（重点研读：§1 架构总纲、§1.4 真实代码基线、§2 7大致命问题、§4 盒模型与隔离舱证明、§8 纯逻辑有向无环图 DAG）；
- 权威方案 Beta：docs/file-tree-and-attachments-architecture/independent-plans/07-final-best-plan-beta.md（重点研读：§1.2 四大红线矩阵、§4 盒模型 3 级高度链物理方程与 0/50/300/2000px 极限代数证明、W3C Stacking Context 合成图层证明、§5 五大物理交付闭环物证体系）；
- 真实物理源码与底层宏注册表：
  * apps/agent-workbench/src-tauri/src/fs_commands/mod.rs:26-35（核验真实命令签名，证实绝对无 workspace_root）
  * apps/agent-workbench/src-tauri/src/command_manifest.rs:108（核验 workbench_list_directory 命令注册）
  * apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx
  * apps/crish-desktop/src/api/filePanelOpener.ts
  * apps/crish-desktop/src/components/files/FilesCard.tsx
  * apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts
  * apps/crish-desktop/src/components/files/FileTreeView.tsx

【00-master-plan.md 具体重构与升级规范（必须逐一达成）】
1. 废除包含幽灵参数的历史旧案：彻底刺破并消除原总方案中声称与 Rust 匹配的 { path, workspaceRoot } 虚构参数，纠偏为严格的单一对象 { path }，确立 1:1 对齐底层 Rust 命令 workbench_list_directory；
2. 写入【架构原则与纯逻辑规划】与【四大严禁负向红线（零容忍）】终审对照矩阵，严格覆盖零功能伪连通、零多轨旧岛、零幽灵契约、零虚构Token与样式欺骗；
3. 写入【产品真存活五大物理交付闭环物证体系】与 NEG-01 至 NEG-06 刚性门禁表，确立以真实产品端物理存活为交付唯一依据；
4. 绘制【10 步端到端真实物理调用链全景图】（Mermaid SequenceDiagram）：
   - 步骤 1：用户点击 58×58 卡片；
   - 步骤 2：AttachmentCard 首行 e.stopPropagation() 拦截冒泡；
   - 步骤 3：ChatUserMessageRow 调用 openFileInPanel；
   - 步骤 4：filePanelOpener 无条件派发 crish-open-file 广播并设置 pendingOpenPath；
   - 步骤 5：FilesCard 捕获广播，takePendingOpenPath 消费路径；
   - 步骤 6：handleOpenFile 驱动两线（preview.openFile 与 nav.revealPath）；
   - 步骤 7：nav.revealPath 调用 toCanonicalFsPath 与 getAncestorDirPaths 提取规范化祖先；
   - 步骤 8：workbench_list_directory 仅传 { path } 发起 1:1 IPC 拉取；
   - 步骤 9：Promise.allSettled 聚合错误回写 setError，成功项原子更新 setExpanded；
   - 步骤 10：FileTreeView 响应 selected，计算居中坐标并驱动 container.scrollTo({ behavior: 'smooth' })，W3C 原生 scrollend 确认停泊后转移焦点并播放 1.4s 翡翠绿脉冲高亮；
5. 写入【祖先盒模型真实 3 级高度链物理方程推导】：
   - H_host = 100% (calc(100vh - header - margin))；
   - H_body = max(0, H_host - 32px)；
   - H_viewport ≡ H_containerRef = H_body = max(0, H_host - 32px)；
   - 给出 0px（折叠）、50px（矮视口）、300px（紧凑屏）、2000px（4K 大屏）4 大极限视口高度代数证明；
6. 写入【W3C Compositing & Blending Level 1 隔离舱防穿透数学证明】：
   - isolation: isolate 建立局部层叠上下文 S_body，全局堆叠等级 Level(S_body) = 0；
   - 偏序关系 Level(S_body) = 0 < Level(filesBar) = 10 <= Level(展开浮层) = 400；
   - 分割线像素 100% 封闭于底座，绝对不可穿透顶栏；
7. 编排【五大 Wave 纯逻辑执行拓扑与独占文件域矩阵】（严格有向无环图 DAG，不设工期人天，问题逻辑同权）；
8. 形成一份篇幅 1500+ 行、具有绝对权威性与施工图级精度的总纲领方案。

【执行纪律与格式红线】
1. 只能使用系统内置工具（view_file, write_to_file），绝对严禁使用任何脚本批量替换！
2. 纯逻辑规划，不谈工期、人天、P0/P1，所有问题逻辑同权；
3. 写文件 UTF-8 无 BOM，严禁执行 git commit；
4. 完成后向主控汇报文档的就地更新行数与核心校准指标。
```

---

## 六、Agent 2：SPEC-01 路径规范化内核详案专家提示词（责任文档：`detailed-plans/01-path-canonical-spec.md`）

```markdown
你是一名资深跨平台路径架构专家。当前任务是作为【SPEC-01 路径规范化内核与 SSOT 契约详细施工规范专家】，依据前面已校准验证的权威方案（06-final-best-plan-alpha.md 与 07-final-best-plan-beta.md）以及真实源码，全面重塑与就地更新详案 01：
📁 独占责任目标文件：c:\Software\conex\docs\file-tree-and-attachments-architecture\detailed-plans\01-path-canonical-spec.md

【前置必读的权威落地资产与真实源码】
- 权威方案 Alpha：docs/file-tree-and-attachments-architecture/independent-plans/06-final-best-plan-alpha.md（重点研读：§2.2 契约校准、§6.2 workspaceFsApi.ts 完整纯函数与 IPC 实现、§7 单测规范）；
- 权威方案 Beta：docs/file-tree-and-attachments-architecture/independent-plans/07-final-best-plan-beta.md（重点研读：§2.2 幽灵契约清算、§6.2 纯函数算法推导）；
- 真实物理源码与 Rust 命令：
  * apps/crish-desktop/src/api/workspaceFsApi.ts（核验真实导出、listDirectory 现存签名、workspaceRootArg 辅助函数）
  * apps/agent-workbench/src-tauri/src/fs_commands/mod.rs:26-35（核验 Rust 真实入参只有 path，无 workspace_root）
  * apps/agent-workbench/src-tauri/src/command_manifest.rs:108（核验宏注册名称 workbench_list_directory）
  * apps/crish-desktop/src/api/__tests__/workspaceFsApi.test.ts

【01-path-canonical-spec.md 具体重构与重塑规范（必须逐一达成）】
1. 严格独占文件白名单锁定：apps/crish-desktop/src/api/workspaceFsApi.ts 与 apps/crish-desktop/src/api/__tests__/workspaceFsApi.test.ts，严禁触碰白名单外任何文件；
2. 彻底切除幽灵参数：现场证明 Rust 注册表 workbench_list_directory 仅接收 (app, path)。详案必须明确删除前端私有的 workspaceRootArg() 辅助函数，将 listDirectory 发送给 Tauri 的 IPC 负载严格修正为单一对象 { path }；
3. 真实补齐导出纯函数：真实代码中缺失 toCanonicalFsPath、isSameFsPath、getAncestorDirPaths。详案必须给出 100% 完整无留白的 TypeScript 实现代码，严禁引入 node:path 或任何 npm 第三方库：
   - toCanonicalFsPath：反斜杠转正斜杠、UNC 双斜杠保护、点号段 /./ 与 /../ 栈解析消解、Windows 驱动器盘符强制小写（c:/）、消除除根路径外的末尾斜杠；
   - isSameFsPath：调用 toCanonicalFsPath 后进行等值比对，Windows 盘符路径与 UNC 不区分大小写；
   - getAncestorDirPaths：自底向上推导顶层直属子目录至目标父目录的有序祖先数组，遇到根外路径立即返回空数组，阻断越界逃逸；
4. 给出 workspaceFsApi.test.ts 完整展开的单元测试套件代码，覆盖 Windows 盘符、反斜杠、大小写驱动器归一、UNC 前缀、相对点号段消解、兄弟前缀碰撞隔离（如 c:/repo 与 c:/repo_fake）与幂等性断言；
5. 设立针对 workspaceRoot 幽灵字段的负向断言：断言出站 payload 键集合 Object.keys(args) 严格等于 ['path']；
6. 形式规范：全文展开为 10 节标准模板（白名单、可复用资产、纯逻辑接口、算法安全契约、负向禁令、单测用例、验证命令），零 // ... 省略。

【执行纪律与格式红线】
1. 只能使用系统内置工具（view_file, write_to_file），绝对严禁使用任何脚本批量替换！
2. 纯逻辑规划，不谈工期、人天、P0/P1，所有问题逻辑同权；
3. 写文件 UTF-8 无 BOM，严禁执行 git commit；
4. 完成后向主控汇报文档的就地更新行数与核心校准指标。
```

---

## 七、Agent 3：SPEC-02 目录树单轨与展开 Hook 详案专家提示词（责任文档：`detailed-plans/02-tree-navigation-spec.md`）

```markdown
你是一名资深状态机架构专家。当前任务是作为【SPEC-02 目录树单轨收敛与祖先展开 Hook 详细施工规范专家】，依据前面已校准验证的权威方案（06-final-best-plan-alpha.md 与 07-final-best-plan-beta.md）以及真实源码，全面重塑与就地更新详案 02：
📁 独占责任目标文件：c:\Software\conex\docs\file-tree-and-attachments-architecture\detailed-plans\02-tree-navigation-spec.md

【前置必读的权威落地资产与真实源码】
- 权威方案 Alpha：docs/file-tree-and-attachments-architecture/independent-plans/06-final-best-plan-alpha.md（重点研读：§2.3 异常回写、§3.4 深度 32 熔断防环、§6.3 useFileNavigation.ts 全量生产代码、§7.2 单测）；
- 权威方案 Beta：docs/file-tree-and-attachments-architecture/independent-plans/07-final-best-plan-beta.md（重点研读：§2.3 静默吞咽根治、§3.4 防环集合、§6.3 状态机实现）；
- 真实物理源码：
  * apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts（核验真实 Hook 签名、状态定义、L18/L48/L82-88 cwd 相关历史残留）
  * apps/crish-desktop/src/components/files/hooks/__tests__/useFileNavigation.test.tsx
  * apps/crish-desktop/src/api/projectStore.ts（核验 getWorkspacePath 权威源）

【02-tree-navigation-spec.md 具体重构与重塑规范（必须逐一达成）】
1. 严格独占文件白名单锁定：apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts 与 apps/crish-desktop/src/components/files/hooks/__tests__/useFileNavigation.test.tsx，严禁触碰白名单外任何文件；
2. 单轨模型物理收敛：树根永久锁定在 getWorkspacePath()。从 Hook 状态定义、内部逻辑与返回值对象中彻底物理删除 cwd、setCwd、goUp 与 refresh(_ignoredDir?: string) 伪参数，严禁保留 @deprecated cwd 等任何兼容 Shim；
3. 根除核心异常静默吞咽（CRIT-03）：重构 revealPath 中的 Promise.allSettled。严禁直接忽略 rejected 目录！必须显式聚合所有失败条目的 reason 字符串，调用 setError(`部分祖先目录无法读取: ${errors.join('; ')}`) 并在 UI 暴露黄色/红色内联警示条；若全部祖先拉取均失败，严格返回 false 宣告定位失败；
4. 平铺虚拟树熔断与防环（MIN-04）：重写 flatTree 中的 walk 递归遍历：
   - 维护 visitedPaths = new Set<string>() 集合，递归进入前记录规范化路径，退出时删除，防范软链接/Junction 环形递归；
   - 注入硬熔断上限 if (depth > 32) return;，彻底防御超深目录导致的调用栈溢出（RangeError: Maximum call stack size exceeded）；
5. 完整生产代码骨架：给出 useFileNavigation.ts 完整无留白 AST 生产代码（包含 root, entries, expanded, loading, error, filter, filterMode, gitStatusMap, loadDir, refresh, toggleExpand, revealPath, setFilter, setFilterMode, setError, setExpanded, setEntries, setLoading, flatTree, isDirty, confirmNavigation, confirmGateView，零 // ... 省略）；
6. 给出配套单测用例与 NEG-01 刚性断言：expect((nav as any).cwd).toBeUndefined()；
7. 形式规范：全文展开为 10 节标准模板（物理删除对照表、类型签名、完整源码骨架、状态转移拓扑、负向约束、测试套件），零 // ... 省略。

【执行纪律与格式红线】
1. 只能使用系统内置工具（view_file, write_to_file），绝对严禁使用任何脚本批量替换！
2. 纯逻辑规划，不谈工期、人天、P0/P1，所有问题逻辑同权；
3. 写文件 UTF-8 无 BOM，严禁执行 git commit；
4. 完成后向主控汇报文档的就地更新行数与核心校准指标。
```

---

## 八、Agent 4：SPEC-03 虚拟列表视口与停泊详案专家提示词（责任文档：`detailed-plans/03-tree-virtual-scroll-spec.md`）

```markdown
你是一名资深前端渲染与视口架构专家。当前任务是作为【SPEC-03 目录树虚拟滚动几何居中与平滑停泊详细施工规范专家】，依据前面已校准验证的权威方案（06-final-best-plan-alpha.md 与 07-final-best-plan-beta.md）以及真实源码，全面重塑与就地更新详案 03：
📁 独占责任目标文件：c:\Software\conex\docs\file-tree-and-attachments-architecture\detailed-plans\03-tree-virtual-scroll-spec.md

【前置必读的权威落地资产与真实源码】
- 权威方案 Alpha：docs/file-tree-and-attachments-architecture/independent-plans/06-final-best-plan-alpha.md（重点研读：§2.4 scrollend 原生停泊、§3.2 翡翠绿脉冲、§3.5 矮视口死锁消除、§6.4 FileTreeView.tsx 生产代码、§7.2 单测适配）；
- 权威方案 Beta：docs/file-tree-and-attachments-architecture/independent-plans/07-final-best-plan-beta.md（重点研读：§2.4 视口停泊分析、§3.5 矮视口代数证明、§6.4 视口实现）；
- 真实物理源码：
  * apps/crish-desktop/src/components/files/FileTreeView.tsx（核验真实 Props、DOM 结构、styles 引用）
  * apps/crish-desktop/src/components/files/FileTreeView.test.tsx（真实物理路径在 files/ 根目录下，非 __tests__/）
  * apps/crish-desktop/src/hooks/useVirtualScroll.ts（核验真实入参 fallbackHeight 与闭区间切片特性）
  * apps/crish-desktop/src/styles/z-index.css（核验 --z-sticky: var(--z-dock) 真实 Token）

【03-tree-virtual-scroll-spec.md 具体重构与重塑规范（必须逐一达成）】
1. 严格独占文件白名单锁定：apps/crish-desktop/src/components/files/FileTreeView.tsx 与 apps/crish-desktop/src/components/files/FileTreeView.test.tsx，严禁触碰白名单外任何文件；
2. 纠正真实代码事实：
   - useVirtualScroll 真实入参为 fallbackHeight: ITEM_HEIGHT，真实返回切片范围 [startIndex, endIndex] 为闭区间，渲染切片必须严格为 flatTree.slice(startIndex, endIndex + 1)，否则视口底端条目将被截断；
   - 纠正单测真实物理路径为 apps/crish-desktop/src/components/files/FileTreeView.test.tsx（直接在 files/ 根下，非 __tests__/）；
3. 原生停泊与焦点守护（CRIT-04）：废除 200ms 硬编码魔术数字补偿！采用 W3C 原生 scrollend 事件驱动停泊确认：
   - 在 containerRef.current 上监听 scrollend 事件（{ once: true }），平滑滚动停止后通过 requestAnimationFrame 触发 focusTreeRow 与 1.4s 呼吸高亮；
   - 配合 350ms 优雅降级兜底定时器（window.setTimeout），在旧环境或无滚动场景下安全停泊，时序竞争彻底归零；
4. 矮视口死锁消除（MIN-05）：自适应缓冲公式消除视口 < 56px 时的舒适区负区间死锁，自适应将 padding 设为 0，数学上永不出现区间倒置；
5. 纠正虚构 Token 与样式：内联错误条 z-index 纠偏为系统权威 Token var(--z-sticky, 10)，彻底清除不存在的 --z-pinned-bar；脉冲高亮关键帧动画全域收敛为翡翠绿 hsl(160 84% 36%)；
6. 给出 FileTreeView.tsx 100% 完整展开的 TypeScript 生产代码，以及单测存量 7 大用例适配与负向断言代码（断言 props.cwd 未定义、断言 z-index 为正典变量）；
7. 形式规范：全文展开为 10 节标准模板（代数居中公式、停泊事件时序、极值证明、完整源码、测试套件），零 // ... 省略。

【执行纪律与格式红线】
1. 只能使用系统内置工具（view_file, write_to_file），绝对严禁使用任何脚本批量替换！
2. 纯逻辑规划，不谈工期、人天、P0/P1，所有问题逻辑同权；
3. 写文件 UTF-8 无 BOM，严禁执行 git commit；
4. 完成后向主控汇报文档的就地更新行数与核心校准指标。
```

---

## 九、Agent 5：SPEC-04 宿主单轨与面包屑详案专家提示词（责任文档：`detailed-plans/04-files-card-and-breadcrumb-spec.md`）

```markdown
你是一名资深前端宿主与层叠隔离架构专家。当前任务是作为【SPEC-04 宿主单轨收敛、防穿透隔离舱与面包屑详细施工规范专家】，依据前面已校准验证的权威方案（06-final-best-plan-alpha.md 与 07-final-best-plan-beta.md）以及真实源码，全面重塑与就地更新详案 04：
📁 独占责任目标文件：c:\Software\conex\docs\file-tree-and-attachments-architecture\detailed-plans\04-files-card-and-breadcrumb-spec.md

【前置必读的权威落地资产与真实源码】
- 权威方案 Alpha：docs/file-tree-and-attachments-architecture/independent-plans/06-final-best-plan-alpha.md（重点研读：§2.5 单测清洗、§2.6 FilesCard 死锁、§3.3 裸色清洗、§4 隔离舱证明、§6.5 FilesCard、§6.6 FileBreadcrumb、§6.7 FileActions、§6.11 样式、§7.1 单测）；
- 权威方案 Beta：docs/file-tree-and-attachments-architecture/independent-plans/07-final-best-plan-beta.md（重点研读：§2.5、§2.6、§4.3 W3C 隔离舱防穿透偏序证明、§6.5、§6.6、§6.12 样式、§7.2 单测）；
- 真实物理源码：
  * apps/crish-desktop/src/components/files/FilesCard.tsx（核验真实行号 L316/L391/L468 cwd 传参、L290-300 顶栏按钮）
  * apps/crish-desktop/src/components/files/FileBreadcrumb.tsx
  * apps/crish-desktop/src/components/files/FileActions.tsx
  * apps/crish-desktop/src/components/files/FilesCard.module.css
  * apps/crish-desktop/src/components/files/__tests__/FileBreadcrumb.test.tsx（存量 13 处 cwd 传参现场）

【04-files-card-and-breadcrumb-spec.md 具体重构与重塑规范（必须逐一达成）】
1. 严格独占文件白名单锁定：FilesCard.tsx, FileBreadcrumb.tsx, FileActions.tsx, FilesCard.module.css, FileBreadcrumb.test.tsx，严禁触碰白名单外任何文件；
2. 宿主全面清除 cwd 死锁（CRIT-06）：
   - 精准切除 FilesCard.tsx 中 L316 面包屑 cwd 传参、L391 动作栏 cwd 传参、L468 树视图 cwd 传参；
   - L190 复制路径与 L227 项目切换收敛至 nav.root；
   - 彻底物理切除 L290-300 顶栏“上级目录 ↰”按钮（删除 handleGoUp、PARENT_DIR_LABEL、CornerLeftUp 图标），双击文件夹严格收敛为 toggleExpand；
3. 面包屑维持现状树逻辑：
   - FileBreadcrumbProps 彻底切除 cwd 属性声明；
   - 单轨面包屑推导仅依赖 root 与 selected，有选中项时自底向上推导路径段，无选中项时恒定展示 root 根芯片；
   - 严格遵从用户最高裁决：面包屑下拉浮层内部树遍历与展开逻辑（openBcFlyout, toggleFlyoutDir, loadDirContents, dirCache）维持现状严禁重构；
4. 存量单测编译断裂消除（CRIT-05）：FileBreadcrumb.test.tsx 存量 13 处 <FileBreadcrumb cwd="..." /> 传参彻底无损清洗，并在测试末尾追加 NEG-01 刚性负向断言；
5. FileActions.tsx 契约切除：从 FileActionsProps 切除 cwd 属性，内部目标路径收敛为 selected || root || null；
6. W3C 原生防穿透隔离舱与裸色清洗（MIN-03）：
   - 在 FilesCard.module.css 中为 .filesBody 注入 position: relative; isolation: isolate; z-index: var(--z-base, 0);，在局部渲染树建立独立层叠上下文，将 .filesSplitResizer（z-index: 1）100% 封印在底座内，绝对不穿透常态顶栏（z-index: 10）与下拉浮层（z-index: 400）；
   - 清洗存量 L8, L46, L275, L290, L542, L554 等 6 处裸 Hex #ffffff 为 hsl(0 0% 100%)；
7. 给出 FilesCard.tsx 核心重构代码段、FileBreadcrumb.tsx（全量 490+ 行）、FileActions.tsx（全量 330+ 行）、FilesCard.module.css 与 FileBreadcrumb.test.tsx 100% 完整展开的生产代码；
8. 形式规范：全文展开为 10 节标准模板，零 // ... 省略。

【执行纪律与格式红线】
1. 只能使用系统内置工具（view_file, write_to_file），绝对严禁使用任何脚本批量替换！
2. 纯逻辑规划，不谈工期、人天、P0/P1，所有问题逻辑同权；
3. 写文件 UTF-8 无 BOM，严禁执行 git commit；
4. 完成后向主控汇报文档的就地更新行数与核心校准指标。
```

---

## 十、Agent 6：SPEC-05 消息气泡附件详案专家提示词（责任文档：`detailed-plans/05-message-attachment-spec.md`）

```markdown
你是一名资深前端 UI 架构师与消息流组件专家。当前任务是作为【SPEC-05 消息气泡附件 58×58 卡片与独立横排布局详细施工规范专家】，依据前面已校准验证的权威方案（06-final-best-plan-alpha.md 与 07-final-best-plan-beta.md）以及真实源码，全面重塑与就地更新详案 05：
📁 独占责任目标文件：c:\Software\conex\docs\file-tree-and-attachments-architecture\detailed-plans\05-message-attachment-spec.md

【前置必读的权威落地资产与真实源码】
- 权威方案 Alpha：docs/file-tree-and-attachments-architecture/independent-plans/06-final-best-plan-alpha.md（重点研读：§2.1 广播解耦、§2.7 百分比坍塌消除、§3.1 冒泡拦截、§6.1 filePanelOpener、§6.8 AttachmentCard、§6.9 ChatUserMessageRow、§6.10 样式切除、§7.3 气泡单测）；
- 权威方案 Beta：docs/file-tree-and-attachments-architecture/independent-plans/07-final-best-plan-beta.md（重点研读：§2.1、§2.7 盒模型推导、§6.1、§6.7 AttachmentCard、§6.8 卡片样式、§6.9 真实 Props 适配、§6.10 样式切除、§7.2 负向断言）；
- 真实物理源码与资产：
  * apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx（核验真实 ChatUserMessageRowProps 与 2 参数 displayText）
  * apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css（核验 L116-176 待删除 61 行旧类）
  * apps/crish-desktop/src/api/filePanelOpener.ts（核验 L113-124 广播截断位置）
  * apps/crish-desktop/src/styles/tokens.css（核验 58×58 卡片 Token 与翡翠绿）
  * media_1788837641997.png（用户上传的最终气泡卡片视觉参考基准）

【05-message-attachment-spec.md 具体重构与重塑规范（必须逐一达成）】
1. 严格独占文件白名单锁定：
   - apps/crish-desktop/src/components/chat-attachment/AttachmentCard.tsx（新建）
   - apps/crish-desktop/src/components/chat-attachment/AttachmentCard.module.css（新建）
   - apps/crish-desktop/src/components/chat-attachment/index.ts（新建）
   - apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx
   - apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
   - apps/crish-desktop/src/api/filePanelOpener.ts
   - apps/crish-desktop/src/components/chat-message-row/__tests__/ChatUserMessageRow.test.tsx
   严禁触碰白名单外任何文件；
2. 严格落实用户视觉参考图 media_1788837641997.png 布局重塑：
   - 结构彻底解耦：上方为独立的 58×58 方形实体卡片横向自适应流（.userAttachmentStrip），下方为独立的半圆角文本气泡（.userBubble）；
   - 消除百分比几何坍塌（CRIT-07）：父级 .userStack 已有限制，.userAttachmentStrip 宽度约束必须收敛为 width: 100%; max-width: 100%; box-sizing: border-box;，杜绝复合折算为 49.3% 导致的挤压提前换行；
   - 空气泡彻底物理销毁（NEG-06）：当纯发附件无文本内容（!displayText && msg.status !== 'queued'）时，.userBubble 在 DOM 中严格彻底销毁为 null，杜绝渲染空背景、空边距的幽灵气泡盒；
3. 物理切除死亡代码：彻底删除 ChatMessageRow.module.css:116-176 共 61 行废弃旧类（.userImages, .userImageWrapper, .userImage, .userAttachments, .userAttachmentChip, .userAttachmentChip:hover, .userAttachmentName），严禁在气泡内保留旧药丸样式；
4. 冒泡拦截（MIN-01）：在 AttachmentCard 的 handleClick 与 handleKeyDown 首行显式执行 e.stopPropagation()，阻止点击卡片冒泡穿透触发外层长气泡的展开/收缩跳跃；
5. 广播解耦（CRIT-01）：重塑 filePanelOpener.ts。真实代码核验表明代码文件会直接进入 file-viewer 并提前 return，导致广播被截断。重构要求：在 resolveWorkspacePath 安全校验后，无论目标分流至 file-viewer 还是 files，无条件第一优先级设置 pendingOpenPath = path 并向 window 派发 crish-open-file 事件，彻底打通调用链；
6. 对齐真实源码签名：严格适配 ChatUserMessageRowProps（包含 msg: SessionMessage, isPinned, isSearchHit, isExpanded, onToggleExpand, onTogglePin, isLastUser, onRetract, messageIndex, virtualScrollManager, onOpenPath），userBubbleDisplayText 严格采用 2 参数 (msg.text, isExpanded)，保留 virtualScrollManager?.invalidateActual(msg.id) 联动；
7. 给出 AttachmentCard.tsx, AttachmentCard.module.css, index.ts, ChatUserMessageRow.tsx, ChatMessageRow.module.css, filePanelOpener.ts 与单测（含 NEG-02/03/06 刚性负向断言）100% 完整展开的生产代码；
8. 形式规范：全文展开为 10 节标准模板，零 // ... 省略。

【执行纪律与格式红线】
1. 只能使用系统内置工具（view_file, write_to_file），绝对严禁使用任何脚本批量替换！
2. 纯逻辑规划，不谈工期、人天、P0/P1，所有问题逻辑同权；
3. 写文件 UTF-8 无 BOM，严禁执行 git commit；
4. 完成后向主控汇报文档的就地更新行数与核心校准指标。
```
