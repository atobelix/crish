/**
 * apps/crish-desktop/src/styles/g2-corner-ratchet-baseline.ts
 *
 * G² 守卫棘轮基线（立项方案 §2.4 第一层-3）：第 0 波开工时点（2026-11-06，
 * git 保存点 refs/muse-save/g2w0-20261106）的存量违规逐项清单。
 * 条目键 = `<相对 src 的文件路径> :: <归一化声明文本>`（空白折叠为单空格）。
 *
 * 纪律（只减不增）：
 * - g2-corner.contract.test.ts 断言「实际违规集合 ⊆ 本基线」且各类条数不得
 *   超过 G2_RATCHET_CAPS；新增违规一律变红，没有例外通道；
 * - 迁移批消除一处违规时，必须在同一提交里删掉对应基线行并同步调低 CAPS；
 * - 回滚提交允许回加基线行，但须在提交信息中声明回滚（§2.5）。
 * 本文件由第 0 波普查脚本机械生成后人工抽核（高可见面逐项对回扫描报告），
 * 后续只许按上述纪律删行/回加，不许整表重生成掩盖增量。
 */

export const G2_RATCHET_CAPS = {
  barePx: 25,
  privateVars: 19, // 甲槽 A 核销 2（Toast）+ 乙槽 C 核销 1（SettingsRulesTab 局部覆写 --radius-xl 退役）+ 丙槽 D 核销 1（Tiptap --slash-radius-outer 外迁 G2Surface）
  fallbackDrift: 4, // F3 回退核正：已核销 21 键 + 纠缠留置 4 键修正值已随 keyframes 提交 729cd8c56 入 HEAD（逐值核对，收口删行）；余 4 键 = 占用跳过 4（ChatToolCallBlock / FoldableToolGroup / ModelBadgePickerMenu），待占用解除后机械核正
} as const;

export const G2_RATCHET_BARE_PX: readonly string[] = [
  'components/agent-card/ApprovalAskCard.module.css :: border-radius: 1px;',
  'components/agent-card/ApprovalCountdownBar.tsx :: borderRadius: 2',
  'components/chat-card/ChatCard.module.css :: border-radius: 14px;',
  'components/chat-composer/ComposerFusedTrigger.module.css :: border-radius: 0 14px 14px 0;',
  'components/chat-composer/ComposerFusedTrigger.module.css :: border-radius: 14px 0 0 14px;',
  'components/chat-composer/ComposerFusedTrigger.module.css :: border-radius: 14px;',
  'components/chat-composer/PermissionModeMenu.module.css :: border-radius: 14px;',
  'components/chat-composer/PermissionModeMenu.module.css :: border-radius: 4px;',
  'components/chat-tool-call/ChatToolCallBlock.module.css :: border-radius: 4px;',
  'components/extensions-surface/ExtensionActionCard.module.css :: border-radius: 14px;',
  'components/extensions-surface/ExtensionsMainSurface.module.css :: border-radius: 14px;',
  'components/extensions-surface/McpConnectModal.module.css :: border-radius: 4px;',
  'components/extensions-surface/McpDetailWorkbench.module.css :: border-radius: 14px;',
  'components/note-paper/NotePaperPanel.module.css :: border-radius: 1px;',
  'components/overview/DockLauncherOverview.module.css :: border-radius: 18px;',
  'components/overview/GitStatusBadge.module.css :: border-radius: 1px;',
  'components/provider/ModelBadgePickerMenu.tsx :: borderRadius: \'14px\'',
  'components/sidebar/Sidebar.module.css :: border-radius: 10px;',
  'components/sidebar/SidebarSessionList.module.css :: border-radius: 1px;',
  'components/ui/ColorPicker/ColorPicker.module.css :: border-radius: 10px;',
  'components/ui/ColorPicker/ColorPicker.module.css :: border-radius: 12px;',
  'components/ui/ColorPicker/ColorPicker.module.css :: border-radius: 20px;',
  'components/ui/ColorPicker/ColorPicker.module.css :: border-radius: 6px;',
  'components/ui/ColorPicker/ColorPicker.module.css :: border-radius: 8px;',
  'components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css :: border-radius: 4px;',
];

export const G2_RATCHET_PRIVATE_VARS: readonly string[] = [
  'components/chat-card/SetupHintBanner.module.css :: --soft-hint-btn-radius:',
  'components/chat-card/SetupHintBanner.module.css :: --soft-hint-radius:',
  'components/chat-composer/AnnotationChipItem.module.css :: --ann-radius-inner:',
  'components/chat-composer/AnnotationChipItem.module.css :: --ann-radius-outer:',
  'components/chat-composer/ChatComposer.module.css :: --composer-radius-outer:',
  'components/chat-composer/PermissionModeMenu.module.css :: --btn-radius:',
  'components/chat-composer/TiptapSlashMenu.module.css :: --slash-radius-inner:',
  'components/chat-message-row/ChatMessageRow.module.css :: --composer-attach-card-radius:',
  'components/chat-message/MessageContent.module.css :: --md-code-inline-radius:',
  'components/diff/DiffCard.module.css :: --btn-radius:',
  'components/sidebar/Sidebar.module.css :: --btn-radius:',
  'components/sidebar/SidebarNav.module.css :: --btn-radius:',
  'components/ui/Badge/Badge.module.css :: --badge-radius:',
  'components/ui/Button/Button.module.css :: --btn-radius:',
  'components/ui/SegmentedControl/SegmentedControl.module.css :: --seg-inner-radius:',
  'components/ui/SegmentedControl/SegmentedControl.module.css :: --seg-outer-radius:',
  'components/ui/Tabs/Tabs.module.css :: --tab-inner-radius:',
  'components/ui/Tabs/Tabs.module.css :: --tab-outer-radius:',
  'components/workspace/PreviewCard.module.css :: --btn-radius:',
];

export const G2_RATCHET_FALLBACK_DRIFT: readonly string[] = [
  'components/chat-tool-call/ChatToolCallBlock.module.css :: border-radius: var(--radius-sm, 4px);',
  'components/chat-tool-call/FoldableToolGroup.module.css :: border-radius: var(--radius-sm, 4px);',
  'components/provider/ModelBadgePickerMenu.module.css :: border-radius: var(--sep-item-radius, 8px);',
  'components/provider/ModelBadgePickerMenu.module.css :: border-radius: var(--sep-radius-outer, 14px);',
];
