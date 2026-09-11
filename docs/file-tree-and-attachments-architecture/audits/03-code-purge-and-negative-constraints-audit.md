# 阶段三：方案合理性严格审计报告 · 物理删除彻底性与负向约束审查（Code Purge & Negative Constraints Audit）

> **文档标识**：`docs/file-tree-and-attachments-architecture/audits/03-code-purge-and-negative-constraints-audit.md`
> **所属战役**：`docs/file-tree-and-attachments-architecture/`
> **审查角色**：资深代码净收敛与死代码清理审查专家（Senior Code Net-Convergence & Dead-Code Purge Audit Specialist）
> **前置输入文档**：
> - 阶段二详细规划任务书 01：[`detailed-plans/01-path-canonical-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/01-path-canonical-spec.md)
> - 阶段二详细规划任务书 02：[`detailed-plans/02-tree-navigation-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/02-tree-navigation-spec.md)
> - 阶段二详细规划任务书 03：[`detailed-plans/03-tree-virtual-scroll-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/03-tree-virtual-scroll-spec.md)
> - 阶段二详细规划任务书 04：[`detailed-plans/04-files-card-and-breadcrumb-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/04-files-card-and-breadcrumb-spec.md)
> - 阶段二详细规划任务书 05：[`detailed-plans/05-message-attachment-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/05-message-attachment-spec.md)
> **权威审计依据**：
> - 审计总纲与准则：[`analysis/05-audit-framework-strategy.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/analysis/05-audit-framework-strategy.md)
> - 仓库根目录协作指令：[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md)（§1 反退避与纯逻辑、§2 子 Agent 调度、§3 Git 提交纪律、§7 严禁补丁作弊、§7.1 立体验证纪律、§8 反过度设计红线、§11 CI 行数门禁）
> - 反过度设计红线：[`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)
> **审查属性**：纯逻辑工程审计（不谈工期、人天、P0/P1，所有问题纯逻辑同权，以代码真实源与物理落盘事实为裁判准绳）。

---

## 目录

- [一、审计概述与裁决总览](#一审计概述与裁决总览)
- [二、物理删除彻底性深度审查（Zero Zombie Code & Zero Legacy Classes）](#二物理删除彻底性深度审查zero-zombie-code--zero-legacy-classes)
  - [2.1 `ChatMessageRow.module.css` 61 行死亡样式审查](#21-chatmessagerowmodulecss-61-行死亡样式审查)
  - [2.2 `ChatUserMessageRow.tsx` 废弃 JSX/逻辑块与隐藏死亡代码审查](#22-chatusermessagerowtsx-废弃-jsx逻辑块与隐藏死亡代码审查)
  - [2.3 `FilesCard.tsx` 钻取残余符号与 `nav.cwd` 跨层契约断裂审查](#23-filescardtsx-钻取残余符号与-navcwd-跨层契约断裂审查)
  - [2.4 物理切除死代码特征对比矩阵](#24-物理切除死代码特征对比矩阵)
- [三、负向断言测试完备性审查（Negative Assertions Audit）](#三负向断言测试完备性审查negative-assertions-audit)
  - [3.1 各规范负向测试覆盖度全景比对](#31-各规范负向测试覆盖度全景比对)
  - [3.2 `FilesCard` 负向断言严重缺失硬伤分析](#32-filescard-负向断言严重缺失硬伤分析)
  - [3.3 源码级静态字符串拦截与运行时断言双重防线](#33-源码级静态字符串拦截与运行时断言双重防线)
- [四、负向约束硬红线与防过度设计审查（Negative Constraints & Guardrails）](#四负向约束硬红线与防过度设计审查negative-constraints--guardrails)
  - [4.1 任务书负向禁令严厉程度核验](#41-任务书负向禁令严厉程度核验)
  - [4.2 跨规范契约冲突审计（盘符大小写归一化分歧）](#42-跨规范契约冲突审计盘符大小写归一化分歧)
  - [4.3 白名单文件域空间独占性与 Git 权限隔离性核验](#43-白名单文件域空间独占性与-git-权限隔离性核验)
- [五、一票否决项（Hard Blockers）逐项扫描结果](#五一票否决项hard-blockers逐项扫描结果)
- [六、六维立体打分卡汇总与扣分明细](#六六维立体打分卡汇总与扣分明细)
- [七、缺陷修复工单与原子修正方案（Actionable Delta Remediation Plan）](#七缺陷修复工单与原子修正方案actionable-delta-remediation-plan)
  - [7.1 工单 1（DEFECT-PURGE-01）：切除 `FilesCard.tsx` 中残留的 `nav.cwd` 属性](#71-工单-1defect-purge-01切除-filescardtsx-中残留的-navcwd-属性)
  - [7.2 工单 2（DEFECT-PURGE-02）：切除 `ChatUserMessageRow.tsx` 中死亡函数 `resolveUserImageSrc` 及无用 imports](#72-工单-2defect-purge-02切除-chatusermessagerowtsx-中死亡函数-resolveuserimagesrc-及无用-imports)
  - [7.3 工单 3（DEFECT-TEST-01）：为 `FilesCard` 增补负向断言测试套件](#73-工单-3defect-test-01为-filescard-增补负向断言测试套件)
  - [7.4 工单 4（DEFECT-SSOT-01）：对齐 Spec-01 与总纲的 Windows 盘符小写化契约](#74-工单-4defect-ssot-01对齐-spec-01-与总纲的-windows-盘符小写化契约)
- [八、最终审计结论与放行裁决（Clearance Verdict）](#八最终审计结论与放行裁决clearance-verdict)

---

## 一、审计概述与裁决总览

依据阶段三方案合理性严格审计准则，审查专家对阶段二产出的 5 份详细规划设计文档（`01-path-canonical-spec.md`、`02-tree-navigation-spec.md`、`03-tree-virtual-scroll-spec.md`、`04-files-card-and-breadcrumb-spec.md`、`05-message-attachment-spec.md`）展开了穿透源码与 AST 级的拉网式审查，重点穿透 **02 导航 Hook**、**04 面包屑宿主**、**05 消息附件卡片** 3 份核心文档。

### 综合审计裁决：
- **最终评审得分**：**87 / 100 分**（准入门槛为 $\ge 95$ 分）
- **一票否决扫描**：发现 **2 项** 触犯阻断项（HB-01 跨层残留 `nav.cwd`、HB-06 缺失 `FilesCard` 负向测试）
- **放行判定**：**CONDITIONAL BLOCK / 暂缓施工（开具原子修正工单，需完成增量复审后方可放行）**
- **核心优点**：
  1. `ChatMessageRow.module.css` 的 61 行死亡 CSS 规则切除计划精准无误，坚决杜绝了 `display: none` 或注释敷衍；
  2. `ChatUserMessageRow.test.tsx` 编写了行业标杆级的负向 DOM 与 CSS Module 导出断言；
  3. `02-tree-navigation-spec.md` 对 `useFileNavigation` 进行了干净彻底的单轨收敛，运行时与契约层拔除 `cwd`、`setCwd`、`goUp`。
- **阻断性缺陷（待修正）**：
  1. **跨层契约撕裂**：`02-tree-navigation-spec.md` 拔除了 `nav.cwd`，但 `04-files-card-and-breadcrumb-spec.md` 的 `FilesCard.tsx` 仍有 2 处保留了 `nav.cwd`（L160 `<FileBreadcrumb cwd={nav.cwd} />`、L189 `handleCopyPath`），直接导致 TypeScript 编译阻断；
  2. **隐藏死亡代码遗漏**：`ChatUserMessageRow.tsx` 原行 22-40 的 `resolveUserImageSrc`（19 行）及其依赖的 `convertFileSrc`、`FileFormatIcon` 未被列入切除矩阵，重构后将沦为无引用僵尸代码；
  3. **负向测试盲区**：`04-files-card-and-breadcrumb-spec.md` 仅在 `FileBreadcrumb.test.tsx` 中做测试，未对 `FilesCard.tsx` 的“上级目录”按钮及 `CornerLeftUp` 编写挂载负向断言。

---

## 二、物理删除彻底性深度审查（Zero Zombie Code & Zero Legacy Classes）

物理删除彻底性审查旨在杜绝任何“伪重构”、“伪清理”，确保历史技术债务连根拔起。

### 2.1 `ChatMessageRow.module.css` 61 行死亡样式审查

审查专家穿透检查了生产源文件 [`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css) 的原行 116 至 176：

