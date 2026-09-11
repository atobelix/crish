# 施工任务书 01：路径规范化内核与 SSOT 契约库

> **文档标识**：`docs/file-tree-and-attachments-architecture/execution-specs/spec-01-path-canonical-api.md`
> **所属战役**：`docs/file-tree-and-attachments-architecture/`
> **指派角色**：`Workspace Path & Canonical API Engineer`
> **纪律铁律**：纯逻辑规划，禁止自主过度发挥，禁止引入第三方路径解析库，严格独占文件域，严禁执行 git commit。

---

## 一、独占文件白名单（Forbidden to touch any other file）

1. `apps/crish-desktop/src/api/workspaceFsApi.ts`（核心实现）
2. `apps/crish-desktop/src/api/__tests__/workspaceFsApi.test.ts`（单元测试）

---

## 二、必须实现的函数签名与精确规范

在 `apps/crish-desktop/src/api/workspaceFsApi.ts` 中实现并导出以下 3 个纯函数：

### 1. `toCanonicalFsPath(path: string): string`
- **输入**：任意原始路径字符串（可包含 Windows 反斜杠、正斜杠、末尾斜杠、大写盘符、相对点号等）。
- **逻辑契约**：
  1. 若输入为空串或纯空白，返回空串 `''`；
  2. 首尾去除空格；
  3. 将所有反斜杠 `\` 统一替换为正斜杠 `/`；
  4. **Windows 盘符规范化**：如果以 `^[A-Za-z]:` 开头，将盘符字母转为小写（例如 `C:/Software` -> `c:/Software`）；
  5. **末尾斜杠处理**：清除末尾多余的 `/`，但保留单斜杠根路径 `/` 以及盘符根路径（如 `c:/`）；
  6. **相对段消解**：将路径内部的 `/./` 替换为 `/`；消解非开头的 `/../` 路径段；
- **输出断言示例**：
  - `toCanonicalFsPath('C:\\Software\\conex\\')` -> `'c:/Software/conex'`
  - `toCanonicalFsPath('c:/Software/conex/./src')` -> `'c:/Software/conex/src'`
  - `toCanonicalFsPath('D:/repo/apps/../packages')` -> `'d:/repo/packages'`
  - `toCanonicalFsPath('/usr/local/bin/')` -> `'/usr/local/bin'`

### 2. `isSameFsPath(a: string, b: string): boolean`
- **逻辑契约**：
  ```typescript
  export function isSameFsPath(a: string, b: string): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return toCanonicalFsPath(a) === toCanonicalFsPath(b);
  }
  ```

### 3. `getAncestorDirPaths(targetPath: string, rootPath: string): string[]`
- **输入**：目标文件或目录路径 `targetPath`，工作区根路径 `rootPath`。
- **逻辑契约**：
  1. `const normTarget = toCanonicalFsPath(targetPath);`
  2. `const normRoot = toCanonicalFsPath(rootPath);`
  3. 若 `!normTarget || !normRoot`，返回 `[]`；
  4. **越界守卫**：若 `normTarget` 不在 `normRoot` 下（即 `!normTarget.startsWith(normRoot + '/')` 且 `normTarget !== normRoot`），返回空数组 `[]`；
  5. 提取直系祖先目录：
     - 若 `normTarget === normRoot`，返回 `[]`；
     - 取目标文件的父目录：`let curr = normTarget.includes('/') ? normTarget.slice(0, normTarget.lastIndexOf('/')) : '';`
     - 若 `curr === normRoot`，说明文件直属项目根（例如 `c:/repo/README.md`），直系祖先目录数组返回 `[]`；
     - 否则，从 `curr` 循环向上追溯，直到 `curr === normRoot`，依次自顶向下收集各级子目录；
  6. **返回值**：有序数组，由浅入深。例如：
     - 根为 `c:/repo`，目标为 `c:/repo/apps/crish-desktop/src/index.ts`
     - 返回：`['c:/repo/apps', 'c:/repo/apps/crish-desktop', 'c:/repo/apps/crish-desktop/src']`。

---

## 三、负向禁止清单（Negative Constraints）

1. **严禁引入 node:path 或第三方库**（如 lodash, path-browserify 等），必须使用原生字符串操作与正则；
2. **严禁破坏 `workspaceFsApi.ts` 已有的任何导出**（如 `resolveWorkspacePath`、`listDirectory` 等保持原有契约不变）；
3. **严禁执行 git commit**。

---

## 四、单元测试与验收命令

在 `workspaceFsApi.test.ts` 中补全测试，必须覆盖以下用例：
1. `toCanonicalFsPath`：Windows 反斜杠、混合斜杠、大写盘符、首尾空白、末尾斜杠；
2. `isSameFsPath`：反斜杠与正斜杠同等判定、盘符大小写同等判定；
3. `getAncestorDirPaths`：深层文件推导（3 层以上）、根直系文件（返回空数组）、工作区外部文件（返回空数组）。

验收执行命令：
```powershell
npx vitest run src/api/__tests__/workspaceFsApi.test.ts
```
