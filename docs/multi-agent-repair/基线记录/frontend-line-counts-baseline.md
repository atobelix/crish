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

<!-- BASELINE_START -->

apps/crish-desktop/src/api/applyFileDiff.ts 441
apps/crish-desktop/src/api/approvalMeta.ts 400
apps/crish-desktop/src/api/backgroundTasksApi.ts 621
apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts 526
apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts 358
apps/crish-desktop/src/api/clientApi.ts 697
apps/crish-desktop/src/api/commandPermissions.ts 521
apps/crish-desktop/src/api/engineConfig.ts 460
apps/crish-desktop/src/api/fontStore.ts 440
apps/crish-desktop/src/api/gitApi.ts 476
apps/crish-desktop/src/api/goalModeController.ts 623
apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParser.ts 362
apps/crish-desktop/src/api/markdown-render/markdownPlugins.ts 517
apps/crish-desktop/src/api/messageUserProjection.ts 626
apps/crish-desktop/src/api/modelCatalog.ts 868
apps/crish-desktop/src/api/previewBrowserStore.ts 343
apps/crish-desktop/src/api/pricingStore.ts 1409
apps/crish-desktop/src/api/provider-profiles/profileStore.ts 541
apps/crish-desktop/src/api/session-persistence/sessionHydration.ts 387
apps/crish-desktop/src/api/session-persistence/sessionRustDbSql.ts 393
apps/crish-desktop/src/api/sessionEventHydrate.ts 554
apps/crish-desktop/src/api/sessionExport.ts 547
apps/crish-desktop/src/api/sessionSearch.ts 412
apps/crish-desktop/src/api/sessionTitle.ts 342
apps/crish-desktop/src/api/skillsApi.ts 630
apps/crish-desktop/src/api/themeStore.ts 697
apps/crish-desktop/src/api/tool-presentation/toolCardPresenter.ts 776
apps/crish-desktop/src/api/toolFeedback.ts 575
apps/crish-desktop/src/api/workspaceFsApi.ts 360
apps/crish-desktop/src/bridges/send-to-note.ts 341
apps/crish-desktop/src/components/agent-card/AgentCard.tsx 461
apps/crish-desktop/src/components/agent-card/AgentTeamBoard.tsx 461
apps/crish-desktop/src/components/agent-card/InlineAgentPanel.tsx 604
apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts 472
apps/crish-desktop/src/components/chat-composer/SlashExtension.ts 442
apps/crish-desktop/src/components/diff/ChangeOverviewCard.tsx 481
apps/crish-desktop/src/components/diff/DiffCard.tsx 442
apps/crish-desktop/src/components/files/FileViewerCard.tsx 427
apps/crish-desktop/src/components/settings-extensions/ExtensionCard.tsx 466
apps/crish-desktop/src/components/settings-extensions/useExtensionMarket.tsx 438
apps/crish-desktop/src/components/settings-mcp/McpServerList.tsx 453
apps/crish-desktop/src/components/settings-models/useModelProfilesState.ts 501
apps/crish-desktop/src/components/settings-skills/useSkillsSettingsState.ts 635
apps/crish-desktop/src/components/settings/SettingsDevicesTab.tsx 486
apps/crish-desktop/src/components/settings/SettingsShortcutsTab.tsx 447
apps/crish-desktop/src/components/workspace/TerminalCard.xterm.tsx 431
apps/crish-desktop/src/components/workspace/browser-panel/BrowserImportSection.tsx 471
apps/crish-desktop/src/hooks/chat-stream/streamCallbacksInternals.ts 364
apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts 457
apps/crish-desktop/src/hooks/tab-drag/tabDragGeometry.ts 718
apps/crish-desktop/src/hooks/tab-drag/useTabDragEvents.ts 359
apps/crish-desktop/src/hooks/useAgentStream.ts 454
apps/crish-desktop/src/hooks/useToastQueue.ts 395
apps/crish-desktop/src/store/layout-tree/layoutTreeStore.ts 352
apps/crish-desktop/src/store/layout-tree/operations.ts 761
apps/crish-desktop/src/store/sessionCrudActions.ts 428
apps/crish-desktop/src/store/sessionIndex.ts 473
apps/crish-desktop/src/store/sessionMessageActions.ts 436
apps/crish-desktop/src/store/sessionSharedHelpers.ts 419
apps/crish-desktop/src/store/streamingStore.ts 351
apps/crish-desktop/src/store/workspace-shell/adapterShape.ts 616
apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts 459
apps/crish-desktop/src/store/workspaceActions.ts 512
<!-- BASELINE_END -->
