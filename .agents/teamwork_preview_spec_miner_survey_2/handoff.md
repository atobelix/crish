# Specification Mining Handoff Report

- **Agent ID**: `teamwork_preview_spec_miner_survey_2`
- **Working Directory**: `C:\Software\conex\.agents\teamwork_preview_spec_miner_survey_2`
- **Target Specification**: Notion-like Markdown Rendering Engine and Editor (`docs/composer-preview`)
- **Output Document**: `C:\Software\conex\.agents\teamwork_preview_spec_miner_survey_2\spec_requirements.md`
- **Date**: 2026-08-04T18:04:45Z

---

## 1. Observation

1. **Primary Requirements Source**:
   - `C:\Software\conex\.agents\ORIGINAL_REQUEST.md` (lines 118–166): Prompt draft specifying Notion-like Markdown rendering engine & editor in `C:\Software\conex\docs\composer-preview` across 5 categories (R1 Foundation & UX, R2 Code & Structure, R3 Tables & Media, R4 AI & Sci-Tech, R5 Version & IO).
2. **Target Working Directory State**:
   - `C:\Software\conex\docs\composer-preview` contains a Vite + React 19 + TypeScript project with `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-placeholder`, `@tiptap/extension-task-list`, `@tiptap/extension-task-item`, `@tiptap/extension-link`, `tiptap-markdown`, and `tiptap-extension-global-drag-handle`.
3. **Prototype Reference Inspection**:
   - `C:\Software\conex\reference\chat-composer-tiptap\src\components\slash-menu\Suggestion.ts` (lines 1–122) and `CommandList.tsx` (lines 1–86): Reference implementation of slash `/` command popup, keyboard handlers (`ArrowUp`, `ArrowDown`, `Enter`, `Escape`), Tippy.js popover attachment, and block insertions.
   - `C:\Software\conex\docs\schemes\SRS_REQUIREMENTS.md` (lines 1–100): High-level architectural context, scope boundaries, anti-overengineering constraints, and monorepo governance rules.
4. **Discovered Requirements Count**:
   - Enumerated **62 granular functional & non-functional requirements** across R1–R5 and NFR.
   - Enumerated **27 detailed edge cases** in tabular format.

---

## 2. Logic Chain

1. **Input Analysis**:
   The dispatch assignment requested a full specification survey enumerating granular functional and non-functional requirements for `docs/composer-preview` broken into 5 explicit categories: R1 (Foundation & UX), R2 (Code & Structure), R3 (Tables & Media), R4 (AI & Sci-Tech), R5 (Version & IO).
2. **Authoritative Mining**:
   - `ORIGINAL_REQUEST.md` lines 133–147 provide the baseline 5 categories.
   - `ORIGINAL_REQUEST.md` lines 150–165 define explicit UI, typography, parsing, and synthetic AI acceptance criteria.
   - Codebase prototypes (`reference/chat-composer-tiptap` and `docs/composer-preview/src/Composer.tsx`) provide concrete UI structure, extension configurations, and keyboard shortcut edge cases.
   - `AGENTS.md` and `SRS_REQUIREMENTS.md` supply non-functional constraints (XSS prevention, custom `<Tooltip>` mandates, zero heavy box shadows, focus contrast limit <10%, line count limit <500 per UI file).
3. **Synthesis & Structuring**:
   Requirements were formatted into two mandated tables (`## Features Discovered` and `## Edge Cases`) in `spec_requirements.md`. Each requirement specifies Category, Feature Name, Description, Inputs, Outputs, Error Behavior, and Discovered Via.

---

## 3. Caveats

1. **Pure Frontend AI Synthetic Mocking**:
   Per `ORIGINAL_REQUEST.md` lines 129 and 143, all AI backend capabilities (R4) in this phase use pure frontend synthetic mock responses. External network integration or real LLM API calls are out-of-scope.
2. **Monorepo Component Decoupling**:
   UI component implementations must adhere to the single-responsibility line count limits (<500 lines per file) and custom Tooltip rules when actual implementation proceeds.

---

## 4. Conclusion

All functional (R1 through R5) and non-functional requirements for the Notion-like Markdown Rendering Engine and Editor in `docs/composer-preview` have been mined, cataloged, and formatted into `spec_requirements.md`. The specification document contains:
- 62 Granular Features in `## Features Discovered`
- 27 Edge Case Scenarios in `## Edge Cases`
- Full traceability to authoritative files (`ORIGINAL_REQUEST.md`, prototype code, SRS docs, and project governance rules).

---

## 5. Verification Method

To verify the completeness and accuracy of this specification document:
1. Inspect `C:\Software\conex\.agents\teamwork_preview_spec_miner_survey_2\spec_requirements.md` using `view_file`.
2. Confirm presence of exact section headers `## Features Discovered` and `## Edge Cases`.
3. Verify coverage across all 5 required categories (R1 Foundation & UX, R2 Code & Structure, R3 Tables & Media, R4 AI & Sci-Tech, R5 Version & IO) plus NFR.
