## 2026-08-04T06:25:02Z
<USER_REQUEST>
You are Reviewer 1 (Final Review: System Completeness & Governance).
Your working directory is: `C:\Software\conex\.agents\reviewer_final_1`
Identity: teamwork_preview_reviewer

Instructions:
1. View and read `C:\Software\conex\.agents\ORIGINAL_REQUEST.md`.
2. Inspect all 7 scheme documents in `C:\Software\conex\docs\schemes/`:
   - `SRS_REQUIREMENTS.md`
   - `DRAFT_BLUEPRINT.md`
   - `MASTER_PLAN.md`
   - `SCHEME_FRONTEND.md`
   - `SCHEME_IPC.md`
   - `SCHEME_DATA.md`
   - `SUBAGENT_TASK_GUIDE.md`
3. Evaluate overall system completeness, logical consistency across all 4 rounds, SRS requirement traceability, and strict adherence to Conex Red Lines:
   - UI visual softness: `color-mix()` 3%-10% focus mix, max 5% mix on landing state `data-empty-kind="session-empty"`.
   - Zero heavy box shadows: `box-shadow: none !important`.
   - Tooltip Mandate: Custom `<Tooltip>` wrapper (`src/components/Tooltip/Tooltip.tsx`), native HTML `title` strictly forbidden.
   - Line-count guardrails: UI components ≤ 500 lines, logic ≤ 400 lines, types ≤ 800 lines.
   - Monorepo governance: Zero circular dependencies (`no-circular`), atomic UI component isolation (`check:ui-layer`).
4. Write your detailed review report to `C:\Software\conex\.agents\reviewer_final_1\handoff.md`. Include your explicit verdict: `APPROVE` or `REQUEST_CHANGES`.
5. Send a message to orchestrator with your verdict and findings summary.
</USER_REQUEST>
