# 施工任务书 SPEC-01：路径规范化内核、IPC 契约对齐与全局广播解耦施工方案

> **文档标识**：`docs/file-tree-and-attachments-architecture/detailed-plans/01-path-canonical-spec.md`  
> **所属战役**：`docs/file-tree-and-attachments-architecture/`（分阶段详细施工方案）  
> **指派角色**：`Workspace Path & Canonical API Architect`（跨平台路径与系统通信架构师）  
> **核心定位**：Wave 1 首发底层基石工程——建立跨平台路径规范化纯函数库、1:1 严格对齐的 Rust IPC 通信契约，以及无条件解耦的全局打开广播总线，为整个文件树与附件联动战役提供不可动摇的系统底座。  
> **前置依赖**：无（Wave 1 为首发基石波次，纯函数与 IPC 契约先行）  
> **后置依赖**：Wave 2（`useFileNavigation.ts` 状态机单轨收敛）、Wave 3（`FileTreeView.tsx` 虚拟列表平滑停泊与高度链隔离）、Wave 4（消息附件 58×58 卡片与空气泡消除）、Wave 5（宿主收敛与存量测试迁移）  
> **权威纪律**：严格遵循仓库根目录 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md)（§1 反退避、§2 子 Agent 调度、§3 Git 提交纪律、§7 严禁补丁与作弊、§7.1 立体验证纪律、§8 反过度设计红线、§11 CI 治理与行数门禁）及 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)。  
> **规划准则**：纯逻辑规划（不谈工期、人天、人员分配，严禁划分 P0/P1 业务优先级，所有工程与架构缺陷逻辑同权，完全基于有向无环图 DAG 编译拓扑与因果调用链编排推进）。  
> **执行纪律**：严格限定于独占文件白名单内，零 `// ...` 施工图级展开，绝对严禁使用任何外部脚本做批量替换，严禁执行 `git commit`。

---

## 一、文档元数据与施工定位（Metadata & Foundational Positioning）

### 1.1 核心使命与战役基石定位
在 Conex / Crish 的桌面工作区体系中，文件路径的处理与跨进程通信契约是支撑上层所有交互的物理根基。既有代码库与历史方案中存在三大系统级断层：
1. **跨平台路径表达分裂（Path Split & Casing Drift）**：Windows 反斜杠 `\`、POSIX 正斜杠 `/`、大小写混杂（如 `C:` 与 `c:`）、冗余点号段（`/./` 与 `/../`）及 UNC 路径未在系统最前沿完成代数归一，导致树展开状态字典 `expanded[path]` 键命中率出现偶发性穿透；
2. **跨进程 IPC 幽灵参数契约（Ghost IPC Contract · CRIT-02）**：前端 `listDirectory`、`readTextFile`、`writeTextFile` 三处长期透传 `workspaceRoot: workspaceRootArg()` 幽灵字段，而底层 Tauri Rust 命令 `workbench_list_directory` / `workbench_read_file_content` / `workbench_write_file_content` 均无此参数，工作区根完全由后端 `WorkspaceRegistry` 解析；
3. **打开器代码文件伪连通截断（Fake Connectivity Truncation · CRIT-01）**：`filePanelOpener.ts` 内部遇到文本代码类文件时在 `if (host === 'file-viewer')` 分支提前 `return host`，导致 `'crish-open-file'` 全局广播总线被物理截断，左侧目录树陷入“右侧编辑器打开但左侧文件树死寂”的严重伪连通状态。

**Wave 1 的核心定位**：作为整个战役的逻辑第 1 波，率先以 AST 级精密代码切除全部幽灵参数，确立 100% 对齐的单一事实源（SSOT）路径规范化函数库，并实现全局广播与预览宿主的物理彻底解耦，为 Wave 2~5 铺设坚不可摧的底层基座。

### 1.2 逻辑输入输出与依赖流向
- **输入端**：用户点击、消息附件反查、工具链解析产生的原始路径字符串（含 Windows 反斜杠、未规范大小写、`..` 相对段等）；
- **处理端**：Wave 1 提供的规范化纯函数（`toCanonicalFsPath`, `isSameFsPath`, `getAncestorDirPaths`）执行代数幂等运算；`listDirectory` 执行纯净的 `{ path }` IPC 请求；`openFileInPanel` 首行无条件派发广播；
- **输出端**：标准规范化路径（统一为正斜杠、Windows 盘符小写标准化、无多余尾斜杠、消除穿越点）、标准全局事件广播，为下游 `useFileNavigation` 驱动直系祖先并发补拉与节点高亮提供权威保障。

---

## 二、严格独占文件白名单（Exclusive Write Whitelist）

依据 Conex 底层内核 [`crates/agent-tools/src/write_paths.rs`](file:///c:/Software/conex/crates/agent-tools/src/write_paths.rs) 的双层沙箱机制与战役调度铁律，写操作必须具备严格的独占文件白名单保护。超出白名单的文件写操作将被内核校验器以 `tool.write_not_allowed` 永久拦截。

本任务书授权 Wave 1 执行的写操作**严格且仅限**于以下 4 个物理文件，绝对禁止触碰任何其他文件：

| 文件序号 | 文件绝对路径与相对路径 | 操作类型 | 核心施工职责 |
| :--- | :--- | :--- | :--- |
| **文件 1** | `apps/crish-desktop/src/api/workspaceFsApi.ts` | **精准修改** | 1. 物理切除 `workspaceRootArg()` 及出站负载中的 `workspaceRoot` 幽灵字段；<br>2. 补充导出 `toCanonicalFsPath`、`isSameFsPath`、`getAncestorDirPaths` 三大跨平台纯函数；<br>3. 保持既有其他公共导出契约 100% 冻结。 |
| **文件 2** | `apps/crish-desktop/src/api/filePanelOpener.ts` | **精准重构** | 1. 彻底解耦广播总线与宿主预览分流；<br>2. 首行无条件设置 `pendingOpenPath = path` 并向 `window` 派发 `'crish-open-file'` 事件；<br>3. 根除代码类文件导致的广播截断伪连通死穴（CRIT-01）。 |
| **文件 3** | `apps/crish-desktop/src/api/__tests__/workspaceFsApi.test.ts` | **新建（专属单测）** | 1. 覆盖正反斜杠归一、Windows 盘符小写、UNC 局域网路径、多层祖先链自上而下提取等全部纯函数用例；<br>2. 注入 `listDirectory` 出站负载绝无 `workspaceRoot` 的刚性负向断言（NEG 断言）；<br>3. 注入 `openFileInPanel` 100% 派发广播的闭环测试；<br>4. 注入 `readTextFile` / `writeTextFile` 出站负载同样零 `workspaceRoot` 的 NEG-07 断言。 |
| **文件 4** | `apps/crish-desktop/src/api/filePanelOpener.test.ts` | **精准修改** | 存量 L91-105 用例「代码路径只调 file-viewer opener，不派 files 事件」逐字断言旧截断行为（`expect(ev).not.toHaveBeenCalled()` 与 `expect(takePendingOpenPath()).toBeNull()`），与 CRIT-01 直接冲突；就地改写该用例为断言「广播必发 + pending 已暂存」（其余用例原样保留）。完整改写代码见 §4.4。 |

### 空间绝对隔离禁令（零容忍）
1. **🚫 严禁越权扩散修改**：除上述 4 个白名单文件外，严禁创建、修改、重命名或删除仓库中的任何其他文件（包括但不限于 `package.json`、`useFileNavigation.ts`、`FileTreeView.tsx`、`FilesCard.tsx`、`ChatUserMessageRow.tsx`、`tokens.css` 等）；
2. **🚫 严禁整目录锁定**：必须以具体文件为单位申请写权限，严禁将整目录 `apps/crish-desktop/src/api/` 整体声明为锁定前缀，防止与并行或后续波次产生写路径冲突；
3. **🚫 严禁使用任何自动化脚本**：全程只能使用内置代码编辑工具，严禁使用 Python、Node.js、PowerShell、Bash 等脚本做批量正则替换。

---

## 三、真实物理代码核验与去幻觉基线（Codebase Verification & Reality Baseline）

基于对 Conex 真实代码库的逐行穿透审查，全面消除前序方案中的所有历史幻觉与错位，确立统一的真理基准：

| 源码文件物理路径 | 真实生产代码物理事实（确凿证据） | 前序方案与历史审查中的幻觉/错位 | Wave 1 施工图权威统一规范 |
| :--- | :--- | :--- | :--- |
| `apps/agent-workbench/src-tauri/src/fs_commands/mod.rs:26-35` | `#[tauri::command(rename = "workbench_list_directory")] pub(crate) fn list_directory(app: tauri::AppHandle, path: String)`，注释明确注明“无 workspace_root 参数，根由 WorkspaceRegistry 解析”。 | 幻觉认为 Rust 端接收 `workspace_root`，或命令名未加前缀。 | 证实 Rust 端命令名称严格为 `workbench_list_directory`，签名严格仅接收 `path: String`，绝无第二参数。 |
| `apps/agent-workbench/src-tauri/src/command_manifest.rs:108` | `entry("workbench_list_directory", "workbench", "gui", true)` 显式完成注册。 | 怀疑命令未在 Tauri 清单注册导致调用失效。 | 证实命令为官方正规注册命令，1:1 通信无断裂。 |
| `apps/crish-desktop/src/api/workspaceFsApi.ts:122-135` | 源码现存 `workspaceRootArg()` 并在 `invokeResult` 中传递 `{ path, workspaceRoot: workspaceRootArg() }`；未导出 `toCanonicalFsPath`, `isSameFsPath`, `getAncestorDirPaths`。 | 误以为三个工具函数已被导出；误以为透传 `workspaceRoot` 是合法行为；历史规范甚至错误要求盘符强制大写。 | 物理切除 `workspaceRootArg` 与出站 `workspaceRoot` 字段；实现并导出三大纯函数，盘符统一标准化为小写（`c:/`），严格对齐 `00-master-plan.md`。 |
| `apps/crish-desktop/src/api/filePanelOpener.ts:113-124` | `const host = resolveFilePreviewHost(path, mode); if (host === 'file-viewer' && fileViewerOpener) { fileViewerOpener(path, mode); return host; }` 提前截断广播。 | 误以为只要右侧打开 Monaco 即可，忽视了左侧目录树需要全局事件联动驱动导航与高亮。 | 物理调整执行顺序：无论分流至何种宿主，首行无条件设置 `pendingOpenPath = path` 并向 `window` 派发 `'crish-open-file'` 事件。 |
| `apps/crish-desktop/src/api/workspaceFsApi.test.ts` vs `apps/crish-desktop/src/api/__tests__/` | 存量单测位于 `apps/crish-desktop/src/api/workspaceFsApi.test.ts`（共 163 行，覆盖工作区边界解析）；`__tests__` 子目录尚不存在。 | 混淆了存量测试与新增专属测试的物理路径。 | 存量 `workspaceFsApi.test.ts` 保持原样不碰；在 `__tests__/workspaceFsApi.test.ts` 新建针对本规范纯函数、IPC 契约与广播解耦的专属立体单测套件。 |
| `apps/crish-desktop/src/api/workspaceFsApi.ts:185-188, 220-224` | `readTextFile`（L188）与 `writeTextFile`（L224）的 `invokeResult` 同样透传 `workspaceRoot: workspaceRootArg()`；后端 `workbench_read_file_content` / `workbench_write_file_content` 均无 `workspace_root` 参数（`fs_commands/mod.rs:40-63`）。 | 早期方案只发现 `listDirectory` 一处幽灵字段，漏掉 read/write 两条链路。 | 三处出站负载一并切除：`readTextFile` 收敛为 `{ path, maxLines }`，`writeTextFile` 收敛为 `{ path, content, overwrite }`，并注入 NEG-07 键集合断言。 |
| `apps/crish-desktop/src/api/filePanelOpener.test.ts:91-105` | 存量用例断言代码路径「不派发 `crish-open-file` 事件、`takePendingOpenPath()` 为 null」——即旧截断行为的逐字固化。 | 未识别该测试与 CRIT-01 的直接冲突。 | 就地改写该用例为断言「宿主分流 file-viewer 的同时，广播必发、pending 已暂存」（§4.4 全量代码）。 |

