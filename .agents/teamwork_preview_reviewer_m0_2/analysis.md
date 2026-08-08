# Requirements Specification Review & Architecture Integrity Analysis

**Target Document**: `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md`  
**Reviewer**: Subagent `teamwork_preview_reviewer_m0_2` (Role: Architecture & Integration Integrity Reviewer / Critic)  
**Date**: 2026-08-04  
**Verdict**: **REQUEST_CHANGES**

---

## Executive Summary

A comprehensive architectural and integration review of `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md` was conducted against `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx`, `useChatComposerProps.ts`, `ComposerField.tsx`, `multimodal.ts`, and Conex Core Directives (`.agents/AGENTS.md`).

While the specification successfully establishes strong guardrails around design system rules (custom `<Tooltip>`, $\le 10\%$ focus border mix limit, $\le 500$ lines CI file limit) and correctly preserves the `useChatComposerProps` 350ms debounced draft persistence state model, **critical technical discrepancies** exist in the prop interface contract, IPC payload signatures, and backend stream dispatch mapping. These defects would cause TypeScript compilation errors (`npm run typecheck` failures) and runtime streaming breakdowns if implemented as written.

---

## Core Verification Points Matrix

| Verification Item | Requirement Status | Baseline Code Match | Assessment |
|---|---|---|---|
| **1. `TiptapComposerField.tsx` Placement** | Specified inside `ChatComposer.tsx` replacing `ComposerField.tsx`. | Replaces `ComposerField` in `ChatComposer.tsx:184`. | **DEFECT**: `TiptapComposerFieldProps` (Section 4.1) omits `processingPlaceholder`, `maxLines`, `leading`, `onKeyDownExtra`, and accessibility ARIA props passed by `ChatComposer.tsx` and dependent components (`AgentCard`, `InlineAgentPanel`). |
| **2. `useChatComposerProps` Contract** | Preserved with 0 modification to hook interface. | Matches `useChatComposerProps.ts`. | **PASS**: Outer state facade (`chatInput`, `setChatInput`, `isComposing`, `attachments`, `queuedMessages`, `onSend`, `onStop`, `onForceStop`) is accurately preserved. |
| **3. 350ms Debounced Draft Persistence** | Specified in `useLayoutStore` with auto-flush on switch/unload. | Matches `useChatComposerProps.ts:99-137`. | **PASS**: Store key, 350ms window via `scheduleComposerDraft`, and `flushComposerDraft` auto-flush behavior are accurately specified. |
| **4. Custom `<Tooltip>` Enforcement** | Zero native `title="..."` attributes; strictly custom `<Tooltip>`. | Aligns with `.agents/AGENTS.md` Rule 2. | **PASS**: All action buttons mandated to use `<Tooltip content="...">` from `@/components/Tooltip`. |
| **5. Focus Border Contrast Limit** | $\le 10\%$ mix limit; landing empty state $\le 5\%$; no heavy box shadows. | Aligns with `.agents/AGENTS.md` Rule 3. | **PASS**: CSS mix tokens (`color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`) strictly enforced. |

---

## Detailed Findings & Critical Issues

### Finding 1 [Major]: Incomplete `TiptapComposerFieldProps` Interface (Section 4.1)
- **Location**: `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md:179-213`
- **Issue**: `TiptapComposerFieldProps` omits key props passed by `ChatComposer.tsx` and dependent host components (`AgentCard.tsx:387`, `InlineAgentPanel.tsx:444`):
  - `processingPlaceholder?: string` (passed by `ChatComposer.tsx:210`)
  - `maxLines?: number` (passed by `AgentCard.tsx:387` and `InlineAgentPanel.tsx:444` for dense height caps)
  - `ariaLabel?: string`, `ariaExpanded?: boolean`, `ariaControls?: string`, `ariaHasPopup?: ...`, `ariaActivedescendant?: string`, `ariaAutocomplete?: ...` (passed by `ChatComposer.tsx:211-216`)
  - `leading?: React.ReactNode` (passed by `ChatComposer.tsx:217` for slot popups)
  - `onKeyDownExtra?: (e: React.KeyboardEvent) => boolean | void` (passed by `ChatComposer.tsx:232`)
- **Impact**: Replacing `ComposerField` with `TiptapComposerField` without these props will fail `npm run typecheck` and break backward compatibility when `ChatComposer` re-exports `ComposerField` for agent sidebars.
- **Remediation**: Expand `TiptapComposerFieldProps` in Section 4.1 to include all optional host layout and accessibility props (`processingPlaceholder`, `maxLines`, `aria*`, `leading`, `onKeyDownExtra`).

---

