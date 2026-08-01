/**
 * commandMap 集中映射测试（PE-03 T03.1 清单驱动版）：
 * - WS 消息 type → Tauri 命令名（① core_* / ② 壳命令），解析值必须 ∈ 清单 registered；
 * - 幽灵条目 9 条已删除（AA-02 W-5）：对应 WS type 一律解析为 null（显式 missing）；
 * - 命令名直接放行：清单校验取代前缀正则与 RUN_LIFECYCLE_COMMANDS 白名单；
 * - mock 清单对照：注入自定义清单验证「映射值不在清单 → null」；
 * - checkCommandMapConsistency：幽灵回归 → console.warn（不崩）；
 * - Tauri 路径 payload 整形（rewind 幽灵整形已删除）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkCommandMapConsistency,
  resolveTauriCommand,
  shapeTauriPayload,
  WS_TYPE_TO_TAURI_COMMAND,
} from './commandMap';
import { BUILTIN_COMMAND_MANIFEST, resetCommandManifestForTests, type CommandManifest } from './commandManifest';
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
    it('映射 ① core_* 命令（get-status → core_get_status）', () => {
      expect(resolveTauriCommand('get-status')).toBe('core_get_status');
      expect(resolveTauriCommand('read-session-events')).toBe('core_read_session_events');
    });

    it('映射 ② 壳命令（session / config）', () => {
      expect(resolveTauriCommand('list-sessions')).toBe('list_sessions');
      expect(resolveTauriCommand('update-config')).toBe('config_update');
    });

    it('命令名直接放行（清单 registered 内，取代前缀正则 / RUN_LIFECYCLE_COMMANDS 白名单）', () => {
      // run 生命周期：清单校验放行
      expect(resolveTauriCommand('core_run_task')).toBe('core_run_task');
      expect(resolveTauriCommand('core_run_control')).toBe('core_run_control');
      expect(resolveTauriCommand('core_approve_tool')).toBe('core_approve_tool');
      expect(resolveTauriCommand('core_deny_tool')).toBe('core_deny_tool');
      // 其他注册面命令名直放行
      expect(resolveTauriCommand('core_read_session_events')).toBe('core_read_session_events');
      expect(resolveTauriCommand('core_list_commands')).toBe('core_list_commands');
      expect(resolveTauriCommand('workbench_pty_create')).toBe('workbench_pty_create');
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

    it('③ 类调用点已清零（PE-03 T03.7）：workflow / cron / scoped-context / probe / sync 无映射，解析 null（显式 missing）', () => {
      // T03.7 裁决：list-capabilities 回补（并入 core_get_status.mcpStatus），
      // 其余 21 处调用点删除；以下 type 不再有任何 transport.request 调用方，
      // 此处仅断言清单校验下的显式 missing（不静默兜底）。
      for (const t of [
        'list-workflows',
        'create-workflow',
        'update-workflow',
        'delete-workflow',
        'trigger-workflow',
        'list-workflow-runs',
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

    it('完整映射表无遗漏：每个映射值都在内置清单 registered 内且可解析', () => {
      const registered = new Set(
        BUILTIN_COMMAND_MANIFEST.commands.filter((c) => c.registered).map((c) => c.name),
      );
      for (const [ws, cmd] of Object.entries(WS_TYPE_TO_TAURI_COMMAND)) {
        expect(registered.has(cmd), `${cmd} 必须在内置清单 registered 内`).toBe(true);
        expect(resolveTauriCommand(ws), ws).toBe(cmd);
        expect(resolveTauriCommand(cmd), cmd).toBe(cmd);
      }
    });

    it('mock 清单对照：映射值不在清单内 → null（显式 missing，不静默兜底）', () => {
      resetCommandManifestForTests(
        makeManifest([
          ['core_get_run_snapshot', true],
          ['config_update', true],
          ['list_sessions', true],
        ]),
      );
      // 'get-status' 映射到 core_get_status，但 mock 清单中没有 → null
      expect(resolveTauriCommand('get-status')).toBeNull();
      // 清单内命令正常解析
      expect(resolveTauriCommand('get-run-snapshot')).toBe('core_get_run_snapshot');
      expect(resolveTauriCommand('list-sessions')).toBe('list_sessions');
      // 直接命令名同理
      expect(resolveTauriCommand('core_run_task')).toBeNull();
    });

    it('mock 清单对照：登记先行命令（registered=false）→ 不可调用 → null', () => {
      resetCommandManifestForTests(
        makeManifest([
          ['core_get_status', true],
          ['config_update', false],
        ]),
      );
      expect(resolveTauriCommand('update-config')).toBeNull();
      expect(resolveTauriCommand('config_update')).toBeNull();
      expect(resolveTauriCommand('get-status')).toBe('core_get_status');
    });
  });

  describe('checkCommandMapConsistency（运行时对照）', () => {
    it('内置清单与 commandMap 一致 → 无警告', () => {
      logger.clearLogs();
      checkCommandMapConsistency();
      expect(
        logger
          .getRecentLogs()
          .some((e) => e.level === 'warn' && e.msg.includes('幽灵条目')),
      ).toBe(false);
    });

    it('mock 清单缺映射值（幽灵回归）→ logger.warn（不崩）', () => {
      logger.clearLogs();
      resetCommandManifestForTests(
        makeManifest([
          ['core_get_run_snapshot', true],
          ['list_sessions', true],
        ]),
      );
      checkCommandMapConsistency();
      const warns = logger
        .getRecentLogs()
        .filter((e) => e.level === 'warn' && e.msg.includes('幽灵条目'));
      expect(warns.some((e) => e.msg.includes('core_get_status'))).toBe(true);
    });
  });

  describe('shapeTauriPayload（payload 整形）', () => {
    it('update-config 剥离 type 字段 + apiKey（K-05：明文 key 不走 update-config 通道）', () => {
      expect(
        shapeTauriPayload('update-config', { type: 'update-config', model: 'm1', apiKey: 'k' }),
      ).toEqual({ model: 'm1' });
      expect(
        shapeTauriPayload('update-config', { type: 'update-config', baseUrl: 'https://x' }),
      ).toEqual({ baseUrl: 'https://x' });
    });

    it('rewind 幽灵命令的整形条目已删除（T03.1）→ 原样返回', () => {
      const p = { sessionId: 's1', targetLeafId: 'l1' };
      expect(shapeTauriPayload('preview-conversation-rewind', p)).toBe(p);
    });

    it('无整形条目 → 原样返回', () => {
      const p = { serverId: 's1' };
      expect(shapeTauriPayload('get-status', p)).toBe(p);
      expect(shapeTauriPayload('get-status', undefined)).toBeUndefined();
    });
  });
});
