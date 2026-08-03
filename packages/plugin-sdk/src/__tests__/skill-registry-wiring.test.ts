// packages/plugin-sdk/src/__tests__/skill-registry-wiring.test.ts
// 单元测试：loadSkillsIntoRegistry（E5 接线辅助，03 方案 E5 内容 2）
//
// 覆盖范围：
// - 技能经 loadFromDirectory → toTool → registerTool 注入运行集（skill__ 前缀）
// - disableModelInvocation 技能跳过注册
// - 注册工具可执行（execute 返回 SKILL.md 正文 + 用户输入）
// - 加载诊断照常返回（注册数 = skills - disableModelInvocation）
// - 多技能批量注册保序

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoader, loadSkillsIntoRegistry } from '../skills';
import type { ToolDefinition } from '@crish/shared-types';

let tmpRoot: string;

async function makeTmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `plugin-sdk-wiring-${prefix}-`));
}

async function writeSkill(
  root: string,
  name: string,
  content: string,
): Promise<void> {
  const skillDir = join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), content, 'utf8');
}

function skillMd(name: string, description: string, extra = ''): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    extra,
    '---',
    `# ${name}`,
    `Body of ${name}.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

beforeEach(async () => {
  tmpRoot = await makeTmpDir('root');
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('loadSkillsIntoRegistry - toTool → registerTool 接线（E5）', () => {
  it('技能注册进运行集：skill__ 前缀 + 定义透传', async () => {
    await writeSkill(tmpRoot, 'reviewer', skillMd('reviewer', 'Review code'));
    await writeSkill(tmpRoot, 'committer', skillMd('committer', 'Commit guidance'));

    const loader = new SkillLoader();
    const registered: ToolDefinition[] = [];
    const result = await loadSkillsIntoRegistry(loader, tmpRoot, (def) => {
      registered.push(def);
    });

    // 注册数与加载数一致，前缀隔离
    expect(registered).toHaveLength(2);
    expect(registered.map((def) => def.name).sort()).toEqual([
      'skill__committer',
      'skill__reviewer',
    ]);
    // 描述来自 SKILL.md frontmatter（toTool 透传）
    const reviewer = registered.find((def) => def.name === 'skill__reviewer')!;
    expect(reviewer.description).toBe('Review code');
    // 诊断无异常
    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toHaveLength(2);
  });

  it('disableModelInvocation 技能跳过注册（仅手动触发）', async () => {
    await writeSkill(
      tmpRoot,
      'manual-only',
      skillMd('manual-only', 'Manual only', 'disable-model-invocation: true'),
    );
    await writeSkill(tmpRoot, 'auto', skillMd('auto', 'Auto skill'));

    const loader = new SkillLoader();
    const registered: ToolDefinition[] = [];
    const result = await loadSkillsIntoRegistry(loader, tmpRoot, (def) => {
      registered.push(def);
    });

    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe('skill__auto');
    // 加载结果仍含被跳过的技能（注册面过滤，加载面完整）
    expect(result.skills).toHaveLength(2);
  });

  it('注册的工具可执行：返回 SKILL.md 正文 + 用户输入', async () => {
    await writeSkill(tmpRoot, 'reviewer', skillMd('reviewer', 'Review code'));

    const loader = new SkillLoader();
    let def: ToolDefinition | undefined;
    await loadSkillsIntoRegistry(loader, tmpRoot, (d) => {
      def = d;
    });

    expect(def).toBeDefined();
    const output = await def!.execute(
      { input: '请重点看并发问题' },
      // 最小执行上下文（ToolExecutionContext 字段可选）
      {} as never,
    );
    expect(output.text).toContain('# Skill: reviewer');
    expect(output.text).toContain('Body of reviewer.');
    expect(output.text).toContain('请重点看并发问题');
  });

  it('目录不可读时诊断照常收集，注册回调不被调用', async () => {
    const loader = new SkillLoader();
    const registered: ToolDefinition[] = [];
    const result = await loadSkillsIntoRegistry(
      loader,
      join(tmpRoot, 'does-not-exist'),
      (def) => {
        registered.push(def);
      },
    );

    expect(registered).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(
      result.diagnostics.some(
        (d) => d.code === 'skill-directory-unreadable' && d.severity === 'error',
      ),
    ).toBe(true);
  });
});
