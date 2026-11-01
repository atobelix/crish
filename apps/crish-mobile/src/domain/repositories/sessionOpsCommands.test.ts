// ===========================================================================
// G3 F5 会话操作域命令对拍一致性测试：sessionOpsCommands ×
// device-protocol.json（modelCommands.test.ts 先例的会话操作域补位）
//
// 策略：注册表为单一真源，运行时直读
// crates/conex-device-protocol/contracts/device-protocol.json（commands 段
// C40-C43 + types 段字段表），注册表漂移时测试红；响应解析器本体为生成面
// （@crish/shared-types generated/device/parser 的 parseGenericOkResult），
// 本测试锁定「命令名 → kind」双射、请求形状与解析分发。
// ===========================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildDeleteSessionRequest,
  buildRenameSessionRequest,
  buildSetSessionArchivedRequest,
  buildSetSessionPinnedRequest,
  parseSessionOpsCommandResult,
  SESSION_OPS_COMMAND_KIND,
} from './sessionOpsCommands';
import type { SessionOpsCommandName } from './sessionOpsCommands';

interface RegistryField {
  name: string;
  required?: boolean;
}

interface RegistryTypeDef {
  fields?: RegistryField[];
}

interface RegistryCommand {
  number: string;
  name: string;
  kind: string;
  domain?: string;
  paramsType: string;
  resultType: string;
}

interface DeviceProtocolRegistry {
  commands?: RegistryCommand[];
  types?: Record<string, RegistryTypeDef>;
}

const REGISTRY_PATH = join(
  __dirname,
  '../../../../../crates/conex-device-protocol/contracts/device-protocol.json'
);

function loadRegistry(): DeviceProtocolRegistry {
  return JSON.parse(
    readFileSync(REGISTRY_PATH, 'utf8')
  ) as DeviceProtocolRegistry;
}

const registry = loadRegistry();
const byName = new Map(
  (registry.commands ?? []).map((c) => [c.name, c] as const)
);

const NAMES: SessionOpsCommandName[] = [
  'renameSession',
  'setSessionPinned',
  'setSessionArchived',
  'deleteSession',
];

describe('sessionOpsCommands × 注册表对拍（C40-C43）', () => {
  it('四条命令在注册表 sessions 域、编号 C40-C43、结果统一 GenericOkResult', () => {
    const numbers = NAMES.map((name) => {
      const cmd = byName.get(name);
      if (!cmd) throw new Error(`注册表缺少命令 ${name}`);
      expect(cmd.domain).toBe('sessions');
      expect(cmd!.kind).toBe(`remote.${name}`);
      expect(cmd!.resultType).toBe('GenericOkResult');
      return cmd!.number;
    });
    expect(numbers).toEqual(['C40', 'C41', 'C42', 'C43']);
  });

  it('命令名 → kind 双射与注册表一致', () => {
    for (const name of NAMES) {
      expect(SESSION_OPS_COMMAND_KIND[name]).toBe(`remote.${name}`);
      expect(byName.get(name)!.kind).toBe(SESSION_OPS_COMMAND_KIND[name]);
    }
  });

  it('参数类型字段与注册表 types 段一致（必填集）', () => {
    const requiredOf = (typeName: string) =>
      (registry.types?.[typeName]?.fields ?? [])
        .filter((f) => f.required)
        .map((f) => f.name)
        .sort();
    expect(requiredOf('RenameSessionParams')).toEqual(['sessionId', 'title']);
    expect(requiredOf('SetSessionPinnedParams')).toEqual([
      'pinned',
      'sessionId',
    ]);
    expect(requiredOf('SetSessionArchivedParams')).toEqual([
      'archived',
      'sessionId',
    ]);
    expect(requiredOf('DeleteSessionParams')).toEqual(['sessionId']);
  });
});

describe('sessionOpsCommands 请求构造', () => {
  it('renameSession：kind 与 body.command 同后缀，参数透传', () => {
    const req = buildRenameSessionRequest({
      sessionId: 's-1',
      title: '新标题',
    });
    expect(req.kind).toBe('remote.renameSession');
    expect(req.body.command).toBe('renameSession');
    expect(req.body.params).toEqual({ sessionId: 's-1', title: '新标题' });
  });

  it('setSessionPinned / setSessionArchived / deleteSession 形状', () => {
    const pin = buildSetSessionPinnedRequest({
      sessionId: 's-1',
      pinned: true,
    });
    expect(pin.kind).toBe('remote.setSessionPinned');
    expect(pin.body.params).toEqual({ sessionId: 's-1', pinned: true });
    const arc = buildSetSessionArchivedRequest({
      sessionId: 's-1',
      archived: false,
    });
    expect(arc.kind).toBe('remote.setSessionArchived');
    expect(arc.body.params).toEqual({ sessionId: 's-1', archived: false });
    const del = buildDeleteSessionRequest({ sessionId: 's-1' });
    expect(del.kind).toBe('remote.deleteSession');
    expect(del.body.params).toEqual({ sessionId: 's-1' });
  });
});

describe('sessionOpsCommands 响应解析', () => {
  it('{ok:true} 四条命令均可解析', () => {
    for (const name of NAMES) {
      const parsed = parseSessionOpsCommandResult(name, { ok: true });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.data.ok).toBe(true);
    }
  });

  it('畸形载荷被生成解析器拒绝', () => {
    expect(parseSessionOpsCommandResult('deleteSession', {}).ok).toBe(false);
    expect(parseSessionOpsCommandResult('renameSession', null).ok).toBe(false);
    expect(
      parseSessionOpsCommandResult('setSessionPinned', { ok: 'yes' }).ok
    ).toBe(false);
  });
});
