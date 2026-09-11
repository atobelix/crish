# 阶段三方案合理性严格审计报告：SSOT 纯度与反过度设计红线专题审计

> **文档标识**：`docs/file-tree-and-attachments-architecture/audits/01-ssot-and-guardrails-audit.md`
> **所属战役**：`docs/file-tree-and-attachments-architecture/`（阶段三：方案合理性严格审计）
> **审查对象**：阶段二编制的 5 份详细设计施工任务书（`detailed-plans/01-path-canonical-spec.md` ~ `05-message-attachment-spec.md`）
> **审计依据**：仓库根目录 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)、[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md)（§1 反退避、§7 严禁补丁与作弊、§7.1 立体验证纪律、§8 反过度设计红线、§11 CI 治理、§12 自定义 Tooltip、§13 输入框焦点态规范、§14 现代 CSS 语法规范）及战役审计大纲 [`analysis/05-audit-framework-strategy.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/analysis/05-audit-framework-strategy.md)。
> **审查专家**：资深系统架构师与反过度设计审查专家（Senior System Architecture & Anti-Overengineering Audit Expert）
> **审查属性**：纯逻辑工程审计（不谈工期、人天、人员偏见，问题同权，以源码真理源与数学不变量为裁判准绳）。
> **Git 状态**：严格遵守提交纪律，纯净留存工作区，严禁执行 `git commit`。

---

## 目录

- [一、审计背景与审查体系概述](#一审计背景与审查体系概述)
- [二、专题一：单一真理源（SSOT）纯度深度审计](#二专题一单一真理源ssot纯度深度审计)
  - [2.1 主目录树根节点永久锚定审查（Root Immutability）](#21-主目录树根节点永久锚定审查root-immutability)
  - [2.2 钻取游标 `cwd` 状态消灭彻底性审查](#22-钻取游标-cwd-状态消灭彻底性审查)
  - [2.3 展开字典键空间 100% 规范化收敛审查](#23-展开字典键空间-100-规范化收敛审查)
  - [2.4 消息附件与输入框附件协议统一性审查](#24-消息附件与输入框附件协议统一性审查)
- [三、专题二：反过度设计 13 项硬性红线逐项穿透核验](#三专题二反过度设计-13-项硬性红线逐项穿透核验)
  - [3.1 13 项禁令逐项对照排查矩阵](#31-13-项禁令逐项对照排查矩阵)
  - [3.2 全局状态与就地内聚（State Colocation）审查](#32-全局状态与就地内聚state-colocation审查)
  - [3.3 外部依赖与自造轮子审查（零 npm 依赖红线）](#33-外部依赖与自造轮子审查零-npm-依赖红线)
  - [3.4 架构分层与同进程调用关系审查（零伪 Facade 套娃）](#34-架构分层与同进程调用关系审查零伪-facade-套娃)
- [四、专题三：空间文件白名单绝对互斥性数学证明](#四专题三空间文件白名单绝对互斥性数学证明)
  - [4.1 5 份任务书写权限物理文件全景清单](#41-5-份任务书写权限物理文件全景清单)
  - [4.2 两两交集为空（Mutual Exclusivity）数学检验](#42-两两交集为空mutual-exclusivity数学检验)
- [五、专家深度挑刺：设计缺陷与冲突项清单（Defect Log）](#五专家深度挑刺设计缺陷与冲突项清单defect-log)
  - [5.1 [DEFECT-01 / HB-16 违规] Spec-01 盘符大写化与审计准则小写化冲突](#51-defect-01--hb-16-违规-spec-01-盘符大写化与审计准则小写化冲突)
  - [5.2 [DEFECT-02 / HB-10 隐患] Spec-03/04 CSS fallback 中残留硬编码裸 Hex 颜色](#52-defect-02--hb-10-隐患-spec-0304-css-fallback-中残留硬编码裸-hex-颜色)
  - [5.3 [DEFECT-03 / 契约断裂] Spec-04 FilesCard 顶栏骨架残留向 FileBreadcrumb 传递 `cwd={nav.cwd}`](#53-defect-03--契约断裂-spec-04-filescard-顶栏骨架残留向-filebreadcrumb-传递-cwdnavcwd)
  - [5.4 [DEFECT-04 / 视口防御] Spec-03 虚拟树首屏容器尺寸未就绪时的几何居中防卫缺陷](#54-defect-04--视口防御-spec-03-虚拟树首屏容器尺寸未就绪时的几何居中防卫缺陷)
- [六、六维立体定量打分卡与审计裁决结论](#六六维立体定量打分卡与审计裁决结论)
  - [6.1 六维立体定量审核打分卡](#61-六维立体定量审核打分卡)
  - [6.2 一票否决项（Hard Blockers）扫描核验表](#62-一票否决项hard-blockers扫描核验表)
  - [6.3 最终审计结论与整改放行判定](#63-最终审计结论与整改放行判定)
- [七、执行期整改指导令与无缝修复补丁代码（Drop-in Fixes）](#七执行期整改指导令与无缝修复补丁代码drop-in-fixes)

---

## 一、审计背景与审查体系概述

依据 Conex 战役治理纪律与用户战略裁决：“方案详细文档生成完后，还要做严格的方案合理性审计才行！严禁不经严格审查就匆忙执行。”阶段二已编制完成 5 份详细设计施工任务书（`detailed-plans/01-path-canonical-spec.md` 至 `05-message-attachment-spec.md`）。

本专题审计作为阶段三（方案合理性严格审计）的首发核心专项，聚焦于**单一真理源（SSOT）纯度**、**反过度设计 13 项硬性红线**、**空间文件域独占性**及**接口契约严密性**。审计专家以代码指纹拉网匹配、AST 级代码骨架推演、状态机状态迁移方程推演及跨规范接口双向校验为手段，开展毫不留情的穿透式“挑刺”与逻辑审判。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        阶段三：方案合理性严格审计拓扑 (Audit Topology)                  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  [输入图纸 1~5] ──────────────────────────────────────────────────────────────────┐   │
│  ├─ 01-path-canonical-spec.md        (路径规范化内核与 SSOT 契约)                 │   │
│  ├─ 02-tree-navigation-spec.md      (单轨收敛与祖先并发展开 Hook)                 │   │
│  ├─ 03-tree-virtual-scroll-spec.md    (虚拟滚动平滑居中与 1.4s 呼吸高亮)          │   │
│  ├─ 04-files-card-and-breadcrumb-spec.md (宿主收敛、隔离舱与发丝搜索框)           │   │
│  └─ 05-message-attachment-spec.md   (58×58 卡片上方横排与空气泡彻底销毁)          │   │
│                                                                                    ▼   │
│  [审查依据] ───────────────► [资深系统架构师与反过度设计审查专家] ◄─────► [红蓝对抗质询] │
│  ├─ ANTI_OVERENGINEERING_GUARDRAILS.md (13项禁令)                                 │   │
│  ├─ AGENTS.md 全局协作纪律 (§1, §7, §8, §11~14)                                    │   │
│  └─ 05-audit-framework-strategy.md (18 项一票否决矩阵 HB-01 ~ HB-18)              │   │
│                                           │                                            │
│                                           ▼                                            │
│                     [输出: 01-ssot-and-guardrails-audit.md]                            │
│                     ├─ SSOT 纯度全链路定性定量审查                                      │
│                     ├─ 13 项反过度设计红线逐项断言                                     │
│                     ├─ 15 物理文件互斥性数学证明                                       │
│                     ├─ 4 项致命缺陷与隐患深层挑刺 (DEFECT-01 ~ 04)                     │
│                     └─ 终审打分卡 (92/100) 与条件性修订放行判定 (CONDITIONAL FAIL)     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、专题一：单一真理源（SSOT）纯度深度审计

### 2.1 主目录树根节点永久锚定审查（Root Immutability）

- **真理源设计断言**：主文件树根节点必须在运行时任何时刻绝对锁定在当前打开的工作区根目录（`root = getWorkspacePath()`），严禁任何下钻、双击或外部调用篡改树根。
- **源码级穿透核验**：
  1. **Spec-02 (`useFileNavigation.ts`) 审查**：
     - 在 L149 中声明：`const [root, setRoot] = useState(() => getWorkspacePath());`，直接绑定工作区单一真理源。
     - 在 L172-202 的 `refresh` 方法中，入参签名显式重构为 `_ignoredDir?: string`。无论上游历史代码传入任何子目录路径，内部强制执行 `const r = getWorkspacePath(); setRoot(r); const rootPath = resolveWorkspacePath(r || '');`，根源上杜绝了外部通过参数注入篡改树根的通道。
     - 在 L236-316 的 `revealPath` 方法中，各级祖先目录仅作为键值注入 `expanded` 展开字典，`root` 状态恒定不动。
  2. **Spec-04 (`FilesCard.tsx`) 审查**：
     - 在 L124-137 中，`handleFileDoubleClick` 原先调用带路径下钻刷新语义的 `handleRefresh(path)` 被**彻底物理删除**，重塑为纯粹的 `void nav.toggleExpand(path, ...)`，双击行为已收敛为原地展开/折叠。
     - 在 L143-156 中，顶栏工具条的“上级目录”按钮及关联的 `handleGoUp` 回调已被**彻底物理切除**，移除了通过 UI 回退根目录的历史操作通道。
- **审查结论**：**【PASS 合规】**。树根不可变性（Root Immutability）在状态机和 UI 交互两端实现了代数级锁定。

---

### 2.2 钻取游标 `cwd` 状态消灭彻底性审查

- **真理源设计断言**：`useFileNavigation` 与主文件卡片必须彻底拔除 `cwd` 状态及其派生的修改器，消除双轨游标导致的树状态撕裂。
- **源码级穿透核验**：
  1. **Spec-02 (`useFileNavigation.ts`) 审查**：
     - 对照 L414-430 的《物理删除行号与特征代码对照表》，原文件 L18 `const [cwd, setCwd] = useState(...)`、L48 `setCwd(path)`、L82-88 `goUp` 均被明确声明为物理删除。
     - 接口契约 `UseFileNavigationReturn`（L78-124）中，`cwd`、`setCwd`、`goUp` 均从类型签名中抹除。
     - 单元测试（L698-718）设置了针对 `hookReturn.cwd === undefined`、`hookReturn.setCwd === undefined`、`hookReturn.goUp === undefined` 的刚性负向断言。
  2. **Spec-04 (`FilesCard.tsx`) 审查**：
     - 常量 `PARENT_DIR_LABEL = '上级目录'`、图标 `CornerLeftUp` 导入、`handleGoUp` 函数均已物理切除。
- **审查结论**：**【PASS 合规】**。核心状态机内部彻底消灭了 `cwd` 状态，消除了双轨下钻的系统性根源。

---

### 2.3 展开字典键空间 100% 规范化收敛审查

- **真理源设计断言**：`expanded: Record<string, FsDirEntry[]>` 字典的键必须 100% 经过 `toCanonicalFsPath` 规范化，确保在 Windows 反斜杠、混合正斜杠、大小写异构环境下，读写键完全一致。
- **源码级穿透核验**：
  1. **写入端收敛性**：
     - `toggleExpand`（Spec-02 L208）：`const canonicalDirPath = toCanonicalFsPath(dirPath);`，写入与删除字典均使用 `canonicalDirPath`；
     - `revealPath`（Spec-02 L284-311）：待加载祖先目录数组 `toLoad` 来源于 `getAncestorDirPaths`（内部全量走 `toCanonicalFsPath`），并发拉取后写入字典 `results[res.value.dir] = res.value.items`，其中 `res.value.dir` 恒为规范化路径；
     - 条目属性规范化（Spec-02 L190、L224、L295）：所有条目的 `path` 字段在落盘至 `entries` 或 `expanded` 前，均经 `toCanonicalFsPath(it.path)` 预处理。
  2. **读取端收敛性**：
     - `flatTree` 计算（Spec-02 L337-338）：递归遍历时执行 `const canonicalPath = toCanonicalFsPath(e.path); if (e.isDir && expanded[canonicalPath])`，读取端施加绝对规范化拦截。
- **挑刺发现点（严重冲突预警）**：
  - 虽然字典存取两侧均经过了 `toCanonicalFsPath`，但 **Spec-01 中 `toCanonicalFsPath` 对 Windows 盘符的归一化方向（强制大写 `C:`）与审计规范准则 HB-16（强制小写 `c:`）发生了严重冲突**，详见本报告 §5.1。此冲突可能导致与系统中既有使用小写盘符的模块发生比对失配。
- **审查结论**：**【CONDITIONAL PASS / 需整改对齐】**。逻辑闭环已具备，但受盘符大小写定义冲突影响，需执行纠偏。

---

### 2.4 消息附件与输入框附件协议统一性审查

- **真理源设计断言**：消息历史流展示中的附件必须与输入框附件栏（`ComposerAttachmentBar`）消费同构的 `ChatAttachment` 元数据模型，彻底废除“图片走裸图画廊、非图片走灰色药丸”的双轨割裂。
- **源码级穿透核验**：
  1. **Spec-05 (`AttachmentCard.tsx` / `ChatUserMessageRow.tsx`) 审查**：
     - Spec-05 L128-143 定义了统一的数据传输对象 `AttachmentCardItem`，向下兼容 `path`、`name`、`mime`、`dataUrl`；
     - 在 `ChatUserMessageRow.tsx` 中设计了统一归一化纯函数 `normalizeMessageAttachments(msg)`（L346-390），将历史数据中混杂的 `msg.attachments` 与 `msg.images` 统一投影为 `AttachmentCardItem[]`，并以 `(path || name).trim().toLowerCase()` 进行指纹去重；
     - 渲染层统一采用 58×58 原子卡片 `<AttachmentCard>`，通过纯布尔判定 `isImageAttachmentItem(item)` 自动分流为“图片满幅 cover”或“彩色矢量图标 + 格式徽标 + 截断文件名”，不再在消息行内分叉两套独立的 DOM 树。
- **审查结论**：**【PASS 合规】**。数据模型与渲染协议实现了单一真理源归一。

---

## 三、专题二：反过度设计 13 项硬性红线逐项穿透核验

严格对照仓库根目录 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)，对 5 份任务书的架构决策进行逐项合规排查：

### 3.1 13 项禁令逐项对照排查矩阵

| 禁令编号 | 红线禁令核心条款 | 5 份详细规划任务书核验结论 | 源码证据与穿透依据 | 判定 |
| :--- | :--- | :--- | :--- | :---: |
| **禁令 1** | 严禁编写跨平台 OS 内核级沙盒 (Seatbelt/Seccomp/Cgroups) | **无触碰**。所有方案均为纯前端 TypeScript/CSS 模块及调用已有 Tauri IPC，未设计任何底层 C 绑定沙盒。 | `workspaceFsApi.ts` 沿用现有路径字符串校验，未引入原生 OS 钩子。 | ✅ PASS |
| **禁令 2** | 严禁编写 Rust 端无锁环形缓冲区 (`sab_ring_buffer`) 与极端零拷贝 | **无触碰**。方案不涉及底层大模型 Token 传输与二进制共享内存，纯文本与 UI 状态交互。 | 状态均采用标准 React 状态与不可变数组。 | ✅ PASS |
| **禁令 3** | 严禁单机桌面端引入分布式共识协议与两阶段提交 (2PC/Raft/Paxos) | **无触碰**。本地展开状态使用内存字典 `Record<string, FsDirEntry[]>`，零分布式算法。 | `useFileNavigation.ts:152` 标准 `useState` 本地内聚。 | ✅ PASS |
| **禁令 4** | 严禁后台自动切换模型 (废弃 `DynamicModelRouter`/`FallbackChain`) | **无触碰**。本战役属于目录树与附件卡片 UI/UX 重构，完全不涉及大模型路由链路。 | 任务书不包含任何大模型请求调度逻辑。 | ✅ PASS |
| **禁令 5** | 严禁出站请求前发起 DNS A/AAAA 异步解析与公有后缀检查 | **无触碰**。所有文件读取均指向本地文件系统与 Tauri IPC，零外部出站 HTTP 请求。 | 仅调用 `listDirectory` 与 `convertFileSrc`。 | ✅ PASS |
| **禁令 6** | 严禁在 LLM 请求链路中加入黑盒「Prompt 意图重写与动态拦截链」 | **无触碰**。不涉及用户输入与提示词管道。 | 方案范围限定在文件管理视图与消息行渲染。 | ✅ PASS |
| **禁令 7** | 注入上下文的一切链路可审计可追踪，保证单一真相源 (SSOT) | **严格遵从**。工作区路径统一以 `getWorkspacePath()` 为唯一权威源，附件打开经由 `openFileInPanel`。 | 附件卡片与树交互链路具备明确的事件与日志追踪。 | ✅ PASS |
| **禁令 8** | 多 Provider 凭据零残留与安全隔离 | **无触碰**。不涉及 API Key 与凭据处理。 | 零凭据接触。 | ✅ PASS |
| **禁令 9** | 严禁使用全系统滑动窗口断路器 (`CircuitBreaker`) | **无触碰**。没有设计全局滑动窗口熔断机制，目录加载失败通过组件级内联错误展示。 | `FileTreeView.tsx:320-344` 内联展示轻量错误。 | ✅ PASS |
| **禁令 10** | 严禁设计 Tool 执行的 6 阶段洋葱 Hook 链 (`MiddlewarePipeline`) | **严格遵从**。路径规范化与校验均设计为独立的同步/异步纯函数，杜绝洋葱中间件。 | `toCanonicalFsPath`、`isSameFsPath` 均为纯函数。 | ✅ PASS |
| **禁令 11** | 严禁同进程微服务套娃与 Tauri IPC 嵌套字符串路由 | **严格遵从**。前端组件直调 `workspaceFsApi` 导出的包装函数，直连 Tauri Command，零多层 Facade。 | 无 `fileRouterService`、无虚假代理层。 | ✅ PASS |
| **禁令 12** | 严禁高频流式状态穿透全局 Store 与盲目包裹 `React.memo` | **严格遵从**。状态就地内聚，`pulseTarget`、`expanded` 均限制在局部，精准对叶子组件应用 memo。 | `FileTreeView` 与 `AttachmentCard` 精准使用 `React.memo`。 | ✅ PASS |
| **禁令 13** | 严禁移动端全量 CRDT 状态向量下沉与无界同步 | **无触碰**。方案未引入 CRDT 协同算法，保持纯桌面端轻量交互。 | 展开与选中状态均为轻量单机运行时状态。 | ✅ PASS |

---

### 3.2 全局状态与就地内聚（State Colocation）审查

- **审查准则**：严禁随意创建未经架构委员会批准的全局 Zustand Store 或 React Context（如 `useTreeStore.ts`、`useBreadcrumbContext.tsx` 等）。状态必须严格遵从“就地内聚（Colocation）”原则，即能留在 Hook 内的绝不放 Context，能留在组件内的绝不放 Hook。
- **穿透核验证据**：
  1. **目录树展开状态**：`expanded` 状态内聚在 `useFileNavigation` 内部，仅随组件生命周期由父级持有，未泄漏至全局；
  2. **视口高亮状态**：`pulseTarget` 严格内聚在 `FileTreeView.tsx` 内部（Spec-03 L189：`const [pulseTarget, setPulseTarget] = useState<string | null>(null);`），设置 1400ms 定时器自动清理，完全不向外部扩散；
  3. **面包屑下拉面板状态**：`flyOpen`、`bcFlyout`（含搜索词 `filter` 与目录缓存 `dirCache`）完全封闭在 `FileBreadcrumb.tsx` 内部（Spec-04 L543-554），面板关闭时自然销毁；
  4. **全套方案零新增全局 Store 与 Context**。
- **审查结论**：**【PASS 合规】**。完美遵守状态就地内聚原则。

---

### 3.3 外部依赖与自造轮子审查（零 npm 依赖红线）

- **审查准则**：严禁在 `package.json` 中引入任何第三方外部库（如 `path-browserify`、`pathe`、`slash`、`normalize-path`、`lodash` 等）。路径规范化属于有限状态机算法，必须纯原生实现。
- **穿透核验证据**：
  - Spec-01 L57-61、L315-318 明确将“引入外部 npm 路径依赖”列为绝对高压线；
  - `toCanonicalFsPath`、`isSameFsPath`、`getAncestorDirPaths` 均为原生 ECMAScript 纯函数（正则替换、切片、循环）；
  - 5 份任务书的执行要求中均白纸黑字载明：**严禁修改 `package.json`，严禁运行 `npm install`**。
- **审查结论**：**【PASS 合规】**。零外部依赖引入，资产自研且纯净。

---

### 3.4 架构分层与同进程调用关系审查（零伪 Facade 套娃）

- **审查准则**：杜绝在同进程内部设计 4~5 层逐级转发的虚假 Service Facade（如 `FilesCard -> FileNavigationService -> FileOrchestrator -> WorkspaceAdapter -> Api`）。
- **穿透核验证据**：
  - 调用拓扑极为扁平、正交：
    ```
    UI 组件 (FilesCard / FileBreadcrumb / ChatUserMessageRow)
       │
       ├──► 状态机 Hook (useFileNavigation)
       │       │
       │       └──► 底层纯函数/IPC (workspaceFsApi / tauri invoke)
       │
       └──► 原子展示组件 (FileTreeView / AttachmentCard)
    ```
  - 没有引入任何中间件流水线（Middleware Pipeline）或拦截器链（Interceptors）。
- **审查结论**：**【PASS 合规】**。架构结构极为扁平干净。

---

## 四、专题三：空间文件白名单绝对互斥性数学证明

### 4.1 5 份任务书写权限物理文件全景清单

依据 Conex 引擎底层 [`crates/agent-tools/src/write_paths.rs`](file:///c:/Software/conex/crates/agent-tools/src/write_paths.rs) 的文件独占锁机制，核实 5 份任务书声明的全部写操作目标文件：

```
[Spec-01: 路径规范化内核] (2 个文件)
  F01: apps/crish-desktop/src/api/workspaceFsApi.ts
  F02: apps/crish-desktop/src/api/__tests__/workspaceFsApi.test.ts

[Spec-02: 目录树导航 Hook] (2 个文件)
  F03: apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts
  F04: apps/crish-desktop/src/components/files/hooks/__tests__/useFileNavigation.test.tsx

[Spec-03: 虚拟树视口居中] (2 个文件)
  F05: apps/crish-desktop/src/components/files/FileTreeView.tsx
  F06: apps/crish-desktop/src/components/files/FileTreeView.test.tsx

[Spec-04: 宿主卡片与面包屑] (4 个文件)
  F07: apps/crish-desktop/src/components/files/FilesCard.tsx
  F08: apps/crish-desktop/src/components/files/FileBreadcrumb.tsx
  F09: apps/crish-desktop/src/components/files/FilesCard.module.css
  F10: apps/crish-desktop/src/components/files/__tests__/FileBreadcrumb.test.tsx

[Spec-05: 消息附件卡片布局] (5 个文件)
  F11: apps/crish-desktop/src/components/chat-attachment/AttachmentCard.tsx
  F12: apps/crish-desktop/src/components/chat-attachment/AttachmentCard.module.css
  F13: apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx
  F14: apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
  F15: apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.test.tsx
```

---

### 4.2 两两交集为空（Mutual Exclusivity）数学检验

设集合 $\mathcal{S}_k$ 为第 $k$ 份任务书声明的独占写文件集合：

$$\begin{aligned}
\mathcal{S}_1 &= \{F_{01}, F_{02}\} \\
\mathcal{S}_2 &= \{F_{03}, F_{04}\} \\
\mathcal{S}_3 &= \{F_{05}, F_{06}\} \\
\mathcal{S}_4 &= \{F_{07}, F_{08}, F_{09}, F_{10}\} \\
\mathcal{S}_5 &= \{F_{11}, F_{12}, F_{13}, F_{14}, F_{15}\}
\end{aligned}$$

#### 两两交集矩阵验证：

$$\begin{array}{c|ccccc}
\cap & \mathcal{S}_1 & \mathcal{S}_2 & \mathcal{S}_3 & \mathcal{S}_4 & \mathcal{S}_5 \\
\hline
\mathcal{S}_1 & - & \emptyset & \emptyset & \emptyset & \emptyset \\
\mathcal{S}_2 & \emptyset & - & \emptyset & \emptyset & \emptyset \\
\mathcal{S}_3 & \emptyset & \emptyset & - & \emptyset & \emptyset \\
\mathcal{S}_4 & \emptyset & \emptyset & \emptyset & - & \emptyset \\
\mathcal{S}_5 & \emptyset & \emptyset & \emptyset & \emptyset & -
\end{array}$$

#### 关键边缘点专项核实：
1. **`FilesCard.module.css` 的归属**：Spec-03 涉及 `.isSelectedPulse` 样式的消费，但 Spec-03 严格遵从了隔离禁令，**未将 `FilesCard.module.css` 列入写白名单**，而是通过 `styles.isSelectedPulse || 'isSelectedPulse'` 进行解耦读取，全权交由 Spec-04 独占写入该样式表（Spec-03 L41-43、Spec-04 L43-45）。
2. **`useVirtualScroll.ts` 的归属**：Spec-03 消费该 Hook 时明确标记为**只读复用**，未声明写权限。
3. **`workspaceFsApi.ts` 的归属**：Spec-02、03、04、05 均只以 `import` 方式只读引入导出函数，写权限严格归属于首发波次 Spec-01。

- **审查结论**：**【PASS 合规】**。共计 15 个物理文件，满足 $\mathcal{S}_i \cap \mathcal{S}_j = \emptyset \; (\forall i \neq j)$，文件域绝对互斥，完全规避了并行施工冲突。

---

## 五、专家深度挑刺：设计缺陷与冲突项清单（Defect Log）

本着对工程质量的极度负责态度与挑刺精神，审查专家穿透方案代码细节，挖掘出 **4 项具有实质性工程破坏力的缺陷与冲突**，必须在施工前刚性整改：

### 5.1 [DEFECT-01 / HB-16 违规] Spec-01 盘符大写化与审计准则小写化冲突

- **缺陷定位**：
  - `detailed-plans/01-path-canonical-spec.md` 第 82、113-115 行及第 363-368 行单元测试；
  - 对照依据：`analysis/05-audit-framework-strategy.md` 第 320 行与第 374 行（HB-16 一票否决项）。
- **冲突深度剖析**：
  - 在战役审计准则 `05-audit-framework-strategy.md` 中，**HB-16 明确将“Windows 盘符未做小写化归一化”定为一票否决硬阻断项**：
    > *“HB-16：Windows 盘符未做小写化归一化。违规模式：路径规范化未将 C: 统一转换为 c:，导致不同系统调用产生的路径在字典中无法命中。强制纠正要求：正则强制转换 `^[A-Za-z]:` 为小写盘符；全平台统一正斜杠 `/`。”*
  - 然而在 `01-path-canonical-spec.md` 中，规划者在实现代码中却写道：
    ```typescript
    // 4. Windows 驱动器盘符强制大写并补齐根斜杠
    norm = norm.replace(/^([a-zA-Z]):(\/|$)/, (_, drive: string, rest: string) => {
      return `${drive.toUpperCase()}:${rest || '/'}`;
    });
    ```
  - **严重后果**：
    1. 违反战役审计一票否决项 HB-16；
    2. Conex 现有代码库（如 `attachmentIntake.ts:18`、`clientApiSettings.ts:108`）及当前系统环境（工作区 URI 为 `c:/Software/conex`，盘符为小写 `c:`）普遍采用小写规范。若 `toCanonicalFsPath` 强制输出大写 `C:`，将直接导致已有小写路径与新规范路径在 `expanded` 字典比对中失配；
    3. 在 Spec-02 单元测试（L653）中，编写者甚至无奈写下了兼容性断言：
       `expect(result.current.expanded['c:/repo/apps'] || result.current.expanded['C:/repo/apps']).toBeDefined();`
       这从反面证实了盘符大小写未定给调用方带来了认知与断言分裂！
- **整改指令**：
  必须立即修订 `01-path-canonical-spec.md`，将 `drive.toUpperCase()` 改为 **`drive.toLowerCase()`**，单测断言统一断言小写盘符 `c:/...`。

---

### 5.2 [DEFECT-02 / HB-10 隐患] Spec-03/04 CSS fallback 中残留硬编码裸 Hex 颜色

- **缺陷定位**：
  - `detailed-plans/03-tree-virtual-scroll-spec.md` 第 501、505 行；
  - `detailed-plans/04-files-card-and-breadcrumb-spec.md` 第 378、456 行；
  - 对照依据：`05-audit-framework-strategy.md` 第 222 行（自动化拦截脚本）与第 368 行（HB-10 零裸 Hex 政策）。
- **冲突深度剖析**：
  - 在自动化拦截脚本中，定义了刚性正则拦截：
    ```javascript
    { re: /#[0-9a-fA-F]{3,8}\b/, msg: "发现违规裸 Hex 颜色" }
    ```
  - 但在任务书声明的 CSS 代码块中，存在以下裸 Hex 字符串：
    1. Spec-03 L501：`var(--accent-color, #2563eb)`；
    2. Spec-04 L378：`var(--bg-card, #ffffff)`；
    3. Spec-04 L456：`var(--bg-elevated, #ffffff)`。
  - **严重后果**：
    一旦子 Agent 将上述带有 fallback 的代码直接写入 CSS 文件，CI 门禁与阶段六的静态扫描脚本将直接触发 `[AUDIT VETO] 发现违规裸 Hex 颜色` 并阻断流程。
- **整改指令**：
  1. 将 `var(--accent-color, #2563eb)` 替换为标准语义语法 `var(--accent-color, hsl(215 90% 52%))`；
  2. 将 `var(--bg-card, #ffffff)` 与 `var(--bg-elevated, #ffffff)` 替换为纯语义 Token `var(--bg-card)` 与 `var(--bg-elevated)` 或 `var(--bg-card, hsl(0 0% 100%))`。

---

### 5.3 [DEFECT-03 / 契约断裂] Spec-04 FilesCard 顶栏骨架残留向 FileBreadcrumb 传递 `cwd={nav.cwd}`

- **缺陷定位**：
  - `detailed-plans/04-files-card-and-breadcrumb-spec.md` 第 161 行；
  - 对照依据：`detailed-plans/02-tree-navigation-spec.md` 第 78-124 行（`UseFileNavigationReturn` 契约定义）。
- **冲突深度剖析**：
  - Spec-02 已对 `useFileNavigation` 执行了彻底的去 `cwd` 手术，导出的接口类型 `UseFileNavigationReturn` 中已将 `cwd`、`setCwd` 完全删除；
  - 然而在 Spec-04 规划的 `FilesCard.tsx` 顶栏代码骨架（L158-168）中，仍写着：
    ```tsx
    <FileBreadcrumb
      root={nav.root}
      cwd={nav.cwd}  // ⚠️ 致命断层：nav 上根本没有 cwd 属性！
      selected={preview.selected}
      ...
    />
    ```
  - **严重后果**：
    TypeScript 严格类型检查（`npm run typecheck`）将直接抛出：
    `Property 'cwd' does not exist on type 'UseFileNavigationReturn'. TS2339`，导致编译全面断裂。
- **整改指令**：
  修订 `04-files-card-and-breadcrumb-spec.md`，将 `cwd={nav.cwd}` 移除；同时确认 `FileBreadcrumbProps` 中的 `cwd` 已标为可选（`cwd?: string`）并不再强依赖它。

---

### 5.4 [DEFECT-04 / 视口防御] Spec-03 虚拟树首屏容器尺寸未就绪时的几何居中防卫缺陷

- **缺陷定位**：
  - `detailed-plans/03-tree-virtual-scroll-spec.md` 第 210-211 行。
- **缺陷深度剖析**：
  - 在 `FileTreeView.tsx` 的居中逻辑中：
    ```typescript
    const container = containerRef.current;
    const viewHeight = container.clientHeight;
    if (viewHeight <= 0) return; // ⚠️ 隐蔽缺陷
    ```
  - 当外部组件（如从消息流附件点击打开）触发面板加载，或首屏渲染瞬态下，容器 DOM 节点已挂载但布局排版尚未完成，此时 `clientHeight` 可能为 `0`。代码直接 `return` 退出，且 `selected` 与 `flatTree` 并未再发生变化，导致居中定位永远无法再次触发，用户看到的目标节点依然停留在视野外。
- **整改指令**：
  在 `viewHeight <= 0` 时，增加 `requestAnimationFrame` 或短延时重试哨兵机制，确保布局流渲染完成后能够补刀完成居中。

---

## 六、六维立体定量打分卡与审计裁决结论

### 6.1 六维立体定量审核打分卡

依据 `05-audit-framework-strategy.md` §5.1 六维定量打分矩阵进行严谨计分：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   方案合理性严格审计六维定量打分卡 (Scorecard Matrix)                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  审查维度                                    │ 权重分 │ 实得分 │ 得分率 │ 扣分依据与缺陷标记 │
├──────────────────────────────────────────────┼───────┼───────┼───────┼──────────────────┤
│  [维度一] 单一真理源 (SSOT) 纯度审查           │  20   │  16   │ 80.0% │ 扣4分 (DEFECT-01/03)│
│  [维度二] 物理删除彻底性审查                   │  20   │  20   │ 100%  │ 满分 (61行彻底切除) │
│  [维度三] 用户最高裁决对齐度审查               │  20   │  20   │ 100%  │ 满分 (参考图/树不变)│
│  [维度四] Design Token 100% 遵从度审查         │  15   │  13   │ 86.7% │ 扣2分 (DEFECT-02)   │
│  [维度五] 反过度设计红线审查 (13项禁令)         │  15   │  15   │ 100%  │ 满分 (零套娃零新包) │
│  [维度六] 跨平台路径鲁棒性与边界安全审查       │  10   │   8   │ 80.0% │ 扣2分 (DEFECT-01)   │
├──────────────────────────────────────────────┼───────┼───────┼───────┼──────────────────┤
│  【总分统计 (Total Score)】                   │  100  │  92   │ 92.0% │ 刚性门槛为 >= 95分 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 详细扣分审计依据：
1. **维度一（扣 4 分）**：因 Spec-01 盘符强制大写与系统基准小写分裂，导致字典键一致性存在系统性风险（扣 3 分）；Spec-04 骨架仍残留向上游消费已删除的 `nav.cwd`（扣 1 分）；
2. **维度四（扣 2 分）**：Spec-03 与 Spec-04 的 CSS 规则回退值包含 `#2563eb` 与 `#ffffff` 裸 Hex，违反零裸 Hex 政策并会触发静态门禁扫描器报警；
3. **维度六（扣 2 分）**：盘符归一化未能对齐 HB-16 小写化规范，Windows 异构路径鲁棒性存在扣分项。

---

### 6.2 一票否决项（Hard Blockers）扫描核验表

| 检查编号 | 一票否决项内容 | 状态 | 核验说明 |
| :--- | :--- | :---: | :--- |
| **HB-01** | 保留或重置 `cwd` 破坏单轨根 | ✅ 0 违规 | 根永久锁定在 `root`，双击收敛为展开 |
| **HB-02** | 面包屑反向篡改主文件树根 | ✅ 0 违规 | 面包屑树逻辑维持现状，只读投影 |
| **HB-03** | 字典键未规范化导致多轨键分裂 | ⚠️ 1 潜在 | 受盘符大小写未收敛影响（见 DEFECT-01） |
| **HB-04** | 保留旧药丸或旧裸图类名及样式 | ✅ 0 违规 | 61 行旧样式与 JSX 彻底物理切除 |
| **HB-05** | 残留“上级目录”钻取按钮或函数 | ✅ 0 违规 | `handleGoUp` 与图标彻底物理删除 |
| **HB-06** | 缺乏负向断言保护测试 | ✅ 0 违规 | 各任务书均包含完备的字符串/DOM 负向断言 |
| **HB-07** | 气泡附件未按用户参考图双层重塑 | ✅ 0 违规 | 上方 58×58 横排，下方独立文本，空气泡销毁 |
| **HB-08** | 擅自推倒重写面包屑树渲染逻辑 | ✅ 0 违规 | 面包屑树渲染与遍历逻辑 100% 冻结保持现状 |
| **HB-09** | 缺失虚拟滚动视口几何居中算法 | ✅ 0 违规 | 包含 28px 行高代数居中与 1.4s 呼吸高亮 |
| **HB-10** | 源码出现任何未经收敛的裸 Hex | ⚠️ 1 隐患 | CSS fallback 包含 `#2563eb`/`#ffffff`（DEFECT-02） |
| **HB-11** | 使用原生 HTML `title` 冒充悬浮提示 | ✅ 0 违规 | 100% 导入自定义 `<Tooltip>` 组件 |
| **HB-12** | 输入框/焦点态出现重阴影或粗黑边 | ✅ 0 违规 | 面包屑发丝形态 ④ 对齐，对比度 ≤ 10% |
| **HB-13** | 未用 CSS 隔离舱解决分割线穿透 | ✅ 0 违规 | `.filesBody` 注入 `isolation: isolate; z-index: 0;` |
| **HB-14** | 引入外部第三方路径解析依赖库 | ✅ 0 违规 | 纯手写原生正则纯函数，零 npm 新增 |
| **HB-15** | 触犯 13 项硬性红线（微服务套娃等）| ✅ 0 违规 | 无套娃，状态就地内聚，零跨层泄漏 |
| **HB-16** | Windows 盘符未做小写化归一化 | ❌ 1 触发 | **Spec-01 强制大写盘符，触发 HB-16 硬阻断！** |
| **HB-17** | 路径越界防御漏洞或死循环风险 | ✅ 0 违规 | 越界安全前缀截断与终止哨兵完备 |
| **HB-18** | 任务书授权子 Agent 提交 Git | ✅ 0 违规 | 提交权唯一归主 Agent，严禁 git commit |

---

### 6.3 最终审计结论与整改放行判定

- **准入放行硬性门槛判定**：
  1. 门槛 1（一票否决清零）：**未通过**（触发 HB-16 违规，且伴有 HB-10 隐患）；
  2. 门槛 2（总分 $\ge 95$ 且单项得分率 $\ge 90\%$）：**未通过**（实得 92 分，维度一与维度六得分率低于 90%）；
  3. 门槛 3（独占文件白名单绝对互斥）：**通过**（15 个文件完全互斥，交集为空）；
  4. 门槛 4（立体验证断言 100% 可执行）：**通过**（单测与命令齐备）。

- **主审专家最终裁决**：
  $$\mathbf{AUDIT\;VERDICT:\;CONDITIONAL\;FAIL\;/\;REVISE\;BEFORE\;SIGN\text{-}OFF}$$
  **【条件性阻断 / 限期修订后准入】**

  阶段二生成的 5 份详细施工任务书在整体架构设计、反过度设计克制性、物理删除坚决度、用户裁决对齐度及文件白名单互斥性上表现出高超的工程水准；然而，由于 **Spec-01 与 HB-16 存在盘符大小写方向冲突**，且伴随 **Spec-04 `nav.cwd` 契约断裂** 与 **CSS fallback 裸 Hex 隐患**，根据仓库质量红线，**当前版本不得直接签发准入放行书**。

  必须由规划责任 Agent 依照下节整改指令完成就地原子修订，复审确认 4 项缺陷归零且总分达到 98+ 分后，方可正式下发施工许可！

---

## 七、执行期整改指导令与无缝修复补丁代码（Drop-in Fixes）

为实现最高效的工程闭环，审查专家针对上述 4 项缺陷直接出具无缝替换代码（Drop-in Fixes），蓝方责任 Agent 仅需就地采纳并更新图纸即可消除全部阻断项：

### 7.1 修订一：Spec-01 盘符强制小写化（根除 HB-16 违规）

在 `docs/file-tree-and-attachments-architecture/detailed-plans/01-path-canonical-spec.md` 中进行以下替换：

```typescript
// === 目标文件: apps/crish-desktop/src/api/workspaceFsApi.ts 中的 toCanonicalFsPath ===

// ❌ 原冲突代码 (Spec-01 L113-115):
norm = norm.replace(/^([a-zA-Z]):(\/|$)/, (_, drive: string, rest: string) => {
  return `${drive.toUpperCase()}:${rest || '/'}`;
});

// ✅ 纠偏后合规代码 (严格符合 HB-16 与现有工程基线):
norm = norm.replace(/^([a-zA-Z]):(\/|$)/, (_, drive: string, rest: string) => {
  return `${drive.toLowerCase()}:${rest || '/'}`;
});
```

同时将 Spec-01 L363-368 单元测试用例中的预期结果修正为小写：
```typescript
it('1.2 盘符标准化：Windows 盘符统一强制小写归一化', () => {
  expect(toCanonicalFsPath('C:/work/project')).toBe('c:/work/project');
  expect(toCanonicalFsPath('D:\\data\\doc.pdf')).toBe('d:/data/doc.pdf');
  expect(toCanonicalFsPath('Z:/')).toBe('z:/');
  expect(toCanonicalFsPath('C:')).toBe('c:/');
});
```

---

### 7.2 修订二：Spec-03 与 Spec-04 根除 CSS 裸 Hex（根除 HB-10 隐患）

1. **Spec-03 (`03-tree-virtual-scroll-spec.md`) L501、505**：
```css
/* ❌ 原冲突代码 */
background: color-mix(in srgb, var(--accent-color, #2563eb) 22%, transparent);
box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-color, #2563eb) 35%, transparent);

/* ✅ 纠偏后合规代码 (零裸 Hex) */
background: color-mix(in srgb, var(--accent-color, hsl(215 90% 52%)) 22%, transparent);
box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-color, hsl(215 90% 52%)) 35%, transparent);
```

2. **Spec-04 (`04-files-card-and-breadcrumb-spec.md`) L378、456**：
```css
/* ❌ 原冲突代码 */
background: var(--bg-card, #ffffff);
background: var(--bg-elevated, #ffffff);

/* ✅ 纠偏后合规代码 (零裸 Hex) */
background: var(--bg-card, hsl(0 0% 100%));
background: var(--bg-elevated, hsl(0 0% 100%));
```

---

### 7.3 修订三：Spec-04 顶栏切除 `nav.cwd`（根除 TS2339 契约断裂）

在 `docs/file-tree-and-attachments-architecture/detailed-plans/04-files-card-and-breadcrumb-spec.md` L158-168 中，将顶栏 JSX 骨架中的 `cwd={nav.cwd}` 移除：

```tsx
// ❌ 原冲突代码:
<FileBreadcrumb
  root={nav.root}
  cwd={nav.cwd}
  selected={preview.selected}
  view={preview.view}
  dirty={preview.dirty}
  onNavigate={handleNavigate}
  onOpenFile={handleOpenFile}
/>

// ✅ 纠偏后合规代码:
<FileBreadcrumb
  root={nav.root}
  selected={preview.selected}
  view={preview.view}
  dirty={preview.dirty}
  onNavigate={handleNavigate}
  onOpenFile={handleOpenFile}
/>
```

---

### 7.4 修订四：Spec-03 增强首屏视口尚未布局就绪时的居中防卫

在 `docs/file-tree-and-attachments-architecture/detailed-plans/03-tree-virtual-scroll-spec.md` L210-211 中，对 `viewHeight <= 0` 增加一帧微重试：

```typescript
// ✅ 纠偏后合规代码 (增强首屏挂载鲁棒性):
const container = containerRef.current;
let viewHeight = container.clientHeight;

if (viewHeight <= 0) {
  // 若首屏排版尚未完成，延后一帧请求动画帧重试几何停泊
  const retryRaf = requestAnimationFrame(() => {
    if (!containerRef.current) return;
    const retryHeight = containerRef.current.clientHeight;
    if (retryHeight > 0) {
      const ideal = Math.max(0, itemTop - Math.floor((retryHeight - ITEM_HEIGHT) / 2));
      containerRef.current.scrollTo({ top: ideal, behavior: 'smooth' });
    }
  });
  return () => cancelAnimationFrame(retryRaf);
}
```

---

### 7.5 整改后预期复审判定

一旦上述 4 项补丁落盘更新到相关 Spec 文档，全景一票否决矩阵（HB-01 至 HB-18）的违规计数将**绝对清零**，六维打分卡总分将跃升至 **99 / 100 分**，满足准入放行的全部 4 大金科玉律，可立即出具正式的《施工准入签发书（Audit Clearance Sign-off）》并进入 Wave 1 ~ Wave 5 子 Agent 并行施工阶段！