```css
/* 原始生产代码 ChatMessageRow.module.css:116-176 (共 61 行) */
116: .userImages {
117:   display: flex;
118:   flex-wrap: wrap;
119:   gap: var(--space-2, 8px);
120:   margin-bottom: var(--space-2, 8px);
121: }
122:
123: .userImageWrapper {
124:   cursor: pointer;
125:   border-radius: var(--radius-lg, 10px);
126:   overflow: hidden;
127:   border: 1px solid var(--border-subtle);
128:   background: var(--bg-card);
129:   transition: transform var(--transition-base, 150ms ease), border-color var(--transition-base, 150ms ease);
130: }
131:
132: .userImageWrapper:hover {
133:   border-color: var(--border-color);
134:   transform: scale(1.01);
135: }
136:
137: .userImage {
138:   display: block;
139:   max-width: min(100%, 320px);
140:   max-height: 240px;
141:   object-fit: cover;
142:   border-radius: inherit;
143: }
144:
145: .userAttachments {
146:   display: flex;
147:   flex-wrap: wrap;
148:   gap: var(--space-1_5, 6px);
149:   margin-bottom: var(--space-2, 8px);
150: }
151:
152: .userAttachmentChip {
153:   display: inline-flex;
154:   align-items: center;
155:   gap: var(--space-1_5, 6px);
156:   padding: var(--space-1, 4px) var(--space-2, 8px);
157:   font-size: var(--font-size-xs, 12px);
158:   background: color-mix(in srgb, var(--text-primary) 8%, transparent);
159:   border-radius: var(--radius-md, 6px);
160:   border: 1px solid var(--border-subtle);
161:   cursor: pointer;
162:   color: var(--text-secondary);
163:   transition: background var(--transition-fast), color var(--transition-fast);
164: }
165:
166: .userAttachmentChip:hover {
167:   background: color-mix(in srgb, var(--text-primary) 14%, transparent);
168:   color: var(--text-primary);
169: }
170:
171: .userAttachmentName {
172:   max-width: 180px;
173:   overflow: hidden;
174:   text-overflow: ellipsis;
175:   white-space: nowrap;
176: }
```

#### 审查结论：
1. **一网打尽核验**：`detailed-plans/05-message-attachment-spec.md` §5.1 表中将上述 8 个死亡类名规则（共 61 行）100% 完整列出，行号区间界定为 `L116 - L176`，无一遗漏；
2. **拒绝敷衍核验**：规范明确声明：在原位仅替换为 11 行纯净的 `.userAttachmentStrip` 规则，坚决禁止使用 `display: none`，坚决禁止使用 `/* */` 注释；
3. **净收敛指标**：样式表代码实现 **50 行净减少**；
4. **评审判定**：**✅ PASS（无可挑剔）**。

