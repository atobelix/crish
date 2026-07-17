# Daemon Protocol Single Source

Date: 2026-06-09

Scope: daemon WebSocket protocol types, schema validators, message registry, capability registry, and Workbench/Tauri bridge contract tests.

## Current Guardrails

`packages/agent-daemon/src/protocol/schema.ts` is still the validator implementation file, but it is no longer an independent message map:

- `INBOUND_MESSAGE_TYPES` and `OUTBOUND_MESSAGE_TYPES` are re-exported from `protocol/registry.ts`.
- `DAEMON_INBOUND_MESSAGE_TYPES` and `DAEMON_OUTBOUND_MESSAGE_TYPES` are compile-time checked against `DaemonInboundMessage["type"]` and `DaemonOutboundMessage["type"]`.
- `DAEMON_INBOUND_MESSAGE_REGISTRY` and `DAEMON_OUTBOUND_MESSAGE_REGISTRY` attach each wire message type to a protocol capability and state.
- `protocol/schema-groups.ts` groups every registered message by capability.
- `protocol/registry.test.ts` verifies message type allowlists, handler switch cases, inbound validators, outbound validators, capability groups, and minimal valid samples stay aligned.
- Workbench contract tests already protect important projections: status/provider snapshots, task snapshots, conversation rewind responses, and session action availability.

The remaining problem is file shape, not only coverage: `schema.ts` is large enough that validators, wire types, and UI projections are easy to edit in separate places without noticing the architectural boundary.

## Split Plan

Keep one public registry and split implementation files under it. The registry remains the only place where a new message type is admitted.

Recommended shape:

- `protocol/registry.ts`: message type arrays, message-to-capability registry, and stable exported helper functions for lookup.
- `protocol/schema.ts`: thin public facade that exports `validateInboundMessage`, `validateOutboundMessage`, `encodeOutboundMessage`, and shared validation types.
- `protocol/validators/base.ts`: common JSON/object/string/enum/correlation helpers.
- `protocol/validators/inbound.ts`: inbound dispatcher generated from or keyed by the registry.
- `protocol/validators/outbound.ts`: outbound dispatcher generated from or keyed by the registry.
- `protocol/validators/session.ts`: session listing, event replay, and `apply-session-action` validation.
- `protocol/validators/workflow.ts`: workflow definition/run validators.
- `protocol/validators/status.ts`: daemon status, lifecycle, MCP, metrics, and capability snapshot validators.
- `protocol/validators/provider.ts`: provider readiness, account-center, gateway, key-source, and provider diagnostics validators.
- `protocol/validators/rewind.ts`: conversation rewind boundary, preview, apply, plan, and step-result validators.

Rules for the split:

- Do not create per-file message type arrays. Domain files export validator maps keyed with `satisfies Partial<Record<DaemonInboundMessageType | DaemonOutboundMessageType, Validator>>`.
- The top-level inbound/outbound dispatchers compose domain maps and assert the composed key set equals the registry key set in tests.
- Shared helper validators move first; message validators move by capability group only when tests already cover that group.
- `schema.ts` should keep compatibility exports during the migration so callers do not change in the same step as the split.

## Shared Protocol Package Boundary

Move wire-level protocol material into a shared protocol package only when both daemon and Workbench/Tauri need the same contract:

- Include daemon inbound/outbound message unions and discriminant strings.
- Include `ProtocolValidationResult`, error codes, validator entry points, and encode/decode helpers.
- Include capability snapshot wire types and message-to-capability registry metadata.
- Include status/provider/MCP/session/run/rewind wire snapshots that are daemon-owned facts.
- Include session action wire contracts already shared through `@crish/shared-types`, or re-export them from the protocol package if that reduces imports.

Keep Workbench view models out of daemon protocol:

- Do not move pane layout, split view state, selected tab/message IDs, local pending overlays, menu availability text, or UI grouping into daemon protocol.
- Do not move `WorkbenchProviderConfigSnapshot` as a daemon fact; daemon owns provider status, Workbench owns how that status is displayed and edited.
- Do not treat unsupported UI actions like fork or withdraw as daemon wire commands until the daemon has durable facts and receipts for them.
- Do not make Tauri command names the protocol. Tauri commands are a bridge surface that can reference protocol messages and capabilities.

## One Registry For Runtime And Bridge Checks

The desired dependency direction is:

`protocol registry -> schema validators -> daemon handler switch -> capability registry -> Workbench/Tauri bridge tests`

Concrete next steps:

- Handler switch tests should continue reading `server-handlers.ts`, but expected cases must come from `DAEMON_INBOUND_MESSAGE_TYPES`.
- Schema validator tests should continue comparing dispatcher `case` labels or validator-map keys to `DAEMON_*_MESSAGE_TYPES`.
- Capability definitions should derive or validate `relatedMessageTypes` against `DAEMON_INBOUND_MESSAGE_REGISTRY` and `DAEMON_OUTBOUND_MESSAGE_REGISTRY`, rather than carrying unverified strings.
- Tauri bridge registry tests should compare daemon capability `relatedTauriCommands` with `REGISTERED_TAURI_COMMANDS`, while still allowing explicit `unsupported`, `backend-not-wired`, and `developer-diagnostics` entries.
- Workbench contract tests should import shared protocol guards for daemon-owned shapes, then keep projection-specific assertions in `workbench-contract.test.ts`.

This keeps new protocol work honest: adding a message requires a type, registry entry, capability group, validator, handler or explicit unsupported state, capability exposure, and bridge test coverage where applicable.

## Review Notes

No large refactor is needed before the next split. The registry tests already cover the most important drift points. The most valuable small guard to add later is a capability/bridge cross-check: every daemon capability `relatedMessageTypes` must be registered, and every `relatedTauriCommands` entry must exist in the Workbench Tauri command registry or be explicitly allowlisted.
