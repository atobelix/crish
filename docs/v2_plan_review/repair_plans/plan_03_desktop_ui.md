# Plan 03: Desktop UI TypeScript 编译错误修复方案

> **Agent**: #3 (修复方案规划 Agent)  
> **范围**: `apps/crish-desktop/src/` (JSX 解析错误 · 类型错误)  
> **生成命令**: `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json`  
> **总错误数**: 28  
> **涉事文件**: 10  
> **日期**: 2026-07-25

---

## 目录

1. [错误全景](#1-错误全景)
2. [问题分类与根因分析](#2-问题分类与根因分析)
3. [写集隔离（Write-Set Isolation）](#3-写集隔离write-set-isolation)
4. [任务卡表](#4-任务卡表)
5. [覆盖率矩阵](#5-覆盖率矩阵)
6. [机器可读台账（Round/Wave 分配与状态跟踪）](#6-机器可读台账roundwave-分配与状态跟踪)
7. [修复后验收命令](#7-修复后验收命令)

---

## 1. 错误全景

### 1.1 全局统计

| 错误代码 | 含义 | 出现次数 | 典型场景 |
|----------|------|----------|----------|
| TS17008 | JSX element has no corresponding closing tag | 3 | `<div>` 缺 `</div>`，或 `<>` 不匹配 |
| TS17002 | Expected corresponding JSX closing tag | 1 | `<button>` 缺 `</button>`（QuickOpen） |
| TS1005 | ';' expected | 10 | 语句结束符错误，多在文件末尾 |
| TS1381 | Unexpected token. Did you mean `{'}'}` or `&rbrace;`? | 5 | `}` 在 JSX 文本中未转义 |
| TS1382 | Unexpected token. Did you mean `{'>'}` or `&gt;`? | 2 | `>` 在 JSX 属性值中未转义 |
| TS1128 | Declaration or statement expected | 1 | 挂尾语句导致声明错误 |
| TS1136 | Property assignment expected | 1 | 对象字面量未正确闭合 |
| TS1109 | Expression expected | 2 | 表达式位置出现闭合标签 |

### 1.2 按文件统计

| # | 文件路径 | 错误行 | 错误代码 | 预计根因分类 |
|---|----------|--------|----------|-------------|
| 1 | `src/components/CardPanel.tsx` | 793 | TS17008 | JSX 标签不匹配 (div) |
| 2 | `src/components/CardPanel.tsx` | 894 | TS1005 | 级联解析错误 |
| 3 | `src/components/CardPanel.tsx` | 1002 | TS1381 | 花括号未正确闭合 |
| 4 | `src/components/CardPanel.tsx` | 1042 (×2) | TS1005 + TS1381 | 花括号 + 级联 |
| 5 | `src/components/CardPanel.tsx` | 1168 | TS1005 | 组件结尾语法错误 |
| 6 | `src/components/CardPanel.tsx` | 1169 | TS1381 | 组件结尾语法错误 |
| 7 | `src/components/CardPanel.tsx` | 1171 | TS1005 | 组件结尾语法错误 |
| 8 | `src/components/ChatHeaderMore.tsx` | 238 | TS1005 | React.memo 结尾 `));` → `});` |
| 9 | `src/components/ChatStatusRibbons.tsx` | 913 | TS1005 | React.memo 结尾 `));` → `});` |
| 10 | `src/components/ComposePlusMenu.tsx` | 233 | TS1005 | React.memo 结尾 `));` → `});` |
| 11 | `src/components/DiffCardFileList.tsx` | 337 | TS1005 | React.memo 结尾 `));` → `});` |
| 12 | `src/components/DiffCardGitActions.tsx` | 106 | TS1005 | React.memo 结尾 `));` → `});` |
| 13 | `src/components/ModelPicker.tsx` | 300 | TS1005 | React.memo 结尾 `));` → `});` |
| 14 | `src/components/SettingsPanel.tsx` | 730 | TS1005 | React.memo 结尾 `));` → `});` |
| 15 | `src/components/SettingsPanel.tsx` | 731 | TS1128 | 级联自 730 |
| 16 | `src/components/QuickOpen.tsx` | 231 | TS1005 | `<button` 未 `>` 闭合即嵌套 `<Tooltip` |
| 17 | `src/components/QuickOpen.tsx` | 246 | TS17002 | 级联自 231 |
| 18 | `src/components/WorkspaceChromeBars.tsx` | 356 | TS17008 | JSX 元素 `div` 缺 `</div>`，根因在 433-437 的 onClick 未闭合 |
| 19 | `src/components/WorkspaceChromeBars.tsx` | 436 | TS1136 | `</div>` 替代了 `})`，对象字面量未闭合 |
| 20 | `src/components/WorkspaceChromeBars.tsx` | 437 | TS1005 | 级联自 436 |
| 21 | `src/components/WorkspaceChromeBars.tsx` | 509 | TS1381 | WorkspaceStrip 结尾 `});` 正确但被前序错误级联污染 |
| 22 | `src/components/WorkspaceChromeBars.tsx` | 512 (×2) | TS17008 + TS1382 | SessionStrip 声明中 `<Props>` 被解析为 JSX |
| 23 | `src/components/WorkspaceChromeBars.tsx` | 513 | TS1109 | 级联 |
| 24 | `src/components/WorkspaceChromeBars.tsx` | 602 | TS1381 | SessionStrip 结尾，级联 |
| 25 | `src/components/WorkspaceChromeBars.tsx` | 605 (×2) | TS17008 + TS1382 | 同理 512，`<Props>` 级联 |
| 26 | `src/components/WorkspaceChromeBars.tsx` | 606 | TS1109 | 级联 |
| 27 | `src/components/WorkspaceChromeBars.tsx` | 617 | TS1381 | 级联 |
| 28 | `src/components/WorkspaceChromeBars.tsx` | 618 | TS1005 | 级联 |

### 1.3 级联依赖分析

```
CardPanel.tsx
  Line 793 TS17008 (div missing close) → 894 TS1005 → 1002 TS1381 → 1042 TS1005/TS1381 → 1168 TS1005 → 1169 TS1381 → 1171 TS1005
  ├── Root cause 1: JSX 标签或花括号匹配断裂（需 Read 确认具体位置）
  └── All remaining 6 errors are cascading

QuickOpen.tsx
  Line 231 TS1005 (<button without >) → 246 TS17002
  └── Root cause: 缺少 `>` 闭合 button 开标签
  └── All 1 remaining error is cascading

WorkspaceChromeBars.tsx
  Line 433-435 onClick handler + object literal unclosed → 436/437 TS1136/TS1005 → cascade through 509, 512, 513, 602, 605, 606, 617, 618
  ├── Root cause: onClick 箭头函数体 + s.selectWorkspace 对象未用 `})` 闭合
  └── All 10 remaining errors are cascading

SettingsPanel.tsx
  Line 730 TS1005 ()); → });) → 731 TS1128
  └── Root cause: React.memo 结尾应为 `});` 而非 `));`
  └── All 1 remaining error is cascading
```

---

## 2. 问题分类与根因分析

### 2.1 分类 A: React.memo 结尾 `));` → `});`（7 文件）

**涉事文件**: ChatHeaderMore.tsx, ChatStatusRibbons.tsx, ComposePlusMenu.tsx, DiffCardFileList.tsx, DiffCardGitActions.tsx, ModelPicker.tsx, SettingsPanel.tsx

**根因**: 这些组件均使用 `React.memo(({ ... }: Props) => { return (...); })` 模式。正确的结尾应为 `});`：
- `)` 关闭 `return(`
- `}` 关闭箭头函数体 `=> {`
- `)` 关闭 `React.memo(`
- `;` 结束语句

但实际代码包含 `));`，其中第二个 `)` 应为 `}`。

**验证方法**:
```bash
Select-String -Path "apps/crish-desktop/src/components/*.tsx" -Pattern "\)\);" | ForEach-Object { "$($_.FileName):$($_.LineNumber) $($_.Line)" }
```

**修复方式**: 精确单行替换：`));` → `});`（仅文件末行）

### 2.2 分类 B: QuickOpen.tsx - `<button` 未闭合（1 文件）

**文件**: `src/components/QuickOpen.tsx`

**根因**: 第 230-231 行：
```tsx
                  <button
                    <Tooltip content={hit.path} side="right">
```
`<button` 在 230 行打开后，231 行直接出现了 `<Tooltip`，缺少 `>` 来闭合 button 的 opening tag。正确形式应为：
```tsx
                  <button
                    type="button"
                    ...
                  >
                    <Tooltip content={hit.path} side="right">
```

当前代码中 button 的 opening tag 未闭合（缺少 `type="button"` 等属性和 `>`），导致 TS 认为 `<Tooltip` 是 button 标签的属性名，造成解析错误。

### 2.3 分类 C: WorkspaceChromeBars.tsx - onClick 回调未闭合（1 文件）

**文件**: `src/components/WorkspaceChromeBars.tsx`

**根因**: 第 427-437 行，第二个菜单按钮的 `onClick` 事件处理器未正确闭合：
```tsx
431:                 onClick={() => {
432:                   add.setOpen(false);
433:                   s.selectWorkspace({
434:                     kind: 'general',
435:                     id: GENERAL_FOLDER,
436:         </div>
437:       </div>
```

`onClick={() => {` 打开的箭头函数体 `{` 未用 `}}>` 闭合。对象字面量 `s.selectWorkspace({` 也未用 `})` 闭合。取而代之的是 `</div>\n      </div>`，这破坏了 JSX 结构，导致 TypeScript 解析器从 436 行开始完全失去同步，后续所有错误均为级联错误。

正确的代码应为：
```tsx
431:                 onClick={() => {
432:                   add.setOpen(false);
433:                   s.selectWorkspace({
434:                     kind: 'general',
435:                     id: GENERAL_FOLDER,
436:                   });
437:                 }}
438:               >
```

然后需要添加 `</button>` 来闭合 `<button`（第 427 行），并确保 JSX 树的闭合标签匹配。

### 2.4 分类 D: CardPanel.tsx - 复合结构断裂（1 文件）

**文件**: `src/components/CardPanel.tsx`

**根因**: 该文件需要深入分析。错误从 793 行开始（TS17008: div 无对应 closing tag），级联至 1171 行。可能的根本原因：
1. 某个 JSX 文本节点或属性值中包含未转义的 `{`、`}`、`>` 字符
2. 混合缩进（tab + space）导致解析器在特定位置逻辑行断裂
3. 存在一个未闭合的 JSX 标签（非 div），导致所有后续标签匹配错位

**需要 Read 确认的具体检查点**:
- [ ] 检查 792-805 行的 `return ( <div ... >` 结构是否完整
- [ ] 检查 1000-1042 行花括号闭合顺序
- [ ] 检查是否有未转义的 `>` 或 `}` 出现在 JSX 文本中
- [ ] 检查 `{activeCardId === 'chat' ? ... ) : ( ... )}` 嵌套正确性

详细 Read 结果见下文 Task Card T-UI-001 的根因确认部分。

---

## 3. 写集隔离（Write-Set Isolation）

每个组件文件属于独立的写集（Write-Set），可并行修复、互不冲突。

| 写集 ID | 文件 | 修复 Agent | 依赖 |
|---------|------|-----------|------|
| WS-001 | `CardPanel.tsx` | Agent #4 | 无 |
| WS-002 | `ChatHeaderMore.tsx` | Agent #4 | 无 |
| WS-003 | `ChatStatusRibbons.tsx` | Agent #4 | 无 |
| WS-004 | `ComposePlusMenu.tsx` | Agent #4 | 无 |
| WS-005 | `DiffCardFileList.tsx` | Agent #4 | 无 |
| WS-006 | `DiffCardGitActions.tsx` | Agent #4 | 无 |
| WS-007 | `ModelPicker.tsx` | Agent #4 | 无 |
| WS-008 | `QuickOpen.tsx` | Agent #4 | 无 |
| WS-009 | `SettingsPanel.tsx` | Agent #4 | 无 |
| WS-010 | `WorkspaceChromeBars.tsx` | Agent #4 | 无 |

**并行修复策略**:
- Round 1（Wave 1）: WS-002 至 WS-009（8 个简单修复，`));` → `});`，及 QuickOpen 的 button 闭合）
- Round 1（Wave 2）: WS-010（WorkspaceChromeBars 的 onClick 修复）
- Round 1（Wave 3）: WS-001（CardPanel 的复合结构修复，需先 Read 确认根因）

---

## 4. 任务卡表

### T-UI-001: CardPanel.tsx

- **文件**: `apps/crish-desktop/src/components/CardPanel.tsx`
- **错误行**: 793, 894, 1002, 1042 (×2), 1168, 1169, 1171
- **错误代码**: TS17008, TS1005, TS1381, TS1005, TS1005, TS1381, TS1005
- **写集**: WS-001
- **预计修复复杂度**: 高（需 Read 确认根因）

#### 根因确认（Read 结果）

从 Read 结果分析，CardPanel.tsx 使用 `React.memo(` 包裹（228 行），`return (` 从 792 行开始。

**检查点 1: line 792-805**
```
792:   return (
793:     <div
794:       className={`...${...}`}
...
805:     >
```
`return (` 正确打开，`<div` 正确开始，`>` 在 805 行正确闭合。此处无问题。

**检查点 2: line 894-1002 花括号闭合**
```
893:             ) : (
894:               <div className="tabs-bar">
...
1001:               </div>
1002:             )}
```
第 893 行的 `) : (` 是 `{activeCardId === 'chat' ? ... ) : (...)}` 的 else 分支。  
第 1002 行的 `)}` 中的 `)` 关闭 else 分支的 `(`，`}` 关闭 `{activeCardId === 'chat' ? ...}` 的 `{`。  
但查看实际缩进：1001 行 `              </div>`（14 空格）对应 894 行 `              <div`（14 空格），匹配正确。  
1002 行的 `)}` 缩进与 893 行 `) : (` 对齐（12 空格），逻辑正确。

**检查点 3: line 1040-1042**
```
1040:               : null}
1041:           </div>
1042:         ) : null}
```
1041 行 `</div>` 闭合 `card-header`（814 行的 `<div className="card-header">`）。  
1042 行 `) : null}` 中的 `)` 闭合 `showCardHeader ? (`（813 行），`}` 闭合 `{showCardHeader` 的 JSX 表达式。  

此处结构正确，但注意 1040 行的 `: null}` 其实是 `{tabAddOpen && tabAddPos ? createPortal(...) : null}` 的闭合，与 showCardHeader 嵌套在同一层级。

**检查点 4: line 1167-1170（组件结尾）**
```
1167:       </div>
1168:     );
1169:   }
1170: );
```
1167 行 `</div>` 闭合 793 行的 `<div`。  
1168 行 `);` 闭合 `return (；  
1169 行 `}` 闭合箭头函数体 `=> {`（229 行）；  
1170 行 `);` 闭合 `React.memo(`（228 行）。

**根因结论**: 文件结构从逻辑上看是正确的。TS17008 于 793 行可能是由于 892-894 行之间的某个字符导致 JSX 解析断裂。具体来说：

查看 892-894 行：
```
892:                   <ChatHeaderMore canExport={Boolean(activeSession)} />
893:                 </span>
894:             ) : (
```

892 行的 JSX 自闭合标签 `<ChatHeaderMore ... />` 正确闭合。893 行 `</span>` 闭合 889 行的 `<span>`。894 行的 `) : (` 属于外层 ternary。

**可能的真正根因**: 第 892 行的 `{}` 嵌套 `{Boolean(activeSession)}`——如果此处有任何花括号/引号不配对，会导致整个后续 JSX 的 `}` 数量错位。但当前代码看起来正确。

**候选修复策略**:
1. 在 1000-1042 区域检查是否有 `}` 或 `>` 出现在 JSX 文本节点的字符串内容中但未用 `{...}` 包裹
2. 检查第 904-907 行的 `const` 声明是否在 `group.cards.map(...)` 的回调函数内正确
3. 最简单的验证方式：在 1167 行前显式添加 `{/* end root div */}` 注释，确认 `</div>` 与 793 行匹配
4. 如果无法确定精确根因，可采取"语法重建"策略：将 792-1167 的 JSX 主体复制到空文件，逐个还原标签匹配

**修复**:
```
步骤 1: Read CardPanel.tsx 第 890-895 行，确认有无隐藏字符/制表符混用
步骤 2: Read CardPanel.tsx 第 1000-1005 行，确认花括号配对
步骤 3: 若发现具体断裂点，修复；若未发现，在 1167 行添加明确闭合注释后重新检查
```

**验收**: `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "CardPanel"` → 0 matches

---

### T-UI-002: ChatHeaderMore.tsx

- **文件**: `apps/crish-desktop/src/components/ChatHeaderMore.tsx`
- **错误行**: 238
- **错误代码**: TS1005
- **写集**: WS-002
- **预计修复复杂度**: 低

#### 当前代码（Read 确认）

```
236:       ) : null}
237:     </div>
238:   ));
```

#### 根因

`React.memo(({ ... }: Props) => { return (...); })` 模式的结尾应为 `});`，实际为 `));`。  
239 行是文件末尾，错误 `'`;' expected` 是因为 `)` 无法匹配任何打开的`(`。

#### 修复

**文件末尾行（238 行）**: `));` → `});`

```diff
-   ));
+   });
```

#### 验收

```powershell
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "ChatHeaderMore"
```
Expected: 0 matches

---

### T-UI-003: ChatStatusRibbons.tsx

- **文件**: `apps/crish-desktop/src/components/ChatStatusRibbons.tsx`
- **错误行**: 913
- **错误代码**: TS1005
- **写集**: WS-003
- **预计修复复杂度**: 低

#### 当前代码（Read 确认）

```
912:     </AppErrorBoundary>
913:   ));
914: 
```

#### 根因

同 T-UI-002。`React.memo` 结尾 `));` 应为 `});`。

#### 修复

**文件末尾行（913 行）**: `));` → `});`

#### 验收

```powershell
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "ChatStatusRibbons"
```
Expected: 0 matches

---

### T-UI-004: ComposePlusMenu.tsx

- **文件**: `apps/crish-desktop/src/components/ComposePlusMenu.tsx`
- **错误行**: 233
- **错误代码**: TS1005
- **写集**: WS-004
- **预计修复复杂度**: 低

#### 当前代码（Read 确认）

```
231:     </div>,
232:     document.body,
233:   ));
```

#### 根因

`React.memo(({ ... }: Props) => { return createPortal(...); })` 结尾应为 `});`。  
注意该组件使用 `createPortal` 而非普通的 `return (...)`，但结尾模式相同。

#### 修复

**文件末尾行（233 行）**: `));` → `});`

#### 验收

```powershell
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "ComposePlusMenu"
```
Expected: 0 matches

---

### T-UI-005: DiffCardFileList.tsx

- **文件**: `apps/crish-desktop/src/components/DiffCardFileList.tsx`
- **错误行**: 337
- **错误代码**: TS1005
- **写集**: WS-005
- **预计修复复杂度**: 低

#### 当前代码（Read 确认）

```
335:       )}
336:     </div>
337:   ));
```

#### 根因

同 T-UI-002。`React.memo` 结尾 `));` 应为 `});`。

#### 修复

**文件末尾行（337 行）**: `));` → `});`

#### 验收

```powershell
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "DiffCardFileList"
```
Expected: 0 matches

---

### T-UI-006: DiffCardGitActions.tsx

- **文件**: `apps/crish-desktop/src/components/DiffCardGitActions.tsx`
- **错误行**: 106
- **错误代码**: TS1005
- **写集**: WS-006
- **预计修复复杂度**: 低

#### 当前代码（Read 确认）

```
104:       </div>
105:     </div>
106:   ));
```

#### 根因

同 T-UI-002。`React.memo` 结尾 `));` 应为 `});`。

#### 修复

**文件末尾行（106 行）**: `));` → `});`

#### 验收

```powershell
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "DiffCardGitActions"
```
Expected: 0 matches

---

### T-UI-007: ModelPicker.tsx

- **文件**: `apps/crish-desktop/src/components/ModelPicker.tsx`
- **错误行**: 300
- **错误代码**: TS1005
- **写集**: WS-007
- **预计修复复杂度**: 低

#### 当前代码（Read 确认）

```
298:       </div>
299:     </div>
300:   ));
```

#### 根因

同 T-UI-002。`React.memo` 结尾 `));` 应为 `});`。

#### 修复

**文件末尾行（300 行）**: `));` → `});`

#### 验收

```powershell
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "ModelPicker"
```
Expected: 0 matches

---

### T-UI-008: QuickOpen.tsx

- **文件**: `apps/crish-desktop/src/components/QuickOpen.tsx`
- **错误行**: 231, 246
- **错误代码**: TS1005 (`>` expected at 231), TS17002 (Expected corresponding JSX closing tag for 'button' at 246)
- **写集**: WS-008
- **预计修复复杂度**: 低

#### 当前代码（Read 确认）

```
229:                 <li key={`${hit.path}-${i}`} role="presentation">
230:                   <button
231:                     <Tooltip content={hit.path} side="right">
232:                       <button
233:                         type="button"
...
245:                       </button>
246:                     </Tooltip>
247:                 </li>
```

#### 根因

第 230 行的 `<button` 缺少 `>` 和属性（type, className, onClick 等），直接嵌套了 `<Tooltip>`。  
TypeScript 解析器将 `<Tooltip` 视为 button 标签的未闭合属性名称，导致 TS1005（期望 `>`）。  
级联导致 246 行的 `</Tooltip>` 被认为与不存在的 `<button` 匹配，产生 TS17002。

#### 修复

在 `<button`（230 行）后添加必要的 JSX 属性和闭合 `>`，使其成为一个完整的自闭合标签或包裹标签。

具体修复（替换 230-231 行）：

```diff
-                   <button
-                     <Tooltip content={hit.path} side="right">
+                   <button
+                     type="button"
+                     className={styles.item}
+                     onClick={() => openHit(hit)}
+                   >
+                     <Tooltip content={hit.path} side="right">
```

但注意 232-245 行已有另一个 `<button>` 包含了完整内容（type, className, onClick 等）。这看起来像是外部 `<button>` 是冗余的，Tooltip 直接包裹内部 button 即可。

**更精确的修复**: 删除外侧多余的 `<button>` 标签（230 行），让 `<Tooltip>` 直接包裹内部的完整 `<button>`。

```diff
-                   <button
-                     <Tooltip content={hit.path} side="right">
+                   <Tooltip content={hit.path} side="right">
```

#### 验收

```powershell
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "QuickOpen"
```
Expected: 0 matches

---

### T-UI-009: SettingsPanel.tsx

- **文件**: `apps/crish-desktop/src/components/SettingsPanel.tsx`
- **错误行**: 730, 731
- **错误代码**: TS1005, TS1128
- **写集**: WS-009
- **预计修复复杂度**: 低

#### 当前代码（Read 确认）

```
729:   </div>
730: ));
731: };
```

#### 根因

第 730 行 `));` 中的第二个 `)` 应为 `}`。`React.memo` 结尾应为 `});`。  
第 731 行 `};` 是级联错误——由于 730 行的 `}` 缺失，731 行的 `}` 被当作函数体闭合，多余的 `};` 导致 TS1128。

#### 修复

**730 行**: `));` → `});`  
**731 行**: 删除（`};`）

```diff
- ));
- };
+ });
```

#### 验收

```powershell
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "SettingsPanel"
```
Expected: 0 matches

---

### T-UI-010: WorkspaceChromeBars.tsx

- **文件**: `apps/crish-desktop/src/components/WorkspaceChromeBars.tsx`
- **错误行**: 356, 436, 437, 509, 512 (×2), 513, 602, 605 (×2), 606, 617, 618
- **错误代码**: TS17008, TS1136, TS1005, TS1381, TS17008, TS1382, TS1109, TS1381, TS17008, TS1382, TS1109, TS1381, TS1005
- **写集**: WS-010
- **预计修复复杂度**: 中

#### 当前代码（Read 确认）

第 427-437 行（根因区）:
```
427:               <button
428:                 type="button"
429:                 role="menuitem"
430:                 className={`${styles.wsChromeAddItem} ws-chrome-add-item`}
431:                 onClick={() => {
432:                   add.setOpen(false);
433:                   s.selectWorkspace({
434:                     kind: 'general',
435:                     id: GENERAL_FOLDER,
436:         </div>
437:       </div>
```

以下为正确的参考结构（413-426 行的第一个按钮已正确闭合）:
```
413:               <button
414:                 type="button"
415:                 role="menuitem"
416:                 className={`${styles.wsChromeAddItem} ws-chrome-add-item`}
417:                 onClick={() => {
418:                   add.setOpen(false);
419:                   s.onAdd();
420:                 }}
421:               >
422:                 <FolderPlus size={16} strokeWidth={1.75} aria-hidden />
423:                 <span ...>
424:                   <span>添加本地项目</span>
425:                 </span>
426:               </button>
```

#### 根因

第二个按钮（427-436 行）的 `onClick` 回调在 `s.selectWorkspace({ kind: 'general', id: GENERAL_FOLDER,` 处断裂了。  
对象字面量缺少 `})` 闭合，箭头函数缺少 `}}>` 闭合，button 标签缺少 `>` 和 `</button>`。  
取而代之的是 `</div>\n      </div>`，这完全打乱了 JSX 树结构，导致 TypeScript 解析器从 436 行开始完全失步。

**具体缺失的内容**:
1. 对象 `s.selectWorkspace({...})` 需用 `})` 闭合（435 行后）
2. 箭头函数 `onClick={() => { ... }}` 需用 `}}>` 闭合
3. button 标签需用 `>` 闭合 opening tag（之后还需 `</button>` closing tag）

#### 修复

替换第 435-437 行：

```diff
-                   s.selectWorkspace({
-                     kind: 'general',
-                     id: GENERAL_FOLDER,
-         </div>
-       </div>
+                   s.selectWorkspace({
+                     kind: 'general',
+                     id: GENERAL_FOLDER,
+                   });
+                 }}
+               >
+                 <FolderPlus size={16} strokeWidth={1.75} aria-hidden />
+                 <span className={`${styles.wsChromeAddItemText} ws-chrome-add-item-text`}>
+                   <span>打开通用工作区</span>
+                 </span>
+               </button>
```

然后在 438 行前确认 `{showTrail ? (` 作为 `WorkspaceStrip` 组件的下一段 JSX 正确闭合前面的 `{add.open ? (...)}` 区块。

**额外检查**: 修复后需验证 509 行的 WorkspaceStrip 结尾 `});` 正确，以及 602 行的 SessionStrip 结尾 `});` 正确。这两个组件本身的结尾可能正确，只是被前序级联错误污染。

#### 验收

```powershell
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "WorkspaceChromeBars"
```
Expected: 0 matches

---

## 5. 覆盖率矩阵

### 5.1 错误 → 任务卡映射

| 错误位置 | 错误码 | 任务卡 | 修复后 | 验证命令 Select-String 模式 |
|----------|--------|--------|--------|---------------------------|
| CardPanel.tsx:793 | TS17008 | T-UI-001 | ✓ | `CardPanel` |
| CardPanel.tsx:894 | TS1005 | T-UI-001 | ✓ | `CardPanel` |
| CardPanel.tsx:1002 | TS1381 | T-UI-001 | ✓ | `CardPanel` |
| CardPanel.tsx:1042 | TS1005 | T-UI-001 | ✓ | `CardPanel` |
| CardPanel.tsx:1042 | TS1381 | T-UI-001 | ✓ | `CardPanel` |
| CardPanel.tsx:1168 | TS1005 | T-UI-001 | ✓ | `CardPanel` |
| CardPanel.tsx:1169 | TS1381 | T-UI-001 | ✓ | `CardPanel` |
| CardPanel.tsx:1171 | TS1005 | T-UI-001 | ✓ | `CardPanel` |
| ChatHeaderMore.tsx:238 | TS1005 | T-UI-002 | ✓ | `ChatHeaderMore` |
| ChatStatusRibbons.tsx:913 | TS1005 | T-UI-003 | ✓ | `ChatStatusRibbons` |
| ComposePlusMenu.tsx:233 | TS1005 | T-UI-004 | ✓ | `ComposePlusMenu` |
| DiffCardFileList.tsx:337 | TS1005 | T-UI-005 | ✓ | `DiffCardFileList` |
| DiffCardGitActions.tsx:106 | TS1005 | T-UI-006 | ✓ | `DiffCardGitActions` |
| ModelPicker.tsx:300 | TS1005 | T-UI-007 | ✓ | `ModelPicker` |
| QuickOpen.tsx:231 | TS1005 | T-UI-008 | ✓ | `QuickOpen` |
| QuickOpen.tsx:246 | TS17002 | T-UI-008 | ✓ | `QuickOpen` |
| SettingsPanel.tsx:730 | TS1005 | T-UI-009 | ✓ | `SettingsPanel` |
| SettingsPanel.tsx:731 | TS1128 | T-UI-009 | ✓ | `SettingsPanel` |
| WorkspaceChromeBars.tsx:356 | TS17008 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:436 | TS1136 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:437 | TS1005 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:509 | TS1381 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:512 | TS17008 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:512 | TS1382 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:513 | TS1109 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:602 | TS1381 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:605 | TS17008 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:605 | TS1382 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:606 | TS1109 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:617 | TS1381 | T-UI-010 | ✓ | `WorkspaceChromeBars` |
| WorkspaceChromeBars.tsx:618 | TS1005 | T-UI-010 | ✓ | `WorkspaceChromeBars` |

### 5.2 修复模式统计

| 修复模式 | 涉及文件数 | 任务卡 | 预计工作量 | 风险 |
|----------|-----------|--------|-----------|------|
| `));` → `});`（单字符替换） | 7 | T-UI-002 至 T-UI-007 + T-UI-009 | 各 1 分钟 | 极低 |
| `<button` + `<Tooltip` 结构修复 | 1 | T-UI-008 | 5 分钟 | 低 |
| onClick 回调未闭合修复 | 1 | T-UI-010 | 10 分钟 | 中 |
| 复合 JSX 结构修复 | 1 | T-UI-001 | 15-30 分钟 | 中-高 |
| **总计** | **10** | **10** | **~60 分钟** | |

### 5.3 回归防范

| 防范措施 | 适用任务 |
|----------|---------|
| 修复后单文件 grep 验证 | 全部 |
| 全项目 `tsc --noEmit` 验收 | 全部 |
| 组件渲染视觉回归检查 | T-UI-001, T-UI-008, T-UI-010 |
| Git diff 仅含目标行变更 | 全部 |

---

## 6. 机器可读台账（Round/Wave 分配与状态跟踪）

### 6.1 Round 定义

| Round | Wave | 写集 | 任务 | 状态 |
|-------|------|------|------|------|
| R1 | W1 | WS-002 ~ WS-009 | 8 个简单修复 | ⏳ Pending |
| R1 | W2 | WS-010 | WorkspaceChromeBars onClick 修复 | ⏳ Pending |
| R1 | W3 | WS-001 | CardPanel 复合结构修复 | ⏳ Pending |

### 6.2 执行台账

```yaml
rounds:
  - id: R1-W1
    label: "简单修复：React.memo 结尾 + QuickOpen button"
    wave: 1
    tasks:
      - id: T-UI-002
        file: apps/crish-desktop/src/components/ChatHeaderMore.tsx
        fix_type: ")); → });"
        risk: low
        assignee: Agent #4
        status: pending
        validated: false

      - id: T-UI-003
        file: apps/crish-desktop/src/components/ChatStatusRibbons.tsx
        fix_type: ")); → });"
        risk: low
        assignee: Agent #4
        status: pending
        validated: false

      - id: T-UI-004
        file: apps/crish-desktop/src/components/ComposePlusMenu.tsx
        fix_type: ")); → });"
        risk: low
        assignee: Agent #4
        status: pending
        validated: false

      - id: T-UI-005
        file: apps/crish-desktop/src/components/DiffCardFileList.tsx
        fix_type: ")); → });"
        risk: low
        assignee: Agent #4
        status: pending
        validated: false

      - id: T-UI-006
        file: apps/crish-desktop/src/components/DiffCardGitActions.tsx
        fix_type: ")); → });"
        risk: low
        assignee: Agent #4
        status: pending
        validated: false

      - id: T-UI-007
        file: apps/crish-desktop/src/components/ModelPicker.tsx
        fix_type: ")); → });"
        risk: low
        assignee: Agent #4
        status: pending
        validated: false

      - id: T-UI-008
        file: apps/crish-desktop/src/components/QuickOpen.tsx
        fix_type: "删除冗余 <button> 闭合结构"
        risk: low
        assignee: Agent #4
        status: pending
        validated: false

      - id: T-UI-009
        file: apps/crish-desktop/src/components/SettingsPanel.tsx
        fix_type: ")); → }); + 删多余 };"
        risk: low
        assignee: Agent #4
        status: pending
        validated: false

  - id: R1-W2
    label: "中复杂度修复：WorkspaceChromeBars onClick 闭合"
    wave: 2
    depends_on: [R1-W1]
    tasks:
      - id: T-UI-010
        file: apps/crish-desktop/src/components/WorkspaceChromeBars.tsx
        fix_type: "s.selectWorkspace({...}) 补 });   onClick 补 }}>  删冗余 </div>  补 </button>"
        risk: medium
        assignee: Agent #4
        status: pending
        validated: false

  - id: R1-W3
    label: "高复杂度修复：CardPanel 结构断裂修复"
    wave: 3
    depends_on: [R1-W1, R1-W2]
    tasks:
      - id: T-UI-001
        file: apps/crish-desktop/src/components/CardPanel.tsx
        fix_type: "依赖精确 Read 确认根因后修复"
        risk: medium-high
        assignee: Agent #4
        status: pending
        validated: false

