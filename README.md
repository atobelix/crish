# Crish

Crish is a product-grade local agent Workbench built around one backend execution path:

```text
Workbench / Tauri -> agent-daemon -> AgentOrchestrator -> AgentRuntime
```

The project is moving away from prototype UI and CLI-only flows. New product work should land on the daemon-backed path first, with the Workbench consuming daemon snapshots, events, diagnostics, approvals, plans, workflows, and provider status as the source of truth.

## Current Product Path

- `apps/agent-workbench`: the supported desktop Workbench and Tauri host.
- `packages/agent-daemon`: the long-running backend service for sessions, runs, workflows, provider configuration, metrics, plan documents, approvals, and capability snapshots.
- `packages/agent-orchestrator`: the run/session lifecycle core, including durable events, restart recovery, goal runs, and conversation rewind planning.
- `packages/agent-runtime`: the model/tool execution kernel, including tools, permissions, context compression, prompt assembly, checkpoints, metrics, MCP/LSP foundations, and workspace mutation coordination.

## Legacy Surfaces

- `apps/web-ui` is a frozen prototype kept only as historical reference. It is not the supported product path.
- `apps/agent-workbench/src/ui` is legacy CLI/dev reference material only. The Tauri product build should use `src/styles` and Preact components, not root `src/ui` assets.
- Legacy CLI helpers may remain for development or debugging, but they should not define user-facing product behavior.
- Unsupported or experimental Workbench features must report typed diagnostics instead of returning silent empty data.

## Architecture Principles

- Keep one execution path. Do not add parallel runtime, provider, session, or UI state sources.
- Treat sessions, runs, events, plans, approvals, artifacts, checkpoints, and rewind boundaries as backend product concepts.
- Prefer append-only durable logs, typed status snapshots, and replayable projections over frontend-only state reconstruction.
- Use Git as the workspace versioning substrate while Crish owns user-facing checkpoint, restore, diff, and rewind policy.
- Keep provider setup simple for users: account-center backed usage should be the default path, direct API keys should remain an advanced path, and secrets must stay redacted.
- Keep prompt assembly cache-friendly: stable rules, skills, project progress, tool schemas, and summaries should precede volatile user turns and tool outputs.

## Development Commands

Install dependencies:

```bash
npm install
```

Run the Workbench frontend:

```bash
npm run dev:workbench
```

Run the daemon in development:

```bash
npm run daemon
```

Run the legacy CLI diagnostic path explicitly:

```bash
npm run dev:cli
```

Run type checks:

```bash
npm run check:core
```

Run core tests:

```bash
npm run test:core
```

Build the Workbench:

```bash
npm run build:workbench
```

## Engineering Notes

- Use `DEVELOPMENT_LOG.md` as the living architecture and progress log.
- Read reference projects for ideas only; do not copy their code or create duplicate compatibility lanes.
- When editing files that contain Chinese text, use the local `chinese-encoding-guard` workflow and verify after writing.

## License

MIT
