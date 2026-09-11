# HOTFIX-1: run-task clientMessageId / assistantClientMessageId

**Date:** 2026-07-29
**Status:** fixed
**Blocks:** live MCP chat send (W10-MCP-1 / E0-4)

## Symptom

Daemon rejected desktop `run-task`:

```
Invalid run-task message: $.clientMessageId: Unexpected field;
$.assistantClientMessageId: Unexpected field
```

## Root cause

Desktop W7-6 sends optional `clientMessageId` + `assistantClientMessageId` on `run-task` for hydrate rekey.

- **Types** (`protocol-inbound-run.ts`) and **handlers** (`run-handler.ts`, `admission-control.ts`) already accepted/stamped these fields.
- **Validators** still used a closed allowlist (`RUN_TASK_FIELDS`) without them, so `rejectUnknownFields` failed before handlers ran.
- Validator pass-through also omitted the fields from the parsed value.

## Fix (minimal)

| File | Change |
|------|--------|
| `packages/agent-daemon/src/protocol/validators/common-fields-msg.ts` | Add both fields to `RUN_TASK_FIELDS` |
| `packages/agent-daemon/src/protocol/validators/run.ts` | Optional non-empty parse + include in `ok()` value |
| `packages/agent-daemon/src/protocol/registry.test.ts` | Valid run-task with both fields; empty strings rejected |

No desktop field-name changes. No feature expansion.

## Tests

- `registry.test.ts`: `accepts optional clientMessageId + assistantClientMessageId on run-task`

## Residual

- Running daemon process must reload this package (restart / rebuild) for live MCP send to work.
- Empty-string IDs are rejected (`nonEmpty: true`); desktop already trims and omits blanks.
