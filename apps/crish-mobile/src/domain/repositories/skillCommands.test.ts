// ===========================================================================
// G7 F6 技能域命令对拍一致性测试：skillCommands × device-protocol.json
// （modelCommands.test.ts 先例的技能域补位）
//
// 策略：注册表为单一真源，运行时直读
// crates/conex-device-protocol/contracts/device-protocol.json（commands 段
// C44 + types 段字段表），注册表漂移时测试红；响应解析器本体为生成面
// （@crish/shared-types generated/device/parser），本测试锁定「命令名 →
// 解析器」分发、请求形状与作用域呈现口径。
// ===========================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildListSkillsRequest,
  SKILL_COMMAND_KIND,
  parseSkillCommandResult,
  skillScopeLabel,
  skillScopeOrder,
} from './skillCommands';
import type { SkillCommandName } from './skillCommands';

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
  write?: boolean;
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

describe('F6 技能域命令注册表基线（device-protocol.json C44）', () => {
  it('listSkills 已登记，domain=settings，kind=remote.listSkills，只读', () => {
    const name: SkillCommandName = 'listSkills';
    const cmd = byName.get(name);
    expect(cmd).toBeDefined();
    expect(cmd!.number).toBe('C44');
    expect(cmd!.domain).toBe('settings');
    expect(cmd!.kind).toBe('remote.listSkills');
    expect(cmd!.write).toBe(false);
    expect(SKILL_COMMAND_KIND[name]).toBe(cmd!.kind);
    expect(cmd!.paramsType).toBe('ListSkillsParams');
    expect(cmd!.resultType).toBe('ListSkillsResult');
  });

  it('SkillEntry 字段表与契约一致（id/name/description/scope/system 必填）', () => {
    const fields = registry.types!['SkillEntry']!.fields ?? [];
    const required = fields.filter((f) => f.required).map((f) => f.name);
    expect(required.sort()).toEqual(
      ['description', 'id', 'name', 'scope', 'system'].sort()
    );
    const optional = fields.filter((f) => !f.required).map((f) => f.name);
    expect(optional.sort()).toEqual(
      ['disableModelInvocation', 'fileActivation'].sort()
    );
  });
});

describe('技能命令构造（buildListSkillsRequest）', () => {
  it('kind/body.command 与注册表一致，params 恒空对象', () => {
    const req = buildListSkillsRequest();
    expect(req.kind).toBe('remote.listSkills');
    expect(req.body.command).toBe('listSkills');
    expect(req.body.params).toEqual({});
  });
});

describe('parseSkillCommandResult（生成解析器分发）', () => {
  it('listSkills 合法载荷 → 解析成功，可选字段缺省不报错', () => {
    const full = parseSkillCommandResult('listSkills', {
      skills: [
        {
          id: 'skill_95cfb221d00f',
          name: 'my-skill',
          description: '演示',
          scope: 'project',
          system: false,
          disableModelInvocation: true,
          fileActivation: 'recommended',
        },
        {
          id: 'skill_aaaaaaaaaaaa',
          name: 'bare',
          description: '',
          scope: 'global',
          system: true,
        },
      ],
    });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.data.skills).toHaveLength(2);
      expect(full.data.skills[0]!.fileActivation).toBe('recommended');
      expect(full.data.skills[1]!.disableModelInvocation).toBeUndefined();
    }
  });

  it('空目录合法；必填字段缺失 → 拒绝', () => {
    const empty = parseSkillCommandResult('listSkills', { skills: [] });
    expect(empty.ok).toBe(true);
    const bad = parseSkillCommandResult('listSkills', {
      skills: [{ id: 'skill_x', name: 'n' }],
    });
    expect(bad.ok).toBe(false);
  });
});

describe('作用域呈现（与桌面 scopeGroupLabel 同口径）', () => {
  it('project/workspace/global 文案与排序', () => {
    expect(skillScopeLabel('project')).toBe('当前项目');
    expect(skillScopeLabel('workspace')).toBe('工作区');
    expect(skillScopeLabel('global')).toBe('全局');
    // 未知作用域原样回传，不编造归类
    expect(skillScopeLabel('custom')).toBe('custom');
    expect(skillScopeOrder('project')).toBeLessThan(
      skillScopeOrder('workspace')
    );
    expect(skillScopeOrder('workspace')).toBeLessThan(
      skillScopeOrder('global')
    );
  });
});
