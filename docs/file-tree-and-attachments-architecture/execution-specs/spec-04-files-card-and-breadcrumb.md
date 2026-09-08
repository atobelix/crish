# 施工任务书 04：宿主单轨收敛、防穿透隔离舱与面包屑搜索框重塑

> **文档标识**：`docs/file-tree-and-attachments-architecture/execution-specs/spec-04-files-card-and-breadcrumb.md`  
> **所属战役**：`docs/file-tree-and-attachments-architecture/`  
> **指派角色**：`FilesCard & Breadcrumb UI Engineer`  
> **纪律铁律**：
> 1. **用户明确裁决：面包屑下拉树逻辑维持现状，严禁改写或删除下钻树逻辑！**
> 2. 严格按要求注入 CSS 隔离舱消除穿透；
> 3. 严格独占文件域，严禁执行 git commit。

---

## 一、独占文件白名单（Forbidden to touch any other file）

1. `apps/crish-desktop/src/components/files/FilesCard.tsx`
2. `apps/crish-desktop/src/components/files/FileBreadcrumb.tsx`
3. `apps/crish-desktop/src/components/files/FilesCard.module.css`

---

## 二、`FilesCard.tsx` 必须落地的改造

1. **物理切除“上级目录”按钮**：
   - 彻底删除原第 158-165 行的 `const handleGoUp = useCallback(...)`；
   - 彻底删除原第 290-300 行的 `<Tooltip content={PARENT_DIR_LABEL}>...<CornerLeftUp />...</Tooltip>` 按钮；
   - 清除文件顶部的 `CornerLeftUp` 图标导入；
   - 清除常数 `PARENT_DIR_LABEL` 的声明与使用。
2. **双击文件/目录逻辑单轨收敛**：
   - 修改 `handleFileDoubleClick`：
     ```typescript
     const handleFileDoubleClick = useCallback(
       (path: string, isDir: boolean) => {
         if (isDir) {
           void nav.toggleExpand(path, {
             stopPropagation: () => {},
           } as unknown as React.MouseEvent);
         } else {
           void handleOpenFile(path);
         }
       },
       [nav, handleOpenFile]
     );
     ```
     **坚决杜绝任何调用 `handleRefresh(path)` 篡改根目录的行为**！双击目录只能原地展开/折叠。
3. **打开文件与定位联动**：
   - 确保 `handleOpenFile` 调用 `await nav.revealPath(resolved)`，保证左侧树被正确驱动展开。

---

## 三、`FilesCard.module.css` 防穿透隔离舱与层级修复

1. **注入 `.filesBody` 原生隔离舱（彻底根除分割线穿透）**：
   在 `.filesBody`（约行 498）添加 `position: relative; isolation: isolate; z-index: var(--z-base, 0);`：
   ```css
   .filesBody {
     flex: 1;
     min-height: 0;
     display: flex;
     flex-direction: column;
     overflow: hidden;
     position: relative;
     isolation: isolate;
     z-index: var(--z-base, 0);
   }
   ```
   **效果**：将 `.filesSplitResizer` 的层叠上下文完全封闭在 Level 0 内，代数几何级切断其穿透面板的途径！
2. **纠正 `.filesBar` 层级**：
   ```css
   .filesBar {
     /* 保持原有布局属性 */
     position: relative;
     z-index: var(--z-dock, 10);
   }
   .filesBar:has(.filesBcFlyout) {
     z-index: var(--z-breadcrumb, 400);
   }
   ```
3. **支持呼吸脉冲高亮样式**：
   ```css
   .filesRow.isSelectedPulse {
     background-color: color-mix(in srgb, var(--accent-color, #2563eb) 12%, transparent) !important;
     transition: background-color var(--transition-slow, 0.4s) ease;
   }
   ```

---

## 四、`FileBreadcrumb.tsx` 搜索框重塑（全面对齐 `ModelBadgePickerMenu`）

**铁律：下拉树的遍历与展开折叠逻辑保持现状，严禁改动树渲染核心！**

仅重塑顶部 `.filesBcFlyoutSearch` 及其在 `FilesCard.module.css` 中的样式：
1. **JSX 结构调整**：
   - 将 `<input type="search" ... />` 改为 `<input type="text" ... />`，消除原生浏览器的粗框与默认清除装饰；
   - 左侧使用 `<Search size={14} className={styles.filesBcSearchIcon} aria-hidden />`；
   - 保留右侧紧凑的操作按钮。
2. **CSS 样式重塑（对齐 `ModelBadgePickerMenu` 极简形态）**：
   ```css
   .filesBcFlyoutSearch {
     display: flex;
     align-items: center;
     gap: 6px;
     padding: 6px 8px;
     margin-bottom: 6px;
     border: none;
     border-bottom: 1px solid var(--hairline, var(--border-subtle));
     background: transparent;
     color: var(--text-tertiary);
     flex-shrink: 0;
   }

   .filesBcFlyoutSearch input {
     flex: 1;
     min-width: 0;
     border: none;
     outline: none;
     background: transparent;
     font: inherit;
     font-size: var(--font-size-sm, 13px);
     color: var(--text-primary);
     padding: 2px 4px;
     box-shadow: none;
   }

   .filesBcFlyoutSearch input::placeholder {
     color: var(--text-tertiary);
   }
   ```

---

## 五、验收命令

```powershell
npx vitest run src/components/files/
```