---

### 2.2 `ChatUserMessageRow.tsx` 废弃 JSX/逻辑块与隐藏死亡代码审查

审查专家对照生产源文件 [`apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx) 对 `detailed-plans/05-message-attachment-spec.md` 进行穿透：

#### 1. 计划内切除项核验：
- **原行 108-113**：双轨归一化判定逻辑（`images`、`nonImageAttachments`、`hasImages`、`hasAttachments`）被彻底切除，替换为统一纯函数 `normalizeMessageAttachments(msg)`；
- **原行 229-257**：裸图大画廊 JSX（29 行，含 `<div className={styles.userImages}>`、`userImageWrapper`、`userImage`）被物理连根拔起；
- **原行 259-283**：旧灰色药丸胶囊 JSX（25 行，含 `<div className={styles.userAttachments}>`、`userAttachmentChip`、`userAttachmentName`）被物理连根拔起。

#### 2. 挑刺与缺陷检出（隐蔽死亡代码遗漏）：
审查专家在对 `ChatUserMessageRow.tsx` 全文 AST 依赖分析中发现：
- **遗漏点 1（函数级僵尸代码）**：原源文件第 22-40 行定义了图片解析辅助函数：
  ```typescript
  // ChatUserMessageRow.tsx:22-40 (共 19 行)
  function resolveUserImageSrc(source: string | undefined): string {
    if (!source) return '';
    if (source.startsWith('data:') || source.startsWith('blob:') || source.startsWith('http')) {
      return source;
    }
    if (isAbsoluteFsPath(source)) {
      try {
        const safe = assertWorkspacePath(source);
        return convertFileSrc(safe);
      } catch {
        return '';
      }
    }
    return source;
  }
  ```
  在重构方案中，图片解析与安全转换已完全封装至原子卡片组件 [`AttachmentCard.tsx:236-262`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/05-message-attachment-spec.md#L236-L262)（`resolveCardImageSrc`）。在重构后的 `ChatUserMessageRow.tsx` 内部，`resolveUserImageSrc` **没有任何调用点，沦为 19 行无用死亡代码**！但 `05-message-attachment-spec.md` §5.2 的物理删除对照表却未将 L22-40 列入切除清单！
- **遗漏点 2（无用 Import 符号残留）**：由于图片与文件渲染完全收敛至 `<AttachmentCard />`，原文件中的以下导入符号在 `ChatUserMessageRow.tsx` 中已完全无用：
  - `import { FileFormatIcon } from '../../assets/icons';`（L16）
  - `import { convertFileSrc } from '@tauri-apps/api/core';`（L18）
  - `import { assertWorkspacePath } from '../../api/workspaceFsApi';`（L19）
  若不一并物理切除，将触发 TypeScript `noUnusedLocals` 报错或打包冗余。

---

### 2.3 `FilesCard.tsx` 钻取残余符号与 `nav.cwd` 跨层契约断裂审查

审查专家对照生产源文件 [`apps/crish-desktop/src/components/files/FilesCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.tsx) 对 `detailed-plans/04-files-card-and-breadcrumb-spec.md` 与 `detailed-plans/02-tree-navigation-spec.md` 展开交叉质询：

#### 1. 计划内切除项核验：
- **`handleGoUp` 回调（L158-165）**：彻底从 `FilesCard.tsx` 中物理清除；
- **`PARENT_DIR_LABEL` 常量（L28）**：彻底清除；
- **`CornerLeftUp` 图标导入（L5）**：从 `lucide-react` 导入列表中物理剔除；
- **顶栏“上级目录”按钮 JSX（L289-300）**：彻底物理切除，顶栏仅保留刷新按钮与面包屑；
- **双击事件收敛（L180-186）**：双击文件夹从 `handleRefresh(path)`（钻取并重设 cwd）彻底收敛为 `nav.toggleExpand(path)`。

#### 2. 挑刺与致命缺陷检出（跨层契约撕裂导致编译失败）：
审查专家发现了本次方案中**最严重的一处跨任务书契约断裂**：
- 在 `02-tree-navigation-spec.md` §3.1 中，`useFileNavigation` 彻底切除了 `cwd` 字段，其返回值接口 `UseFileNavigationReturn` 中**已没有任何 `cwd` 属性**：
  ```typescript
  // 02-tree-navigation-spec.md:79-85
  export interface UseFileNavigationReturn {
    root: string;
    entries: FsDirEntry[];
    expanded: Record<string, FsDirEntry[]>;
    // 彻底切除了 cwd !
  ```
  且在单测中明确声明：`expect(hookReturn.cwd).toBeUndefined()`。
- **然而**，在 `04-files-card-and-breadcrumb-spec.md` §4.1.2 给出的 `FilesCard.tsx` 完整骨架代码中，竟赫然写着：
  ```tsx
  // 04-files-card-and-breadcrumb-spec.md:159-167
  {!noRoot ? (
    <FileBreadcrumb
      root={nav.root}
      cwd={nav.cwd}  // ❌ 致命错误：nav 上根本没有 cwd 属性！
      selected={preview.selected}
      view={preview.view}
      dirty={preview.dirty}
      onNavigate={handleNavigate}
      onOpenFile={handleOpenFile}
    />
  ) : null}
  ```
