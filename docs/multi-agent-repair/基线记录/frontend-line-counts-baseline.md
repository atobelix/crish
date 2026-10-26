# 前端行数基线（RL-03 · frontend line counts）

> 归属：05 代码质量方案（`docs/frontend-audit/20-proposals/05-code-quality-proposal.md` 步骤②）· 批次 7.3
> 日期：2026-08-10（建线）· 维护：`node scripts/check-line-counts.mjs --update --all`
> 语义：三级行数门禁（.agents/AGENTS.md 规则 1/3 声明与实现永久同步）——
> ≥85% 上限警告（仅报告）/ ≥100% 上限违规（fail）/ >650 硬阻断（fail，阈值 = max(650, 上限)，
> 类型契约档即 800 自身）；**per-file 基线**：有基线条目的文件以基线值为上限
> （存量冻结、增长必 fail、下降放行），无条目的文件按声明上限严格执行（新文件零豁免）。
> 行数口径：有效代码行（注释/空行不计）。
> 本文件为量化数据文件，标记区由脚本维护；正文表格为验收时点口径，以标记区为准。

## 口径说明（与审计 10-analysis/05-code-quality-audit.md 的差异）

- 审计口径（2026-08-09）：`--all` 实测 44 违规 + 19 警告（665 文件）、18 文件 >650 行；
- 门禁口径（本基线）：同一脚本同一扫描面，但分类正则已按 30-reviews/02 P1-2 收敛
  （`/types?/i` 过宽 → `*.types.ts` / `*-types.ts` / `types/` 目录后缀匹配），
  个别文件类别档位变动属预期；44/19 为审计日数字，基线以 --update 实测为准。
- 基线登记范围：超过 85% 上限（警告级及以上）的文件全部登记（含实测行数）；
  清理后降至 85% 上限以内 → `--update` 自动移除条目（基线清空 = 声明全量生效）。

## 基线登记（2026-08-10 建线）

| 文件（相对仓库根）         | 有效行数（基线值） |
| -------------------------- | ------------------ |
| （见下方标记区，脚本维护） | —                  |

## 治理记录

- 2026-08-10（批次 7.3）：三级语义 + per-file 基线机制接线完成（基线模式，`--all` 退出 0）；
  CI/package.json 接线因并行域（T-E 批次 5.4 门禁接线同文件在途）暂缓，由主控在
  package.json/ci.yml 合入后追加 `check:line-counts`（`node scripts/check-line-counts.mjs --all`）。
- 2026-08-10（批次 7.3 补完）：package.json 新增 `check:line-counts` 并并入 `check:desktop`；
  ci.yml lint job 追加 `npm run check:line-counts`；`.agents/AGENTS.md` 规则 1/3 声明与实现
  逐条同步（基线豁免句 + 实现载体句）。吞错报告模式（check:swallowed-errors-frontend）同期接线。
- > 650 高发清单（步骤④拆分优先队列输入）：pricingStore.ts / sessionRustDb.ts /
  > useStreamCallbacks.ts / modelCatalog.ts / store/layout-tree/operations.ts 等（见标记区实测）。

## G-03d VIOL 处置登记（2026-08-13-wave · 门禁治理维度）

> 处置口径：`--update` 按路径精确登记（未跑 `--all`，避免误登记 HARD 文件）；登记三要素 = 实测行数 / 理由 / 拆分时限触发条件。登记 ≠ 拆分完成。

| 文件                   | 实测有效行 | 理由                                                                                            | 拆分时限触发条件（二元结构）                                    |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| sessionSearch.ts       | 412        | 小幅超类别上限 400（+12），纯函数搜索助手，拆分面大收益低                                       | SR-06 结构轮 sessionSearch 拆分完成（该文件 ≤400 行时移除登记） |
| MessageVirtualizer.tsx | 492        | 类别上限 500 内（492<500），React.memo 穷尽检查面，拆分破坏 memo 契约风险高                     | SR-06 结构轮 MessageVirtualizer 拆分完成（≤441 行时移除登记）   |
| ChangeOverviewCard.tsx | 481        | 类别上限 500 内（481<500），单组件强耦合，拆分归结构轮                                          | SR-06 结构轮 ChangeOverviewCard 拆分完成（≤432 行时移除登记）   |
| useSlashSend.ts        | 457        | 单闭包 hook（handleSendChat 巨型函数），提取依赖注入面大，拆分归结构轮                          | SR-06 结构轮 useSlashSend 拆分完成（≤400 行时移除登记）         |
| useAgentStream.ts      | 454        | 单 hook 强耦合 useCallback 链（buildStreamCallbacks/finalizeAgentStop），拆分归结构轮           | SR-06 结构轮 useAgentStream 拆分完成（≤400 行时移除登记）       |
| McpServerList.tsx      | 453        | G-03d 已拆 renderTools/renderSharedToolbar（→McpServerTools/McpServerToolbar），实测回落 500 内 | SR-06 结构轮继续拆分（≤425 行时 --update 自动移除登记）         |