### Finding 2 [Critical]: Fabricated Return Signature for `buildMultimodalFromAttachments` (Section 6.1)
- **Location**: `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md:338-345`
- **Issue**: Section 6.1 documents `buildMultimodalFromAttachments` as:
  ```typescript
  export function buildMultimodalFromAttachments(
    text: string,
    attachments: ChatAttachment[]
  ): {
    contentParts: ChatContentPart[];
    attachmentMetas: StreamAttachmentMeta[];
  }
  ```
  However, in `apps/crish-desktop/src/hooks/chat-stream/multimodal.ts:13-19`, the actual production signature is:
  ```typescript
  export function buildMultimodalFromAttachments(
    modelText: string,
    attachments: ChatAttachment[]
  ): {
    promptAttachBlock: string;
    streamOptions: StreamRequestOptions | undefined;
  }
  ```
- **Impact**: Code written to match Section 6.1 will fail to compile against `multimodal.ts`.
- **Remediation**: Update Section 6.1 to reflect the real return type (`promptAttachBlock: string; streamOptions: StreamRequestOptions | undefined`).

---

### Finding 3 [Critical]: Incorrect IPC Dispatch Mechanism (Section 6.2)
- **Location**: `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md:352-358`
- **Issue**: Section 6.2 claims user chats are dispatched via direct typed IPC invocation `invokeTyped<RunTaskResponse>('run_task', { sessionId, promptParts, attachmentMetas, permissionMode })`.
  In reality, assistant streaming in Conex flows through `useChatStream` -> `handleSendChat` -> `streamAssistantResponseApi` (`streamViaEngine`), which uses WebSocket / Tauri transport with `StreamRequestOptions`.
- **Impact**: Developers attempting direct `invokeTyped('run_task')` calls will bypass `streamAssistantResponseApi`, breaking streaming responses, token chunking, thought logs, and tool approval callbacks.
- **Remediation**: Rewrite Section 6.2 to clarify that `TiptapComposerField` outputs serialized markdown to `onChange`, and `useChatComposerProps` / `useChatStream` manages dispatch via `streamAssistantResponseApi` (`streamViaEngine`).

---

### Finding 4 [Major]: Unclarified Handoff for Slash Command Palette (Section 3.3 vs Section 4.1)
- **Location**: `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md:139-149` & `ChatComposer.tsx:188-244`
- **Issue**: Section 3.3 mandates replacing legacy popovers with `@tiptap/suggestion`. However, `ChatComposer.tsx` currently manages `slashMenuOpen`, `slashSelectedIndex`, `filteredCommands`, `loadSkillSlash`, and passes `leading={<ComposerSlashMenu ... />}` to `ComposerField`.
- **Impact**: Without explicit specification of whether `ChatComposer.tsx` delegates slash command state completely to Tiptap's internal suggestion plugin or retains external state via callbacks, implementation will result in duplicate event listeners or broken slash command selection.
- **Remediation**: Explicitly specify the architectural responsibility boundary: either `TiptapComposerField` encapsulates slash command rendering internally via `@tiptap/suggestion` (and `ChatComposer` passes `loadSkillSlash`), or `TiptapComposerField` exposes a portal insertion point for `ComposerSlashMenu`.

---

### Finding 5 [Minor]: Missing Coverage for Re-exported `ComposerField` in `AgentCard` & `InlineAgentPanel` (Section 2.2)
- **Location**: `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md:90-102`
- **Issue**: Section 2.2 Component Map table does not mention `AgentCard.tsx` or `InlineAgentPanel.tsx`, both of which import `ComposerField` from `ChatComposer.tsx`.
- **Impact**: Risk of regressions in agent sidebars/inline panels if `ChatComposer` re-export compatibility is not documented.
- **Remediation**: Add `AgentCard.tsx` and `InlineAgentPanel.tsx` to Section 2.2 Component Map, confirming that re-exported `ComposerField` (`TiptapComposerField`) supports dense mode (`dense={true}`, `maxLines={3}`).

---

## Adversarial Stress-Testing & Integrity Checks

1. **Integrity Violation Check**:
   - No hardcoded test results, facade shortcuts, or self-certifying bypasses detected in the document.
   - The findings are legitimate technical/architectural contract mismatches between the SRS and host codebase.
2. **Edge Case / Boundary Conditions**:
   - CJK IME composition handling during slash suggestion matching is correctly specified in Section 5.5.
   - 350ms debounced persistence auto-flush on session switch and `beforeunload` is correctly specified in Section 4.2.1.
   - L2 cooperative stop vs L3 force stop confirmation hierarchy (`FORCE_CANCEL_CONFIRM`, `FORCE_STOP_LONG_PRESS_MS = 550`) is correctly specified in Section 4.2.4.

---

## Conclusion & Actionable Verdict

**Verdict**: **REQUEST_CHANGES**

The specification document `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md` is fundamentally sound regarding UI design constraints, draft persistence state architecture, and functional editing goals. However, changes are requested to resolve the 5 findings listed above (specifically fixing `TiptapComposerFieldProps`, aligning `buildMultimodalFromAttachments` return signature, correcting the `streamAssistantResponseApi` dispatch architecture, and clarifying slash command ownership).

Once these 5 items are updated, the document will be ready for approval.