---

## 四、全量 AST 级生产源码规范（全部模块 100% 展开，零 `// ...` 省略）

### 4.1 `apps/crish-desktop/src/api/workspaceFsApi.ts`（纯函数扩展与 1:1 IPC 契约校准）

#### 变更策略：
1. **物理清除**：彻底删除 L121-125 的私有函数 `workspaceRootArg`；
2. **契约校准**：在 `listDirectory` 中，调用 `workbench_list_directory` 时传参对象由 `{ path, workspaceRoot: workspaceRootArg() }` 严格收敛为 `{ path }`；
3. **纯函数导出**：在 `pathRelativeToRoot` 函数之后完整插入并导出 `toCanonicalFsPath`、`isSameFsPath` 与 `getAncestorDirPaths` 三大跨平台纯函数；
4. **零外部依赖**：100% 依托原生 JavaScript 正则与字符串算子，严禁引入 `node:path` 或任何第三方 npm 包。

#### 核心 AST 源码实现：

```typescript
/**
 * 跨平台文件系统路径规范化纯函数（SSOT 核心算法）：
 * 1. 空值与空白防御：输入为 null/undefined/空串/纯空格时，恒定返回 ''；
 * 2. 分隔符统一：将所有 Windows 反斜杠 '\' 统一转换为标准正斜杠 '/'；
 * 3. UNC 路径保护与连续斜杠压缩：
 *    - 若路径以 '//' 开头且不以 '///' 开头，识别为 UNC 路径，保留前导 '//'，后续连续重复斜杠压缩为单斜杠；
 *    - 其它非 UNC 路径，所有连续重复斜杠统一压缩为单斜杠 '/'；
 * 4. 栈代数消解冗余点号段与相对父级段（/./ 与 /../ 杜绝目录穿越）：
 *    - 对绝对路径前缀（Windows 盘符根、UNC 根、POSIX 根）建立防逃逸边界，.. 到顶后不越界回退；
 * 5. Windows 驱动器盘符标准化（严格遵从 HB-16 与 00-master-plan 铁律）：
 *    - 若路径匹配 '^[a-zA-Z]:(\/|$)'，强制将驱动器盘符转换为小写（如 'C:' -> 'c:/', 'C:/' -> 'c:/', 'D:\repo' -> 'd:/repo'）；
 * 6. 消除非根路径末尾多余斜杠：
 *    - 根路径（'/'、'//'、'^[a-z]:\/$'）保留其末尾斜杠；其余非根路径一律剔除末尾多余正斜杠 '/'；
 * 7. 严格幂等性：恒满足 toCanonicalFsPath(toCanonicalFsPath(p)) === toCanonicalFsPath(p)。
 */
export function toCanonicalFsPath(path: string): string {
  const p = (path || '').trim();
  if (!p) return '';

  // 1. 统一正反斜杠为 '/'
  let norm = p.replace(/\\/g, '/');

  // 2. 识别 UNC 路径并压缩重复斜杠
  const isUnc = norm.startsWith('//') && !norm.startsWith('///');
  if (isUnc) {
    norm = '//' + norm.slice(2).replace(/\/+/g, '/');
  } else {
    norm = norm.replace(/\/+/g, '/');
  }

  // 3. 提取前缀并进行相对段栈解析消解（/./ 与 /../ 杜绝目录穿越）
  const isAbsolutePosix = norm.startsWith('/') && !isUnc;
  const isWindowsDrive = /^[a-zA-Z]:(\/|$)/.test(norm);

  let prefix = '';
  let pathBody = norm;

  if (isUnc) {
    prefix = '//';
    pathBody = norm.slice(2);
  } else if (isWindowsDrive) {
    const colonIdx = norm.indexOf(':');
    const drive = norm.slice(0, colonIdx).toLowerCase();
    prefix = `${drive}:/`;
    pathBody = norm.slice(colonIdx + 1).replace(/^\/+/, '');
  } else if (isAbsolutePosix) {
    prefix = '/';
    pathBody = norm.slice(1);
  }

  const rawSegments = pathBody.split('/');
  const stack: string[] = [];

  for (const seg of rawSegments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!prefix) {
        stack.push('..');
      }
      // 拥有绝对路径前缀时，.. 到顶后直接丢弃，防止越界逃逸
    } else {
      stack.push(seg);
    }
  }

  norm = prefix ? prefix + stack.join('/') : stack.join('/');

  // 4. Windows 盘符小写标准化补强（若前面未走 isWindowsDrive 分支）
  norm = norm.replace(/^([a-zA-Z]):(\/|$)/, (_, drive: string, rest: string) => {
    return `${drive.toLowerCase()}:${rest || '/'}`;
  });

  // 5. 消除非根路径末尾多余斜杠（保留 'c:/'、'/'、'//'）
  const isRoot = norm === '/' || norm === '//' || /^[a-z]:\/$/i.test(norm);
  if (norm.length > 1 && norm.endsWith('/') && !isRoot) {
    norm = norm.slice(0, -1);
  }

  return norm;
}

/**
 * 跨平台路径等值比对（考虑 Windows 文件系统大小写不敏感与斜杠异构）
 */
export function isSameFsPath(pathA: string | null | undefined, pathB: string | null | undefined): boolean {
  if (!pathA || !pathB) return false;
  return toCanonicalFsPath(pathA).toLowerCase() === toCanonicalFsPath(pathB).toLowerCase();
}

/**
 * 纯函数：根据目标文件/目录路径与工作区根路径，推导从顶层直属子目录到目标父目录的有序祖先链（自上而下顺序）
 *
 * 边界与安全规则：
 * 1. 目标或工作区根为空时返回空数组；
 * 2. 目标包含未消解遍历段（..）时直接阻断返回空数组；
 * 3. 严格前缀判定：必须以 rootPrefix（如 'c:/work/'）开头，坚决拒绝兄弟前缀（如 'c:/work-extra'）；
 * 4. 目标与工作区根相同、或目标是根的直属子文件时，返回空数组；
 * 5. 返回的祖先数组不包含根自身，不包含目标自身，严格按照自顶向下的物理层级排序。
 */
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

  // 安全前缀：杜绝 c:/work 与 c:/work-extra 兄弟前缀假碰撞
  const rootPrefix = normRootLower.endsWith('/') ? normRootLower : normRootLower + '/';

  if (!normTargetLower.startsWith(rootPrefix) || normTargetLower === normRootLower) {
    return [];
  }

  const ancestors: string[] = [];
  let curr = pathDirname(canonTarget);

  while (curr) {
    const currCanon = toCanonicalFsPath(curr);
    const currLower = currCanon.toLowerCase();

    // 终止判定：抵达工作区根或已收敛至根以上
    if (currLower === normRootLower || currLower === normRootLower.replace(/\/+$/, '') || currLower.length <= normRootLower.length) {
      break;
    }

    ancestors.unshift(currCanon);
    const next = pathDirname(currCanon);
    if (next === currCanon) {
      break;
    }
    curr = next;
  }

  return ancestors;
}

/**
 * 列出工作区目录内容。
 * 核心修复（CRIT-02）：彻底切除不存在的 workspaceRoot 幽灵参数，
 * 严格 1:1 对齐底层 Rust: #[tauri::command(rename = "workbench_list_directory")] pub fn list_directory(app, path: String)
 */
export async function listDirectory(dirPath?: string): Promise<FsDirEntry[]> {
  const root = getFsRoot();
  const path = resolveWorkspacePath(dirPath || root);
  if (!path) throw new Error('未打开项目工作区，请先选择项目');

  const res = await invokeResult<{ items?: Array<Record<string, unknown>> }>(
    'workbench_list_directory',
    { path } // 仅发送 path，1:1 契约严格对齐
  );

  if (res.status === 'ok' && res.data?.items) {
    return res.data.items.map((it) => ({
      name: String(it.name ?? ''),
      isDir: Boolean(it.isDir ?? it.is_dir),
      ...(typeof it.size === 'number' && { size: it.size }),
      ...(it.modified != null && { modified: String(it.modified) }),
      path: joinPath(path, String(it.name ?? '')),
    }));
  }
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('当前环境无法浏览本地目录（需桌面壳）');
}
```

