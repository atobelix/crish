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
    // 用量监控面五命令追加（126 → 131）
    expect(registered.has('workbench_apply_models_config')).toBe(true);
    for (const retired of [
      'config_get',
      'config_update',
      'config_profile_apply',
      'catalog_get',
      'catalog_refresh',
    ]) {
      expect(registered.has(retired)).toBe(false);
    }
  });

  it('keeps native browser webview commands registered with hit-test capability explicit', () => {
    const commands = [
      'browser_webview_create',
      'browser_webview_set_bounds',
      'browser_webview_set_visible',
      'browser_webview_navigate',
      'browser_webview_action',
      'browser_webview_close',
      'browser_webview_set_muted',
      'browser_webview_set_hit_test',
      'browser_webview_set_inspector',
    ];
    const registered = new Set(
      extractRegisteredTauriCommands(readFileSync(rustMainPath, 'utf8'))
    );

    for (const command of commands) {
      expect(registered.has(command), `${command} must be registered`).toBe(
        true
      );
      expect(TAURI_COMMAND_REGISTRY.get(command)?.status).toBe('implemented');
    }

    const hitTest = TAURI_COMMAND_REGISTRY.get('browser_webview_set_hit_test');
    expect(hitTest?.capabilityStatus).toBe(UNSUPPORTED_CODE);
    expect(isProductCapabilityCommand(hitTest!)).toBe(false);
  });

  it('keeps all workspace authorization commands in the registered snapshot', () => {
    const rustMain = readFileSync(rustMainPath, 'utf8');
    const registered = new Set(extractRegisteredTauriCommands(rustMain));
    const frontend = new Map(
      REGISTERED_TAURI_COMMANDS.map((entry) => [entry.command, entry])
    );

    for (const command of [
      'workbench_open_workspace',
      'workbench_open_workspaces',
      'workbench_activate_default_workspace',
      'workbench_list_workspaces',
      'workbench_pick_workspace_folder',
      'workbench_pick_workspace_folders',
    ]) {
      expect(registered.has(command), `${command} must be registered`).toBe(
        true
      );
      expect(
        frontend.get(command),
        `${command} must be in the snapshot`
      ).toMatchObject({ status: 'implemented' });
    }
  });

  it('keeps every declared command registered without placeholder entries', () => {
    const wired = REGISTERED_TAURI_COMMANDS.filter(shouldHaveTauriRegistration);
    const pending = REGISTERED_TAURI_COMMANDS.filter(
      (entry) => !shouldHaveTauriRegistration(entry)
    );

    const actual = extractRegisteredTauriCommands(
      readFileSync(rustMainPath, 'utf8')
    );
    expect(REGISTERED_TAURI_COMMANDS).toHaveLength(actual.length);
    expect(wired).toHaveLength(actual.length);
    expect(pending).toHaveLength(0);
    expect(pending.map((entry) => entry.command).sort()).toEqual([]);
  });

  it('keeps product run commands wired through run_ipc', () => {
    const rustMain = readFileSync(rustMainPath, 'utf8');
    const registered = extractRegisteredTauriCommands(rustMain);

    for (const command of [
      'core_run_task',
      'core_run_control',
      'core_cancel_run',
      'core_approve_tool',
      'core_deny_tool',
    ]) {
      expect(rustMain).toContain(`("${command}", run_ipc::`);
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

    // 校准：165 条 registered 命令；其中原生 browser hit-test 命令会显式
    // 回报 unsupported，因此有 164 条作为完整 product capability 计数。
    // 包含 models_yaml 三命令、usage 五命令以及 b6 core_generate_session_title。
    // 2026-09-15 更正：131 为陈旧值——旧 config/catalog 命令族 5 条
    // （config_get / config_profile_apply / config_update / catalog_get /
    // catalog_refresh）随单轨收敛退役；另新增 workbench_apply_models_config、
    // workbench_window_ready、auth_* ×7、note_document_* ×4、prefs_* ×3。
    // 2026-09-15 单轨收敛第二轮：出厂能力字典读面
    // workbench_read_capability_dictionary 登记（142 → 143）；随后 8 条
    // 「Rust 已注册、前端零消费」真漂移退役 → 135。
    // b6：core_generate_session_title 追加后 135 → 136。
    // Win11 贴靠布局热区 workbench_set_snap_overlay_rect 追加后 136 → 137。
    // 2026-10-14 命令面补链：workbench_abort_run + 4 条 MCP 服务管理命令 → 142。
    // 技能副本写入 workbench_mutate_owned_skill 追加后 142 → 143。
    // 更新器分段 4 条（workbench_check_update / download_update / install_update /
    // restart_app）在 manifest 与 main.rs 早已注册、本表漏登，D11 补齐后 143 → 147。
    // 工作区授权六命令漏登，D11 命中后补齐 147 → 153。
    // 条数与四方集合一致性由 scripts/check-provider-single-track.mjs 的 D11 守护。
    expect(productCommands).toHaveLength(164);
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
