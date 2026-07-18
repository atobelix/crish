# Contributing to Crish

Thank you for your interest in contributing to Crish! We welcome contributions of all kinds, including bug reports, feature requests, documentation improvements, and code changes.

## Development Workflow

Crish is a monorepo structured as follows:
- `apps/crish-desktop`: React 19 + Zustand desktop UI.
- `apps/agent-workbench`: Tauri shell wrapping the desktop UI.
- `packages/agent-daemon`: Daemon process handling sessions, configuration, and WebSocket APIs.
- `packages/agent-orchestrator`: Session lifecycle, events, and execution orchestration.
- `packages/agent-runtime`: LLM integration, tools, permissions, and runtime context.

### Prerequisites

You will need the following tools installed locally:
- Node.js (v18+)
- Rust & Cargo (latest stable)

### Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/conex-community/crish.git
   cd crish
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the development environment:
   ```bash
   # Start React UI development server
   npm run dev:desktop

   # Start Tauri workbench shell with UI
   npm run dev:workbench

   # Start the daemon directly for debugging
   npm run daemon
   ```

### Code Style & Guidelines

- **TypeScript**: We use strict TypeScript. Ensure your code passes typecheck:
  ```bash
  npm run check:core
  ```
- **Rust**: Ensure Rust code is formatted and passes clippy.
- **Commit Messages**: Write clear, descriptive commit messages.

## Submitting Pull Requests

1. Fork the repository and create your branch from `main`.
2. If you've added code that should be tested, add tests!
3. Ensure the test suite passes:
   ```bash
   npm run test
   ```
4. Submit a pull request to the main repository.

## Community

If you have questions or want to discuss design changes, feel free to open a GitHub Issue or join our discussions.
