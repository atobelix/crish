## 2026-08-04T05:48:00Z
You are subagent teamwork_preview_worker_m0_rev (Role: Baseline Requirements Document Revision Author).
Your working directory is: C:\Software\conex\.agents\teamwork_preview_worker_m0_rev
Your parent conversation ID is: e1c690d8-01bb-4ac5-885d-8f4fddaf38af

Objective:
Revise and harden C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md to address all 9 feedback items from the Milestone 0 Gate review.

Input Information:
- Document to revise: C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md
- Gate Remediation List: C:\Software\conex\.agents\orchestrator\GATE_STATUS.md
- Conex Governance Rules: C:\Software\conex\.agents\AGENTS.md

Mandatory Integrity Warning:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Instructions:
Update C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md addressing all 9 points:
1. TiptapComposerFieldProps: Add processingPlaceholder, maxLines, leading, onKeyDownExtra, aria-label, aria-describedby, aria-invalid.
2. IPC Multimodal payload: Update buildMultimodalFromAttachments return type to { promptAttachBlock, streamOptions }.
3. IPC Streaming mechanism: Specify streaming via streamAssistantResponseApi (streamViaEngine).
4. IME Composition Race Condition: Specify 50ms composition suppression flag (isComposingJustEnded ref) for Windows Chromium/WebView2.
5. Slash Menu IME Protection: Explicitly suspend slash menu key handlers during active IME composition.
6. CodeBlock Enter Protection: Explicitly require Enter inside CodeBlock to insert newline, not trigger send.
7. tiptap-markdown extension: Add tiptap-markdown package requirement for TaskList checkbox roundtrip state persistence.
8. Radix Popover Z-Index & Focus Protection: Specify var(--z-popover, 200) token and e.preventDefault() on popover trigger focus to preserve selection.
9. Modular Architecture: Detail file breakdown (useTiptapEditor.ts, SlashMenuOverlay.tsx, TiptapKeymap.ts) to guarantee each file is <= 500 lines.

Write your handoff report to C:\Software\conex\.agents\teamwork_preview_worker_m0_rev\handoff.md following Handoff Protocol.
Send message back to parent e1c690d8-01bb-4ac5-885d-8f4fddaf38af with summary of updates and path to handoff.md when done.
