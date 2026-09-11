# BATCH-06 基线记录

- **日期**：2026-09-11
- **方案 SSOT**：`docs/layout-token-system/00-总方案.md` v2
- **前置**：BATCH-01 ~ 05 已落地

## 落地内容

1. **settings-content-max**：tokens 默认 720→**820px**；Skills fallback 对齐 820。
2. **embeddedDiffCard**：4 个 `!important` → `data-card-variant='embedded'` 属性选择器；`ToolCallDiffPreview`/`ToolCallOutputPane` 接线。
3. **check-layout-tokens.mjs**：复用 `extractCssRules`；R1 负 margin / R2 错误 fallback / R3 密度表；markdown 棘轮基线 + `--update`。
4. **check:desktop**：根链末尾追加 `check:layout-tokens`（未截断旧链）。
5. **layout-contract.test.ts**：三档密度偶数单调 + listInner 禁 48 + Button 7px。

## 验收

```
node scripts/check-layout-tokens.mjs   → OK
npx vitest run layout-contract + style-contract → 37/37
```

## 改动文件

- `apps/crish-desktop/src/styles/tokens.css`
- `apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css`
- `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css`
- `apps/crish-desktop/src/components/chat-tool-call/ToolCallDiffPreview.tsx`
- `apps/crish-desktop/src/components/chat-tool-call/ToolCallOutputPane.tsx`
- `scripts/check-layout-tokens.mjs`
- `package.json`
- `apps/crish-desktop/src/styles/layout-contract.test.ts`
- `docs/layout-token-system/基线记录/layout-token-baseline.md`

## 明确未做（有意）

- handleRootWheel 拔除（侧栏滚轮联动）
- 全屏设置 document/workbench 解耦全量
- 审批卡片合并、控制行 24/32 全仓收敛（可后续棘轮 burn-down）
