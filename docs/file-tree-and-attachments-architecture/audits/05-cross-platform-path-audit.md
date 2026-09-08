# 阶段三：方案合理性严格审计 · 跨平台路径鲁棒性与边界算法审计报告 (Cross-Platform Path Robustness & Boundary Algorithm Audit)

> **文档标识**：`docs/file-tree-and-attachments-architecture/audits/05-cross-platform-path-audit.md`  
> **战役工作区**：`docs/file-tree-and-attachments-architecture/`  
> **审查专家**：资深跨平台底层与边界安全审查专家（Senior Cross-Platform Low-Level & Boundary Security Audit Expert）  
> **审计基准依据**：
> 1. `docs/file-tree-and-attachments-architecture/analysis/05-audit-framework-strategy.md`（审计框架与一票否决全景准则）；
> 2. `AGENTS.md`（§1 逻辑规划与反退避、§7 严禁补丁与作弊、§7.1 立体验证纪律、§8 反过度设计硬性红线、§11 CI 治理与解耦断言）；
> 3. `ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计 13 项硬性禁令）。  
> **审查对象清单**：
> - [`detailed-plans/01-path-canonical-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/01-path-canonical-spec.md)（路径规范化与 SSOT 契约）
> - [`detailed-plans/02-tree-navigation-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/02-tree-navigation-spec.md)（目录树单轨收敛与祖先展开 Hook）
> - [`detailed-plans/03-tree-virtual-scroll-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/03-tree-virtual-scroll-spec.md)（虚拟滚动平滑居中与脉冲高亮）
> - 交叉校验文档：[`detailed-plans/04-files-card-and-breadcrumb-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/04-files-card-and-breadcrumb-spec.md) 与 [`detailed-plans/05-message-attachment-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/05-message-attachment-spec.md)  
> **审计纪律属性**：纯逻辑工程审计（不谈工期、人天、人员偏见，技术问题与边界缺陷逻辑同权，完全以源码真理源与代数确定性为准绳，严禁执行 git commit）。

---

## 目录

