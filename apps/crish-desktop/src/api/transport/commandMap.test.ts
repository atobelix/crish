// @vitest-environment jsdom
/**
 * commandMap 集中命令名清单测试（T18 终态：WS 双命名空间已删除）：
 * - 纯命令名直传：命令名 ∈ 清单 registered 面 → 原样放行；清单外一律 null；
 * - WS 时代 type（get-status / update-config / approve-tool …）一律 null（显式 missing）；
 * - 幽灵条目 9 条已删除（AA-02 W-5）：对应 WS type 一律解析为 null（显式 missing）；
 * - ③ 类调用点已清零（PE-03 T03.7）：无映射、无调用方，一律 null；
 * - 白名单对照：COMMAND_NAME_ALLOWLIST 每条都在内置清单 registered 内；
 * - mock 清单对照：注入自定义清单验证「命令名不在清单 → null」；
 * - checkCommandMapConsistency：白名单内命令名不在清单 → console.warn（不崩）；
 * - Tauri 路径 payload 整形（键为命令名 config_update；rewind 幽灵整形已删除）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkCommandMapConsistency,
  COMMAND_NAME_ALLOWLIST,
  resolveTauriCommand,
  shapeTauriPayload,
} from './commandMap';
import {
  BUILTIN_COMMAND_MANIFEST,
  resetCommandManifestForTests,
  type CommandManifest,
} from './commandManifest';
import { logger } from '../../services/LoggerService';

/** 构造最小 mock 清单（registered 名集合自定，模拟 Rust 真源不同注册面） */
function makeManifest(commands: Array<[string, boolean]>): CommandManifest {
  return {
    contractVersion: '1.0.0',
    commands: commands.map(([name, registered]) => ({
      name,
      family: 'test',
      surface: 'engine',
      registered,
    })),
  };
}

