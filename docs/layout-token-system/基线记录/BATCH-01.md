# BATCH-01 基线记录

- **日期**：2026-09-11
- **方案 SSOT**：`docs/layout-token-system/00-总方案.md` v2
- **用户裁决**：U1 按钮 7px 锁；U2 扩阶梯允许 24px；U3 BATCH 串行

## 落地内容

1. `tokens.css`：7px 按钮单源；small/large 密度表按 §4 重写（全偶、单调、零碰撞）；新增 `--radius-3xl` / `--composer-radius-*` / `--chat-bubble-radius`；圆角密度档偶数化。
2. 组件 CSS 错误 fallback 清洗：6 处错误 space fallback + 6 处错误 button-radius fallback → 0。
3. 测试：`Button.test.tsx` 反转为 7px；`Tabs.module.css` fallback 7px + xl 12px；`Tabs.test.tsx` 同步。

## 验收

```
npx vitest run src/styles/style-contract.test.ts \
  src/components/ui/Button/Button.test.tsx \
  src/components/ui/Tabs/Tabs.test.tsx
# 3 files, 71 tests, all passed
```

## 改动文件（BATCH-01 域）

- `apps/crish-desktop/src/styles/tokens.css`
- `apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css`
- `apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.module.css`
- `apps/crish-desktop/src/components/sidebar/SidebarNav.module.css`
- `apps/crish-desktop/src/components/sidebar/Sidebar.module.css`
- `apps/crish-desktop/src/components/workspace/PreviewCard.module.css`
- `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css`
- `apps/crish-desktop/src/components/settings/SettingsPanel.module.css`
- `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css`
- `apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css`
- `apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css`
- `apps/crish-desktop/src/components/ui/Button/Button.test.tsx`
- `apps/crish-desktop/src/components/ui/Tabs/Tabs.test.tsx`

## 未做（留给后续 BATCH）

- Tier2 全面语义化、fallback 全删、`--space-50` 数字名
- Shell 入流 / 二叉树 / 消息流 / Composer / 卡片门禁（BATCH-02~06）
- 主控统一 `git commit --only` 收口（当前仅工作区）
