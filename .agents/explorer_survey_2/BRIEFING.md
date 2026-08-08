# BRIEFING — 2026-08-04T14:18:30+08:00

## Mission
Survey target host application codebase (`apps/crish-desktop` and `apps/agent-workbench`), analyzing chat composer/input implementation, React components, Zustand state stores (`window.__CRISH_*`), layout trees, theme system, tooltips, focus state rules, shortcuts, and attachment UI to establish exact insertion points and boundary maps for Tiptap Composer migration.

## 🔒 My Identity
- Archetype: Teamwork explorer
- Roles: survey_explorer
- Working directory: C:\Software\conex\.agents\explorer_survey_2
- Original parent: f5139a67-1418-485c-bcc1-563ff8cf9490
- Milestone: Step 1 Survey (Target Host Codebase) Completed

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Strictly follow anti-overengineering guardrails & CI rules (AGENTS.md)
- Custom `<Tooltip>` required, no browser native `title`
- Focus contrast rules max 10%, standard 3-6% mix
- Document exact file paths, line numbers, store facades, insertion points

## Current Parent
- Conversation ID: f5139a67-1418-485c-bcc1-563ff8cf9490
- Updated: 2026-08-04T14:18:30+08:00

## Investigation State
- **Explored paths**: `apps/crish-desktop/src/components/chat-card`, `apps/crish-desktop/src/components/chat-composer`, `apps/crish-desktop/src/components/Tooltip`, `apps/crish-desktop/src/store`, `apps/agent-workbench/src`
- **Key findings**: Documented exact component hierarchy, store facades (`useSessionStore` = `useLayoutStore`), window bindings (`window.__CRISH_*`), CSS theme tokens, dual-box composer geometry, focus contrast caps, custom Tooltip rules, shortcut handlers, and attachment pipeline.
- **Unexplored areas**: None for survey scope.

## Key Decisions Made
- Written detailed analysis report to `C:\Software\conex\.agents\explorer_survey_2\analysis.md`.
- Written handoff report to `C:\Software\conex\.agents\explorer_survey_2\handoff.md`.

## Artifact Index
- `C:\Software\conex\.agents\explorer_survey_2\DISPATCH.md` — Task dispatch log
- `C:\Software\conex\.agents\explorer_survey_2\BRIEFING.md` — Briefing state
- `C:\Software\conex\.agents\explorer_survey_2\progress.md` — Liveness heartbeat
- `C:\Software\conex\.agents\explorer_survey_2\analysis.md` — Survey analysis report
- `C:\Software\conex\.agents\explorer_survey_2\handoff.md` — 5-component Handoff report
