# 多 Agent 独立竞技方案编制任务任务书（Task Specification Prompt）

> **文档标识**：`docs/file-tree-and-attachments-architecture/independent-plans/00-competing-task-prompt.md`
> **任务目标**：根据两份深度审计报告（`06` 与 `07`）挑出的所有致命缺陷与深层隐患，独立制定出**最系统、最彻底、无任何妥协与兼容 Shim 的端到端重构最佳方案（Best Comprehensive Implementation Plan）**。
> **审查与竞技机制**：两个受派子 Agent 将根据本任务书独立开展全量推导与方案设计，主控 Agent 将对两份产出进行多维深度评比与优劣合流。

---

## 一、授权查阅文档白名单（严禁越界查阅未授权文件）

为保障方案设计的纯粹性与专注度，受派 Agent **严格且仅限查阅**以下白名单内的文档与源码，未列出的文件一律禁止查阅：

### 1. 核心审计报告输入（挑刺基准）
- [`docs/file-tree-and-attachments-architecture/audits/06-e2e-connectivity-and-protocols-audit.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/audits/06-e2e-connectivity-and-protocols-audit.md)（端到端伪连通、幽灵契约与真实调用流深度审计，1856 行）
- [`docs/file-tree-and-attachments-architecture/audits/07-ssot-purge-boxmodel-and-evidence-audit.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/audits/07-ssot-purge-boxmodel-and-evidence-audit.md)（SSOT 单轨纯度、物理切除彻底性、盒模型与五大物证体系审计，1291 行）