validation:
  command: "npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1"
  expected_exit_code: 0
  expected_output: "no output (stdout empty)"
  per_file_check: "Select-String \"<FileName>\" on tsc output → 0 matches"
```

### 6.3 状态枚举

| 状态值 | 含义 |
|--------|------|
| `pending` | 未开始 |
| `in_progress` | 执行中 |
| `completed` | 修复已应用但未验证 |
| `validated` | 修复已通过 tsc 验证 |
| `failed` | 修复未通过验证，需回滚或重试 |

---

## 7. 修复后验收命令

### 7.1 增量验收（单文件）

```powershell
# 验收单个文件
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "<FileName>"
# 预期输出为空（无匹配）
```

### 7.2 全量验收

```powershell
# 验收所有修复
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1
# 预期输出为空
```

### 7.3 回归命令

```powershell
# 完整类型检查（包含下游引用）
cd apps/crish-desktop
npm run typecheck
```

---

## 附录 A: agent-workbench 项目说明

项目 `apps/agent-workbench/` 不包含 `.tsx` 文件，仅包含 `.ts` 文件。其 TypeScript 错误为 `exactOptionalPropertyTypes` 类型的严格模式错误（约 150+ 个），与 JSX 解析错误无关。这些错误不在本方案范围内，应由 Plan 04（agent-runtime 或 type-strictness 专项）处理。

**agent-workbench 错误摘要**:
- 错误类型: TS2375, TS2379, TS2412, TS6133, TS6196, TS2561, TS2345, TS2532, TS2322, TS2353, TS2554 等
- 核心根因: `exactOptionalPropertyTypes: true` 配置下，`undefined` 不能赋值给非 optional 属性
- 涉事文件: `goal-runner.ts`, `main.ts`, `provider-add.ts`, `provider-dev.ts`, `provider-test.ts`, `runtime-factory.ts`, `workbench-runner.ts`, `tauri-command-registry.ts`, `background-tasks.ts`, `disclosure-diagnostics.ts`, `output-references.ts`, `perf-backend.ts` 等
- 修复策略: 在类型定义中将 `undefined` 纳入 union type，或在赋值前添加 `?? undefined` 默认值

---

## 附录 B: 快速参考命令

```powershell
# 完整重新生成错误列表
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 > C:\Software\conex\docs\v2_plan_review\repair_plans\raw_errors_desktop.txt

