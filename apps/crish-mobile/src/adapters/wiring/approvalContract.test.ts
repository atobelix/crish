// ============================================================================
// 审批域命令对拍一致性测试：approvalWiring × device-protocol.json
//
// 背景：approvalCommands.test.ts 曾随旧 repositories 层删除，导致「仍在发送的
// 审批协议帧」失去契约保护（approvalWiring 依旧发送 command:'approve'/'deny'）。
// 本测试直读协议注册表，锁定命令名 / kind / 参数键集 / 幂等语义，注册表漂移
// 或发送形状漂移都会红。
//
// 真源索引：
// - crates/conex-types/contracts/device-protocol.json（C11 approve / C12 deny /
//   C13 listPendingApprovals / C14 approvalHistory）
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildApproveRequest,
  buildDenyRequest,
} from '@/adapters/wiring/approvalWiring';

interface RegistryField {
  name: string;
  type?: string;
  required?: boolean;
}

interface RegistryTypeDef {
  kind?: string;
  fields?: RegistryField[];
}

interface RegistryCommand {
  number: string;
  name: string;
  kind: string;
  domain?: string;
  write?: boolean;
  outbox?: boolean;
  idempotencyKey?: string;
  paramsType: string;
  resultType: string;
  errorCodes?: string[];
}

interface DeviceProtocolRegistry {
  commands?: RegistryCommand[];
  types?: Record<string, RegistryTypeDef>;
}

const REGISTRY_PATH = join(
  __dirname,
  '../../../../../crates/conex-types/contracts/device-protocol.json'
);

function loadRegistry(): DeviceProtocolRegistry {
  return JSON.parse(
    readFileSync(REGISTRY_PATH, 'utf8')
  ) as DeviceProtocolRegistry;
}

function registryCommand(name: string): RegistryCommand {
  const cmd = loadRegistry().commands?.find((c) => c.name === name);
  if (!cmd)
    throw new Error(`注册表 device-protocol.json 缺失命令 name=${name}`);
  return cmd;
}

function registryType(typeName: string): RegistryTypeDef {
  const def = loadRegistry().types?.[typeName];
  if (!def) throw new Error(`注册表 device-protocol.json 缺失类型 ${typeName}`);
  return def;
}

describe('审批域命令注册表基线（C11-C14）', () => {
  const APPROVAL_COMMANDS = [
    'approve',
    'deny',
    'listPendingApprovals',
    'approvalHistory',
  ];

  it('四条命令全部登记且 domain=approval', () => {
    for (const name of APPROVAL_COMMANDS) {
      expect(registryCommand(name).domain).toBe('approval');
    }
  });

  it('决策命令（approve / deny）为写命令且走 outbox，幂等键 = toolCallId + msgId', () => {
    for (const name of ['approve', 'deny']) {
      const cmd = registryCommand(name);
      expect(cmd.write).toBe(true);
      expect(cmd.outbox).toBe(true);
      expect(cmd.idempotencyKey).toBe('toolCallId + msgId');
    }
  });

  it('查询命令（listPendingApprovals / approvalHistory）非写非 outbox', () => {
    for (const name of ['listPendingApprovals', 'approvalHistory']) {
      const cmd = registryCommand(name);
      expect(cmd.write).toBe(false);
      expect(cmd.outbox).toBe(false);
    }
  });
});

describe('buildApproveRequest 对拍 C11', () => {
  it('kind 与注册表 kind 一致', () => {
    const cmd = registryCommand('approve');
    expect(buildApproveRequest('tc-1').kind).toBe(cmd.kind);
  });

  it('body.command 与注册表命令名一致', () => {
    const cmd = registryCommand('approve');
    expect(buildApproveRequest('tc-1').body.command).toBe(cmd.name);
  });

  it('params 键集 ⊆ ApproveParams 注册字段，且必填字段齐备', () => {
    const cmd = registryCommand('approve');
    const allowed = new Set(
      (registryType(cmd.paramsType).fields ?? []).map((f) => f.name)
    );
    const required = (registryType(cmd.paramsType).fields ?? [])
      .filter((f) => f.required)
      .map((f) => f.name);

    const params = buildApproveRequest('tc-1').body.params as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(params)) {
      expect(allowed.has(key)).toBe(true);
    }
    for (const key of required) {
      expect(params).toHaveProperty(key);
    }
  });

  it('runId 仅在提供时下发（缺省不产生空键）', () => {
    expect(buildApproveRequest('tc-1').body.params).not.toHaveProperty('runId');
    expect(buildApproveRequest('tc-1', 'run-9').body.params).toMatchObject({
      runId: 'run-9',
    });
  });

  it('决策恒为批准：参数面不携带 decision 字段（M6 §4.2.1）', () => {
    const params = buildApproveRequest('tc-1').body.params as Record<
      string,
      unknown
    >;
    expect(params).not.toHaveProperty('decision');
  });
});

describe('buildDenyRequest 对拍 C12', () => {
  it('kind 与注册表 kind 一致', () => {
    const cmd = registryCommand('deny');
    expect(buildDenyRequest('tc-1').kind).toBe(cmd.kind);
  });

  it('body.command 与注册表命令名一致', () => {
    const cmd = registryCommand('deny');
    expect(buildDenyRequest('tc-1').body.command).toBe(cmd.name);
  });

  it('params 键集 ⊆ DenyParams 注册字段', () => {
    const cmd = registryCommand('deny');
    const allowed = new Set(
      (registryType(cmd.paramsType).fields ?? []).map((f) => f.name)
    );
    const params = buildDenyRequest('tc-1', '风险过高', 'run-1').body
      .params as Record<string, unknown>;
    for (const key of Object.keys(params)) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  it('reason 省略时不下发该键（缺省由桌面补 "user denied"）', () => {
    expect(buildDenyRequest('tc-1').body.params).not.toHaveProperty('reason');
    expect(buildDenyRequest('tc-1', 'no').body.params).toMatchObject({
      reason: 'no',
    });
  });
});