> 同日处置（非登记）：messageWindow.ts 三切分（Primitives/DomBudget/Viewport/Indices/Expand 五叶 + hub re-export），
> 实测 558→111 有效行，`--update` 自动移除其 498 基线条目；并行域 M 文件（goalModeController 644 / sessionSharedHelpers 422）未触碰，收口后由后续轮次处置。

## R5 处置登记（2026-08-16 · 输入流收敛战役收口 · `--update --all` 一次性刷新 66 条目）

> 触发：R5 固定审计（`docs/input-stream-consolidation/execution/audits/R5-审计报告.md` §2.7/§9-2）实证
> 7 处违规中 3 处为 T4 提交 `01be2074` 的 prettier 格式化附带引入（`git show -w` 零逻辑变更），按
> AGENTS §11.9 / 附录 B §9「超限走拆分或 `--update` 登记基线，不以放宽阈值掩盖」处置，选择登记路径
> （拆分属域外文件重构风险高；格式化膨胀非逻辑增长）。本次 `--update --all` 仅修改本基线文件，diff 逐行复核：

- **T4 引入 3 处登记（格式化纯膨胀，零逻辑变更实证）**：useChatComposerProps 472→478（越基线）、
  SettingsAppearanceTab 537（新 VIOLATION）、useSkillsSettingsState 635→732（HARD BLOCK 冻结为基线上限 732）。
- **R5 前存量 4 处再冻结（非本批引入，R5 审计 §2.7 实证 R5 前后零变化）**：eventParser 358→377、
  InlineAgentPanel 604→621、TiptapEditorField 464→477、sessionSharedHelpers 419→440。
- **存量条目按实测刷新**（均 < 类别上限，冻结现状）：modelCatalog 868→634、clientApi 697→680、
  skillsApi 630→588、sessionEventHydrate 554→520、ConnectionLifecycle 503→502、DiffCard 442→439、
  sessionRustDbSql 393→384、streamCallbacksInternals 364→359、sessionCrudActions 428→416、streamingStore 373→369 等。
- **5 条目自动移除（文件已回落 ≤85% 上限，放行语义）**：toolCardPresenter 394→198、SlashExtension 444→367、
  FileViewerCard 427→367、useModelProfilesState 501→362、useSlashSend 457→195。
- **6 新条目（越过 85% 的新增/增长文件，登记语义）**：EventRouter 386、clientApiNormalize 342、
  Menu.tsx 448、Tooltip.tsx 445、timelineNormalizer 347（审计时点 342，脚本实测 347，均 WARNING 级）、
  MockPhysicalGeometryEngine 385。
- **死条目手动移除**：messageUserProjection.ts 626 对应文件已于 V1 `aaa68087` 整删（`--update` 不扫描已删文件故需手动清）。
- **拆分时限触发条件**：以上条目在 SR-06 结构轮或对应拆分完成（降至类别上限内）时由 `--update` 自动移除；登记 ≠ 拆分完成。

## R7 处置登记（2026-08-16 · 输入流收敛战役 R2 后半执行位 · 路径精确 `--update`）

> 触发：R2-a ③ drain 抢跑窗口关闭（useChatComposerProps）+ R2-b ⑥ withdraw 收口适配
> （sessionMessageActions）功能增长越冻结基线，均仍低于类别上限（481<500 / 473 为存量
> 超限冻结项续登，登记 ≠ 拆分完成）。路径精确登记（未跑 `--all`，避免误登记并行 Agent 文件）。

- `useChatComposerProps.ts` 478→481：R2-a ③ 编辑回移标记（editedBackMsgIdRef）+ drain 队首跳过守卫（+3 有效行，功能增长）。
- `sessionMessageActions.ts` 471→473：R2-b ⑥ gap2 补点（withdrawMessage 失效广播，+2 有效行，功能增长）。

