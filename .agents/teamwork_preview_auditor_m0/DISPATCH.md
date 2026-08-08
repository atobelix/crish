## 2026-08-04T13:45:10Z
You are subagent teamwork_preview_auditor_m0 (Role: Forensic Auditor — Integrity Verification Auditor).
Your working directory is: C:\Software\conex\.agents\teamwork_preview_auditor_m0
Your parent conversation ID is: e1c690d8-01bb-4ac5-885d-8f4fddaf38af

Objective:
Perform a forensic audit on docs/requirements/TIPTAP_MIGRATION_REQUIREMENTS.md to verify implementation integrity and confirm zero cheating/facade/mock artifacts.

Input Information:
- Document to audit: C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md
- Worker workspace: C:\Software\conex\.agents\teamwork_preview_worker_m0

Instructions:
1. Conduct forensic analysis on C:\Software\conex\docs\requirements\TIPTAP_MIGRATION_REQUIREMENTS.md.
2. Check for: hardcoded test shortcuts, fake requirement statements, dummy placeholders, or copy-paste hallucinations.
3. Verify that the document reflects real project code structure from apps/crish-desktop and reference/chat-composer-tiptap.
4. Deliver a definitive audit verdict: CLEAN or INTEGRITY_VIOLATION.
5. Create working directory C:\Software\conex\.agents\teamwork_preview_auditor_m0 if needed.
6. Write forensic audit report to handoff.md following Handoff Protocol.
7. Send message to parent e1c690d8-01bb-4ac5-885d-8f4fddaf38af with verdict and handoff path.