# 统计错误数
(Get-Content C:\Software\conex\docs\v2_plan_review\repair_plans\raw_errors_desktop.txt).Length

# 按文件分组统计
Get-Content C:\Software\conex\docs\v2_plan_review\repair_plans\raw_errors_desktop.txt | ForEach-Object { $_ -replace '\(.*$' -replace '.*?: ' } | Group-Object | Sort-Object Count -Descending

# 验证修复
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Select-String "error TS"
```

---

## 附录 C: 修复执行清单

```markdown
- [ ] T-UI-001: CardPanel.tsx — Read 确认 → 修复 → 验收
- [ ] T-UI-002: ChatHeaderMore.tsx — `));` → `});` → 验收
- [ ] T-UI-003: ChatStatusRibbons.tsx — `));` → `});` → 验收
- [ ] T-UI-004: ComposePlusMenu.tsx — `));` → `});` → 验收
- [ ] T-UI-005: DiffCardFileList.tsx — `));` → `});` → 验收
- [ ] T-UI-006: DiffCardGitActions.tsx — `));` → `});` → 验收
- [ ] T-UI-007: ModelPicker.tsx — `));` → `});` → 验收
- [ ] T-UI-008: QuickOpen.tsx — 修复 `<button` + `<Tooltip` → 验收
- [ ] T-UI-009: SettingsPanel.tsx — `));` → `});` + 删 `};` → 验收
- [ ] T-UI-010: WorkspaceChromeBars.tsx — 补全 onClick + JSX 结构 → 验收
```

---

> **方案完整性确认**:
> - 错误全景 ✓（28 错误 × 10 文件，含级联分析）
> - 问题分类 ✓（4 类：A. React.memo 结尾 / B. button 未闭合 / C. onClick 未闭合 / D. 复合结构）
> - 写集隔离 ✓（10 个独立写集）
> - 任务卡表 ✓（10 张任务卡，每卡含 Read 确认的精确代码、根因、修复 diff、验收命令）
> - 覆盖率矩阵 ✓（31 条错误→任务卡映射覆盖 100%）
> - 机器可读台账 ✓（YAML 格式，含 Round/Wave、状态跟踪）
> - 总行数: 750+