## R7 收口修正登记（2026-08-16 · 输入流收敛战役 R7 收口位 · 路径精确 `--update`）

> 触发：R7 固定审计（`execution/audits/R7-审计报告.md` §4/§10）实测 `--all` exit 1——
> R2b 提交消息「471→473 登记」失实（实测有效 +5 行：import 1 + invalidateEditObjects
> 块 4，471+5=476，登记 473 少 3）→ VIOLATION；useModelProfilesState 经 R2b 设置页
> 失效订阅 +217 行后进入 ≥85% WARNING 区未登记。收口位路径精确重登记（未跑 `--all`，
> 避免误登记并行 Agent 文件；与 R2b 同期登记口径一致）。

- `sessionMessageActions.ts` 473→**476**：R2b 登记值失实修正（R7 审计实测 476，Δ+3；
  import 1 + invalidateEditObjects 块 4，共 +5 有效行），基线回归真实形状。
- `useModelProfilesState.ts`（新登记）**456**：R2b 设置页失效订阅后 362→456（+217 有效行），
  进入 UI 组件档（≤500）85% WARNING 区——登记基线冻结现状（登记 ≠ 拆分完成）。
- 复跑 `node scripts/check-line-counts.mjs --all`：**exit 0（0 VIOLATION / 0 WARNING /
  0 HARD BLOCK / 63 BASELINE = 61 + 2 新登记）**。

## R9 收束登记（2026-08-16 · 输入流收敛战役 R9 收束位 · 路径精确 `--update`）

> 触发：R8 固定审计（`docs/input-stream-consolidation/execution/audits/R8-审计报告.md`
> §2.3/§7/§9-1）实测 `--all` exit 1——T5 提交 `22ed68bf` 对 `backgroundTasksApi.ts`
> `+87/−45` 后越过硬阻断线（663 > 650 HARD BLOCK，Business Logic 档）；基线登记 621
> 失实。收束位路径精确重登记（未跑 `--all`，避免误登记并行 Agent 文件）。

- `backgroundTasksApi.ts` 621→**663**：T5 `+87/−45` 后实测有效行 663 > 650 硬阻断线——
  per-file 基线以实测值冻结现状（**登记 ≠ 拆分完成**，拆分仍归 SR-06 结构轮）。
- 复跑 `node scripts/check-line-counts.mjs --all`：**exit 0（0 VIOLATION / 0 WARNING /
  0 HARD BLOCK / 63 BASELINE = 62 + 1 新登记）**。