- **连带遗漏点**：在 `FilesCard.tsx` 原第 188-193 行的 `handleCopyPath` 回调中：
  ```tsx
  // FilesCard.tsx:188-193
  const handleCopyPath = useCallback(
    (mode: 'abs' | 'rel') => {
      preview.copyPath(preview.selected || nav.cwd, nav.root, mode); // ❌ 残留 nav.cwd
    },
    [preview, nav.cwd, nav.root] // ❌ 残留 nav.cwd 依赖
  );
  ```
  `04-files-card-and-breadcrumb-spec.md` 的切除表（§5）中**完全遗漏了对 `handleCopyPath` 的处理**！
- **严重后果**：子 Agent 一旦按 `04` 任务书施工，执行 `npm run typecheck` 时将立即报出 `Property 'cwd' does not exist on type 'UseFileNavigationReturn'` 致命类型错误，导致 CI 流水线瞬间挂掉！触犯 **HB-01**！

---

### 2.4 物理切除死代码特征对比矩阵

| 物理文件 | 原始代码行号 | 死亡代码特征片段 | 规范处置声明 | 审查实际状态 | 审查裁决 |
| :--- | :--- | :--- | :--- | :--- | :---: |
| `ChatMessageRow.module.css` | L116-L176 | 61 行死亡 CSS（`.userImages` 至 `.userAttachmentName`） | 彻底物理清除，替换为 11 行纯净规则 | 覆盖完整，严禁注释与 display:none | ✅ **PASS** |
| `ChatUserMessageRow.tsx` | L108-L113 | `const images = ...; const nonImageAttachments = ...` | 彻底物理清除，替换为归一化 Hook | 覆盖完整 | ✅ **PASS** |
| `ChatUserMessageRow.tsx` | L229-L257 | `{hasImages ? (<div className={styles.userImages}>...` | 彻底物理切除 29 行裸图大画廊 | 覆盖完整，不留空节点 | ✅ **PASS** |
| `ChatUserMessageRow.tsx` | L259-L283 | `{hasAttachments ? (<div className={styles.userAttachments}>...` | 彻底物理切除 25 行旧灰色药丸 | 覆盖完整，旧类名彻底移除 | ✅ **PASS** |
| `ChatUserMessageRow.tsx` | **L22-L40** | `function resolveUserImageSrc(...)` (共 19 行) | **遗漏！未在切除表中声明** | **重构后成为死函数，必须补入切除表** | ❌ **DEFECT** |
| `ChatUserMessageRow.tsx` | **L16,18,19** | `import { FileFormatIcon, convertFileSrc, ... }` | **遗漏！未清理无用 Import** | **存在未使用的废弃依赖，必须清理** | ❌ **DEFECT** |
| `FilesCard.tsx` | L5 | `import { CornerLeftUp, ... }` | 物理移除 `CornerLeftUp` 导入 | 覆盖完整 | ✅ **PASS** |
| `FilesCard.tsx` | L28 | `const PARENT_DIR_LABEL = '上级目录';` | 彻底物理删除整行定义 | 覆盖完整 | ✅ **PASS** |
| `FilesCard.tsx` | L158-L165 | `const handleGoUp = useCallback(...)` | 彻底物理删除 8 行函数实现 | 覆盖完整 | ✅ **PASS** |
| `FilesCard.tsx` | L180-L186 | `if (isDir) void handleRefresh(path);` | 替换为原地 `toggleExpand` | 覆盖完整，清除钻取 | ✅ **PASS** |
| `FilesCard.tsx` | L289-L300 | 顶栏“上级目录”按钮 JSX 节点（12 行） | 彻底物理切除整块 JSX | 覆盖完整 | ✅ **PASS** |
| `FilesCard.tsx` | **L160 (Spec04)** | `<FileBreadcrumb root={nav.root} cwd={nav.cwd} ... />` | **严重违规！骨架中依然书写 `nav.cwd`** | **契约断裂！nav 无 cwd，导致 TS 编译阻断** | ❌ **BLOCKER** |
| `FilesCard.tsx` | **L188-L193** | `preview.copyPath(preview.selected \|\| nav.cwd, ...)` | **遗漏！未在切除表中声明** | **残留 nav.cwd 引用，导致 TS 编译阻断** | ❌ **BLOCKER** |

---

## 三、负向断言测试完备性审查（Negative Assertions Audit）

按照 `AGENTS.md` §7.1 与 `analysis/05-audit-framework-strategy.md` §2.2 规定：“必须提供自动化测试用例，断言废弃字段与废弃类名出现次数严格为 0，以编译期与测试断言刚性守门”。

### 3.1 各规范负向测试覆盖度全景比对

审查专家对 5 份详细规范中声明的单元测试进行了逐行审查：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        各规范负向测试覆盖度全景比对                    │
├────────────────────────────────────────────────────────────────────────┤
│ Spec-02 (useFileNavigation):                                           │
│   - hookReturn.cwd === undefined            [✅ 覆盖]                  │
│   - hookReturn.setCwd === undefined         [✅ 覆盖]                  │
│   - hookReturn.goUp === undefined           [✅ 覆盖]                  │
├────────────────────────────────────────────────────────────────────────┤
│ Spec-04 (FileBreadcrumb & FilesCard):                                  │
│   - container.querySelector('.filesBcFlyoutSearch') === null  [✅ 覆盖] │
│   - input[type="search"] === null                             [✅ 覆盖] │
│   - FilesCard 渲染中无 PARENT_DIR_LABEL                        [❌ 缺失] │
│   - FilesCard 渲染中无 CornerLeftUp                            [❌ 缺失] │
├────────────────────────────────────────────────────────────────────────┤
│ Spec-05 (ChatUserMessageRow & AttachmentCard):                         │
│   - container.querySelector('.userAttachmentChip') === null   [✅ 覆盖] │
│   - container.querySelector('.userImages') === null           [✅ 覆盖] │
│   - container.querySelector('.userImageWrapper') === null     [✅ 覆盖] │
│   - container.querySelector('.userImage') === null            [✅ 覆盖] │
│   - container.querySelector('.userAttachments') === null      [✅ 覆盖] │
│   - container.querySelector('.userAttachmentName') === null   [✅ 覆盖] │
│   - container.querySelector('[data-testid="user-images-gallery"]') === null [✅ 覆盖] │
│   - moduleExports.userAttachmentChip === undefined            [✅ 覆盖] │
│   - card.getAttribute('title') === null (零原生 title)         [✅ 覆盖] │
│   - 空气泡模式下 userBubble === null (零空壳渲染)               [✅ 覆盖] │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.2 `FilesCard` 负向断言严重缺失硬伤分析

