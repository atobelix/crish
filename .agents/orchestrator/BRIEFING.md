# BRIEFING — 2026-08-04T15:05:35+08:00

## Mission
Execute parallel Tiptap core code migration to `apps/crish-desktop` based on `FINAL_REPAIR_SCHEME.md` and `SUBAGENT_TASK_GUIDE.md`, followed by a hyper-critical multi-agent fault-finding audit and audit-driven iterative repair cycles.

## 🔒 My Identity
- Archetype: Project Orchestrator
- Roles: orchestrator, user_liaison, human_reporter, successor
- Working directory: C:\Software\conex\.agents\orchestrator
- Original parent: Sentinel / Top-level
- Original parent conversation ID: 7190861f-3cb5-4c44-b347-6887c528cd68

## 🔒 My Workflow
- **Pattern**: Project Pattern
- **Scope document**: C:\Software\conex\PROJECT.md
1. **Decompose**:
   - Phase T0: Stub & Type Contract Author (`composerTypes.ts` & stubs) — [DONE]
   - Phase T1: ProseMirror Field Specialist (`TiptapEditorField.tsx`), Slash Popover Specialist (`TiptapSlashMenu.tsx`, `SlashExtension.ts`) — [DONE]
   - Phase T2: UI Shell Specialist (`TiptapComposerContainer.tsx`, AttachmentBar, PlusMenu, Tooltips) — [DONE]
   - Phase T3: State Specialist (`useTiptapComposerState.ts`, GFM serializers), IPC Specialist (`daemonClient.ts`, Rust LFI blocking) — [DONE]
   - Phase 4: Dedicated Multi-Agent Hyper-Critical Fault-Finding Audit Team — [DONE] (Round 1: 3 REJECTIONS)
   - Phase 5: Audit-Driven Iterative Repair Cycles & Verification — [IN_PROGRESS]
     - Round 1 Repair: 3 Repair Workers — [DONE]
     - Round 2 Re-Audit: 3 Dedicated Auditors — [IN_PROGRESS]
2. **Dispatch & Execute**: Delegate to subagents (Worker -> Auditor -> Repair Worker -> Re-Audit cycle).
3. **On failure**: Retry -> Replace -> Skip -> Redistribute -> Redesign -> Escalate.
4. **Succession**: Threshold at 20 spawns. Write handoff.md, spawn successor, update parent.

## 🔒 Key Constraints
- DISPATCH-ONLY orchestrator: MUST delegate ALL work to subagents. MUST NOT write code nor solve problems directly.
- Enforce explicit Conex red lines: 5-10% UI focus mix limit, max 5% mix landing, line-count guardrails (UI components <= 500 lines, logic <= 400 lines, types <= 800 lines), custom Tooltips only (no title attr), zero circular dependencies, layer decoupling, anti-overengineering rules.
- Max 12 useState per component.
- Z-index = 200 for popovers.
- Rust backend LFI blocking (`file://` interception returning `UserFacingError`).
- Audit report must be 100% hyper-critical (zero positive remarks, strictly flaw/defect accusations and modification demands).
- Never reuse a subagent after handoff delivery.

## Current Parent
- Conversation ID: 7190861f-3cb5-4c44-b347-6887c528cd68
- Updated: 2026-08-04T15:05:35+08:00

## Key Decisions Made
- All 3 Repair Workers completed remediation cleanly with 100% pass on build and unit test suites.
- Launched 3 fresh Auditors for Re-Audit Round 2 verification.

## Team Roster
| Agent | Type | Work Item | Status | Conv ID |
|-------|------|-----------|--------|---------|
| Worker T0 | teamwork_preview_worker | Task Card 1: composerTypes.ts & component stubs | completed | 9f2d7a6f-4f07-4864-9007-a50c343e9dab |
| Worker T1 Field | teamwork_preview_worker | Task Card 2: TiptapEditorField.tsx & Keymaps | completed | e04d8aae-6fbf-4047-8aa0-3a10ac4d382f |
| Worker T1 Slash | teamwork_preview_worker | Task Card 3: TiptapSlashMenu.tsx & SlashExtension | completed | 6c5a42d2-6c8e-484d-8640-81829d77ba91 |
| Worker T2 Shell | teamwork_preview_worker | Task Card 4: TiptapComposerContainer & Toolbar | completed | 731091be-92ea-45aa-a516-a9b4b596931d |
| Worker T3 State | teamwork_preview_worker | Task Card 5: useTiptapComposerState & Serializers | completed | c571ddd8-5255-4ed4-b941-3091096eee51 |
| Worker T3 IPC | teamwork_preview_worker | Task Card 6: daemonClient.ts & Rust LFI Blocking | completed | b776632d-b2ea-4ecf-aaa6-a5c52a39b63f |
| Auditor FE R1 | teamwork_preview_auditor | Hyper-Critical Audit: Frontend UI & Softness | completed (REJECTED) | fd77f90b-5fdb-4293-a2c4-0f696c77dd9e |
| Auditor State R1 | teamwork_preview_auditor | Hyper-Critical Audit: State & Memory Leaks | completed (REJECTED) | a6fcdb66-d1fb-4ff4-8707-d0f38544d62c |
| Auditor IPC R1 | teamwork_preview_auditor | Hyper-Critical Audit: IPC Bridge & Security | completed (REJECTED) | 3ff33481-14fe-4bea-ada5-772cf70dcabd |
| Repair Worker 1 | teamwork_preview_worker | Audit Repair: Frontend Dependencies & UI Rules | completed | f81ad405-a821-4aa0-bf83-777207ba2f80 |
| Repair Worker 2 | teamwork_preview_worker | Audit Repair: State Sync, Drafts & Serializers | completed | e81d0278-a3be-4895-b259-8dd93b78e361 |
| Repair Worker 3 | teamwork_preview_worker | Audit Repair: Rust Concurrency, LFI & IPC | completed | d5623bd8-d1cf-4595-8b89-48956d9bcf07 |
| Auditor FE R2 | teamwork_preview_auditor | Re-Audit R2: Frontend UI & Softness | in-progress | ff10d374-7ad9-422b-a23f-a5ea293a4a66 |
| Auditor State R2 | teamwork_preview_auditor | Re-Audit R2: State & Memory Leaks | in-progress | 61cbcf7b-69d8-4390-9d23-3ab0639392e4 |
| Auditor IPC R2 | teamwork_preview_auditor | Re-Audit R2: IPC Bridge & Security | in-progress | c8d82ae3-269c-44ba-b99d-b611ee8e19b7 |

## Succession Status
- Succession required: no
- Spawn count: 15 / 20
- Pending subagents: ff10d374-7ad9-422b-a23f-a5ea293a4a66, 61cbcf7b-69d8-4390-9d23-3ab0639392e4, c8d82ae3-269c-44ba-b99d-b611ee8e19b7
- Predecessor: none
- Successor: not yet spawned

## Active Timers
- Heartbeat cron: running (`task-25`)
- Safety timer: none

## Artifact Index
- C:\Software\conex\.agents\ORIGINAL_REQUEST.md — Original User Request
- C:\Software\conex\.agents\orchestrator\DISPATCH.md — Orchestrator Dispatch Log
- C:\Software\conex\.agents\orchestrator\progress.md — Progress & Liveness Log
- C:\Software\conex\.agents\repair_worker_1\handoff.md — Repair Worker 1 Handoff
- C:\Software\conex\.agents\repair_worker_2\handoff.md — Repair Worker 2 Handoff
- C:\Software\conex\.agents\repair_worker_3\handoff.md — Repair Worker 3 Handoff
