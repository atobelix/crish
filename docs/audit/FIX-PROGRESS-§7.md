# FIX-PROGRESS-§7

> date 2026-09-08 (America/New_York)
> scope SYSTEMATIC-FIX-PLAN §7.1–7.4 + QUALITY-GATE
> **不开** §8

## 意图
按 SCOUT-§7 / SYSTEMATIC-FIX-PLAN §7 一次性收口渲染纪律与 XSS 面：外链导航单轨、粘贴 DOMPurify 显式禁未知协议、GFM emoji 默认关（Rust+JS 同默认）、技能预览删 previewHtml 死轨。

## §7.1 外链导航单轨 — 完成
（半成品续完已核）
1. MarkdownDocumentView 点击外链统一 sanitizeUrlCandidate + isSafeHref；删 startsWith 启发式。
2. 回归：HTTPS/MAILTO 外开；javascript/未知 scheme 不 window.open；相对/# 不外开；源码契约禁 startsWith 回潮。
3. vitest MarkdownDocumentView.test.tsx：21 passed

## §7.2 Tiptap DOMPurify 禁未知协议 — 完成
1. 抽出命名常量 TIPTAP_PASTE_DOMPURIFY_CONFIG（含 ALLOW_UNKNOWN_PROTOCOLS: false）。
2. 粘贴路径 DOMPurify.sanitize(html, TIPTAP_PASTE_DOMPURIFY_CONFIG)，禁止内联选项旁路。
3. 回归：TiptapEditorExtensions.sec7.dompurify.test.ts（源码契约 + jsdom 运行时：javascript:/未知协议/data:）。
4. 既有 TiptapEditorField.test.tsx 粘贴 script 剥离仍绿。

## §7.3 GFM emoji 默认关 — 完成
（工作区半成品已齐，本路核验）
1. JS：GFM_EMOJI_SHORTCODES_DEFAULT = false；translateGfmEmoji 默认关；formatMarkdownTextSegment 不强制 true。
2. Rust：GFM_EMOJI_SHORTCODES_DEFAULT = false；translate_gfm_emoji 走 DEFAULT；显式开用 _with(..., true)。
3. 回归：markdownInlineFormat.sec7.source.test.ts；cargo test -p conex-markdown gfm_emoji：5 passed（unit 2 + integration 3）。

## §7.4 删技能预览 previewHtml 死轨 — 完成
1. 删除 useSkillEditor 中 parseMarkdownToHtml / previewHtml useMemo。
2. 删除 useSkillsSettingsState / SkillsSettingsTab / SkillDetailPreview 全链路 prop。
3. 去掉 useSkillsSettingsState.test.tsx 对 parseMarkdownToHtml 的无意义 mock。
4. 源码契约：SkillDetailPreview.sec7.source.test.ts（禁 previewHtml / parseMarkdownToHtml；须 MarkdownDocumentView；禁 dangerouslySetInnerHTML）。

## 改动文件
- apps/crish-desktop/src/components/ui/MarkdownDocumentView.tsx (+test) — §7.1（既有）
- apps/crish-desktop/src/components/chat-composer/TiptapEditorExtensions.ts
- apps/crish-desktop/src/components/chat-composer/TiptapEditorExtensions.sec7.dompurify.test.ts（新）
- apps/crish-desktop/src/api/markdown-render/markdownInlineFormat.ts (+sec7 source test) — §7.3（既有）
- crates/conex-markdown/src/renderer.rs / lib.rs / tests — §7.3（既有）
- apps/crish-desktop/src/components/settings-skills/useSkillEditor.ts
- apps/crish-desktop/src/components/settings-skills/useSkillsSettingsState.ts (+test)
- apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.tsx
- apps/crish-desktop/src/components/settings-skills/SkillDetailPreview.tsx
- apps/crish-desktop/src/components/settings-skills/SkillDetailPreview.sec7.source.test.ts（新）

## 测试结果（本机）
- vitest（§7 相关 6 文件）：53 passed
- cargo conex-markdown gfm_emoji：5 passed

## QUALITY-GATE 自检
1. 意图可陈述 — §7.1–7.4 消除点击双轨 / 协议默认依赖 / emoji 双轨 / previewHtml 死轨
2. 无新旁路 — 复用 markdownSanitizer SSOT；DOMPurify 命名常量；emoji 同默认；预览只 MDView
3. 对称失败 — 不安全 href 硬 preventDefault；未知协议由 DOMPurify 剥离；emoji 默认不插入
4. 测试非假绿 — 行为 + 源码契约
5. 门禁可执行 — 本项以 vitest/cargo 锁定；§9 总闸扫描挂接未做（属 §9，不开）
6. 二次核查 — 待 code-audit 出 FIX-§7-verification.md

## 未完成 / 交接
1. code-audit → FIX-§7-verification.md — 待父代理
2. §9 把门禁挂入 check:desktop — 未做（属 §9）
3. 对话 MarkdownBlockItem.innerHTML 平行 sink — scout 标明非 §7 范围，未做
4. 不开 §8

## 非假装修完
- 7.1 外链仅经 sanitize+isSafeHref
- 7.2 ALLOW_UNKNOWN_PROTOCOLS:false 命名常量 + 回归
- 7.3 Rust/JS GFM_EMOJI_SHORTCODES_DEFAULT=false
- 7.4 settings-skills 无 previewHtml 死轨，预览只 MarkdownDocumentView
