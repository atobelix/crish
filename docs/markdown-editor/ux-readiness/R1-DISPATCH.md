# R1 融合编辑器重构 · 多 Agent 派工真源

> **日期**：2026-08-03  
> **波次**：R1（内核 + MD 子集 + 跨选）  
> **执行规格**：`reference/chat-composer-component/docs/markdown-editor/ux-readiness/12-FUSED-EDITOR-REFACTOR-SPEC.md`  
> **目标包**：`packages/conex-mdx`  
> **调度策略**：一工单一 Agent · 只写所有权路径 · 合并前 DoD 全勾  

---

## 0. 硬约束（违反即打回）

| ID | 约束 |
|----|------|
| H-01 | **禁止补丁**：不得在旧 `editor.js` / island `enterEdit` 上继续堆业务当作 R1 完成 |
| H-02 | **禁止兼容层**：不得实现 `legacyBlocks` 双轨、`engine: 'legacy'` 作为新代码主路径、compat re-export 旧 island |
| H-03 | **禁止 mock 数据 / mock AI**：不得 `mockComplete` / 假上传成功 URL / 假 fixture 冒充 roundtrip；演示数据必须是**可被 parse→serialize 真实调用**的 Markdown 文件 |
| H-04 | **禁止偷懒**：不得只改 CSS/README 宣称完成；不得用块级 `selectedIds` 冒充 S04 |
| H-05 | **所有变更走 ProseMirror Transaction**；禁止 `view.dom.innerHTML` 编辑 |
| H-06 | 交付必须附：文件列表 + DoD + 复现命令 + 工单 ID |

裁决顺序：本文件硬约束 > 规格 §3 BAN > §16 工单 DoD > 旧 MIGRATION dual 叙述（**dual 期作废**）。

---

## 1. 目标态（R1 退出）

```text
import { mount, parse, serialize } from '@conex/mdx'

const api = mount(host, { markdown: realMd })
api.getMarkdown()  // 真实 GFM 子集
// 跨段选区、inputrules、slash、history 可用
// 无 enterEdit、无 mock AI
```

| 场景 | 必须 PASS |
|------|-----------|
| S01 | `**demo**` 闭合成粗体 |
| S04 | 跨两个段落拖选 + 复制非空 MD |
| S05 | ↑↓ 跨段无换壳闪白 |
| T-R1-01..25 | ≥20 自动化绿 |

---

## 2. 波次依赖图

```text
R1-01 包骨架 ─────────────────────────────┐
R1-02 Schema ─────────────────────────────┤
R1-08 CSS ────────────────────────────────┤  Wave1 并行
R1-09 fixtures + ban 脚本 ────────────────┘
         │
         ▼
R1-03 parse/serialize  ──┐  Wave2 并行（依赖 schema）
R1-04 createEditor/mount ┘
         │
         ▼
R1-05 inputRules/keymap/history ──┐
R1-06 跨块选区序列化 ─────────────┤  Wave3 并行
R1-07 slash ─────────────────────┤
R1-10 showcase ?engine=v2 ───────┘
         │
         ▼
R1-09 补全测例 + 全量 typecheck/test  Wave4
```

---

## 3. 工单所有权矩阵（严禁越界写）

| 工单 | Agent 标签 | 只写 | 可只读 |
|------|------------|------|--------|
| AGEN-R1-01 | pkg | `packages/conex-mdx/package.json`, `tsconfig*`, `vite.config.ts`, `vitest.config.ts`, 根 `package.json` workspaces 一行, `README.md`, `ARCHITECTURE.md`, `MIGRATION.md`（改写为 fused 单轨） | 规格 §4 |
| AGEN-R1-02 | schema | `packages/conex-mdx/src/schema/**` | §6 |
| AGEN-R1-03 | md | `packages/conex-mdx/src/markdown/**` | schema, §9, 旧 parse.js **只读对照** |
| AGEN-R1-04 | runtime | `packages/conex-mdx/src/editor/**`, `src/index.ts`, `src/types.ts` | schema, markdown, §5 §13 |
| AGEN-R1-05 | plugins-core | `packages/conex-mdx/src/plugins/inputRules.ts`, `keymap.ts`, `history.ts`, `imeGuard.ts` | schema, editor, §7 §10 |
| AGEN-R1-06 | selection | `packages/conex-mdx/src/plugins/selectionClipboard.ts`, `src/util/serializeSelection.ts` | markdown serialize, §7 |
| AGEN-R1-07 | slash | `packages/conex-mdx/src/plugins/slash.ts` | schema, commands, §7.4 |
| AGEN-R1-08 | css | `packages/conex-mdx/src/style/**` | §12 BANNED |
| AGEN-R1-09 | test | `packages/conex-mdx/tests/**`, `packages/conex-mdx/scripts/**`, 真实 fixtures | public API |
| AGEN-R1-10 | demo | `reference/chat-composer-component/markdown-editor-v2.html`（新页）, 以及**仅** demo 入口脚本加载 `@conex/mdx`；**禁止**改旧 `editor.js` | SAMPLE 真实 MD |

**冲突文件串行**：`src/index.ts` 仅 R1-04 写；`package.json` 仅 R1-01 写（后续依赖由调度合并）。

---

## 4. 真实数据策略（禁 mock）

| 产物 | 路径 | 要求 |
|------|------|------|
| R1 黄金 MD | `packages/conex-mdx/tests/fixtures/r1-core.md` | 覆盖 h1–h6、列表、task checked、quote、code fence、hr、marks |
| Showcase 剧本 MD | `packages/conex-mdx/tests/fixtures/showcase-sample.md` | 从 `demo/showcase-sample.js` **抽出真实字符串**写入 `.md`，可被 `parse`/`setMarkdown` 直接吃 |
| 负例 | `tests/fixtures/negatives/*.md` | 货币 `$5`、未闭合 `**` 等（真实文本，非 fake URL） |

**禁止**：`http://example.com/fake-upload.png` 作为「上传成功」；无 `uploadImage` 端口时用 `blob:` 或拒绝并写死策略。  
**禁止**：AI `complete` 返回固定 lorem。

---

## 5. 验收命令（调度合并后）

```bash
cd packages/conex-mdx
npm run typecheck
npm test
bash scripts/check-mdx-bans.sh
```

根仓库：

```bash
npm run typecheck -w @conex/mdx   # 注册后
```

---

## 6. 工单状态板

| 工单 | 状态 | 负责人 |
|------|------|--------|
| AGEN-R1-01 | **完成** | package + workspace + vitest + bans |
| AGEN-R1-02 | **完成** | schema nodes/marks task 模型 A |
| AGEN-R1-03 | **完成** | markdown parse/serialize |
| AGEN-R1-04 | **完成** | createEditor mount |
| AGEN-R1-05 | **完成** | inputRules/keymap/history/ime |
| AGEN-R1-06 | **完成** | 跨块 selection serialize |
| AGEN-R1-07 | **完成** | slash |
| AGEN-R1-08 | **完成** | style/editor.css BAN-01 |
| AGEN-R1-09 | **完成** | tests + 真实 fixtures |
| AGEN-R1-10 | **完成** | showcase |
| **用户路径** | **完成** | `dist/mdx.js` + **默认** `markdown-editor.html` = fused；island → `markdown-editor-legacy.html` |

---

## 7. PR / 交付模板（强制）

```markdown
## 工单 ID: AGEN-R1-XX
## 波次: R1
## 所有权文件: ...
## 对照规格: 12 §...
## DoD:
- [ ] ...
## 复现命令: ...
## 声明: 未使用 enterEdit；未引入兼容层；未使用 mock AI/假数据
```
