# 施工任务书 02：目录树单轨收敛与祖先展开核心 Hook

> **文档标识**：`docs/file-tree-and-attachments-architecture/execution-specs/spec-02-tree-navigation-hook.md`  
> **所属战役**：`docs/file-tree-and-attachments-architecture/`  
> **指派角色**：`Directory Tree Navigation Hook Engineer`  
> **纪律铁律**：纯逻辑规划，禁止自主过度发挥，严禁篡改工作区根目录，严禁执行 git commit。

---

## 一、独占文件白名单（Forbidden to touch any other file）

1. `apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts`（核心实现）
2. `apps/crish-desktop/src/components/files/hooks/__tests__/useFileNavigation.test.tsx`（单元测试）

---

## 二、必须执行的物理删除清单

在 `apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts` 中：
1. **删除 `cwd` 状态**：彻底删除 `const [cwd, setCwd] = useState(root || '');`（原行 18），目录树的唯一根基准永远是 `root`；
2. **删除 `goUp` 函数**：彻底物理切除原行 82-88 的 `const goUp = useCallback(...)`，以及返回值对象中的 `goUp` 字段；
3. **修改 `refresh` 函数**：
   - 彻底删除将传入的 `dir` 设为 `cwd` 的逻辑（删除原行 48 `setCwd(path);`）；
   - `refresh()` 仅负责重新拉取项目根目录下的条目 `setEntries(await loadDir(rootPath))`；
4. **清理返回值**：
   - Hook 返回值保持：`root, entries, expanded, loading, error, filter, filterMode, gitStatusMap, flatTree, loadDir, refresh, toggleExpand, revealPath, setFilter, setFilterMode, setError`；
   - 严禁导出 `cwd` 或 `goUp`。

---

## 三、必须实现的核心逻辑（规范化 revealPath）

从 `../../../api/workspaceFsApi` 引入 `toCanonicalFsPath`, `getAncestorDirPaths`, `isSameFsPath`。

### 1. `revealPath(filePath: string): Promise<boolean>` 完整实现规格
```typescript
const revealPath = useCallback(
  async (filePath: string): Promise<boolean> => {
    const r = getWorkspacePath();
    if (r) setRoot(r);
    const effectiveRoot = r || root;
    if (!effectiveRoot || !filePath?.trim()) return false;

    const normTarget = toCanonicalFsPath(filePath);
    const normRoot = toCanonicalFsPath(effectiveRoot);

    // 作用域安全守卫：若文件不在当前工作区内，优雅返回 false，绝对不重设目录树根！
    const isInside = normTarget.startsWith(normRoot + '/') || normTarget === normRoot;
    if (!isInside) {
      return false;
    }

    // 1. 获取自顶向下的所有直系祖先目录
    const ancestors = getAncestorDirPaths(normTarget, normRoot);

    // 2. 如果是根目录直系文件（ancestors 为空），确保根目录条目已拉取即可
    if (ancestors.length === 0) {
      if (entries.length === 0) {
        try {
          const rootEntries = await loadDir(normRoot);
          setEntries(rootEntries);
        } catch {
          /* ignore */
        }
      }
      return true;
    }

    // 3. 筛选出尚未在 expanded 字典中的祖先目录
    const toLoad = ancestors.filter((dir) => !expanded[dir]);
    if (toLoad.length > 0) {
      const results: Record<string, FsDirEntry[]> = {};
      const loadPromises = toLoad.map(async (dir) => {
        try {
          const list = await loadDir(dir);
          results[dir] = list;
        } catch {
          /* ignore */
        }
      });
      await Promise.allSettled(loadPromises);
      // 原子合并写入 expanded，保证 key 100% 为 toCanonicalFsPath 规范格式
      setExpanded((prev) => ({ ...prev, ...results }));
    }

    return true;
  },
  [root, entries.length, expanded, loadDir]
);
```

### 2. `flatTree` 字典命中对齐
在 `flatTree` 的 `walk` 递归展开逻辑中：
```typescript
for (const e of sorted) {
  out.push({ ...e, depth });
  const canonicalPath = toCanonicalFsPath(e.path);
  if (e.isDir && expanded[canonicalPath]) {
    walk(expanded[canonicalPath] ?? [], depth + 1);
  }
}
```
确保无论系统返回反斜杠还是正斜杠，`expanded[canonicalPath]` 均能 100% 精确命中。

---

## 四、单元测试与验收命令

在 `useFileNavigation.test.tsx` 中：
1. 移除对 `goUp` 的测试用例；
2. 增加对 `revealPath` 的跨平台测试：
   - 传入 Windows 反斜杠深层路径（如 `C:\\repo\\src\\components\\Button.tsx`），断言各级祖先正确注入 `expanded`，且根节点 `root` 保持不变；
   - 传入工作区外部路径，断言返回 `false`，且目录树不被清空。

验收执行命令：
```powershell
npx vitest run src/components/files/hooks/__tests__/useFileNavigation.test.tsx
```