describe('commandMap', () => {
  beforeEach(() => {
    resetCommandManifestForTests();
  });

  describe('resolveTauriCommand', () => {
    it('命令名直放行（清单 registered 内，取代前缀正则 / RUN_LIFECYCLE_COMMANDS 白名单）', () => {
      // 查询类
      expect(resolveTauriCommand('core_get_status')).toBe('core_get_status');
      // F-03（DM-07）：core_read_run_events 恢复激活（与 Rust command_manifest 120 注册面对齐）
      expect(resolveTauriCommand('core_read_run_events')).toBe(
        'core_read_run_events'
      );
      expect(resolveTauriCommand('core_read_session_events')).toBe(
        'core_read_session_events'
      );
      // 审批类
      expect(resolveTauriCommand('core_approve_tool')).toBe(
        'core_approve_tool'
      );
      expect(resolveTauriCommand('core_deny_tool')).toBe('core_deny_tool');
      // 壳命令（F5 终态名）
      expect(resolveTauriCommand('config_update')).toBe('config_update');
      expect(resolveTauriCommand('list_sessions')).toBe('list_sessions');
      // run 生命周期：清单校验放行
      expect(resolveTauriCommand('core_run_task')).toBe('core_run_task');
      expect(resolveTauriCommand('core_run_control')).toBe('core_run_control');
      // 其他注册面命令名直放行
      expect(resolveTauriCommand('core_list_commands')).toBe(
        'core_list_commands'
      );
      expect(resolveTauriCommand('workbench_pty_create')).toBe(
        'workbench_pty_create'
      );
    });

    it('WS 时代 type 已删除（T18）：一律 null（显式 missing，不再有映射层）', () => {
      for (const t of [
        'get-status',
        'get-run-snapshot',
        'read-run-events',
        'read-session-events',
        'approve-tool',
        'deny-tool',
        'update-config',
        'list-sessions',
      ]) {
        expect(resolveTauriCommand(t), t).toBeNull();
      }
    });

    it('幽灵条目已删除（AA-02 W-5，9 条）：对应 WS type 一律 null', () => {
      for (const t of [
        'git-status',
        'git-diff',
        'list-mcp-servers',
        'start-mcp-server',
        'stop-mcp-server',
        'preview-conversation-rewind',
        'apply-conversation-rewind',
        'send-to-subagent',
        'get-subagent-status',
      ]) {
        expect(resolveTauriCommand(t), t).toBeNull();
      }
    });

    it('③ 类调用点已清零（PE-03 T03.7 修正：F9 workflow 实装后六条转为 registered）：cron / scoped-context / probe / sync 无映射，解析 null（显式 missing）；workflow 六条为 F9 真实命令，不再在此清单', () => {
      // T03.7 裁决 + F9 修正：workflow 六条命令于 F9（T-CF-14）实装为
      // registered Tauri 命令（command_manifest 88=84+4）——原 T03.7 的
      // "workflow 无映射" 断言在实装后过时，移出 null 清单（见 :99 旁
      // 白名单断言覆盖 registered 解析）；其余 type 无 transport.request
      // 调用方，此处仅断言清单校验下的显式 missing（不静默兜底）。
      for (const t of [
        'cron.list_tasks',
        'cron.upsert_task',
        'cron.delete_task',
        'list-capabilities',
        'probe-provider-models',
        'probe-provider-chat',
        'upsert-scoped-context',
        'delete-scoped-context',
        'sync-pull',
        'sync-push',
      ]) {
        expect(resolveTauriCommand(t), t).toBeNull();
      }
    });

    it('白名单无遗漏：每个命令名都在内置清单 registered 内且可解析', () => {
      const registered = new Set(
        BUILTIN_COMMAND_MANIFEST.commands
          .filter((c) => c.registered)
          .map((c) => c.name)
      );
      for (const cmd of COMMAND_NAME_ALLOWLIST) {
        expect(registered.has(cmd), `${cmd} 必须在内置清单 registered 内`).toBe(
          true
        );
        expect(resolveTauriCommand(cmd), cmd).toBe(cmd);
      }
    });

    it('mock 清单对照：命令名不在清单内 → null（显式 missing，不静默兜底）', () => {
      resetCommandManifestForTests(
        makeManifest([
          ['core_get_run_snapshot', true],
          ['config_update', true],
          ['list_sessions', true],
        ])
      );
      // 'core_read_session_events' 不在 mock 清单 → null（引导探针白名单仅放行
      // core_get_status / workbench_window_ready，不受清单漂移影响）
      expect(resolveTauriCommand('core_read_session_events')).toBeNull();
      // 引导探针白名单：清单漂移时仍无条件放行（CON-07 加固面）
      expect(resolveTauriCommand('core_get_status')).toBe('core_get_status');
      expect(resolveTauriCommand('workbench_window_ready')).toBe(
        'workbench_window_ready'
      );
      // 清单内命令正常解析
      expect(resolveTauriCommand('core_get_run_snapshot')).toBe(
        'core_get_run_snapshot'
      );
      expect(resolveTauriCommand('list_sessions')).toBe('list_sessions');
      // 直接命令名同理
      expect(resolveTauriCommand('core_run_task')).toBeNull();
    });

    it('mock 清单对照：登记先行命令（registered=false）→ 不可调用 → null', () => {
      resetCommandManifestForTests(
        makeManifest([
          ['core_get_status', true],
          ['config_update', false],
        ])
      );
      expect(resolveTauriCommand('config_update')).toBeNull();
      expect(resolveTauriCommand('core_get_status')).toBe('core_get_status');
    });
  });

  describe('checkCommandMapConsistency（运行时对照）', () => {
    it('内置清单与白名单一致 → 无警告', () => {
      logger.clearLogs();
      checkCommandMapConsistency();
      expect(
        logger
          .getRecentLogs()
          .some((e) => e.level === 'warn' && e.msg.includes('幽灵条目'))
      ).toBe(false);
    });

    it('mock 清单缺白名单命令（幽灵回归）→ logger.warn（不崩）', () => {
      logger.clearLogs();
      resetCommandManifestForTests(
        makeManifest([
          ['core_get_run_snapshot', true],
          ['list_sessions', true],
        ])
      );
      checkCommandMapConsistency();
      const warns = logger
        .getRecentLogs()
        .filter((e) => e.level === 'warn' && e.msg.includes('幽灵条目'));
      expect(warns.some((e) => e.msg.includes('core_get_status'))).toBe(true);
    });
  });

  describe('shapeTauriPayload（payload 整形）', () => {
    it('config_update 剥离 type 字段 + apiKey（K-05：明文 key 不走 config_update 通道）', () => {
      expect(
        shapeTauriPayload('config_update', {
          type: 'config_update',
          model: 'm1',
          apiKey: 'k',
        })
      ).toEqual({ model: 'm1' });
      expect(
        shapeTauriPayload('config_update', {
          type: 'config_update',
          baseUrl: 'https://x',
        })
      ).toEqual({ baseUrl: 'https://x' });
    });

    it('rewind 幽灵命令的整形条目已删除（T03.1）→ 原样返回', () => {
      const p = { sessionId: 's1', targetLeafId: 'l1' };
      expect(shapeTauriPayload('preview-conversation-rewind', p)).toBe(p);
    });

    it('无整形条目 → 原样返回', () => {
      const p = { serverId: 's1' };
      expect(shapeTauriPayload('core_get_status', p)).toBe(p);
      expect(shapeTauriPayload('core_get_status', undefined)).toBeUndefined();
    });
  });
});