在 `detailed-plans/04-files-card-and-breadcrumb-spec.md` 中存在明显的测试盲区：
1. **测试白名单限制**：`04` 规范在 §2.2 中仅把 `FileBreadcrumb.test.tsx` 列为测试文件白名单，**并未包含任何针对 `FilesCard.tsx` 的测试文件**；
2. **负向断言缺失**：在 `FileBreadcrumb.test.tsx` 中，测试用例仅覆盖了面包屑浮层内部搜索栏的形态，而对于宿主容器 `FilesCard.tsx` 切除的：
   - 是否还存在文本为“上级目录”的按钮？
   - 是否还能在 DOM 中通过 `aria-label="上级目录"` 找到节点？
   - 是否还存在 `CornerLeftUp` 图标？
   **没有任何测试用例进行负向断言！**
3. **违反审计准则 HB-06**：“任务书与方案中未声明针对旧类名、废弃符号的负向断言测试用例”。这构成了一处必须纠偏的硬性缺陷。

### 3.3 源码级静态字符串拦截与运行时断言双重防线

仅靠运行时 DOM 测试容易被 Mock 绕过。审查专家核验 `analysis/05-audit-framework-strategy.md` §6 所规定的静态扫描脚本：

```javascript
// 必须在自动化门禁中执行的纯静态物理切除校验
const bannedPatterns = [
  { re: /\.userAttachmentChip\b/, msg: "发现残留的死亡 CSS 类名: .userAttachmentChip" },
  { re: /\.userImages\b/, msg: "发现残留的死亡 CSS 类名: .userImages" },
  { re: /PARENT_DIR_LABEL/, msg: "发现残留的上级目录标签: PARENT_DIR_LABEL" },
  { re: /CornerLeftUp/, msg: "发现残留的上级目录图标: CornerLeftUp" },
  { re: /#[0-9a-fA-F]{3,8}\b/, msg: "发现违规裸 Hex 颜色" }
];
```

**审查意见**：各 Execution Specs 应在自身验收章节显式要求子 Agent 执行该脚本，形成“静态源码正则硬拦截 + 运行时 DOM/JSDOM 负向断言”的双重保险。

---

## 四、负向约束硬红线与防过度设计审查（Negative Constraints & Guardrails）

### 4.1 任务书负向禁令严厉程度核验

审查专家对 5 份详细设计文档的“负向约束禁令（Negative Constraints）”章节进行了对齐性核验：

1. **`02-tree-navigation-spec.md` §7（8 条硬红线）**：
   - 严禁发明全局 Store/Zustand；
   - 严禁篡改或重设树根；
   - 严禁使用注释保留旧代码或提供双轨兼容分支；
   - 严禁在返回值中泄露 `cwd`、`setCwd`、`goUp`；
   - 严禁引入外部路径库（`pathe`、`lodash` 等）；
   - 严禁越权修改白名单外文件；
   - 严禁破坏既有 `confirmNavigation` 契约；
   - 严禁执行 `git commit`。
   **评价**：禁令严苛，词义无歧义，完全封死子 Agent 自由发挥空间。

2. **`04-files-card-and-breadcrumb-spec.md` §8（14 条硬红线）**：
   - 严禁滥用魔术数字 `z-index: 9999`；
   - 严禁将 resizer 的 `z-index` 设为 $\le 0$；
   - 严禁破坏形态 ④ 纯光标规范（无边框、无阴影、仅发丝下边框）；
   - 严禁篡改面包屑下拉树遍历/展开算法（用户最高裁决维持现状）；
   - 严禁将 `dirCache` 改造为全局 Store；
   - 严禁使用原生 HTML `title`，100% 使用自定义 `<Tooltip>`；
   - 严禁使用 `type="search"` 原生属性，强制 `type="text"`；
   - 严禁保留双轨下钻；
   - 严禁执行 `git commit`。
   **评价**：严厉且具备极高针对性，准确锁定 W3C 层叠上下文与形态 ④ 细节。

3. **`05-message-attachment-spec.md` §8（9 条硬红线）**：
   - 严禁在气泡 `userBubble` 内部嵌套卡片容器或药丸胶囊；
   - 严禁在代码或样式表中保留旧类名；
   - 严禁使用 `display: none` 假装删除；
   - 严禁在卡片上使用原生 HTML `title`；
   - 严禁在纯附件模式下渲染空的背景或边框壳子（空气泡彻底销毁）；
   - 严禁在 Hover/Focus 态使用硬编码裸色、黑边或浓重阴影；
   - 严禁修改白名单外文件；
   - 严禁引入 npm 新依赖；
   - 严禁执行 `git commit`。
   **评价**：彻底封堵了 UI 层所有容易产生“打补丁”与“视觉劣化”的漏洞。

---

