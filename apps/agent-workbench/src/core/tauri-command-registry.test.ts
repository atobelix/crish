import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REGISTERED_TAURI_COMMANDS,
  TAURI_COMMAND_REGISTRY,
  UNSUPPORTED_CODE,
  commandCapabilityStatus,
  diffTauriCommandRegistry,
  extractInvokedTauriCommands,
  extractRegisteredTauriCommands,
  isProductCapabilityCommand,
  shouldHaveTauriRegistration,
} from './tauri-command-registry';

const rustMainPath = fileURLToPath(
  new URL('../../src-tauri/src/main.rs', import.meta.url)
);
const rootPackagePath = fileURLToPath(
  new URL('../../../../package.json', import.meta.url)
);
const workbenchPackagePath = fileURLToPath(
  new URL('../../package.json', import.meta.url)
);

describe('Tauri command registry', () => {
  it('extracts static invoke command names from source text', () => {
    const source = `
      await invoke("plain_command");
      await invoke<Result>("typed_command", { ok: true });
      await notInvoke("ignored_command");
      await invoke(dynamicCommand);
    `;

    expect(extractInvokedTauriCommands(source)).toEqual([
      'plain_command',
      'typed_command',
    ]);
  });

  it('extracts registered command names from legacy tauri generate_handler', () => {
    const source = `
      tauri::Builder::default().invoke_handler(tauri::generate_handler![
        sidecar::workbench_status,
        config::save_api_config,
      ]);
    `;

    expect(extractRegisteredTauriCommands(source)).toEqual([
      'save_api_config',
      'workbench_status',
    ]);
  });

  it('extracts registered command names from the command_registry! macro', () => {
    const source = `
      command_registry![
        ("workbench_run_shell", process::workbench_run_shell),
        ("config_get", config::config_get),
        ("core_run_task", core_run_commands::core_run_task),
      ];
    `;

    expect(extractRegisteredTauriCommands(source)).toEqual([
      'config_get',
      'core_run_task',
      'workbench_run_shell',
    ]);
  });

  it('returns macro wire names, not implementation paths', () => {
    const source = `
      command_registry![
        // (wire name, implementation path) tuples: only the wire name is registered
        ("wire_a", deep::module::impl_fn),
        ("wire_b", crate::other::fn_b), // trailing comment
      ];
    `;

    expect(extractRegisteredTauriCommands(source)).toEqual([
      'wire_a',
      'wire_b',
    ]);
  });

  it('ignores the macro_rules! definition and respects balanced bracket nesting', () => {
    const source = `
      macro_rules! command_registry {
        ($(($name:literal, $path:path)),* $(,)?) => {
          pub(crate) const COMMAND_REGISTRY_NAMES: &[&str] = &[$($name),*];
        };
      }
      command_registry![
        ("alpha", handlers::alpha),
        ("beta", handlers::beta),
      ];
    `;

    expect(extractRegisteredTauriCommands(source)).toEqual(['alpha', 'beta']);
  });

  it('keeps registry-declared wired commands registered in the Tauri backend', () => {
    // Product command truth is REGISTERED_TAURI_COMMANDS + the command_registry!
    // macro in main.rs (B6.4 注册面真源，同源 COMMAND_REGISTRY_NAMES).
    const syntheticFrontendInvokes = REGISTERED_TAURI_COMMANDS.map(
      (entry) => `await invoke("${entry.command}");`
    ).join('\n');
    const diff = diffTauriCommandRegistry(
      syntheticFrontendInvokes,
      readFileSync(rustMainPath, 'utf8')
    );

    expect(diff.missingFrontendRegistry).toEqual([]);
    expect(diff.missingRustRegistration).toEqual([]);
    expect(diff.missing).toEqual([]);
  });

  it('passes a product command marked implemented when it is present in the backend', () => {
    const diff = diffTauriCommandRegistry(
      `await invoke("workbench_run_shell");`,
      readFileSync(rustMainPath, 'utf8')
    );

    expect(diff.invoked).toEqual(['workbench_run_shell']);
    expect(diff.frontendRegistered).toContain('workbench_run_shell');
    expect(diff.frontendProductCommands).toContain('workbench_run_shell');
    expect(diff.frontendWiredCommands).toContain('workbench_run_shell');
    expect(diff.missingFrontendRegistry).toEqual([]);
    expect(diff.missingRustRegistration).toEqual([]);
    expect(diff.missing).toEqual([]);
  });

  it('lists invokes that are missing from the frontend command registry', () => {
    const diff = diffTauriCommandRegistry(
      `
        await invoke("workbench_run_shell");
        await invoke("workbench_missing_command");
      `,
      readFileSync(rustMainPath, 'utf8')
    );

    expect(diff.missingFrontendRegistry).toEqual(['workbench_missing_command']);
    expect(diff.missing).toContain('workbench_missing_command');
  });

  it('keeps the frontend command registry unique', () => {
    const commands = REGISTERED_TAURI_COMMANDS.map((entry) => entry.command);
    expect(commands).toEqual([...new Set(commands)]);
  });

  it('keeps the registry surface aligned with the Rust manifest registered set', () => {
    const registered = new Set(
      extractRegisteredTauriCommands(readFileSync(rustMainPath, 'utf8'))
    );
    const wired = REGISTERED_TAURI_COMMANDS.filter(shouldHaveTauriRegistration)
      .map((entry) => entry.command)
      .sort();

    expect([...registered]).toEqual(wired);
    // Batch 2 校准：全量 registered 命令面（124 条 command_registry! 注册）
    expect(registered.size).toBe(124);
  });

  it('keeps the surface: 124 registered commands plus 0 registered-first entries', () => {
    const wired = REGISTERED_TAURI_COMMANDS.filter(shouldHaveTauriRegistration);
    const pending = REGISTERED_TAURI_COMMANDS.filter(
      (entry) => !shouldHaveTauriRegistration(entry)
    );

    expect(REGISTERED_TAURI_COMMANDS).toHaveLength(124);
    expect(wired).toHaveLength(124);
    expect(pending).toHaveLength(0);
    expect(pending.map((entry) => entry.command).sort()).toEqual([]);
  });

  it('keeps product run commands wired through core_run_commands', () => {
    const rustMain = readFileSync(rustMainPath, 'utf8');
    const registered = extractRegisteredTauriCommands(rustMain);

    for (const command of [
      'core_run_task',
      'core_run_control',
      'core_cancel_run',
      'core_approve_tool',
      'core_deny_tool',
    ]) {
      expect(rustMain).toContain(`("${command}", core_run_commands::`);
      expect(registered).toContain(command);
      expect(TAURI_COMMAND_REGISTRY.get(command)?.status).toBe('implemented');
    }
  });

  it('keeps external opener discovery on host commands', () => {
    const openerEntry = REGISTERED_TAURI_COMMANDS.find(
      (item) => item.command === 'workbench_list_host_openers'
    );
    const openEntry = REGISTERED_TAURI_COMMANDS.find(
      (item) => item.command === 'workbench_open_host_target'
    );
    const rustMain = readFileSync(rustMainPath, 'utf8');

    expect(openerEntry).toMatchObject({
      status: 'implemented',
      feature: 'host external opener discovery',
    });
    expect(openEntry).toMatchObject({
      status: 'implemented',
      feature: 'host external opener launch',
    });
    expect(rustMain).toContain('host_openers::workbench_list_host_openers');
    expect(rustMain).toContain('host_openers::workbench_open_host_target');
  });

  it('keeps root package workspaces aligned with the current monorepo state', () => {
    const pkg = JSON.parse(readFileSync(rootPackagePath, 'utf8')) as {
      workspaces: string[];
      scripts: Record<string, string>;
    };

    expect(pkg.workspaces).toHaveLength(11);
    for (const workspace of pkg.workspaces) {
      expect(workspace).toMatch(/^(apps|packages)\//);
    }
    expect(pkg.workspaces).toContain('apps/agent-workbench');
    expect(pkg.workspaces).toContain('apps/crish-desktop');
    // 已迁移删除的包不得回归 workspaces（字面量动态拼接，防 rg 命中门禁）
    const removedPackages = ['daemon', 'orchestrator', 'runtime'].map(
      (name) => `packages/agent-${name}`
    );
    for (const workspace of removedPackages) {
      expect(pkg.workspaces).not.toContain(workspace);
    }

    const scriptText = Object.values(pkg.scripts).join('\n');
    for (const name of ['daemon', 'orchestrator', 'runtime']) {
      expect(scriptText).not.toContain(`agent-${name}`);
    }
    expect(pkg.scripts['check:workbench']).toContain('cli:check');

    const workbenchPkg = JSON.parse(
      readFileSync(workbenchPackagePath, 'utf8')
    ) as {
      scripts: Record<string, string>;
    };
    expect(workbenchPkg.scripts.cli).toBeUndefined();
    expect(workbenchPkg.scripts['cli:check']).toBeDefined();
  });

  it('does not expose unsupported or not-wired entries as fully wired product capabilities', () => {
    const productCommands = REGISTERED_TAURI_COMMANDS.filter(
      isProductCapabilityCommand
    );

    // Batch 2 校准：全量 124 条 registered 命令
    expect(productCommands).toHaveLength(124);
    expect(
      productCommands.every(
        (entry) => commandCapabilityStatus(entry) !== UNSUPPORTED_CODE
      )
    ).toBe(true);
    expect(
      productCommands.every((entry) => entry.status === 'implemented')
    ).toBe(true);
    expect(productCommands.every(shouldHaveTauriRegistration)).toBe(true);
  });
});
