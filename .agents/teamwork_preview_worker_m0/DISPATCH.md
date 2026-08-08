## 2026-08-04T05:44:10Z
<USER_REQUEST>
You are subagent teamwork_preview_worker_m0 (Role: Baseline Requirements Document Author).
Your working directory is: C:\Software\conex\.agents\teamwork_preview_worker_m0
Your parent conversation ID is: e1c690d8-01bb-4ac5-885d-8f4fddaf38af

Objective:
Author the detailed Software Requirements Specification for Tiptap Chat Composer Migration (`docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md`).

Input Information:
- Original Request path: C:\Software\conex\.agents\ORIGINAL_REQUEST.md (READ THIS FIRST)
- Conex Governance Rules: C:\Software\conex\.agents\AGENTS.md
- Explorer 1 Analysis: C:\Software\conex\.agents\teamwork_preview_explorer_survey_1\analysis.md
- Explorer 2 Analysis: C:\Software\conex\.agents\teamwork_preview_explorer_survey_2\analysis.md
- Explorer 3 Analysis: C:\Software\conex\.agents\teamwork_preview_explorer_survey_3\analysis.md

Mandatory Integrity Warning:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Instructions:
1. Create directory C:\Software\conex\docs\requirements\ if it does not exist.
2. Author C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md covering:
   - Section 1: Executive Summary & Project Objectives
   - Section 2: Conex Architecture Context (Rust kernel + Tauri shell + React desktop frontend apps/crish-desktop)
   - Section 3: Functional Requirements (Tiptap v3 core, StarterKit, Markdown shortcuts, Slash commands, TaskList, Drag Handles, ProseMirror <-> Markdown Serializer)
   - Section 4: Target Component Placement & State Integration (TiptapComposerField.tsx replacing ComposerField.tsx inside ChatComposer.tsx, keeping useChatComposerProps interface, 350ms debounced draft persistence in useLayoutStore, session runtime attachments, queue panel, L2/L3 stop buttons)
   - Section 5: UI/UX & Design System Constraints (Custom <Tooltip> over native title, focus state border darkening <= 10% mix, no heavy box shadows, max 500 lines per component file, IME composition handling)
   - Section 6: IPC & Backend Payload Specification (buildMultimodalFromAttachments, invokeTyped<T> handling)
   - Section 7: Verification Criteria & Testing Matrix
3. Ensure the document is detailed, professional, structured with clear Markdown headers, tables, and exact code references.
4. Create your working directory C:\Software\conex\.agents\teamwork_preview_worker_m0 if it does not exist.
5. Write your handoff report to C:\Software\conex\.agents\teamwork_preview_worker_m0\handoff.md following the Handoff Protocol (Observation, Logic Chain, Caveats, Conclusion, Verification).
6. Send a message back to parent e1c690d8-01bb-4ac5-885d-8f4fddaf38af with a summary of work completed and path to handoff.md when done.
</USER_REQUEST>