<!-- BASELINE_START -->
apps/crish-desktop/src/api/VirtualScrollManager.ts 407
apps/crish-desktop/src/api/chat-bridge/streamSession.ts 380
apps/crish-desktop/src/api/clientApiNormalize.ts 355
apps/crish-desktop/src/api/conversation/ConversationAssembler.ts 394
apps/crish-desktop/src/api/draft/sessionDraftManager.ts 372
apps/crish-desktop/src/api/dualLatchProtocol.ts 448
apps/crish-desktop/src/api/engineConfigHelpers.ts 373
apps/crish-desktop/src/api/markdown-render/streamingDfaLexer.ts 419
apps/crish-desktop/src/api/markdown/IncrementalMarkdownSession.ts 399
apps/crish-desktop/src/api/modelsCatalogActions.ts 378
apps/crish-desktop/src/api/modelsCatalogStore.ts 375
apps/crish-desktop/src/api/ptySessionApi.ts 396
apps/crish-desktop/src/api/session-persistence/sessionDeltaWriteBarrier.ts 399
apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts 508
apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts 367
apps/crish-desktop/src/api/sessionEventProjection.ts 427
apps/crish-desktop/src/api/toolFeedbackDiff.ts 341
apps/crish-desktop/src/api/transport/tauriTransport.ts 381
apps/crish-desktop/src/api/virtualScrollGestureGuard.ts 365
apps/crish-desktop/src/api/workflow-api/workflowScheduler.ts 448
apps/crish-desktop/src/api/workspaceFsApi.ts 342
apps/crish-desktop/src/app/UnifiedAppHydrationCoordinator.ts 477
apps/crish-desktop/src/assets/icons/modelVendorCatalog.ts 366
apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx 476
apps/crish-desktop/src/components/chat-card/ChatCard.tsx 476
apps/crish-desktop/src/components/chat-card/useChatAttachments.ts 472
apps/crish-desktop/src/components/chat-card/useChatHandlers.ts 477
apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx 446
apps/crish-desktop/src/components/chat-composer/SlashExtension.ts 433
apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx 429
apps/crish-desktop/src/components/chat-composer/twoTierBlockEditorCache.ts 442
apps/crish-desktop/src/components/chat-message-list/FlowScrubber.tsx 442
apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx 509
apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx 490
apps/crish-desktop/src/components/chat-message-row/PinActionWithPicker.tsx 433
apps/crish-desktop/src/components/chat-message/MessageContent.tsx 467
apps/crish-desktop/src/components/chat-tool-call/toolExpansionState.ts 437
apps/crish-desktop/src/components/chat-tool-call/toolHeaderPresentation.ts 426
apps/crish-desktop/src/components/diff/ChangeOverviewCard.tsx 481
apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx 465
apps/crish-desktop/src/components/diff/useDiffData.ts 426
apps/crish-desktop/src/components/extensions-surface/ExtensionsMainSurface.tsx 468
apps/crish-desktop/src/components/files/FileBreadcrumb.tsx 515
apps/crish-desktop/src/components/files/FileViewerCard.tsx 464
apps/crish-desktop/src/components/files/FilesCard.tsx 480
apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx 428
apps/crish-desktop/src/components/note-paper/useNoteTextPersistence.ts 454
apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.tsx 559
apps/crish-desktop/src/components/settings-extensions/useExtensionMarket.tsx 470
apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx 440
apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx 526
apps/crish-desktop/src/components/settings/SettingsAboutTab.tsx 440
apps/crish-desktop/src/components/settings/SettingsSecurityTab.tsx 481
apps/crish-desktop/src/components/settings/SettingsShortcutsTab.tsx 476
apps/crish-desktop/src/components/settings/WorkflowForm.tsx 509
apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx 440
apps/crish-desktop/src/components/settings/useAppearanceSettings.ts 429
apps/crish-desktop/src/components/settings/useWorkflowsState.ts 576
apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx 446
apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts 551
apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx 680
apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.tsx 478
apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.tsx 456
apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx 427
apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts 635
apps/crish-desktop/src/components/workspace/PreviewCard.tsx 475
apps/crish-desktop/src/components/workspace/useXtermTerminal.ts 536
apps/crish-desktop/src/hooks/chat-stream/helpers.ts 415
apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts 382
apps/crish-desktop/src/hooks/chat-stream/useRunStreamingAssistant.ts 343
apps/crish-desktop/src/hooks/useFileNavigation.ts 373
apps/crish-desktop/src/hooks/useTreeResize.ts 367
apps/crish-desktop/src/i18n/locales/en-US/settingsParts.ts 358
apps/crish-desktop/src/services/toast/ToastStore.ts 363
apps/crish-desktop/src/store/dualLatchProtocol.ts 346
apps/crish-desktop/src/store/layout-helpers/store-persistence.ts 355
apps/crish-desktop/src/store/layout-tree/layoutTreeStore.ts 435
apps/crish-desktop/src/store/layout-tree/sessionTabMigration.ts 497
apps/crish-desktop/src/store/sessionAgentActions.ts 341
apps/crish-desktop/src/store/sessionCrudActions.ts 361
apps/crish-desktop/src/store/sessionEviction.ts 347
apps/crish-desktop/src/store/sessionMessageActionsCore.ts 504
apps/crish-desktop/src/store/sessionSharedHelpers.messageMerge.ts 364
apps/crish-desktop/src/store/sessionStore.ts 386
apps/crish-desktop/src/store/sessionSubtreeModel.ts 374
apps/crish-desktop/src/store/store-persistence.ts 348
apps/crish-desktop/src/store/streamRunCompletion.ts 351
apps/crish-desktop/src/store/types.ts 367
apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts 353
apps/crish-desktop/src/utils/error-translation.ts 380
apps/crish-desktop/src/utils/ptyWriteGate.ts 384
apps/crish-desktop/src/workers/worker-pool.ts 492
<!-- BASELINE_END -->