- [一、审计执行概述与最高裁决判定](#一审计执行概述与最高裁决判定)
- [二、一票否决项（Hard Blockers）拉网式筛查结果](#二一票否决项hard-blockers拉网式筛查结果)
- [三、核心挑刺要点深度穿透审计](#三核心挑刺要点深度穿透审计)
  - [3.1 跨平台路径归一化审计（toCanonicalFsPath 与 isSameFsPath）](#31-跨平台路径归一化审计tocanonicalfspath-与-issamefspath)
  - [3.2 越界与安全沙箱审计（getAncestorDirPaths 与 revealPath）](#32-越界与安全沙箱审计getancestordirpaths-与-revealpath)
  - [3.3 并发补拉与状态原子性审计（Promise.allSettled 与 setExpanded）](#33-并发补拉与状态原子性审计promiseallsettled-与-setexpanded)
  - [3.4 虚拟滚动几何居中与视口停泊审计（FileTreeView 视口计算）](#34-虚拟滚动几何居中与视口停泊审计filetreeview-视口计算)
  - [3.5 跨规范接口契约一致性（Inter-Spec Contract Topology）](#35-跨规范接口契约一致性inter-spec-contract-topology)
- [四、缺陷清单与零留白整改方案（Drop-in Fix Proposals）](#四缺陷清单与零留白整改方案drop-in-fix-proposals)
  - [4.1 DEFECT-01：toCanonicalFsPath 盘符大小写与相对段 /../ 消解修复](#41-defect-01tocanonicalfspath-盘符大小写与相对段--消解修复)
  - [4.2 DEFECT-02：getAncestorDirPaths 根路径斜杠双拼与越界防御修复](#42-defect-02getancestordirpaths-根路径斜杠双拼与越界防御修复)
  - [4.3 DEFECT-03：useFileNavigation 中 revealPath 大小写鲁棒性与根兼容修复](#43-defect-03usefilenavigation-中-revealpath-大小写鲁棒性与根兼容修复)
  - [4.4 DEFECT-04：FileTreeView 视口 [0, maxScrollTop] 钳位与防劫持修复](#44-defect-04filetreeview-视口-0-maxscrolltop-钳位与防劫持修复)
  - [4.5 DEFECT-05：Spec-04 中 FilesCard 与 FileBreadcrumb 契约消除 cwd 遗漏修复](#45-defect-05spec-04-中-filescard-与-filebreadcrumb-契约消除-cwd-遗漏修复)
- [五、六维立体定量审核打分卡（Scorecard Matrix）](#五六维立体定量审核打分卡scorecard-matrix)
- [六、最终审计结论与放行裁决](#六最终审计结论与放行裁决)

---

## 一、审计执行概述与最高裁决判定

根据阶段三方案合理性严格审计的红蓝对抗机制，本专家代表红方（严苛挑战与质量守门）与绿方（主控终审），对阶段二编制的 5 份详细施工设计任务书展开了源码级、状态机级与数学几何级的穿透式深度审查。

### 最高审计裁决：
**【REJECTED / CONDITIONAL FAIL（否决，阻断施工，责令就地原子修订后复审）】**

**综合评审得分**：**84 / 100 分**（低于准入放行底线 95 分，且单维度得分率出现低于 90% 的严重偏科缺陷，触发一票否决阻断项 HB-16 与 HB-17 风险项）。

### 核心阻断原因归纳：
1. **盘符大小写违背审计框架强制门槛（触发 HB-16 否决）**：`01-path-canonical-spec.md` 强制将盘符转为**大写**，直接违反了审计战略框架 `05-audit-framework-strategy.md` 第 3.2 节一票否决项 **HB-16** 所规定的“强制小写化归一化（`^[A-Za-z]:` $\to$ 小写）”刚性门槛，导致跨模块比对与已有系统调用产生撕裂；
2. **相对段 `/../` 消解缺失导致沙箱逃逸漏洞（触发 HB-17 越界风险）**：`toCanonicalFsPath` 仅循环消解 `/./`，完全未处理 `/../`，导致形如 `C:/repo/sub/../../secret.txt` 的路径绕过 `getAncestorDirPaths` 的前缀检测，造成祖先链向外部目录失控爬轨；
3. **驱动器根路径与 POSIX 根目录前缀拼接产生双斜杠崩溃**：当工作区为驱动器根（如 `C:/`）或系统根（`/`）时，`getAncestorDirPaths` 与 `revealPath` 盲目使用 `normRoot + '/'` 形成 `c://` 或 `//`，导致前缀匹配恒定失败（100% 拒绝合法文件）；
4. **虚拟滚动居中公式缺失上限闭环安全钳位**：`FileTreeView.tsx` 的理想居中位移仅做了 `Math.max(0, ...)` 下限钳位，未做 `[0, totalHeight - viewHeight]` 上限安全钳位，导致树底部节点滚动位移溢出；且 `isInView` 判定存在边界死区（第 0 项与末尾项恒判定为不在视口内）；
5. **视口滚动被状态重算强制劫持（UX 致命震荡）**：`FileTreeView` 的居中 `useEffect` 依赖了 `flatTree`，导致用户选中文件后若滚动到其他目录展开折叠时，视口被强行暴力拉回选中节点；
6. **跨规范接口契约撕裂（Typecheck 编译断裂）**：Spec-02 彻底清退了 `useFileNavigation` 的 `cwd` 导出，但 Spec-04 的 `FilesCard.tsx` 仍向 `FileBreadcrumb` 传递 `cwd={nav.cwd}`，且 `FileBreadcrumbProps` 未做可选兼容，直接导致 TSC 静态类型检查失败。

---

## 二、一票否决项（Hard Blockers）拉网式筛查结果

对照 `05-audit-framework-strategy.md` 第 3.2 节制定的 18 项一票否决矩阵（HB-01 至 HB-18），静态审查结果如下：

| 检查编号 | 一票否决项（Hard Blocker） | 涉及文档 | 筛查命中情况 | 判定结论 |
| :--- | :--- | :--- | :--- | :---: |
| **HB-01** | 保留或重置 `cwd` 破坏单轨根 | Spec-02, Spec-04 | 树根永久锚定 `root`，双击目录收敛为原地展开 | ✅ PASS |
| **HB-02** | 面包屑反向篡改主文件树根 | Spec-04 | 面包屑维持现状，仅浮层内下钻，零根篡改 | ✅ PASS |
| **HB-03** | 字典键未规范化导致多轨键分裂 | Spec-01, Spec-02 | 所有存取均施加 `toCanonicalFsPath` 处理 | ✅ PASS |
| **HB-04** | 保留旧药丸或旧裸图类名及样式 | Spec-05 | 61 行死亡 CSS 规则及废弃 JSX 声明物理切除 | ✅ PASS |
| **HB-05** | 残留“上级目录”钻取按钮或函数 | Spec-02, Spec-04 | `handleGoUp`、`PARENT_DIR_LABEL` 声明物理删除 | ✅ PASS |
| **HB-06** | 缺乏负向断言保护测试 | Spec-01~Spec-05 | 各 Spec 均声明了对旧字段/旧类名的负向断言单测 | ✅ PASS |
| **HB-07** | 气泡附件未按用户参考图双层重塑 | Spec-05 | 上方 58×58 卡片横排流 + 下方独立气泡，空气泡销毁 | ✅ PASS |
| **HB-08** | 擅自推倒重写面包屑树渲染逻辑 | Spec-04 | 面包屑树渲染逻辑 100% 维持现状不变 | ✅ PASS |
| **HB-09** | 缺失虚拟滚动视口几何居中算法 | Spec-03 | 已提供居中位移与平滑滚动代码（但存在数学边界缺陷） | ⚠️ WARN |
| **HB-10** | 源码出现任何未经收敛的裸 Hex | Spec-03, 04, 05 | 样式均使用 Design Tokens 与现代 CSS 语法 | ✅ PASS |
| **HB-11** | 使用原生 HTML `title` 冒充提示 | Spec-03, 04, 05 | 100% 声明使用自定义 `<Tooltip>` 组件 | ✅ PASS |
| **HB-12** | 输入框/焦点态出现重阴影或粗黑边 | Spec-03, Spec-04 | 面包屑搜索框发丝化，激活混入文本色 $\le 10\%$ | ✅ PASS |
| **HB-13** | 未用 CSS 隔离舱解决分割线穿透 | Spec-04 | `.filesBody` 显式注入 `isolation: isolate` | ✅ PASS |
| **HB-14** | 引入外部第三方路径解析依赖库 | Spec-01 | 零 npm 路径库依赖，纯原生 ECMAScript 实现 | ✅ PASS |
| **HB-15** | 触犯 13 项硬性红线（微服务套娃等） | Spec-01~Spec-05 | 架构保持无头 Hook + 原子组件扁平直调 | ✅ PASS |
| **HB-16** | **Windows 盘符未做小写化归一化** | **Spec-01:L83, L113** | **违规：强制将驱动器盘符转为大写 (`drive.toUpperCase()`)，触发审计战略一票否决** | ❌ **VETO** |
| **HB-17** | **路径越界防御漏洞或死循环风险** | **Spec-01:L108, L193** | **违规：未消解 `/../` 导致沙箱逃逸，根路径拼接 `//` 导致合法路径被阻断** | ❌ **VETO** |
| **HB-18** | 任务书授权子 Agent 提交 Git | Spec-01~Spec-05 | 所有任务书均明确禁止子 Agent 执行 `git commit` | ✅ PASS |

---

## 三、核心挑刺要点深度穿透审计

### 3.1 跨平台路径归一化审计（`toCanonicalFsPath` 与 `isSameFsPath`）

审查对象：[`detailed-plans/01-path-canonical-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/01-path-canonical-spec.md) 第 4 节实现代码。

#### 挑刺点 1：盘符大小写标准违规与双标分裂（Hard Blocker HB-16）
- **规范现状**：
  在 `01-path-canonical-spec.md` 第 4 节 L113-115：
  ```typescript
  // 4. Windows 驱动器盘符强制大写并补齐根斜杠
  norm = norm.replace(/^([a-zA-Z]):(\/|$)/, (_, drive: string, rest: string) => {
    return `${drive.toUpperCase()}:${rest || '/'}`;
  });
  ```
- **架构断层分析**：
  1. 审计战略总纲 `05-audit-framework-strategy.md` 第 2.6 节 L320 与第 3.2 节 HB-16 明确裁定：**“Windows 盘符小写化：匹配 `^[A-Za-z]:` 时强制将盘符字母转为小写（例如 `C:/Project` 必须稳定转换为 `c:/Project`）”**。Spec-01 擅自将其改为大写，直接触发 HB-16 否决；
  2. 既有系统源码证据穿透：`apps/crish-desktop/src/api/workspaceFsApi.ts:83` 内部实现 `const r = root.toLowerCase(); const n = norm.toLowerCase();`，且 VS Code、Tauri 前端 URI 规范及 Chrome DevTools 规范普遍将盘符表示为小写（如 `c:/Software/...`）；
  3. Spec-02 的作者已经察觉到了这种不一致性，因而在 `02-tree-navigation-spec.md` L652 的测试用例中写出了如下“妥协断言”：
     ```typescript
     expect(result.current.expanded['c:/repo/apps'] || result.current.expanded['C:/repo/apps']).toBeDefined();
     ```
     这从反面确凿证实：Spec-01 的大写盘符规划破坏了单一真理源（SSOT）的代数唯一性。
- **裁决指令**：必须彻底将 `toCanonicalFsPath` 的盘符处理改为**强制小写**：
  ```typescript
  norm = norm.replace(/^([a-zA-Z]):(\/|$)/, (_, drive: string, rest: string) => {
    return `${drive.toLowerCase()}:${rest || '/'}`;
  });
  ```

#### 挑刺点 2：相对段 `/../`（Dot-Dot Segments）消解完全缺失
- **规范现状**：
  在 `01-path-canonical-spec.md` 第 4 节 L108-110：
  ```typescript
  // 3. 循环消解相对点号段 (/./ 或末尾 /.)
  while (/\/\.(?=\/|$)/.test(norm)) {
    norm = norm.replace(/\/\.(?=\/|$)/g, '');
  }
  ```
- **算法漏洞证明**：
  上述正则表达式中，先行断言 `(?=\/|$)` 规定点号 `.` 之后必须是斜杠或字符串结尾。
  若输入路径包含父级相对段 `sub/../file.ts`，由于第一个 `.` 之后是另一个 `.`，先行断言失败；第二个 `.` 之前不是斜杠，无法匹配！
  **数学事实证明**：`toCanonicalFsPath('c:/work/sub/../file.ts')` 的输出结果原封不动仍为 `'c:/work/sub/../file.ts'`！
- **严重次生灾害**：
  `05-audit-framework-strategy.md` L322 明确要求：“安全消解内部的 `/./` 与不越界的 `/../` 路径段”。未能消解 `/../` 直接导致下游依赖它的 `getAncestorDirPaths` 产生安全漏洞。

#### 挑刺点 3：`isSameFsPath` 正则与相对路径大小写漏洞
- **规范现状**：
  在 `01-path-canonical-spec.md` L148-151：
  ```typescript
  if (/^[A-Z]:\//.test(a) && /^[A-Z]:\//.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  ```
- **缺陷分析**：
  1. 若盘符按 HB-16 改为小写后，`/^[A-Z]:\//` 将直接失配，导致比对错误降级为大小写敏感比对；正则必须声明为 `/^[a-zA-Z]:\//`；
  2. 若传入相对路径 `src/components/button.tsx` 与 `src/components/Button.tsx`，在 Windows 平台环境下应具备大小写不敏感等值能力，但当前代码未进入 Windows 分支，直接返回 `false`。

---

### 3.2 越界与安全沙箱审计（`getAncestorDirPaths` 与 `revealPath`）

审查对象：[`detailed-plans/01-path-canonical-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/01-path-canonical-spec.md) 与 [`detailed-plans/02-tree-navigation-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/02-tree-navigation-spec.md)。

#### 挑刺点 4：驱动器根与 POSIX 根路径前缀拼接产生双斜杠 `//` 导致 100% 拒真（Hard Blocker HB-17）
- **规范现状**：
  在 `01-path-canonical-spec.md` L193：
  ```typescript
  if (!normTargetLower.startsWith(normRootLower + '/')) {
    return [];
  }
  ```
  以及在 `02-tree-navigation-spec.md` L255：
  ```typescript
  const isInside = normTarget.startsWith(normRoot + '/') || normTarget === normRoot;
  ```
- **代数推导与崩溃现场重现**：
  1. 根据 `toCanonicalFsPath` 规则 5 与 6，根路径末尾斜杠被严格保留：
     - 若工作区根为 Windows 盘符根 `C:/`，规范化后 `canonRoot` 为 `c:/`，`normRootLower` 为 `c:/`；
     - 若工作区根为 POSIX 根 `/`，规范化后 `canonRoot` 为 `/`，`normRootLower` 为 `/`。
  2. 当执行 `normRootLower + '/'` 时：
     - Windows 盘符根：`'c:/' + '/'` $\implies$ `'c://'`！
     - POSIX 根：`'/' + '/'` $\implies$ `'//'`！
  3. 目标文件正常规范化后为 `c:/folder/file.txt` 或 `/home/user/file.txt`。
  4. 执行前缀核验：
     - `'c:/folder/file.txt'.startsWith('c://')` $\implies$ **`false`**！
     - `'/home/user/file.txt'.startsWith('//')` $\implies$ **`false`**！
  5. **破坏性后果**：一旦用户打开整个盘符根目录（如移动硬盘、U 盘、或直接将驱动器作为工作区）或 Linux 根路径，`getAncestorDirPaths` 恒定返回 `[]`，`revealPath` 恒定返回 `false`！树导航与附件跳转在根级工作区下**全线崩溃**！
- **裁决指令**：前缀组装必须消除前导已有斜杠的重复追加：
  ```typescript
  const rootPrefix = normRootLower.endsWith('/') ? normRootLower : normRootLower + '/';
  if (!normTargetLower.startsWith(rootPrefix)) return [];
  ```

#### 挑刺点 5：利用未消解 `/../` 的目录沙箱逃逸与幽灵祖先（Path Traversal Attack）
- **漏洞场景重演**：
  1. 假设工作区根目录为 `c:/repo`；
  2. 攻击者或外部异常消息传入路径：`targetPath = "c:/repo/sub/../../Windows/System32/cmd.exe"`；
  3. 因 `toCanonicalFsPath` 不消解 `/../`，`canonTarget` 仍为 `"c:/repo/sub/../../Windows/System32/cmd.exe"`；
  4. `normTargetLower` 仍为 `"c:/repo/sub/../../windows/system32/cmd.exe"`；
  5. 检测 `normTargetLower.startsWith("c:/repo/")`：**通过！因为字符串前 8 个字符确实是 `c:/repo/`！**；
  6. `getAncestorDirPaths` 进入 `while (curr)` 循环回溯 `parentPath`：
     - 提取出祖先目录：`"c:/repo/sub/../../Windows/System32"`、`"c:/repo/sub/../../Windows"`、`"c:/repo/sub/.."`；
     - 循环终止条件：`currLower === normRootLower`。由于回溯过程中路径字符串永远不会等于 `"c:/repo"`，最终回溯到驱动器根触发 `next === currCanon` 跳出；
  7. **破坏性后果**：`getAncestorDirPaths` 返回了一组完全处于工作区外部（跨越到了操作系统的 `Windows/System32`）的伪造祖先数组！
  8. `useFileNavigation` 接收后将其塞入 `Promise.allSettled` 并注入主树的 `expanded` 字典，导致工作区外的敏感目录被非法拉取并污染主树！
- **裁决指令**：
  1. `toCanonicalFsPath` 必须实现标准的路径栈解析，将 `/../` 依法回退消除；
  2. 若 `/../` 回退企图越过根节点，予以硬性丢弃或归零；
  3. `getAncestorDirPaths` 在入口增加 `/(^|\/)\.\.($|\/)/` 防御断言，凡包含未消解遍历段者直接拒绝并返回 `[]`。

#### 挑刺点 6：兄弟前缀碰撞攻击阻断有效性核验
- **核验断言**：当工作区根为 `c:/repo`，目标路径为 `c:/repo_fake/file.txt` 或 `c:/repo-backup/src/App.tsx` 时：
  - `normRootLower + '/'` 形成 `'c:/repo/'`；
  - `normTargetLower` 为 `'c:/repo_fake/file.txt'`；
  - `'c:/repo_fake/file.txt'.startsWith('c:/repo/')` 为 `false`；
  - **结论**：在修复上述挑刺点 4 后，规范中的前缀加斜杠逻辑能够**100% 精准阻断兄弟前缀碰撞**，不存在误放行漏洞。

#### 挑刺点 7：`revealPath` 对外部文件污染的防护完备性
- **核验断言**：
  在 `02-tree-navigation-spec.md` L243-258 中：
  ```typescript
  try {
    resolvedTarget = assertWorkspacePath(filePath);
  } catch (err) {
    setError(err instanceof Error ? err.message : '文件不在当前工作区内');
    return false;
  }
  ```
  - 当外部文件（如 `D:/outside.txt`）传入时，`assertWorkspacePath` 抛错被捕获，函数立即返回 `false`；
  - `entries`、`expanded`、`flatTree` 均未发生任何改变，确保了工作区主树结构的**零污染**；
  - **红方挑刺（微瑕）**：捕获外部文件时调用了 `setError(...)`，这会导致 `FileTreeView` 顶部弹出一个黏性内联错误横幅。对于消息附件是外部文件的正常场景，不应视为全局错误污染 UI，建议仅静默返回 `false`，由调用方（如 `openFileInPanel`）决定通过 Toast 提示。

---

### 3.3 并发补拉与状态原子性审计（`Promise.allSettled` 与 `setExpanded`）

审查对象：[`detailed-plans/02-tree-navigation-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/02-tree-navigation-spec.md) 第 3.2 节。

#### 挑刺点 8：并发拉取与渲染合并原子性分析
- **正向肯定**：
  1. `02-tree-navigation-spec.md` L288-305 采用了 `Promise.allSettled(toLoad.map(...))` 并发批量请求缺失的祖先目录，彻底根除了单线程串行 I/O 瀑布延时，符合性能不变量；
  2. 拉取结果汇聚在局部对象 `results: Record<string, FsDirEntry[]>` 中；
  3. L309 仅调用了一次 `setExpanded((prev) => ({ ...prev, ...results }))`，利用 React 18 自动批处理机制，保证在整个补拉周期内 `flatTree` 的 `useMemo` **仅重算 1 次**，有效消除了多重中间态导致的虚拟列表剧烈抖动与多次重渲染。

#### 挑刺点 9：全量失败时的乐观 `return true` 状态机欺骗
- **规范现状**：
  在 `02-tree-navigation-spec.md` L285-313：
  ```typescript
  if (toLoad.length > 0) {
    const results: Record<string, FsDirEntry[]> = {};
    const settledResults = await Promise.allSettled(...);
    for (const res of settledResults) {
      if (res.status === 'fulfilled') {
        results[res.value.dir] = res.value.items;
      }
    }
    if (Object.keys(results).length > 0) {
      setExpanded((prev) => ({ ...prev, ...results }));
    }
  }
  return true; // ❌ 漏洞：即使全部 rejected 也返回 true！
  ```
- **时序断层剖析**：
  1. 若用户尝试定位深层文件，但因权限不足或目录被物理删除，`toLoad` 中的所有祖先目录在 `Promise.allSettled` 中均为 `rejected`；
  2. `results` 为 `{}`，`setExpanded` 未执行；
  3. 函数却依然盲目执行 `return true`！
  4. 上游调用方（`FilesCard.tsx` 或测试用例）误认为展开成功，紧接着触发 `selected` 高亮，而 `FileTreeView` 在 `flatTree` 中根本查不到该节点（`findIndex` 返回 -1），导致定位静默流产且无任何可感知的错误反馈。
- **裁决指令**：若存在需要加载的祖先（`toLoad.length > 0`），必须校验是否至少成功拉取或关键直系祖先未失败；若全部失败，必须 `return false` 并置入受控错误。

---

### 3.4 虚拟滚动几何居中与视口停泊审计（`FileTreeView` 视口计算）

审查对象：[`detailed-plans/03-tree-virtual-scroll-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/03-tree-virtual-scroll-spec.md) 第 4 节及第 7 节。

#### 挑刺点 10：视口居中公式缺失上限闭环安全钳位（Critical Boundary Defect）
- **规范现状**：
  在 `03-tree-virtual-scroll-spec.md` L224-227：
  ```typescript
  const idealScrollTop = Math.max(
    0,
    itemTop - Math.floor((viewHeight - ITEM_HEIGHT) / 2)
  );
  container.scrollTo({
    top: idealScrollTop,
    behavior: 'smooth',
  });
  ```
- **代数几何与物理溢出证明**：
  1. 设虚拟滚动列表总高度为 $H_{\text{total}} = N \times 28\text{px}$，视口高度为 $H_{\text{viewport}} = 280\text{px}$；
  2. 容器物理最大合法滚动位移为：
     $$\text{maxScrollTop} = \max(0, H_{\text{total}} - H_{\text{viewport}})$$
  3. 当定位的目标节点处于列表最末端附近时（例如 $N=50$ 项，目标为第 48 项）：
     - $H_{\text{total}} = 50 \times 28 = 1400\text{px}$，$\text{maxScrollTop} = 1400 - 280 = 1120\text{px}$；
     - $\text{itemTop} = 48 \times 28 = 1344\text{px}$；
     - $\text{idealScrollTop} = 1344 - \lfloor(280 - 28) / 2\rfloor = 1344 - 126 = 1218\text{px}$！
  4. **溢出发生**：计算出的位移值 $1218\text{px}$ **超出了物理最大可滚动上限 $1120\text{px}$ 整整 $98\text{px}$**！
  5. 虽然原生浏览器 DOM 对 `scrollTo` 具备硬件级末端截断，但在虚拟滚动管理器（`VirtualScrollManager`）与跨平台 WebView2 渲染层中，未安全钳位的非法坐标会引发以下严重异常：
     - 在 JSDOM 自动化单元测试中，Mock 的 `scrollTo` 将直接捕获到非法的 `top: 1218`，与代数预期断裂；
     - 在部分 Linux WebKit 与触控板惯性滚动下，非法坐标会导致回弹动画破裂与过度绘制；
     - **最致命点**：若列表总高度小于视口高度（如只有 3 个文件，$H_{\text{total}} = 84\text{px} < 280\text{px}$），$\text{maxScrollTop}$ 恒为 0，任何大于 0 的位移均为非法。
- **裁决指令**：必须将位移严格闭合钳位在 $[0, \text{maxScrollTop}]$ 区间内：
  ```typescript
  const maxScrollTop = Math.max(0, totalHeight - viewHeight);
  const targetScrollTop = Math.min(
    maxScrollTop,
    Math.max(0, itemTop - Math.floor((viewHeight - ITEM_HEIGHT) / 2))
  );
  ```

#### 挑刺点 11：`isInView` 判定在边界处的“死区陷阱（Deadzone Trapping）”
- **规范现状**：
  在 `03-tree-virtual-scroll-spec.md` L218-220：
  ```typescript
  const isInView =
    itemTop >= currentScrollTop + ITEM_HEIGHT &&
    itemBottom <= currentScrollTop + viewHeight - ITEM_HEIGHT;
  ```
- **边界死区反例分析**：
  1. **顶部死区**：当用户停留在树顶部，`currentScrollTop === 0`。
     - 此时第 0 个节点（`targetIndex = 0`）完全露在视野最上方；
     - 计算其 $\text{itemTop} = 0$；
     - 评估表达式：`0 >= 0 + 28` $\implies$ **`false`**！
     - **荒谬现象**：第 0 个条目明明在屏幕上清晰可见，算法却判定它**不在视口内**，进而反复触发 `scrollTo({ top: 0 })` 平滑滚动！
  2. **底部死区**：当容器滚动到底部时，最底部的条目同样因 `itemBottom > currentScrollTop + viewHeight - 28` 而**永远被判定为不在视口内**！
- **裁决指令**：边界判定缓冲必须自适应当前滚动位置：在滚动已贴合顶部（`scrollTop === 0`）或贴合底部（`scrollTop >= maxScrollTop`）时，豁免边缘缓冲要求。

#### 挑刺点 12：`flatTree` 作为 `useEffect` 依赖导致视口被强制劫持（重大体验 Bug）
- **规范现状**：
  在 `03-tree-virtual-scroll-spec.md` L250：
  ```typescript
  useEffect(() => {
    // ...
  }, [selected, flatTree, focusTreeRow, containerRef]);
  ```
- **用户交互灾难重现**：
  1. 用户在第 5 行选中了 `App.tsx`，树平滑滚动并将第 5 行居中高亮；
  2. 随后用户用鼠标滚轮向下滚动了 200 行，去查看底部的 `package.json` 或折叠某个与 `App.tsx` 无关的目录；
  3. 用户点击折叠该目录，触发了 `toggleExpand`；
  4. `expanded` 改变，导致 `flatTree` 重新生成新数组引用；
  5. **灾难发生**：`useEffect` 监测到 `flatTree` 变化立即触发！此时 `selected` 依然是 `App.tsx`，算法一查当前第 5 行不在当前屏幕内（`!isInView`），**瞬间暴力触发平滑滚动，将视口强行拽回到第 5 行**！
  6. 用户刚想在底部找文件，页面突然自己“瞬移”回去了！用户将完全无法在选中任何文件后正常浏览其它深层目录！
- **裁决指令**：
  居中停泊与脉冲高亮必须且只能由**显式的选择跃迁（Selection Transition）**或**路径定位命令（Reveal Command）**触发！必须使用 `prevSelectedRef` 锁定状态跃迁，严禁在 `flatTree` 自身变化但 `selected` 没变的常规折叠展开时劫持视口！

#### 挑刺点 13：虚拟 DOM 节点未挂载时的焦点丢失与微任务时序断层
- **规范现状**：
  在 `03-tree-virtual-scroll-spec.md` L241-245：
  ```typescript
  focusTreeRow(targetIndex);
  const rafId = requestAnimationFrame(() => {
    focusTreeRow(targetIndex);
  });
  ```
- **虚拟渲染时序事实**：
  1. 虚拟滚动只渲染视口内可见的 `visibleItems`；
  2. 若目标节点当前在视口外 1000px 处，**该节点的 DOM 元素在当前帧根本就不存在**（`querySelector` 100% 返回 `null`）；
  3. 容器调用了 `scrollTo({ behavior: 'smooth' })`，平滑滚动在真实浏览器中需要经历 300ms~500ms 的缓动帧插值；
  4. 在第一帧微任务与第一帧 rAF（耗时仅 16ms）执行时，容器位移才刚动了几个像素，目标节点**依然处于视口外且未被渲染**！
  5. 两次 `focusTreeRow` 均以 `null.focus()` 失败而静默吞噬，平滑滚动结束后目标节点**彻底丢失键盘焦点**！
- **裁决指令**：应在 `visibleRange` 包含 `targetIndex` 的生命周期钩子中，或平滑停泊的完成态下补齐焦点转移。

---

### 3.5 跨规范接口契约一致性（Inter-Spec Contract Topology）

审查对象：Spec-02 与 Spec-04 的跨文件类型契约。

#### 挑刺点 14：Spec-04 `FilesCard.tsx` 残留 `nav.cwd` 引用导致 TypeScript 编译阻断
- **证据链穿透**：
  1. 在 `02-tree-navigation-spec.md` 第 3.1 节 L78-125 中，严格物理删除了 `cwd`，其返回契约 `UseFileNavigationReturn` 中**完全不存在 `cwd` 字段**（负向测试 L704 明确断言 `expect(hookReturn.cwd).toBeUndefined()`）；
  2. 然而在 `04-files-card-and-breadcrumb-spec.md` 第 4.1.2 节 L161 中，顶栏渲染代码竟然还在书写：
     ```tsx
     <FileBreadcrumb
       root={nav.root}
       cwd={nav.cwd} // ❌ 编译阻断：UseFileNavigationReturn 上不存在属性 cwd！
       ...
     />
     ```
  3. 且查看既有代码 `apps/crish-desktop/src/components/files/FileBreadcrumb.tsx:78`：
     ```typescript
     interface FileBreadcrumbProps {
       root: string;
       cwd: string; // ❌ 仍为必填参数
       ...
     ```
  4. 这构成了典型的跨 Spec 协同断裂。一旦执行，`npm run typecheck` 将立即抛出 `TS2339: Property 'cwd' does not exist on type 'UseFileNavigationReturn'`，直接击穿 CI 门禁！
- **裁决指令**：
  - 在 Spec-04 的 `FileBreadcrumb.tsx` 中将 `cwd` 改为可选废弃标记 `cwd?: string`；
  - 在 `FilesCard.tsx` 中移除 `cwd={nav.cwd}` 传参；
  - `FileBreadcrumb` 内部在缺失 `cwd` 时退化为单轨 `root`。

---

## 四、缺陷清单与零留白整改方案（Drop-in Fix Proposals）

为落实纯逻辑反退避铁律，杜绝“指出问题却留给子 Agent 瞎猜”，以下出具 5 处关键缺陷的 AST 级精确零留白替换代码块。

### 4.1 DEFECT-01：`toCanonicalFsPath` 盘符大小写与相对段 `/../` 消解修复

目标文件：`apps/crish-desktop/src/api/workspaceFsApi.ts`（Spec-01 范围）  
整改目标：符合 HB-16 强制小写化，增加循环栈消除 `/../` 路径段。

```typescript
/**
 * 将任意跨平台路径归一化为系统的唯一标准规范路径（Canonical FS Path）
 * 修复：盘符强制小写 (对齐 HB-16)，消解 /./ 与 /../ 相对段，保留合法根斜杠
 */
export function toCanonicalFsPath(path: string): string {
  const p = (path || '').trim();
  if (!p) return '';

  // 1. 统一分隔符为正斜杠
  let norm = p.replace(/\\/g, '/');

  // 2. 识别 UNC 路径并压缩重复斜杠
  const isUnc = norm.startsWith('//') && !norm.startsWith('///');
  if (isUnc) {
    norm = '//' + norm.slice(2).replace(/\/+/g, '/');
  } else {
    norm = norm.replace(/\/+/g, '/');
  }

  // 3. 循环消解相对点号段 (/./ 或末尾 /.)
  while (/\/\.(?=\/|$)/.test(norm)) {
    norm = norm.replace(/\/\.(?=\/|$)/g, '');
  }

  // 4. 标准栈式消解相对父级段 (/../)
  if (norm.includes('/..')) {
    const isAbs = norm.startsWith('/');
    const driveMatch = norm.match(/^([a-zA-Z]:)(\/|$)/);
    const prefix = isUnc ? '//' : driveMatch ? driveMatch[1].toLowerCase() + '/' : isAbs ? '/' : '';
    const body = norm.slice(prefix.length);
    const segments = body.split('/').filter(Boolean);
    const stack: string[] = [];

    for (const seg of segments) {
      if (seg === '..') {
        if (stack.length > 0 && stack[stack.length - 1] !== '..') {
          stack.pop();
        } else if (!prefix) {
          stack.push('..');
        }
      } else if (seg !== '.') {
        stack.push(seg);
      }
    }
    norm = prefix + stack.join('/');
  }

  // 5. Windows 驱动器盘符强制小写化并补齐根斜杠 (严格对齐 HB-16 铁律)
  norm = norm.replace(/^([a-zA-Z]):(\/|$)/, (_, drive: string, rest: string) => {
    return `${drive.toLowerCase()}:${rest || '/'}`;
  });

  // 6. 消除非根路径末尾多余斜杠（保留 'c:/'、'/'、'//'）
  const isRoot = norm === '/' || norm === '//' || /^[a-z]:\/$/i.test(norm);
  if (norm.length > 1 && norm.endsWith('/') && !isRoot) {
    norm = norm.slice(0, -1);
  }

  return norm;
}

/**
 * 跨平台路径等值比对（修复大小写正则）
 */
export function isSameFsPath(pathA: string, pathB: string): boolean {
  const a = toCanonicalFsPath(pathA);
  const b = toCanonicalFsPath(pathB);
  if (!a || !b) return false;
  if (a === b) return true;

  // Windows 驱动器路径不敏感比对（使用 i 标志兼容小写盘符）
  if (/^[a-z]:\//i.test(a) && /^[a-z]:\//i.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }

  // Windows UNC 路径不敏感比对
  if (a.startsWith('//') && b.startsWith('//')) {
    return a.toLowerCase() === b.toLowerCase();
  }

  return false;
}
```

---

### 4.2 DEFECT-02：`getAncestorDirPaths` 根路径斜杠双拼与越界防御修复

目标文件：`apps/crish-desktop/src/api/workspaceFsApi.ts`（Spec-01 范围）  
整改目标：根路径尾斜杠安全拼接，杜绝 `c://`，增加 `..` 越界守卫。

```typescript
export function getAncestorDirPaths(targetPath: string, rootPath: string): string[] {
  const canonTarget = toCanonicalFsPath(targetPath);
  const canonRoot = toCanonicalFsPath(rootPath);

  if (!canonTarget || !canonRoot) return [];

  // 坚决阻断包含未消解遍历段的恶意逃逸
  if (/(^|\/)\.\.($|\/)/.test(canonTarget)) {
    return [];
  }

  const normRootLower = canonRoot.toLowerCase();
  const normTargetLower = canonTarget.toLowerCase();

  // 修复：安全前缀判断，杜绝 c:/ + / 变成 c:// 导致的 100% 拒真
  const rootPrefix = normRootLower.endsWith('/') ? normRootLower : normRootLower + '/';

  if (!normTargetLower.startsWith(rootPrefix)) {
    return [];
  }

  const ancestors: string[] = [];
  let curr = parentPath(canonTarget);

  while (curr) {
    const currCanon = toCanonicalFsPath(curr);
    const currLower = currCanon.toLowerCase();

    // 终止判定：抵达工作区根或已收敛
    if (currLower === normRootLower || currLower === normRootLower.replace(/\/+$/, '') || currLower.length <= normRootLower.length) {
      break;
    }

    ancestors.unshift(currCanon);
    const next = parentPath(currCanon);
    if (next === currCanon) {
      break;
    }
    curr = next;
  }

  return ancestors;
}
```

---

### 4.3 DEFECT-03：`useFileNavigation` 中 `revealPath` 大小写鲁棒性与根兼容修复

目标文件：`apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts`（Spec-02 范围）  
整改目标：修复 Windows 大小写不敏感校验，修复根目录 `//` 判定，完善失败拦截。

```typescript
  const revealPath = useCallback(
    async (filePath: string): Promise<boolean> => {
      const r = getWorkspacePath();
      if (r) setRoot(r);
      const effectiveRoot = r || root;
      if (!effectiveRoot || !filePath?.trim()) return false;

      let resolvedTarget: string;
      try {
        resolvedTarget = assertWorkspacePath(filePath);
      } catch (err) {
        // 外部文件静默返回 false，不向主树塞全局错误横幅
        return false;
      }

      const normTarget = toCanonicalFsPath(resolvedTarget);
      const normRoot = toCanonicalFsPath(effectiveRoot);

      // 修复：Windows 环境下大小写不敏感判断，且安全处理末尾斜杠
      const targetLower = normTarget.toLowerCase();
      const rootLower = normRoot.toLowerCase();
      const rootPrefix = rootLower.endsWith('/') ? rootLower : rootLower + '/';

      const isInside = targetLower.startsWith(rootPrefix) || targetLower === rootLower;
      if (!isInside) {
        return false;
      }

      // 获取自顶向下的所有直系祖先目录
      const ancestors = getAncestorDirPaths(normTarget, normRoot);

      // 根目录条目容错初拉
      if (entries.length === 0) {
        try {
          const rootEntries = await loadDir(normRoot);
          setEntries(
            rootEntries.map((e) => ({
              ...e,
              path: toCanonicalFsPath(e.path),
            })),
          );
        } catch {
          /* ignore */
        }
      }

      if (ancestors.length === 0) {
        return true;
      }

      // 筛选出尚未在 expanded 字典中的缺失祖先集
      const toLoad = ancestors.filter((dir) => !expanded[dir]);
      if (toLoad.length > 0) {
        const results: Record<string, FsDirEntry[]> = {};
        const settledResults = await Promise.allSettled(
          toLoad.map(async (dir) => {
            const list = await loadDir(dir);
            return {
              dir,
              items: list.map((it) => ({
                ...it,
                path: toCanonicalFsPath(it.path),
              })),
            };
          }),
        );

        let hasSuccess = false;
        for (const res of settledResults) {
          if (res.status === 'fulfilled') {
            results[res.value.dir] = res.value.items;
            hasSuccess = true;
          }
        }

        if (Object.keys(results).length > 0) {
          setExpanded((prev) => ({ ...prev, ...results }));
        }

        // 若全部补拉失败，返回 false
        if (!hasSuccess) {
          return false;
        }
      }

      return true;
    },
    [root, entries.length, expanded, loadDir],
  );
```

---

### 4.4 DEFECT-04：`FileTreeView` 视口 `[0, maxScrollTop]` 钳位与防劫持修复

目标文件：`apps/crish-desktop/src/components/files/FileTreeView.tsx`（Spec-03 范围）  
整改目标：代数闭环钳位位移，使用 `prevSelectedRef` 阻断 `flatTree` 重算时的视口劫持。

```typescript
    // 跟踪上一次的 selected 状态，防止 flatTree 变动时错误劫持用户视口
    const prevSelectedRef = useRef<string | null>(null);

    useEffect(() => {
      if (!selected || !containerRef.current) {
        prevSelectedRef.current = selected;
        return;
      }

      // 跨平台规范化比对目标节点索引
      const targetIndex = flatTree.findIndex((n) => isSameFsPath(n.path, selected));
      if (targetIndex === -1) return;

      // 核心防护：仅当 selected 发生真实变更时才执行视口居中与脉冲动画！
      // 杜绝用户滚动到其他目录展开/折叠时，视口被暴力拉回选中行
      const isNewSelection = !prevSelectedRef.current || !isSameFsPath(prevSelectedRef.current, selected);
      prevSelectedRef.current = selected;

      if (!isNewSelection) return;

      const container = containerRef.current;
      const viewHeight = container.clientHeight;
      if (viewHeight <= 0) return;

      const itemTop = targetIndex * ITEM_HEIGHT;
      const itemBottom = itemTop + ITEM_HEIGHT;
      const currentScrollTop = container.scrollTop;
      const maxScrollTop = Math.max(0, totalHeight - viewHeight);

      // 修复边界死区：若已在最顶部且 targetIndex 为 0，视为在视口内；否则按舒适区判定
      const isAtTopBoundary = currentScrollTop === 0 && targetIndex === 0;
      const isAtBottomBoundary = currentScrollTop >= maxScrollTop && targetIndex === flatTree.length - 1;

      const isInView =
        isAtTopBoundary ||
        isAtBottomBoundary ||
        (itemTop >= currentScrollTop + ITEM_HEIGHT &&
          itemBottom <= currentScrollTop + viewHeight - ITEM_HEIGHT);

      if (!isInView) {
        // 修复：代数严格双向钳位在 [0, maxScrollTop] 区间内
        const rawScrollTop = itemTop - Math.floor((viewHeight - ITEM_HEIGHT) / 2);
        const targetScrollTop = Math.min(maxScrollTop, Math.max(0, rawScrollTop));

        container.scrollTo({
          top: targetScrollTop,
          behavior: 'smooth',
        });
      }

      // 挂载 1.4s 呼吸高亮
      setPulseTarget(selected);
      const pulseTimer = setTimeout(() => {
        setPulseTarget(null);
      }, 1400);

      // 结合 microtask 与 rAF 尝试聚焦
      focusTreeRow(targetIndex);
      const rafId = requestAnimationFrame(() => {
        focusTreeRow(targetIndex);
      });

      return () => {
        clearTimeout(pulseTimer);
        cancelAnimationFrame(rafId);
      };
    }, [selected, flatTree, focusTreeRow, containerRef, totalHeight]);
```

---

### 4.5 DEFECT-05：Spec-04 中 `FilesCard` 与 `FileBreadcrumb` 契约消除 `cwd` 遗漏修复

目标文件：`apps/crish-desktop/src/components/files/FilesCard.tsx` 与 `FileBreadcrumb.tsx`（Spec-04 范围）  
整改目标：从顶层移除废弃属性传递，解除 TypeScript 编译阻断。

**在 `FilesCard.tsx` 中（移除 `cwd={nav.cwd}`）**：
```tsx
            {/* 面包屑导航：彻底解绑已物理删除的 cwd */}
            {!noRoot ? (
              <FileBreadcrumb
                root={nav.root}
                selected={preview.selected}
                view={preview.view}
                dirty={preview.dirty}
                onNavigate={handleNavigate}
                onOpenFile={handleOpenFile}
              />
            ) : null}
```

**在 `FileBreadcrumb.tsx` 中（将 `cwd` 改为可选兼容标记并安全降级）**：
```typescript
interface FileBreadcrumbProps {
  root: string;
  cwd?: string; // 标记为可选
  selected: string | null;
  view: ViewMode;
  dirty?: boolean;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
}
```

---

## 五、六维立体定量审核打分卡（Scorecard Matrix）

根据 `05-audit-framework-strategy.md` 第 5.1 节设定的百分制标准，对本战役规划方案执行逐项实打实评分：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    方案合理性六维定量打分体系 (总分: 84 / 100)              │
├─────────────────────────────────────────────────────────────────────────────┤
│  [维度一] 单一真理源 (SSOT) 纯度审查           │ 得分: 17 / 20 分 (85%)      │
│  [维度二] 物理删除彻底性审查                   │ 得分: 18 / 20 分 (90%)      │
│  [维度三] 用户最高裁决对齐度审查               │ 得分: 15 / 20 分 (75%)      │
│  [维度四] Design Token 100% 遵从度审查         │ 得分: 15 / 15 分 (100%)     │
│  [维度五] 反过度设计红线审查                   │ 得分: 15 / 15 分 (100%)     │
│  [维度六] 跨平台路径鲁棒性审查                 │ 得分: 04 / 10 分 (40%)      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 详细扣分与得分分析表：

| 审查维度 | 权重分 | 实得分 | 得分率 | 扣分依据与缺陷事实 |
| :--- | :---: | :---: | :---: | :--- |
| **一、SSOT 纯度** | 20分 | **17分** | 85% | 扣 3 分：Spec-04 的 `FilesCard.tsx` 中仍残留 `cwd={nav.cwd}` 传参调用，与 Spec-02 的强类型契约不兼容，破坏了真理源单轨收敛一致性。 |
| **二、物理删除彻底性** | 20分 | **18分** | 90% | 扣 2 分：Spec-04 规划未同步更新 `FileBreadcrumb.tsx` 的 Props 契约去除 `cwd`，造成存量僵尸参数死锁。其余 61 行 CSS 与上级目录按钮清理规划彻底。 |
| **三、用户裁决对齐度** | 20分 | **15分** | 75% | 扣 5 分：视口平滑停泊算法未闭环，缺少 `maxScrollTop` 上限钳位；且由于 `flatTree` 依赖导致视口被强制抢占劫持，违背了用户交互舒适性铁律。 |
| **四、Design Token 遵从**| 15分 | **15分** | 100% | 满分：全域零裸 Hex、100% 自定义 Tooltip、发丝搜索框全态无边框无重阴影、`.filesBody` 注入 `isolation: isolate` 隔离舱彻底防穿透。 |
| **五、反过度设计红线** | 15分 | **15分** | 100% | 满分：零 npm 外部路径依赖库；零同进程微服务套娃与洋葱中间件；状态正交内聚在无头 Hook 与组件内，符合 13 项禁令。 |
| **六、跨平台路径鲁棒性**| 10分 | **04分** | 40% | 扣 6 分：盘符大写违背 HB-16 扣 2 分；缺失 `/../` 消解导致逃逸漏洞扣 2 分；驱动器根目录拼接 `//` 导致合法文件 100% 拒真扣 2 分。 |
| **总计** | **100分** | **84分** | **84%** | **判定：FAIL / BLOCK。总分 < 95 分，且存在 2 项一票否决阻断项。** |

---

## 六、最终审计结论与放行裁决

### 6.1 审计裁定结论
根据仓库纪律 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1“效果锁与反退避”、§7“严禁补丁与作弊”及 `05-audit-framework-strategy.md` 第 5.2 节“方案施工准入放行四大金科玉律”，资深跨平台底层与边界安全审查专家作出最终裁决：

**❌ 暂缓签发准入放行书（HOLD / BLOCKED FOR EXECUTION）**

### 6.2 纠偏指令与闭环复审路线图
子 Agent 施工团队必须严格按照本审计报告第四节提供的 **AST 级零留白整改方案（DEFECT-01 至 DEFECT-05）**，对相关 Spec 执行**增量原子修订（Delta Revision）**：

1. **修订 Spec-01（`01-path-canonical-spec.md`）**：
   - 将盘符改为强制小写（对齐 HB-16）；
   - 补齐栈式 `/../` 相对段消解算法；
   - 修复 `getAncestorDirPaths` 的 `rootPrefix` 拼接逻辑（杜绝 `c://`）；
   - 在专属单测中追加 `/../` 逃逸防御与驱动器根目录测试用例。
2. **修订 Spec-02（`02-tree-navigation-spec.md`）**：
   - 修复 `revealPath` 中的 Windows 大小写不敏感校验与 `rootPrefix` 拼接；
   - 完善全量祖先拉取失败时的布尔返回状态机。
3. **修订 Spec-03（`03-tree-virtual-scroll-spec.md`）**：
   - 居中公式补齐 `Math.min(maxScrollTop, ...)` 闭环钳位；
   - 增加 `prevSelectedRef` 拦截 `flatTree` 变化引起的非预期视口抢占；
   - 修正边界点（第 0 项与末尾项）舒适区判定逻辑。
4. **修订 Spec-04（`04-files-card-and-breadcrumb-spec.md`）**：
   - 彻底切除 `FilesCard.tsx` 中向 `FileBreadcrumb` 传递的 `cwd={nav.cwd}`；
   - 明确声明 `FileBreadcrumbProps` 中 `cwd?: string` 的可选与解绑规划。

**完成上述增量修订后，重新发起增量复审（Delta Re-Audit）。一旦一票否决项违规归零且评分超过 95 分，主控将立即正式签发 Audit Clearance 准入放行指令，准许启动阶段四子 Agent 并行施工！**

---
*审计报告定稿完毕。遵循纯逻辑工程规划，全量技术事实均有数学代数与源码指纹确凿证据支持，无虚饰，无妥协。*
