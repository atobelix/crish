# Handoff Report — Tiptap Migration Requirements Review (M0 Target Baseline)

**Role**: Reviewer 2 (Architecture & Integration Integrity Reviewer / Critic)  
**Agent ID**: `teamwork_preview_reviewer_m0_2`  
**Working Directory**: `C:\Software\conex\.agents\teamwork_preview_reviewer_m0_2`  
**Target Document**: `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md`  
**Parent Conversation ID**: `e1c690d8-01bb-4ac5-885d-8f4fddaf38af`  
**Verdict**: **REQUEST_CHANGES**

---

## 1. Observation

Direct code & specification inspection revealed the following exact observations:

1. **Host Component Placement & Prop Pass-through**:
   - `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx:184-245` renders `<ComposerField ... />` passing `processingPlaceholder`, `leading`, `onKeyDownExtra`, `ariaLabel`, `ariaExpanded`, `ariaControls`, `ariaHasPopup`, `ariaActivedescendant`, `ariaAutocomplete`.
   - `apps/crish-desktop/src/components/agent-card/AgentCard.tsx:387` and `InlineAgentPanel.tsx:444` import `ComposerField` re-exported from `ChatComposer.tsx:24` and pass `dense={true}` and `maxLines={3}`.
   - `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md:179-213` defines `TiptapComposerFieldProps` omitting `processingPlaceholder`, `maxLines`, `leading`, `onKeyDownExtra`, and `aria*` accessibility props.

2. **Multimodal Payload Construction Signature**:
   - `apps/crish-desktop/src/hooks/chat-stream/multimodal.ts:13-19`:
     ```typescript
     export function buildMultimodalFromAttachments(
       modelText: string,
       attachments: ChatAttachment[]
     ): {
       promptAttachBlock: string;
       streamOptions: StreamRequestOptions | undefined;
     }
     ```
   - `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md:338-345` claims signature returns `{ contentParts: ChatContentPart[]; attachmentMetas: StreamAttachmentMeta[]; }`.

3. **IPC Dispatch Mechanism**:
   - `apps/crish-desktop/src/api/chatApi.ts:157-167` & `useChatStream.ts:367-388`: User prompts are streamed via `streamAssistantResponseApi` (`streamViaEngine`) over WebSocket/Tauri IPC transport using `StreamRequestOptions`.
   - `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md:352-358` claims user prompt is sent directly via `invokeTyped<RunTaskResponse>('run_task', { sessionId, promptParts, attachmentMetas, permissionMode })`.

4. **350ms Debounced Persistence & Hook Contract**:
   - `apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts:98-137`: Draft state persistence is debounced at 350ms writing to `useLayoutStore.getState().composerDrafts[activeSessionId]` with auto-flush on session switch or window `beforeunload`.
   - `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md:239-245` matches this exact state model.

5. **Design System Guardrails**:
   - `.agents/AGENTS.md` Rule 2 & Rule 3: Zero native `title` (use custom `<Tooltip>`), focus border mix limit $\le 10\%$ (`color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`), maximum 500 lines per component file.
   - `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md:263-315` incorporates these exact rules.

---

## 2. Logic Chain

1. **Prop Interface Incompleteness**: `ChatComposer.tsx`, `AgentCard.tsx`, and `InlineAgentPanel.tsx` rely on props (`processingPlaceholder`, `maxLines`, `aria*`, `leading`, `onKeyDownExtra`). If `TiptapComposerFieldProps` in Section 4.1 does not include these props, replacing `ComposerField` with `TiptapComposerField` will cause TypeScript build errors (`npm run typecheck`) and break agent sidebar composer rendering.
2. **IPC Signature Discrepancy**: Implementers building payload serializers according to Section 6.1 will fail to compile against `multimodal.ts` because the documented return type (`{ contentParts, attachmentMetas }`) does not match actual `multimodal.ts` (`{ promptAttachBlock, streamOptions }`).
3. **Dispatch Flow Misalignment**: Implementing `invokeTyped('run_task')` directly as described in Section 6.2 bypasses `streamAssistantResponseApi` (`streamViaEngine`), disabling streaming chunk callbacks, thought logs, and approval handlers.
4. **Conclusion**: Therefore, `docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md` cannot be approved in its current state and requires specific revisions.

---

## 3. Caveats

- **No Caveats**: All key host files (`ChatComposer.tsx`, `ComposerField.tsx`, `useChatComposerProps.ts`, `multimodal.ts`, `chatApi.ts`, `AgentCard.tsx`, `InlineAgentPanel.tsx`, `.agents/AGENTS.md`) were directly inspected and verified.

---

## 4. Conclusion

**Verdict**: **REQUEST_CHANGES**

The specification is well-structured and accurately covers functional targets, state preservation, 350ms debounced draft persistence, custom `<Tooltip>` usage, and focus border mix limits. However, changes are required to address:
1. Expanding `TiptapComposerFieldProps` in Section 4.1 (`processingPlaceholder`, `maxLines`, `aria*`, `leading`, `onKeyDownExtra`).
2. Correcting `buildMultimodalFromAttachments` return signature in Section 6.1.
3. Updating Section 6.2 to reflect streaming dispatch via `streamAssistantResponseApi` (`streamViaEngine`).
4. Clarifying slash command UI ownership between `ChatComposer.tsx` and `@tiptap/suggestion`.
5. Mentioning `AgentCard.tsx` / `InlineAgentPanel.tsx` in Section 2.2 Component Map.

---

## 5. Verification Method

To independently verify these findings:
1. **Inspect Code Files**:
   - Check `multimodal.ts:13-19` for `buildMultimodalFromAttachments` return type vs `TIPTAP_MIGRATION_REQUIREMENTS.md:338-345`.
   - Check `ChatComposer.tsx:184-245`, `AgentCard.tsx:387`, `InlineAgentPanel.tsx:444` vs `TIPTAP_MIGRATION_REQUIREMENTS.md:179-213`.
   - Check `chatApi.ts:157-167` vs `TIPTAP_MIGRATION_REQUIREMENTS.md:352-358`.
2. **Run Standard Conex Verification Commands**:
   - `npm run typecheck`
   - `npx vitest run src/components/chat-composer`
   - `cargo test --workspace`
   - `npm run check:zindex`