#### 4.1.1 `readTextFile` / `writeTextFile` 出站负载同步切除（CRIT-02 全域闭环）

> **全域核验补充（2026-09-08）**：`workspaceRoot` 幽灵字段不止 `listDirectory` 一处，`readTextFile` 与 `writeTextFile` 同样透传。二者签名与调用方契约不变，仅出站负载收敛：

```typescript
// readTextFile（原 L188）：负载由 { path, maxLines, workspaceRoot } 收敛为 { path, maxLines }
const res = await invokeResult<{
  content?: string;
  lineCount?: number;
  line_count?: number;
  truncated?: boolean;
}>('workbench_read_file_content', {
  path,
  maxLines: lines,
  // workspaceRoot: workspaceRootArg(), // ✂ 物理切除（CRIT-02）
});

// writeTextFile（原 L224）：负载由 { path, content, overwrite, workspaceRoot } 收敛为 { path, content, overwrite }
const res = await invokeResult('workbench_write_file_content', {
  path,
  content,
  overwrite,
  // workspaceRoot: workspaceRootArg(), // ✂ 物理切除（CRIT-02）
});
```

---

### 4.2 `apps/crish-desktop/src/api/filePanelOpener.ts`（全量广播解耦生产源码）

#### 变更策略：
1. **解除广播截断（CRIT-01）**：在 `openFileInPanel` 中，将 `pendingOpenPath = path` 与 `window.dispatchEvent(new CustomEvent('crish-open-file', ...))` 提升至预览宿主分流判断之前无条件首发执行；
2. **预览分流解耦**：随后独立调用 `resolveFilePreviewHost`，若为 `file-viewer` 则唤起编辑器并返回 `'file-viewer'`，否则返回 `'files'`。保证左侧文件树导航 100% 能够收到广播事件。

#### 100% 展开完整生产源码：