### 2. 当前战役基线方案
- [`docs/file-tree-and-attachments-architecture/00-master-plan.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/00-master-plan.md)
- `docs/file-tree-and-attachments-architecture/detailed-plans/01-path-canonical-spec.md` 至 `05-message-attachment-spec.md`

### 3. 真实物理源码与样式（现场事实依据）
- `apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx`
- `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`
- `apps/crish-desktop/src/api/filePanelOpener.ts`
- `apps/crish-desktop/src/components/files/FilesCard.tsx`
- `apps/crish-desktop/src/components/files/FileBreadcrumb.tsx`
- `apps/crish-desktop/src/components/files/FileTreeView.tsx`
- `apps/crish-desktop/src/components/files/FilesCard.module.css`
- `apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts`
- `apps/crish-desktop/src/api/workspaceFsApi.ts`
- `apps/crish-desktop/src/styles/tokens.css`
- `apps/crish-desktop/src/styles/z-index.css`
- `apps/agent-workbench/src-tauri/src/fs_commands/mod.rs`
- `apps/agent-workbench/src-tauri/src/main.rs`

---

## 二、必须彻底攻克并根除的核心问题清单

你的方案必须正面击穿并彻底解决以下所有致命隐患与细节缺陷，给出完整的 AST 级代码修复方案与时序闭环证明：

### 1. 七大架构级致命问题（Critical Big Issues）
1. **[CRIT-01] 消除 `filePanelOpener.ts` 的核弹级伪连通拦截**：
   - 现存 Bug：L114-117 当 `host === 'file-viewer'` 时直接 return，导致点击任何代码文件（`.ts`, `.rs`, `.py` 等）附件时，全局事件 `crish-open-file` 被截断，左侧主目录树级联展开、视口居中与脉冲高亮 100% 瘫痪；
   - 方案要求：重塑打开时序，无论右侧打开何种编辑器，必须确保无条件派发或同步触发目录树的定位广播，彻底打通调用链。
2. **[CRIT-02] 消除 `workspaceFsApi.ts` 与 Rust IPC 的幽灵契约参数**：
   - 现存 Bug：前端透传 `{ path, workspaceRoot }`，而底层 Rust 注册表 `fs_commands/mod.rs:30` 的 `workbench_list_directory` 仅接收 `(app, path)`；
   - 方案要求：精准纠偏前端调用签名与参数结构，确保跨层通信与底层主注册表严格 1:1 对齐。
3. **[CRIT-03] 消除 `useFileNavigation.ts` 并发补拉时的核心异常静默吞咽**：
   - 现存 Bug：`Promise.allSettled` 中直接忽略了所有 `rejected` 祖先目录，既不记录错误原因也不向 `nav.error` 回写错误；
   - 方案要求：建立严密的异常分类处理链路，真实 I/O 故障向状态机写回错误并由视图层展示内联提示，杜绝截肢式容错。
4. **[CRIT-04] 消除虚拟列表平滑滚动与焦点转移的时序竞争断层**：
   - 现存 Bug：平滑滚动需 200~400ms，而 rAF 在 16ms 执行焦点转移时目标行尚未进入虚拟 DOM（`visibleRange`），导致 `querySelector` 返回 null，焦点转移 100% 失败且脉冲提早熄灭；
   - 方案要求：设计基于视口状态、滚动停泊检测（`scrollend` / 动态重试）的确定性焦点与高亮挂载机制。
5. **[CRIT-05] 消除 `FileBreadcrumb.test.tsx` 中 13 处硬传参导致的编译雪崩**：
   - 现存 Bug：既有单测中存留 13 处 `<FileBreadcrumb cwd="..." />`，若直接从 `FileBreadcrumbProps` 切除 `cwd`，既有测试将全线编译暴毙；
   - 方案要求：方案必须明确包含对这 13 处存量测试的无损清理，同时追加负向断言。
6. **[CRIT-06] 消除 `FilesCard.tsx` 中隐藏的 3 处存量 `cwd` 引用死锁**：
   - 现存 Bug：L190（`handleCopyPath`）、L227（`onProject`）、L391（`FileActions` 传参）未规划清理；
   - 方案要求：彻底将这 3 处收敛为 `nav.root`，全域切除 `cwd`。
7. **[CRIT-07] 消除 `.userAttachmentStrip` 百分比复合折算几何坍塌**：
   - 现存 Bug：声明了 `max-width: min(70.2%, 560px)`，因父级 `.userStack` 已有限制，复合折算后实际宽度萎缩至 49.3%，卡片过早挤压换行；
   - 方案要求：修正为 `max-width: 100%`，自适应撑满父级网格。

### 2. 五大细节缺陷（Minor Issues）
1. **[MIN-01] 拦截 `AttachmentCard.tsx` 点击事件冒泡**：添加 `e.stopPropagation()`，防止触发长气泡的展开/折叠状态跳变；
2. **[MIN-02] 纠正主题色冲突**：将脉冲高亮与边框回退色从经典蓝 `hsl(215 90% 52%)` 统一纠偏为系统翡翠绿 `hsl(160 84% 36%)`；
3. **[MIN-03] 清洗存量裸 Hex**：对 `FilesCard.module.css` 中的 6 处 `#ffffff` 彻底替换为 `hsl(0 0% 100%)` 或对应 Token；
4. **[MIN-04] `walk` 递归深度熔断**：为平铺虚拟树的递归遍历加入符号链接防环与深度上限熔断（`MAX_DEPTH = 32`）；
5. **[MIN-05] 矮视口死锁消除**：修复视口高度 $< 56\text{px}$ 时居中缓冲公式区间倒置的问题。

---

## 三、必须坚守的四大严禁负向红线（零容忍）

1. **严禁功能伪连通**：禁止仅写纯函数或空转组件却未在真实宿主调用链中生效；严禁真实调用处传递 Default/None/空配置；严禁出现带有 `#[allow(dead_code)]` 或零调用的死快照；
2. **严禁多轨并存与给旧岛续命**：单一概念收敛至唯一权威源（SSOT）。严禁将新数据倒灌回旧介质；重构必须是物理切除，严禁使用注释、隐藏或永久性兼容 Shim（严禁保留 `@deprecated cwd?: string` 或 `cwd: _cwd`）；
3. **严禁幽灵契约与截肢式降级**：跨层通信必须与底层主注册表 1:1 对齐，严禁调用未注册命令；严禁破坏性容错回退，严禁静默吞咽核心异常；
4. **严禁虚构 Token 与样式欺骗**：UI 必须 100% 遵从 Design Tokens，严禁发明不存在的伪变量（如 `var(--z-pinned-bar)`），严禁裸 Hex；必须穿透检查祖先盒模型与 Stacking Context。

---

## 四、必须建立的五大闭环客观交付物证

方案必须给出具体的全链路物证验收规范，杜绝仅凭“单测全绿”或“类型无报错”宣告完成：
1. **触发端物证**：卡片点击真实触发，安全路径准确提取，广播事件真实发出；
2. **传输端物证**：IPC 调用日志真实记录 `workbench_list_directory` 命令与出入参，零未注册命令；
3. **介质端物证**：工作区根永久锚定，`useFileNavigation` 内零 `cwd` 变量，`expanded` 字典键 100% 规范化；
4. **消费端物证**：目录树祖先真实在 DOM 挂载展开，虚拟滚动真实停泊在居中坐标，1.4s 呼吸动效真实播放，纯附件消息下方空气泡在 DOM 中彻底为 null；
5. **负向断言物证**：测试中必须包含 6 项刚性负向断言（`cwd` 不存在、旧药丸不存在、旧大图不存在、旧搜索容器不存在、原生 search 属性不存在、空气泡不存在）。

---

## 五、方案输出要求与纪律规范

1. **纯逻辑依赖拓扑**：方案仅包含纯逻辑执行顺序与依赖拓扑，不涉及时间工期、人员分配或优先级排序（所有列出的问题逻辑同权）；
2. **零留白 AST 级代码**：关键模块（`filePanelOpener.ts`、`useFileNavigation.ts`、`FileTreeView.tsx`、`FilesCard.tsx`、`FileBreadcrumb.tsx`、`AttachmentCard.tsx`、`ChatUserMessageRow.tsx`）必须给出完整的 TypeScript / CSS 代码骨架，严禁使用 `// ...` 等任何占位符；
3. **输出篇幅充足**：必须系统、完整、全面展开，包含严密的架构推导、时序图、盒模型分析与完整测试套件；
4. **编码与环境**：UTF-8 无 BOM，纯中文技术注释；严禁执行 git commit。
