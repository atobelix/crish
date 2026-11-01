// ===========================================================================
// G2/W-B F6 模型域命令对拍一致性测试：modelCommands × device-protocol.json
// （filesCommands.test.ts 先例的模型域补位）
//
// 策略：注册表为单一真源，运行时直读
// crates/conex-device-protocol/contracts/device-protocol.json（commands 段
// C38/C39 + types 段字段表），注册表漂移时测试红；响应解析器本体为生成面
// （@crish/shared-types generated/device/parser），本测试锁定「命令名 →
// 解析器」分发、请求形状与身份键口径。
// ===========================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildListModelsRequest,
  buildSetActiveModelRequest,
  MODEL_COMMAND_KIND,
  modelRefKey,
  parseModelCommandResult,
} from './modelCommands';
import type { ModelCommandName } from './modelCommands';

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

describe('F6 模型域 2 条命令注册表基线（device-protocol.json C38/C39）', () => {
  it('listModels / setActiveModel 均登记，domain=settings，kind=remote.<name>', () => {
    for (const name of ['listModels', 'setActiveModel'] as ModelCommandName[]) {
      const cmd = byName.get(name);
      expect(cmd).toBeDefined();
      expect(cmd!.domain).toBe('settings');
      expect(cmd!.kind).toBe(`remote.${name}`);
      expect(MODEL_COMMAND_KIND[name]).toBe(cmd!.kind);
    }
    expect(byName.get('listModels')!.number).toBe('C38');
    expect(byName.get('setActiveModel')!.number).toBe('C39');
    expect(byName.get('listModels')!.paramsType).toBe('ListModelsParams');
    expect(byName.get('listModels')!.resultType).toBe('ListModelsResult');
    expect(byName.get('setActiveModel')!.paramsType).toBe(
      'SetActiveModelParams'
    );
    expect(byName.get('setActiveModel')!.resultType).toBe(
      'SetActiveModelResult'
    );
  });
});

describe('模型命令构造（build*Request）', () => {
  it('listModels：kind/body.command 与注册表一致，params 恒空对象', () => {
    const req = buildListModelsRequest();
    expect(req.kind).toBe('remote.listModels');
    expect(req.body.command).toBe('listModels');
    expect(req.body.params).toEqual({});
  });

  it('setActiveModel：params 键集 == 注册表 SetActiveModelParams 字段名集', () => {
    const req = buildSetActiveModelRequest({
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
    });
    expect(req.kind).toBe('remote.setActiveModel');
    expect(req.body.command).toBe('setActiveModel');
    const registryFields = (
      registry.types!['SetActiveModelParams']!.fields ?? []
    ).map((f) => f.name);
    expect(Object.keys(req.body.params as object).sort()).toEqual(
      registryFields.sort()
    );
  });
});

describe('parseModelCommandResult（生成解析器分发）', () => {
  it('listModels 合法载荷 → 解析成功，activeModel 可选', () => {
    const full = parseModelCommandResult('listModels', {
      models: [
        {
          providerId: 'anthropic',
          modelId: 'claude-sonnet',
          displayName: 'Claude Sonnet',
          providerDisplayName: 'Anthropic',
          active: true,
        },
      ],
      activeModel: {
        providerId: 'anthropic',
        modelId: 'claude-sonnet',
        displayName: 'Claude Sonnet',
      },
    });
    expect(full.ok).toBe(true);

    const noActive = parseModelCommandResult('listModels', { models: [] });
    expect(noActive.ok).toBe(true);
    if (noActive.ok) {
      expect(noActive.data.activeModel).toBeUndefined();
    }
  });

  it('listModels 必填字段缺失 → 拒绝', () => {
    const bad = parseModelCommandResult('listModels', {
      models: [{ providerId: 'anthropic', modelId: 'm' }],
    });
    expect(bad.ok).toBe(false);
  });

  it('setActiveModel 合法载荷 → 解析成功；缺 activeModel → 拒绝', () => {
    const ok = parseModelCommandResult('setActiveModel', {
      ok: true,
      activeModel: {
        providerId: 'p',
        modelId: 'm',
        displayName: 'M',
      },
    });
    expect(ok.ok).toBe(true);
    const bad = parseModelCommandResult('setActiveModel', { ok: true });
    expect(bad.ok).toBe(false);
  });
});

describe('modelRefKey（桌面 modelRefKey 同口径）', () => {
  it('(providerId, modelId) 二元组编码；同 modelId 不同供应商键不同', () => {
    expect(modelRefKey('anthropic', 'm')).toBe('["anthropic","m"]');
    expect(modelRefKey('a', 'm')).not.toBe(modelRefKey('b', 'm'));
    expect(modelRefKey('a', 'm')).not.toBe(modelRefKey('a', 'n'));
  });
});