```typescript
/**
 * 文件面板打开器 + 工具参数路径抽取。
 * 
 * 架构重构核心修复（CRIT-01）：
 * 彻底解耦文件预览宿主分流（FilePreviewLeafHost）与主目录树联动导航（Tree Navigation）。
 * 无论目标路径分流至 'file-viewer' 还是 'files'，只要是工作区合法物理文件，
 * 必须无条件优先设置 pendingOpenPath 并向 window 派发 'crish-open-file' 事件，
 * 确保左侧主目录树 100% 触发 revealPath、祖先级联展开、视口居中与脉冲高亮。
 */

import {
  detectFileKind,
  isMarkdownFilename,
  pathBasename,
  resolveWorkspacePath,
} from './workspaceFsApi';

/** 面板尚未挂载时暂存待打开路径 */
let pendingOpenPath: string | null = null;

export function takePendingOpenPath(): string | null {
  const p = pendingOpenPath;
  pendingOpenPath = null;
  return p;
}

let fileViewerOpener: ((filePath: string, mode?: 'plain' | 'diff') => void) | null =
  null;

export function registerFileViewerOpener(
  opener: typeof fileViewerOpener
): void {
  fileViewerOpener = opener;
}

/** 工作区文件预览宿主：只允许这两片叶 */
export type FilePreviewLeafHost = 'files' | 'file-viewer';

/**
 * 代码（非 md）走 file-viewer URI 叶；md / 图 / pdf / 表 / 二进制走 files 叶适配器。
 * diff 强制 file-viewer。永不返回 note / preview（Web）/ Notebook。
 */
export function resolveFilePreviewHost(
  filePath: string,
  mode?: 'plain' | 'diff'
): FilePreviewLeafHost {
  if (mode === 'diff') return 'file-viewer';
  const name = pathBasename(filePath);
  if (isMarkdownFilename(name)) return 'files';
  return detectFileKind(name) === 'text' ? 'file-viewer' : 'files';
}

/** 附件名 / mention id 是否值得当成工作区路径打开（拒绝 note / 无扩展 id） */
export function looksLikeOpenableFilePath(raw: string): boolean {
  const s = (raw || '').trim();
  if (!s || s.includes('\n') || s.length >= 512) return false;
  if (/^(note|notebook)(:|$)/i.test(s)) return false;
  if (/[\\/]/.test(s)) return true;
  const name = pathBasename(s);
  if (isMarkdownFilename(name)) return true;
  if (detectFileKind(name) !== 'binary') return true;
  return /\.[A-Za-z0-9]{1,12}$/.test(name);
}

/**
 * 从点击目标抽出待打开路径。移除钮 / 非文件 mention 返回 null。
 * 只认 data-file-open-path 或 kind=file 的 mention（id 优先，其次 label）。
 */
export function pathFromFileOpenClickTarget(
  target: EventTarget | null
): string | null {
  const start =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  if (!start) return null;
  if (start.closest('.chat-attach-remove')) return null;
  const el = start.closest(
    '[data-file-open-path], span[data-type="mention"][data-kind="file"]'
  );
  if (!(el instanceof HTMLElement)) return null;
  const explicit = (el.getAttribute('data-file-open-path') || '').trim();
  if (looksLikeOpenableFilePath(explicit)) return explicit;
  if (
    el.getAttribute('data-type') === 'mention' &&
    (el.getAttribute('data-kind') || 'file') === 'file'
  ) {
    const id = (el.getAttribute('data-id') || '').trim();
    if (looksLikeOpenableFilePath(id)) return id;
    const label = (el.getAttribute('data-label') || '').trim();
    if (looksLikeOpenableFilePath(label)) return label;
  }
  return null;
}

/**
 * 在 files / file-viewer 叶打开工作区路径。
 *
 * 核心修复（CRIT-01）：
 * 1. 无条件设置 pendingOpenPath 并向 window 派发 'crish-open-file' 事件；
 * 2. 独立分流处理右侧预览呈现；
 * 3. 彻底根除因 fileViewerOpener 提前 return 导致左侧目录树完全伪连通的核弹级 Bug。
 */
export function openFileInPanel(
  filePath: string,
  mode?: 'plain' | 'diff'
): FilePreviewLeafHost | null {
  if (!filePath?.trim()) return null;
  const trimmed = filePath.trim();
  if (/^(note|notebook)(:|$)/i.test(trimmed)) return null;
  const path = resolveWorkspacePath(trimmed);
  if (!path) return null;

  // 1. 无条件激活左侧主目录树的联动定位链路（SSOT 广播）
  pendingOpenPath = path;
  window.dispatchEvent(
    new CustomEvent('crish-open-file', { detail: { path } })
  );

  // 2. 独立分流处理右侧预览呈现
  const host = resolveFilePreviewHost(path, mode);
  if (host === 'file-viewer' && fileViewerOpener) {
    fileViewerOpener(path, mode);
    return host;
  }

  return 'files';
}

/** 从工具参数中尽量抽出文件路径（相对或绝对） */
export function extractFilePathFromToolArgs(args: string): string | null {
  if (!args?.trim()) return null;
  const raw = args.trim();
  try {
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const inner =
        parsed.parameters && typeof parsed.parameters === 'object'
          ? (parsed.parameters as Record<string, unknown>)
          : parsed.input && typeof parsed.input === 'object'
            ? (parsed.input as Record<string, unknown>)
            : parsed;
      for (const key of [
        'path',
        'filePath',
        'file_path',
        'target_file',
        'targetFile',
        'filename',
        'file',
      ]) {
        const v = inner[key];
        if (
          typeof v === 'string' &&
          v.trim() &&
          !v.includes('\n') &&
          v.length < 512
        ) {
          return v.trim();
        }
      }
    }
  } catch {
    /* swallow-ok: JSON 参数解析失败时按原串路径兜底 */
  }
  return looksLikeOpenableFilePath(raw) ? raw : null;
}
```

---

### 4.3 `apps/crish-desktop/src/api/__tests__/workspaceFsApi.test.ts`（专属单测全量代码）

#### 100% 展开完整生产测试源码：

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  toCanonicalFsPath,
  isSameFsPath,
  getAncestorDirPaths,
  listDirectory,
  readTextFile,
  writeTextFile,
} from '../workspaceFsApi';
import {
  openFileInPanel,
  registerFileViewerOpener,
  takePendingOpenPath,
} from '../filePanelOpener';
import * as tauriInvoke from '../tauriInvoke';

