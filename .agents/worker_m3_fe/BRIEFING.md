# BRIEFING — 2026-08-04T14:22:38Z

## Mission
Author the exhaustive, highly detailed Frontend Component Layer scheme document: `C:\Software\conex\docs\schemes\SCHEME_FRONTEND.md`.

## 🔒 My Identity
- Archetype: teamwork_preview_worker
- Roles: implementer, qa, specialist
- Working directory: C:\Software\conex\.agents\worker_m3_fe
- Original parent: f5139a67-1418-485c-bcc1-563ff8cf9490
- Milestone: Round 3 Scheme Authoring (Frontend Layer)

## 🔒 Key Constraints
- Must align strictly with SRS_REQUIREMENTS.md, DRAFT_BLUEPRINT.md, and MASTER_PLAN.md.
- Must detail all 5 frontend component files + custom extensions + custom state hook + types.
- Enforce visual design & CSS rules: color-mix 3%-10% focus border, max 5% landing mix, box-shadow: none !important.
- Enforce Tooltip mandate: Custom `<Tooltip>` wrapper required, native HTML title attributes strictly forbidden.
- Enforce line-count limits: UI ≤ 500 lines, logic ≤ 400 lines, types ≤ 800 lines. Single component per file (`no-multi-comp`), max 12 `useState` hooks.
- Include traceability tags (`[REF:FRONTEND-001]`, `[REF:FRONTEND-002]`, etc.).
- Output document must be massive (~500+ lines), technical, and complete.

## Current Parent
- Conversation ID: f5139a67-1418-485c-bcc1-563ff8cf9490
- Updated: 2026-08-04T14:22:38Z

## Task Summary
- **What to build**: `C:\Software\conex\docs\schemes\SCHEME_FRONTEND.md`
- **Success criteria**: Comprehensive markdown blueprint covering component hierarchy, ProseMirror extensions, custom keymaps, IME composition protection, visual CSS rules, line-count guardrails, and traceability matrix.
- **Interface contracts**: `SRS_REQUIREMENTS.md`, `MASTER_PLAN.md`

## Key Decisions Made
- Fully expand every component code structure, CSS module rule, popover mounting strategy, and keymap specification.
- Use explicit `[REF:FRONTEND-xxx]` cross-reference tags matching Master Plan and SRS mapping.

## Artifact Index
- `C:\Software\conex\docs\schemes\SCHEME_FRONTEND.md` — Round 3 Detailed Frontend Component Layer Scheme Document
- `C:\Software\conex\.agents\worker_m3_fe\handoff.md` — Handoff report for orchestrator
