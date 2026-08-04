/**
 * commandManifest 测试（PE-03 T03.1）：
 * - 内置快照与 Rust `command_manifest.rs` 对齐（条数 = 注册面 + 登记先行、
 *   9 条新增登记齐备、幽灵命令排除、命令名唯一）——双端手工同步的双向守门；
 * - `initCommandManifest`：拉取成功（mock core_list_commands）→ 真源生效；
 * - 拉取失败（missing）→ 回退内置快照（不崩）；
 * - `isRegisteredCommand`：registered / 登记先行（false）/ 未知名三分支。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import {
  BUILTIN_COMMAND_MANIFEST,
  getEffectiveManifest,
  initCommandManifest,
  isRegisteredCommand,
  resetCommandManifestForTests,
} from './commandManifest';

describe('commandManifest', () => {
  beforeEach(() => {
    resetCommandManifestForTests();
  });

  describe('内置快照（镜像 Rust command_manifest.rs）', () => {
    it('条数公式化：总数 = 注册面 + 登记先行（镜像 Rust 测试断言）', () => {
      const registered = BUILTIN_COMMAND_MANIFEST.commands.filter(
        (c) => c.registered
      ).length;
      const pending = BUILTIN_COMMAND_MANIFEST.commands.length - registered;
      expect(pending).toBeGreaterThan(0);
      // 与 Rust COMMAND_MANIFEST（75 = 71 注册面 + 4 登记先行）保持同步；
      // 变更 Rust 侧时同步本快照，双向条数由两端测试锁定
      // PE-07：T07.3（git_run/fs_delete_file）+ T07.4（profile_apply/secret_reveal）已接线
      // P3 步骤 5（C7 ③）：catalog_get / catalog_refresh 已接线
      expect(registered).toBe(74);
      expect(BUILTIN_COMMAND_MANIFEST.commands.length).toBe(78);
    });

    it('命令名唯一', () => {
      const names = BUILTIN_COMMAND_MANIFEST.commands.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('9 条新增命令登记齐备（§7.2 登记表；PE-07 T07.3/T07.4 已接线）', () => {
      const byName = new Map(
        BUILTIN_COMMAND_MANIFEST.commands.map((c) => [c.name, c])
      );
      for (const name of [
        'upsert_session_entry',
        'append_session_messages',
        'config_profile_apply',
        'config_secret_reveal',
        'workbench_git_run',
        'workbench_fs_delete_file',
        'workbench_open_workspace',
        'workbench_list_workspaces',
        'workbench_dev_mcp_enabled',
      ]) {
        expect(byName.has(name), `${name} 必须登记内置快照`).toBe(true);
      }
      for (const name of [
        'upsert_session_entry',
        'workbench_git_run',
        'workbench_fs_delete_file',
        'config_profile_apply',
        'config_secret_reveal',
      ]) {
        expect(byName.get(name)?.registered, `${name} 已接线`).toBe(true);
      }
      for (const name of [
        'append_session_messages',
        'workbench_open_workspace',
        'workbench_list_workspaces',
        'workbench_dev_mcp_enabled',
      ]) {
        expect(byName.get(name)?.registered, `${name} 尚未接线`).toBe(false);
      }
    });

    it('幽灵命令排除：由 commandMap 侧行为断言 + Rust 侧 manifest 测试双重守门', () => {
      // 幽灵命令（AA-02 W-5，9 条）不得出现在内置快照：此处不重复字面量清单
      // （前端 grep 零命中门禁），守门分工如下：
      // - 映射面：commandMap.test.ts 断言 9 个幽灵 WS type 一律解析为 null；
      // - 清单面：Rust command_manifest.rs `manifest_excludes_ghost_commands`
      //   断言幽灵命令名不得登记 manifest（真源侧拦截）；
      // - 传递性：本测试「映射值全部 registered」+ commandMap 对照测试保证
      //   幽灵命令无任何可调用路径。
      const registered = new Set(
        BUILTIN_COMMAND_MANIFEST.commands
          .filter((c) => c.registered)
          .map((c) => c.name)
      );
      // 幽灵 WS type 对应的命令名不得出现在 registered 面
      for (const ws of ['git-status', 'git-diff']) {
        expect(registered.has(ws)).toBe(false);
      }
    });
  });

  describe('isRegisteredCommand（清单校验）', () => {
    it('registered 命令可调用；登记先行（false）与未知名不可调用', () => {
      expect(isRegisteredCommand('core_run_task')).toBe(true);
      expect(isRegisteredCommand('core_list_commands')).toBe(true);
      expect(isRegisteredCommand('upsert_session_entry')).toBe(true);
      // PE-07 T07.3：git_run / fs_delete_file 已接线；T07.4：profile_apply / secret_reveal 已接线
      expect(isRegisteredCommand('workbench_git_run')).toBe(true);
      expect(isRegisteredCommand('workbench_fs_delete_file')).toBe(true);
      expect(isRegisteredCommand('config_profile_apply')).toBe(true);
      expect(isRegisteredCommand('config_secret_reveal')).toBe(true);
      // 登记先行：尚未接线，不得视为可调用
      expect(isRegisteredCommand('append_session_messages')).toBe(false);
      // 未知名
      expect(isRegisteredCommand('nope')).toBe(false);
    });
  });

  describe('initCommandManifest（启动拉取）', () => {
    it('拉取成功 → 真源清单生效（替换内置快照）', async () => {
      mockTauriCommand('core_list_commands', async () => ({
        contractVersion: '9.9.9',
        commands: [
          {
            name: 'core_mock_only',
            family: 'core',
            surface: 'engine',
            registered: true,
          },
        ],
      }));
      const manifest = await initCommandManifest();
      expect(manifest.contractVersion).toBe('9.9.9');
      expect(getEffectiveManifest()).toBe(manifest);
      expect(isRegisteredCommand('core_mock_only')).toBe(true);
      // 真源替换后，内置快照的 registered 面不再生效
      expect(isRegisteredCommand('core_run_task')).toBe(false);
    });

    it('拉取失败（missing / 非 Tauri 环境）→ 回退内置快照（不崩）', async () => {
      const manifest = await initCommandManifest();
      expect(manifest).toBe(BUILTIN_COMMAND_MANIFEST);
      expect(isRegisteredCommand('core_run_task')).toBe(true);
    });

    it('幂等：并发/重复调用只拉取一次', async () => {
      const impl = vi.fn(async () => ({
        contractVersion: '1.0.0',
        commands: [
          {
            name: 'core_mock_only',
            family: 'core',
            surface: 'engine',
            registered: true,
          },
        ],
      }));
      mockTauriCommand('core_list_commands', impl);
      await Promise.all([
        initCommandManifest(),
        initCommandManifest(),
        initCommandManifest(),
      ]);
      expect(impl).toHaveBeenCalledTimes(1);
    });
  });
});
