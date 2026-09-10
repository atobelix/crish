# sec2 progress

> date 2026-09-07
> scope SYSTEMATIC-FIX-PLAN 2.1

## 意图
拆除恒空 stub（dispatchWorkflowAssistantCard / dispatchSkillContextCard / dispatchGoalModeCard / dispatchGrillMeCard / dispatchAttachmentCards），同步调用点为真实反馈（safe_seed / wire / toast）。

## 完成项
1. 物理删除 slashContextCards.ts。
2. workflowAssistantCard.ts 仅保留 WORKFLOW_CREATE_TEMPLATE 与 buildWorkflowAssistantContext。
3. slashSendPreflight / ScheduledTasksPanel / SettingsScheduleTab 去掉 dispatch*；面板 toast 成功；无会话 toast 失败。
4. 测试：SettingsScheduleTab 5；assembleChatPayload.noStub 3；noPseudoDispatch.gate 2；合计 10 passed。
5. 门禁 scripts/check-no-pseudo-dispatch.mjs；经 check-input-guardrails 嵌入总闸。

## 改动文件
- DELETE apps/crish-desktop/src/hooks/chat-stream/slashContextCards.ts
- apps/crish-desktop/src/api/workflow-api/workflowAssistantCard.ts
- apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts
- apps/crish-desktop/src/components/settings/ScheduledTasksPanel.tsx
- apps/crish-desktop/src/components/settings/SettingsScheduleTab.tsx
- apps/crish-desktop/src/components/settings/SettingsScheduleTab.test.tsx
- apps/crish-desktop/src/hooks/chat-stream/assembleChatPayload.noStub.test.ts
- apps/crish-desktop/src/hooks/chat-stream/noPseudoDispatch.gate.test.ts
- scripts/check-no-pseudo-dispatch.mjs
- scripts/check-input-guardrails.mjs

## 测试结果
- check-no-pseudo-dispatch PASS
- check-markdown-style-compliance PASS
- vitest 10 passed

## QUALITY-GATE
- 无空 stub 仍被调用
- 无新旁路
- 失败路径有 toast 测试
- 门禁可执行（input-guard 嵌入；package.json 未写入）

## 未完成
1. package.json 人工接线：新增 check:markdown-style 与 check:no-pseudo-dispatch，挂到 check:desktop 的 check:input-guard 之后；然后删除 input-guard 内 SEC14_SEC2_EMBEDDED_GATES 段。
2. 方案 2.2 文档伪连通清零未做。
3. code-audit 二次核查未出。

## 非假装修完
未保留被调用空 stub；有 toast/wire/seed 真实路径。