### 4.2 跨规范契约冲突审计（盘符大小写归一化分歧）

在比对 `01-path-canonical-spec.md` 与 `execution-specs/spec-01-path-canonical-api.md` 及 `05-audit-framework-strategy.md` 时，审查专家发现了一处**基础契约冲突**：

- 在 [`detailed-plans/01-path-canonical-spec.md:113-115`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/01-path-canonical-spec.md#L113-L115) 中，作者声明将盘符强制转为**大写**：
  ```typescript
  // 01-path-canonical-spec.md:113-115
  norm = norm.replace(/^([a-zA-Z]):(\/|$)/, (_, drive: string, rest: string) => {
    return `${drive.toUpperCase()}:${rest || '/'}`; // ❌ 此处写了大写
  });
  ```
- 但在 [`execution-specs/spec-01-path-canonical-api.md:27`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/execution-specs/spec-01-path-canonical-api.md#L27) 与 [`analysis/05-audit-framework-strategy.md:320,374`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/analysis/05-audit-framework-strategy.md#L320) 中，硬性裁决 **HB-16** 明确规定：
  > “Windows 盘符小写化：匹配 `^[A-Za-z]:` 时强制将盘符字母转为**小写**（例如 `C:/Project` 必须稳定转换为 `c:/Project`），防止因不同 API 返回大小写盘符导致 `Map` 字典查找失配。”
- 在 `02-tree-navigation-spec.md:652` 的单测中，开发者因察觉到此分歧，写出了妥协性断言：
  ```typescript
  expect(result.current.expanded['c:/repo/apps'] || result.current.expanded['C:/repo/apps']).toBeDefined();
  ```
- **审查裁决**：单一真理源（SSOT）绝不允许双轨！必须消除该分歧，依据战役审计总纲 **HB-16**，统一修正 `01-path-canonical-spec.md` 为**盘符字母强制小写化（`drive.toLowerCase()`）**。

---

### 4.3 白名单文件域空间独占性与 Git 权限隔离性核验

审查专家核验 5 份详细规划任务书的文件独占声明：

$$\text{Files}(\text{Spec}_i) \cap \text{Files}(\text{Spec}_j) = \emptyset \quad (\forall i \ne j)$$

1. **Spec-01**：`workspaceFsApi.ts`、`workspaceFsApi.test.ts`（无交集）
2. **Spec-02**：`useFileNavigation.ts`、`useFileNavigation.test.tsx`（无交集）
3. **Spec-03**：`FileTreeView.tsx`、`FileTreeView.test.tsx`（无交集）
4. **Spec-04**：`FilesCard.tsx`、`FileBreadcrumb.tsx`、`FilesCard.module.css`、`FileBreadcrumb.test.tsx`（无交集）
5. **Spec-05**：`AttachmentCard.tsx`、`AttachmentCard.module.css`、`ChatUserMessageRow.tsx`、`ChatMessageRow.module.css`、`ChatUserMessageRow.test.tsx`（无交集）

**核验结论**：五大任务书文件白名单在数学上严格互斥，完全符合 Conex 引擎 `crates/agent-tools/src/write_paths.rs` 的单文件独占锁要求，并行施工零锁争抢。同时，所有任务书均设立了“严禁执行 git commit”硬红线，权限收敛至主 Agent，合规通过。

---

## 五、一票否决项（Hard Blockers）逐项扫描结果

对照 `analysis/05-audit-framework-strategy.md` §3.2 的 18 项全景一票否决矩阵逐一进行严格判定：

| 检查编号 | 一票否决项（Hard Blocker） | 违规模式 / 毒点代码特征 | 本次规划方案扫描情况 | 判定结论 |
| :--- | :--- | :--- | :--- | :---: |
| **HB-01** | **保留或重置 `cwd` 破坏单轨根** | 在 `useFileNavigation` 中保留 `cwd`；双击调用 `handleRefresh(subDir)`。 | `useFileNavigation` 干净切除；但 `FilesCard.tsx` 仍有 2 处残留 `nav.cwd`。 | ❌ **FAIL (BLOCK)** |
| **HB-02** | **面包屑反向篡改主文件树根** | 面包屑双击重设主树根；在面包屑另建全局 Store。 | 面包屑树逻辑严格维持现状，仅在浮层内局部下钻。 | ✅ **PASS** |
| **HB-03** | **字典键未规范化导致多轨键分裂** | 直接用未归一化路径作为 `expanded[p]` 键。 | 存取统一经 `toCanonicalFsPath`，键空间唯一。 | ✅ **PASS** |
| **HB-04** | **保留旧药丸或旧裸图类名及样式** | 在 CSS 保留 `.userAttachmentChip`；JSX 用注释/隐藏兜底。 | 61 行死亡 CSS 彻底切除，旧类名在 JSX 中无引用。 | ✅ **PASS** |
| **HB-05** | **残留“上级目录”钻取按钮或函数** | 在 `FilesCard.tsx` 保留 `handleGoUp`、`PARENT_DIR_LABEL` 等。 | `FilesCard.tsx` 已声明切除；但缺少配套负向测试。 | ⚠️ **FAIL (转HB-06)** |
| **HB-06** | **缺乏负向断言保护测试** | 任务书未声明针对旧类名、废弃符号的负向断言测试。 | Spec-02与05有负向测试，但 Spec-04 缺失 `FilesCard` 负向测试。 | ❌ **FAIL (BLOCK)** |
| **HB-07** | **气泡附件未按用户参考图双层重塑** | 未采用上方独立卡片+下方独立气泡；空气泡未隐藏。 | 严格对齐参考图，上方 58x58 横排，纯附件空气泡彻底销毁。 | ✅ **PASS** |
| **HB-08** | **擅自推倒重写面包屑树渲染逻辑** | 企图重写面包屑树为全局根；删减逐层下钻能力。 | 严格冻结 `FlyoutState` 与渲染逻辑，维持现状不变。 | ✅ **PASS** |
| **HB-09** | **缺失虚拟滚动视口几何居中算法** | `revealPath` 展开后未计算视口滚动与呼吸高亮。 | Spec-03 提供数学居中公式与 1.4s 呼吸高亮驱动。 | ✅ **PASS** |
| **HB-10** | **源码出现任何未经收敛的裸 Hex** | 在 CSS/TSX 中硬编码 `#fff`、`#000`、`#2563eb` 等。 | 100% 映射 Design Tokens 与现代 CSS `color-mix` 语法。 | ✅ **PASS** |
| **HB-11** | **使用原生 HTML `title` 冒充悬浮提示** | 在组件中书写 `title={...}` 代替自定义 Tooltip。 | 100% 使用项目 `<Tooltip>`，单测设立 `title === null` 断言。 | ✅ **PASS** |
| **HB-12** | **输入框/焦点态出现重阴影或粗黑边** | 面包屑搜索框使用深黑描边或 heavy box-shadow。 | 1:1 对齐极简形态 ④，纯光标闪烁，焦点对比度 $\le 10\%$。 | ✅ **PASS** |
| **HB-13** | **未用 CSS 隔离舱解决分割线穿透** | 用 `z-index: 9999` 或隐藏 resizer 代替隔离舱。 | `.filesBody` 显式注入 `isolation: isolate; z-index: var(--z-base, 0)`。 | ✅ **PASS** |
| **HB-14** | **引入外部第三方路径解析依赖库** | 新增 `path-browserify`、`pathe`、`lodash` 等 npm 库。 | 严格纯手写原生字符串正则纯函数，零新 npm 依赖。 | ✅ **PASS** |
| **HB-15** | **触犯 13 项硬性红线（微服务套娃等）** | 引入 6 阶段中间件、虚假 Facade、分布式共识。 | 架构正交扁平，纯函数直调，零套娃。 | ✅ **PASS** |
| **HB-16** | **Windows 盘符未做小写化归一化** | 路径规范化未将 `C:` 统一转换为 `c:`。 | Spec-01 文本写了 `toUpperCase`，与总纲小写化要求冲突。 | ⚠️ **DEFECT** |
| **HB-17** | **路径越界防御漏洞或死循环风险** | 祖先目录推导算法未作越界校验导致死循环。 | 具备严格的 `startsWith(root + '/')` 越界守卫。 | ✅ **PASS** |
| **HB-18** | **任务书授权子 Agent 提交 Git** | 任务书允许子 Agent 执行 `git commit`。 | 所有任务书均显式禁止子 Agent 执行 `git commit`。 | ✅ **PASS** |

---

## 六、六维立体打分卡汇总与扣分明细

根据 `analysis/05-audit-framework-strategy.md` §5.1 的百分制打分卡，各维度细项评分如下：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    方案合理性六维定量打分卡审查结果                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  [维度一] 单一真理源 (SSOT) 纯度审查           │ 得分: 14 / 20 分 (扣 6 分)  │
│  [维度二] 物理删除彻底性审查                   │ 得分: 14 / 20 分 (扣 6 分)  │
│  [维度三] 用户最高裁决对齐度审查               │ 得分: 20 / 20 分 (满分)     │
│  [维度四] Design Token 100% 遵从度审查         │ 得分: 15 / 15 分 (满分)     │
│  [维度五] 反过度设计红线审查                   │ 得分: 15 / 15 分 (满分)     │
│  [维度六] 跨平台路径鲁棒性审查                 │ 得分:  9 / 10 分 (扣 1 分)  │
├─────────────────────────────────────────────────────────────────────────────┤
│  【总评分】: 87 / 100 分   (准入阈值: >= 95 分 且 0 Hard Blockers)          │
│  【审计状态】: CONDITIONAL BLOCK (暂缓施工，待执行工单修订)                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 详细扣分明细：
1. **维度一（扣 6 分）**：
   - 扣 4 分：`FilesCard.tsx` 中仍残留两处 `nav.cwd`（L160 与 L189），调用已剔除字段，引发类型断裂（触发 HB-01 关联项）；
   - 扣 2 分：`01-path-canonical-spec.md` 与审计总纲关于 Windows 盘符大小写契约不一致（大写 vs 小写）。
2. **维度二（扣 6 分）**：
   - 扣 2 分：`ChatUserMessageRow.tsx` 原第 22-40 行 `resolveUserImageSrc`（19 行）未列入物理删除对照表，重构后成为死代码；
   - 扣 2 分：`ChatUserMessageRow.tsx` 未清理无用的 `convertFileSrc` 与 `FileFormatIcon` 导入；
   - 扣 2 分：`FilesCard.tsx` 缺少针对 `handleGoUp`、`PARENT_DIR_LABEL` 的负向断言测试用例（触发 HB-06）。
3. **维度六（扣 1 分）**：
   - 扣 1 分：盘符大小写定义冲突导致跨平台比对时存在细微语义漂移隐患。

---

## 七、缺陷修复工单与原子修正方案（Actionable Delta Remediation Plan）

为了以最小代价、最快速度将方案推至 **100 分满分** 并解除施工阻断，审查专家签发以下 4 项确定性原子修订工单：

### 7.1 工单 1（DEFECT-PURGE-01）：切除 `FilesCard.tsx` 中残留的 `nav.cwd` 属性

**目标文件**：[`detailed-plans/04-files-card-and-breadcrumb-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/04-files-card-and-breadcrumb-spec.md)
**修订内容**：
1. 在 §4.1.2 的 JSX 骨架中（行 159-167），将 `<FileBreadcrumb cwd={nav.cwd} ... />` 修改为：
   ```tsx
   {/* 修订后：单轨模型下，浏览态默认目录恒为项目根 nav.root，彻底移除 nav.cwd */}
   {!noRoot ? (
     <FileBreadcrumb
       root={nav.root}
       cwd={nav.root}
       selected={preview.selected}
       view={preview.view}
       dirty={preview.dirty}
       onNavigate={handleNavigate}
       onOpenFile={handleOpenFile}
     />
   ) : null}
   ```
2. 在 §5 的物理删除表中追加一行：
   - 原行号：`FilesCard.tsx:188-193`
   - 原代码：`preview.copyPath(preview.selected || nav.cwd, nav.root, mode);`
   - 修订为：`preview.copyPath(preview.selected || nav.root, nav.root, mode);`，同时依赖项移除 `nav.cwd`。

---

### 7.2 工单 2（DEFECT-PURGE-02）：切除 `ChatUserMessageRow.tsx` 中死亡函数 `resolveUserImageSrc` 及无用 imports

**目标文件**：[`detailed-plans/05-message-attachment-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/05-message-attachment-spec.md)
**修订内容**：
1. 在 §5.2 的物理切除表中追加两项：
   - **项 A**：`ChatUserMessageRow.tsx:22-40`：`function resolveUserImageSrc(...)` 全部 19 行代码，处置动作标记为 **彻底物理删除**（职责已迁移至 `AttachmentCard.tsx` 的 `resolveCardImageSrc`）；
   - **项 B**：`ChatUserMessageRow.tsx:16,18,19`：物理删除无用的 `FileFormatIcon`、`convertFileSrc` 与 `assertWorkspacePath` 导入。

---

### 7.3 工单 3（DEFECT-TEST-01）：为 `FilesCard` 增补负向断言测试套件

**目标文件**：[`detailed-plans/04-files-card-and-breadcrumb-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/04-files-card-and-breadcrumb-spec.md)
**修订内容**：
在 §9 单元测试章节追加 `FilesCard` 的负向渲染断言用例：
```typescript
it('【SPEC-04 负向断言】FilesCard 彻底清除钻取模型：严禁渲染上级目录按钮与 CornerLeftUp 图标', async () => {
  const { queryByLabelText, queryByText, container } = render(<FilesCard />);

  // 负向断言 1：通过 aria-label 无法找到上级目录按钮
  expect(queryByLabelText('上级目录')).toBeNull();

  // 负向断言 2：通过文本内容无法找到上级目录
  expect(queryByText('上级目录')).toBeNull();

  // 负向断言 3：容器内严禁出现包含 CornerLeftUp 类名或特征的 SVG 节点
  const cornerIcons = container.querySelectorAll('svg.lucide-corner-left-up');
  expect(cornerIcons.length).toBe(0);
});
```

---

### 7.4 工单 4（DEFECT-SSOT-01）：对齐 Spec-01 与总纲的 Windows 盘符小写化契约

**目标文件**：[`detailed-plans/01-path-canonical-spec.md`](file:///c:/Software/conex/docs/file-tree-and-attachments-architecture/detailed-plans/01-path-canonical-spec.md)
**修订内容**：
在 §4 核心实现代码块中（行 113-115），将：
```typescript
norm = norm.replace(/^([a-zA-Z]):(\/|$)/, (_, drive: string, rest: string) => {
  return `${drive.toUpperCase()}:${rest || '/'}`;
});
```
修正为严格遵循 **HB-16** 的小写化标准：
```typescript
norm = norm.replace(/^([a-zA-Z]):(\/|$)/, (_, drive: string, rest: string) => {
  return `${drive.toLowerCase()}:${rest || '/'}`;
});
```
并在 `02-tree-navigation-spec.md:652` 中将模糊断言收敛为唯一规范断言：
```typescript
expect(result.current.expanded['c:/repo/apps']).toBeDefined();
```

---

## 八、最终审计结论与放行裁决（Clearance Verdict）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    方案合理性审计裁决签发书 (Audit Verdict)                 │
├──────────────────────────────────────────────────────────────────────────────┤
│  战役工作区: docs/file-tree-and-attachments-architecture/                    │
│  审计专家: Senior Code Net-Convergence & Dead-Code Purge Audit Specialist    │
│  审计对象: 详细规划设计文档 01 至 05                                          │
│                                                                              │
│  【审计结论】: CONDITIONAL BLOCK (有条件阻断 / 待增量修复)                    │
│  【综合得分】: 87 分 (未达到 95 分准入门槛，触发 HB-01 与 HB-06 硬阻断)      │
│                                                                              │
│  【放行指令】:                                                                │
│  1. 立即指派相关规划者就地执行第 七 节开具的 4 项原子修复工单；              │
│  2. 修订完成后提交增量复审 (Delta Re-Audit)；                                │
│  3. 待 Hard Blockers 违规计数清零且综合得分 >= 95 分后，正式签发施工准入书；  │
│  4. 在获得正式准入签发书前，严禁任何子 Agent 提前启动代码落地修改！           │
└──────────────────────────────────────────────────────────────────────────────┘
```

---
*本报告严格执行纯逻辑工程审计，全量审计证据与代码行号均穿透复核无误，UTF-8 无 BOM 存盘。*