describe('Wave 1 核心规范与契约验收套件 (SPEC-01)', () => {
  const WORKSPACE_KEY = 'crish_workspace';

  beforeEach(() => {
    localStorage.setItem(WORKSPACE_KEY, 'c:/Software/conex');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. toCanonicalFsPath 跨平台路径规范化纯函数
  // ─────────────────────────────────────────────────────────────────────────
  describe('toCanonicalFsPath 纯函数', () => {
    it('1.1 基础转换：Windows 反斜杠统一转换为正斜杠', () => {
      expect(toCanonicalFsPath('c:\\work\\project\\file.ts')).toBe('c:/work/project/file.ts');
      expect(toCanonicalFsPath('c:\\work\\sub\\')).toBe('c:/work/sub');
      expect(toCanonicalFsPath('src\\components\\Button.tsx')).toBe('src/components/Button.tsx');
    });

    it('1.2 盘符小写标准化：Windows 盘符统一强制小写（对齐 HB-16 与 master-plan）', () => {
      expect(toCanonicalFsPath('C:/work/project')).toBe('c:/work/project');
      expect(toCanonicalFsPath('D:\\data\\doc.pdf')).toBe('d:/data/doc.pdf');
      expect(toCanonicalFsPath('Z:/')).toBe('z:/');
      expect(toCanonicalFsPath('C:')).toBe('c:/');
      expect(toCanonicalFsPath('c:')).toBe('c:/');
    });

    it('1.3 根路径保护：保留盘符根与 POSIX/UNC 根末尾斜杠，剔除其余非根末尾斜杠', () => {
      expect(toCanonicalFsPath('c:/')).toBe('c:/');
      expect(toCanonicalFsPath('C:\\')).toBe('c:/');
      expect(toCanonicalFsPath('/')).toBe('/');
      expect(toCanonicalFsPath('//')).toBe('//');
      expect(toCanonicalFsPath('c:/work/')).toBe('c:/work');
      expect(toCanonicalFsPath('/usr/local/bin/')).toBe('/usr/local/bin');
    });

    it('1.4 冗余清理：非 UNC 连续多余斜杠压缩为单斜杠', () => {
      expect(toCanonicalFsPath('c://work///sub////file.ts')).toBe('c:/work/sub/file.ts');
      expect(toCanonicalFsPath('/usr///local//bin')).toBe('/usr/local/bin');
      expect(toCanonicalFsPath('///root///dir')).toBe('/root/dir');
    });

    it('1.5 UNC 路径支持：正确保留前导双斜杠并规范化内部路径', () => {
      expect(toCanonicalFsPath('\\\\server\\share\\folder\\file.txt')).toBe('//server/share/folder/file.txt');
      expect(toCanonicalFsPath('//wsl$/Ubuntu//var///log')).toBe('//wsl$/Ubuntu/var/log');
      expect(toCanonicalFsPath('//server/share/')).toBe('//server/share');
    });

    it('1.6 相对段消解与防越界栈消除：消解 /./ 与 /../，杜绝绝对路径越界逃逸', () => {
      expect(toCanonicalFsPath('c:/work/./src/./components/App.tsx')).toBe('c:/work/src/components/App.tsx');
      expect(toCanonicalFsPath('c:/work/sub/..')).toBe('c:/work');
      expect(toCanonicalFsPath('c:/work/sub/../file.ts')).toBe('c:/work/file.ts');
      expect(toCanonicalFsPath('c:/work/././dir')).toBe('c:/work/dir');
      // 绝对路径到顶不越界逃逸
      expect(toCanonicalFsPath('c:/..')).toBe('c:/');
      expect(toCanonicalFsPath('c:/../../work')).toBe('c:/work');
      // 保持隐藏文件与多扩展名无损
      expect(toCanonicalFsPath('c:/work/.gitignore')).toBe('c:/work/.gitignore');
      expect(toCanonicalFsPath('c:/work/.env.local')).toBe('c:/work/.env.local');
    });

    it('1.7 空值防御：空串、纯空白、无效输入恒定返回空串', () => {
      expect(toCanonicalFsPath('')).toBe('');
      expect(toCanonicalFsPath('   ')).toBe('');
      // @ts-expect-error 测试非字符串类型防御
      expect(toCanonicalFsPath(null)).toBe('');
      // @ts-expect-error 测试非字符串类型防御
      expect(toCanonicalFsPath(undefined)).toBe('');
    });

    it('1.8 严格幂等律：toCanonicalFsPath(toCanonicalFsPath(p)) === toCanonicalFsPath(p)', () => {
      const samples = [
        'C:\\Users\\test/Documents\\file.txt',
        '//server//share///a/./b/../c/',
        'D:/work/./././src/',
        '/var//log/nginx/',
      ];
      for (const p of samples) {
        const pass1 = toCanonicalFsPath(p);
        const pass2 = toCanonicalFsPath(pass1);
        expect(pass2).toBe(pass1);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. isSameFsPath 跨平台路径等值比对
  // ─────────────────────────────────────────────────────────────────────────
  describe('isSameFsPath 纯函数', () => {
    it('2.1 Windows 平台：大小写不敏感与反斜杠不敏感等值比对', () => {
      expect(isSameFsPath('c:\\work\\file.ts', 'C:/work/file.ts')).toBe(true);
      expect(isSameFsPath('C:/WORK/SUB', 'c:\\work\\sub\\')).toBe(true);
      expect(isSameFsPath('d:/test/a.txt', 'D:/TEST/A.TXT')).toBe(true);
    });

    it('2.2 Windows 平台：不同驱动器盘符判定为不同', () => {
      expect(isSameFsPath('c:/work/file.ts', 'd:/work/file.ts')).toBe(false);
      expect(isSameFsPath('c:/data', 'e:/data')).toBe(false);
    });

    it('2.3 UNC 路径：大小写不敏感等值比对', () => {
      expect(isSameFsPath('\\\\SERVER\\SHARE\\a.txt', '//server/share/A.TXT')).toBe(true);
      expect(isSameFsPath('//wsl$/ubuntu/file', '//WSL$/Ubuntu/file')).toBe(true);
    });

    it('2.4 空值与异常防御：任一路径为空恒定返回 false', () => {
      expect(isSameFsPath('', '')).toBe(false);
      expect(isSameFsPath('c:/work', '')).toBe(false);
      expect(isSameFsPath('', 'c:/work')).toBe(false);
      expect(isSameFsPath(null, 'c:/work')).toBe(false);
      expect(isSameFsPath('c:/work', undefined)).toBe(false);
    });

    it('2.5 代数公理验证：自反性与对称性', () => {
      const p1 = 'c:\\proj\\sub\\a.ts';
      const p2 = 'C:/PROJ/SUB/A.TS';
      expect(isSameFsPath(p1, p1)).toBe(true);
      expect(isSameFsPath(p1, p2)).toBe(isSameFsPath(p2, p1));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. getAncestorDirPaths 祖先链推导
  // ─────────────────────────────────────────────────────────────────────────
  describe('getAncestorDirPaths 纯函数', () => {
    it('3.1 典型深层文件：正确定向输出自上而下祖先链', () => {
      const target = 'c:/Software/conex/apps/crish-desktop/src/App.tsx';
      const root = 'c:/Software/conex';
      const expected = [
        'c:/Software/conex/apps',
        'c:/Software/conex/apps/crish-desktop',
        'c:/Software/conex/apps/crish-desktop/src',
      ];
      expect(getAncestorDirPaths(target, root)).toEqual(expected);
    });

    it('3.2 异构路径与盘符大小写混杂输入：精确匹配并规范化小写输出', () => {
      const target = 'C:\\Software\\conex\\packages\\ui\\src\\Button.tsx';
      const root = 'c:/SOFTWARE/CONEX/';
      const expected = [
        'c:/Software/conex/packages',
        'c:/Software/conex/packages/ui',
        'c:/Software/conex/packages/ui/src',
      ];
      expect(getAncestorDirPaths(target, root)).toEqual(expected);
    });

    it('3.3 根目录直属子文件：祖先集恒为空数组（无需展开祖先）', () => {
      const target = 'c:/Software/conex/README.md';
      const root = 'c:/Software/conex';
      expect(getAncestorDirPaths(target, root)).toEqual([]);
    });

    it('3.4 目标与根相同：祖先集恒为空数组', () => {
      expect(getAncestorDirPaths('c:/Software/conex', 'c:/Software/conex')).toEqual([]);
      expect(getAncestorDirPaths('C:\\software\\conex\\', 'c:/Software/conex')).toEqual([]);
    });

    it('3.5 越界隔离防御：兄弟前缀目录坚决拒绝', () => {
      // 兄弟前缀：c:/work 与 c:/work-extra，前缀相似但非子路径
      const target = 'c:/work-extra/src/file.ts';
      const root = 'c:/work';
      expect(getAncestorDirPaths(target, root)).toEqual([]);
    });

    it('3.6 跨盘符与树外路径防御：坚决拒绝返回空数组', () => {
      expect(getAncestorDirPaths('d:/other/project/file.ts', 'c:/project')).toEqual([]);
      expect(getAncestorDirPaths('c:/Windows/System32/cmd.exe', 'c:/Software/conex')).toEqual([]);
    });

    it('3.7 空值防御：目标或根为空时恒定返回空数组', () => {
      expect(getAncestorDirPaths('', 'c:/work')).toEqual([]);
      expect(getAncestorDirPaths('c:/work/sub/file.ts', '')).toEqual([]);
      expect(getAncestorDirPaths('   ', '   ')).toEqual([]);
    });

    it('3.8 拓扑递进长度不变性：祖先链长度严格等于深度差', () => {
      const root = 'c:/a';
      const target = 'c:/a/1/2/3/4/5/file.ts';
      const ancestors = getAncestorDirPaths(target, root);
      expect(ancestors).toHaveLength(5);
      expect(ancestors[0]).toBe('c:/a/1');
      expect(ancestors[4]).toBe('c:/a/1/2/3/4/5');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. 1:1 IPC 契约校准与刚性负向断言（CRIT-02 & NEG-01）
  // ─────────────────────────────────────────────────────────────────────────
  describe('listDirectory IPC 契约校准与负向守门断言', () => {
    it('[CRIT-02 & NEG-01] 出站 IPC 参数仅发 { path }，绝对无 workspaceRoot 幽灵字段', async () => {
      const invokeSpy = vi.spyOn(tauriInvoke, 'invokeResult').mockResolvedValue({
        status: 'ok',
        data: { items: [] },
      });

      await listDirectory('c:/Software/conex/src');

      expect(invokeSpy).toHaveBeenCalledTimes(1);
      const [cmd, payload] = invokeSpy.mock.calls[0] as [string, Record<string, unknown>];
      
      // 1. 命令名称对齐
      expect(cmd).toBe('workbench_list_directory');
      // 2. 刚性负向断言：出站参数绝无 workspaceRoot
      expect(payload).toHaveProperty('path');
      expect(payload.workspaceRoot).toBeUndefined();
      expect(Object.keys(payload)).toEqual(['path']);
      expect(payload.path).toBe('c:/Software/conex/src');
    });

    it('[NEG-07] readTextFile / writeTextFile 出站负载同样零 workspaceRoot（全域闭环）', async () => {
      const invokeSpy = vi.spyOn(tauriInvoke, 'invokeResult');
      invokeSpy.mockResolvedValueOnce({
        status: 'ok',
        data: { content: 'x', lineCount: 1, truncated: false },
      });
      await readTextFile('c:/Software/conex/src/a.ts', 400);

      const [readCmd, readPayload] = invokeSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(readCmd).toBe('workbench_read_file_content');
      expect(readPayload.workspaceRoot).toBeUndefined();
      expect(Object.keys(readPayload)).toEqual(['path', 'maxLines']);

      invokeSpy.mockResolvedValueOnce({ status: 'ok', data: {} });
      await writeTextFile('c:/Software/conex/src/a.ts', 'new', true);

      const [writeCmd, writePayload] = invokeSpy.mock.calls[1] as [string, Record<string, unknown>];
      expect(writeCmd).toBe('workbench_write_file_content');
      expect(writePayload.workspaceRoot).toBeUndefined();
      expect(Object.keys(writePayload)).toEqual(['path', 'content', 'overwrite']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. 广播总线与预览宿主彻底解耦断言（CRIT-01）
  // ─────────────────────────────────────────────────────────────────────────
  describe('openFileInPanel 广播解耦断言', () => {
    it('[CRIT-01] 无论目标是否为代码文件，首行无条件派发 crish-open-file 事件并暂存 pendingOpenPath', () => {
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      const mockViewerOpener = vi.fn();
      registerFileViewerOpener(mockViewerOpener);

      // 针对 .ts 代码文件调用
      const res = openFileInPanel('c:/Software/conex/src/main.ts');

      // 1. 宿主分流至 file-viewer
      expect(res).toBe('file-viewer');
      expect(mockViewerOpener).toHaveBeenCalledWith('c:/Software/conex/src/main.ts', undefined);

      // 2. 核心物证：window 广播事件 100% 触发，未被提前 return 截断
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const event = dispatchSpy.mock.calls[0][0] as CustomEvent<{ path: string }>;
      expect(event.type).toBe('crish-open-file');
      expect(event.detail.path).toBe('c:/Software/conex/src/main.ts');

      // 3. pendingOpenPath 暂存态校验
      expect(takePendingOpenPath()).toBe('c:/Software/conex/src/main.ts');
      // 再次消费应已被清空
      expect(takePendingOpenPath()).toBeNull();
    });
  });
});
```

---

### 4.4 `apps/crish-desktop/src/api/filePanelOpener.test.ts`（CRIT-01 存量测试同步改写全量代码）

> **为何必须改写**：存量 `filePanelOpener.test.ts:91-105` 的用例「代码路径只调 file-viewer opener，不派 files 事件」逐字断言旧截断行为（`expect(ev).not.toHaveBeenCalled()` 与 `expect(takePendingOpenPath()).toBeNull()`）。CRIT-01 将广播与 pending 暂存提升至宿主分流之前无条件执行后，该用例必然两处失败。本文件归属 Wave 1 独占域（与 `filePanelOpener.ts` 同步改写），其余用例原样保留。

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractFilePathFromToolArgs,
  looksLikeOpenableFilePath,
  openFileInPanel,
  pathFromFileOpenClickTarget,
  registerFileViewerOpener,
  resolveFilePreviewHost,
  takePendingOpenPath,
} from './filePanelOpener';

const WORKSPACE_KEY = 'crish_workspace';

beforeEach(() => {
  localStorage.setItem(WORKSPACE_KEY, 'c:/work');
  registerFileViewerOpener(null);
  takePendingOpenPath();
});

afterEach(() => {
  registerFileViewerOpener(null);
  takePendingOpenPath();
});

describe('resolveFilePreviewHost', () => {
  it('代码走 file-viewer，md/图/表走 files；diff 强制 file-viewer', () => {
    expect(resolveFilePreviewHost('src/app.ts')).toBe('file-viewer');
    expect(resolveFilePreviewHost('lib/main.rs')).toBe('file-viewer');
    expect(resolveFilePreviewHost('README.md')).toBe('files');
    expect(resolveFilePreviewHost('docs/note.mdx')).toBe('files');
    expect(resolveFilePreviewHost('shot.png')).toBe('files');
    expect(resolveFilePreviewHost('doc.pdf')).toBe('files');
    expect(resolveFilePreviewHost('data.csv')).toBe('files');
    expect(resolveFilePreviewHost('pack.zip')).toBe('files');
    expect(resolveFilePreviewHost('README.md', 'diff')).toBe('file-viewer');
    expect(resolveFilePreviewHost('src/app.ts')).not.toBe('preview');
  });
});

describe('looksLikeOpenableFilePath', () => {
  it('拒绝 note / 无扩展 id，接受路径与文件名', () => {
    expect(looksLikeOpenableFilePath('note')).toBe(false);
    expect(looksLikeOpenableFilePath('notebook:abc')).toBe(false);
    expect(looksLikeOpenableFilePath('file-123')).toBe(false);
    expect(looksLikeOpenableFilePath('')).toBe(false);
    expect(looksLikeOpenableFilePath('src/index.ts')).toBe(true);
    expect(looksLikeOpenableFilePath('report.md')).toBe(true);
    expect(looksLikeOpenableFilePath('shot.png')).toBe(true);
    expect(looksLikeOpenableFilePath('archive.zip')).toBe(true);
  });
});

describe('pathFromFileOpenClickTarget', () => {
  it('附件 data-file-open-path 可抽，移除钮忽略', () => {
    const chip = document.createElement('span');
    chip.setAttribute('data-file-open-path', 'src/a.ts');
    const name = document.createElement('span');
    name.appendChild(document.createTextNode('a.ts'));
    chip.appendChild(name);
    expect(pathFromFileOpenClickTarget(name)).toBe('src/a.ts');
    expect(pathFromFileOpenClickTarget(name.firstChild)).toBe('src/a.ts');

    const remove = document.createElement('button');
    remove.className = 'chat-attach-remove';
    chip.appendChild(remove);
    expect(pathFromFileOpenClickTarget(remove)).toBeNull();
  });

  it('file mention 用 id，agent mention 忽略', () => {
    const file = document.createElement('span');
    file.setAttribute('data-type', 'mention');
    file.setAttribute('data-kind', 'file');
    file.setAttribute('data-id', 'src/index.ts');
    file.setAttribute('data-label', 'index.ts');
    expect(pathFromFileOpenClickTarget(file)).toBe('src/index.ts');

    const agent = document.createElement('span');
    agent.setAttribute('data-type', 'mention');
    agent.setAttribute('data-kind', 'agent');
    agent.setAttribute('data-id', 'agent-007');
    expect(pathFromFileOpenClickTarget(agent)).toBeNull();
  });
});

describe('openFileInPanel', () => {
  it('[CRIT-01] 代码路径仍进 file-viewer 宿主，且无条件派发 crish-open-file 广播并暂存 pendingOpenPath', () => {
    const opener = vi.fn();
    registerFileViewerOpener(opener);
    const ev = vi.fn();
    window.addEventListener('crish-open-file', ev);

    const host = openFileInPanel('src/app.ts');
    expect(host).toBe('file-viewer');
    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener.mock.calls[0]?.[0].replace(/\\/g, '/')).toMatch(/src\/app\.ts$/);
    // CRIT-01：广播与 pendingOpenPath 无条件先行，绝不被宿主分流截断
    expect(ev).toHaveBeenCalledTimes(1);
    const dispatched = ev.mock.calls[0]?.[0] as CustomEvent<{ path: string }>;
    expect(dispatched.type).toBe('crish-open-file');
    expect(dispatched.detail.path.replace(/\\/g, '/')).toMatch(/src\/app\.ts$/);
    expect(takePendingOpenPath()?.replace(/\\/g, '/')).toMatch(/src\/app\.ts$/);

    window.removeEventListener('crish-open-file', ev);
  });

  it('md / 图走 files 事件，即使 opener 已注册也不开 file-viewer', () => {
    const opener = vi.fn();
    registerFileViewerOpener(opener);
    const ev = vi.fn();
    window.addEventListener('crish-open-file', ev);

    expect(openFileInPanel('docs/readme.md')).toBe('files');
    expect(opener).not.toHaveBeenCalled();
    expect(ev).toHaveBeenCalledTimes(1);
    const pending = takePendingOpenPath();
    expect(pending?.replace(/\\/g, '/')).toMatch(/docs\/readme\.md$/);

    expect(openFileInPanel('assets/a.png')).toBe('files');
    expect(opener).not.toHaveBeenCalled();

    window.removeEventListener('crish-open-file', ev);
  });

  it('note / 空路径 / 越界路径不打开、不写 persist', () => {
    const opener = vi.fn();
    registerFileViewerOpener(opener);
    const ev = vi.fn();
    window.addEventListener('crish-open-file', ev);

    expect(openFileInPanel('')).toBeNull();
    expect(openFileInPanel('note')).toBeNull();
    expect(openFileInPanel('notebook:abc')).toBeNull();
    expect(openFileInPanel('c:/outside/x.ts')).toBeNull();
    expect(opener).not.toHaveBeenCalled();
    expect(ev).not.toHaveBeenCalled();
    expect(takePendingOpenPath()).toBeNull();

    window.removeEventListener('crish-open-file', ev);
  });

  it('无 opener 时代码也回落 files 叶', () => {
    const ev = vi.fn();
    window.addEventListener('crish-open-file', ev);
    expect(openFileInPanel('src/app.ts')).toBe('files');
    expect(ev).toHaveBeenCalledTimes(1);
    window.removeEventListener('crish-open-file', ev);
  });
});

describe('extractFilePathFromToolArgs', () => {
  it('从 JSON path 与单行路径抽出', () => {
    expect(extractFilePathFromToolArgs('{"path":"src/a.ts"}')).toBe('src/a.ts');
    expect(extractFilePathFromToolArgs('{"file_path":"lib/b.rs"}')).toBe(
      'lib/b.rs'
    );
    expect(extractFilePathFromToolArgs('foo/bar/baz.ts')).toBe('foo/bar/baz.ts');
    expect(extractFilePathFromToolArgs('just text')).toBeNull();
  });
});
```

---

## 五、物理删除与特征代码重塑矩阵（Tombstone Purge Matrix）

本规范坚决贯彻反僵尸代码与反兼容 Shim 铁律，对存量缺陷代码执行不可逆的物理切除，严禁保留注释残留：

| 目标文件 | 物理坐标与特征代码 | 处置动作 | 物理切除原因与危害说明 | 重构后干净代码特征 |
| :--- | :--- | :--- | :--- | :--- |
| `workspaceFsApi.ts` | `L122-125`：<br>`function workspaceRootArg(): string \| undefined { const root = getFsRoot().trim(); return root \|\| undefined; }` | **物理切除（5 行）** | 虚构的跨层传参工具函数。Rust 底层 `workbench_list_directory` 根本不接收此参数，保留它造成跨层契约认知混乱。 | 该函数从源码中彻底绝迹，零调用残留。 |
| `workspaceFsApi.ts` | `L134`：<br>`workspaceRoot: workspaceRootArg(),` | **物理切除（1 行）** | 在 IPC `invokeResult` 中传递虚假参数（CRIT-02）。 | 传参对象收敛为纯净的 `{ path }`，严格 1:1 对齐底层 Rust 签名。 |
| `filePanelOpener.ts` | `L113-117`：<br>`const host = resolveFilePreviewHost(path, mode); if (host === 'file-viewer' && fileViewerOpener) { fileViewerOpener(path, mode); return host; }` | **重塑控制流（消除截断点）** | 提前 `return host` 导致后续广播派发被跳过（CRIT-01），左侧目录树陷入永久伪连通死寂。 | 将 `pendingOpenPath = path` 与 `window.dispatchEvent` 提升至最顶部无条件执行，再执行宿主预览分流。 |
| `workspaceFsApi.ts` | `L188`：<br>`workspaceRoot: workspaceRootArg(),`（`readTextFile` 出站负载） | **物理切除（1 行）** | 同一幽灵字段在 read 链路残留，违反零幽灵契约全域闭环。 | 负载收敛为 `{ path, maxLines }`。 |
| `workspaceFsApi.ts` | `L224`：<br>`workspaceRoot: workspaceRootArg(),`（`writeTextFile` 出站负载） | **物理切除（1 行）** | 同一幽灵字段在 write 链路残留，违反零幽灵契约全域闭环。 | 负载收敛为 `{ path, content, overwrite }`。 |
| `filePanelOpener.test.ts` | `L91-105`：<br>`expect(ev).not.toHaveBeenCalled();` 与 `expect(takePendingOpenPath()).toBeNull();` | **就地改写（1 个用例）** | 逐字固化旧截断行为，与 CRIT-01 直接冲突，落地后必红。 | 改写为断言广播必发 + pending 已暂存（§4.4 全量代码）。 |

### 既有公共契约冻结清单（Frozen Contracts）
除上述针对 `workspaceFsApi.ts` 的契约校准与纯函数扩展、针对 `filePanelOpener.ts` 的广播顺序调整外，以下既有公共导出接口保持 100% 冻结，严禁重命名或破坏签名：
- `getWorkspacePath`, `openPathDefault`
- `FsDirEntry`, `FsReadResult`, `ResolvedPath`
- `isAbsoluteFsPath`, `resolveWorkspacePath`, `assertWorkspacePath`, `isInsideWorkspace`
- `FILE_PREVIEW_*`, `nextFilePreviewLineBudget`
- `readTextFile`, `writeTextFile`, `toAssetUrl`, `revealInOs`
- `pathBasename`, `pathDirname`, `pathRelativeToRoot`, `detectFileKind`, `isMarkdownFilename`, `parseCsvPreview`
- 批注与打开器相关 re-export

---

## 六、算法数学不变量与安全公理体系（State & Logic Invariants）

本规范各算法依托严格的离散数学不变量建立，所有断言均可通过形式化证明验证：

| 不变量名称 | 数学形式化表述 | 工程含义与守门要求 |
| :--- | :--- | :--- |
| **规范化幂等律** | $\forall p, \text{toCanonicalFsPath}(\text{toCanonicalFsPath}(p)) \equiv \text{toCanonicalFsPath}(p)$ | 任何路径无论经由一次还是多次规范化，输出严格恒等，无任何累积副作用。 |
| **盘符小写不变性** | $\forall p \in \text{WindowsPaths}, \text{toCanonicalFsPath}(p) \Rightarrow \text{drive} \in [a-z]$ | Windows 盘符强制收敛为小写字符（`c:/`），从根本上杜绝状态字典由于大小写错位导致的展开丢失。 |
| **栈代数消解律** | $\forall p, \text{toCanonicalFsPath}(p) \cap \{ '/./', '/../' \} = \emptyset$（非相对前导） | 相对目录段在规范化阶段通过堆栈完全消解，杜绝目录穿越与 `..` 逃逸。 |
| **兄弟前缀隔离律** | $\forall t \in \text{SiblingPrefixPaths}, \text{getAncestorDirPaths}(t, r) \equiv []$ | 严格断言 `targetLower.startsWith(rootPrefix)`（包含尾部斜杠），杜绝 `c:/work` 与 `c:/work-extra` 发生前缀碰撞。 |
| **祖先严格偏序链** | $\forall i < j, \text{length}(\text{ancestors}[i]) < \text{length}(\text{ancestors}[j])$ 且 $\text{ancestors}[i] \subset \text{ancestors}[j]$ | 祖先数组按自顶向下严格递进排列，上层目录永远排在下层目录之前。 |
| **广播无条件公理** | $\forall \text{validPath}, \text{Call}(\text{openFileInPanel}(\text{validPath})) \implies \text{Event}('crish-open-file') \text{ Dispatched}$ | 无论文件预览分流至何种叶片宿主，系统广播必定 100% 派发，彻底根除功能伪连通。 |

---

## 七、全量刚性负向断言矩阵（Negative Constraints & NEG-01 守门）

在执行与验收 Wave 1 时，必须刚性履行以下负向断言守门，任何一条违反应被门禁直接阻断：

| 刚性断言编号 | 刚性负向断言表达式 | 拦截的重大架构隐患与毒点 | 守护文件域 |
| :--- | :--- | :--- | :--- |
| **NEG-01** | `expect(payload.workspaceRoot).toBeUndefined()` 且 `expect(Object.keys(payload)).toEqual(['path'])` | 拦截前端向 Tauri IPC 透传 `workspaceRoot` 幽灵参数（CRIT-02），杜绝跨层契约漂移。 | `apps/crish-desktop/src/api/__tests__/workspaceFsApi.test.ts` |
| **NEG-02** | `expect(dispatchSpy).toHaveBeenCalledTimes(1)`（无论代码类文件与否） | 拦截由于提前 `return host` 导致的全局广播被截断（CRIT-01），根除伪连通。 | `apps/crish-desktop/src/api/__tests__/workspaceFsApi.test.ts` |
| **NEG-03** | `expect(toCanonicalFsPath('C:/work')).toMatch(/^c:\//)` | 拦截 Windows 盘符大写回潮，锁定小写规范化。 | `apps/crish-desktop/src/api/__tests__/workspaceFsApi.test.ts` |
| **NEG-04** | 静态扫描禁止 `import ... from 'node:path'` 与 `import ... from 'path'` | 拦截前端渲染层误引入 Node.js 原生模块导致的打包雪崩。 | `apps/crish-desktop/src/api/workspaceFsApi.ts` |
| **NEG-05** | 静态扫描禁止引入任何未授权外部 npm 路径包（如 `path-browserify`、`slash` 等） | 拦截无谓的外部依赖膨胀与供应链风险，恪守纯原生实现。 | `package.json` |

---

## 八、立体验证指令集与交付准则（Verification & Delivery Criteria）

### 8.1 完整闭环验证执行命令集（需在工作区根目录由 pwsh7 驱动）

```powershell
# 1. 严格 TypeScript 静态编译检查（验证全局无类型断裂、三大纯函数签名完全闭环）
npm run typecheck

# 2. Wave 1 专属单元测试套件全绿执行（覆盖纯函数、IPC 契约校准、NEG-01 负向断言、广播解耦）
npx vitest run apps/crish-desktop/src/api/__tests__/workspaceFsApi.test.ts

# 3. 既有 API 存量测试无回归验证（确保工作区沙箱既有 163 行测试 100% 保持全绿）
npx vitest run apps/crish-desktop/src/api/workspaceFsApi.test.ts

# 4. filePanelOpener 存量测试改写后全绿（CRIT-01 广播解耦，见 §4.4）
npx vitest run apps/crish-desktop/src/api/filePanelOpener.test.ts

# 5. 前端文件有效代码行数门禁扫描（确保有效代码行严格处于 400 行配额以内）
npm run check:line-counts

# 6. 工作区代码变更范围核验（断言仅白名单内 4 个文件发生改动）
git status -s
```

### 8.2 交付验收刚性基准表

| 验收维度 | 刚性指标与判定依据 | 失败处理动作 |
| :--- | :--- | :--- |
| **单元测试** | `__tests__/workspaceFsApi.test.ts` 与 `workspaceFsApi.test.ts` **全部用例 100% PASS**，零失败，零跳过。 | 立即排查失败断言，依规范修正实现。 |
| **类型检查** | `npm run typecheck` 退出码严格为 0，零 TS 报错，零类型警告。 | 修复类型契约，禁止使用 `@ts-ignore` 逃避检查。 |
| **行数门禁** | `workspaceFsApi.ts` 有效代码行 ≤ 400 行（当前有效代码行约 340 行），`check:line-counts` 绿灯放行。 | 优化精简逻辑，杜绝冗余代码。 |
| **文件独占** | 仅 `workspaceFsApi.ts`、`filePanelOpener.ts`、`filePanelOpener.test.ts`、`__tests__/workspaceFsApi.test.ts` 4 个物理文件存在修改或新增。 | 若污染其他文件，立即剔除越权修改。 |
| **提交纪律** | **严禁执行 `git commit`**，改动完整保留在本地工作区，供主控统一验收收口。 | 违规提交一票否决。 |

---
*本施工方案（01-path-canonical-spec.md）编制完毕，独占落盘于 `c:\Software\conex\docs\file-tree-and-attachments-architecture\detailed-plans\01-path-canonical-spec.md`。严格遵从无留白、零幻觉与纯逻辑规划铁律，全面消除历史错位，作为 Wave 1 实施的唯一合法施工图纸。*
