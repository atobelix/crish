// packages/plugin-sdk/src/__tests__/skill-loader.test.ts
// 单元测试：SkillLoader（Agent 8-C 产出）
//
// 覆盖范围：
// - SKILL.md frontmatter 解析（kebab-case 键 + 布尔/字符串/列表值）
// - 技能→工具转换（toTool：返回 ToolDefinition）
// - 单个技能加载失败不影响其他技能（diagnostics 收集）
// - 二进制检测（null byte 探测）
// - 文件大小校验（maxSkillBytes）
// - 技能名/描述校验（小写字母+数字+连字符）
// - 目录不存在时静默返回空结果
// - 顶层 markdown 文件加载
//
// 约束：禁令 15/16/17 + 迁移自 agent-tools/src/skills.ts 的解析逻辑

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoader } from '../skills';
import type { PluginSkill } from '../skills';

// ─── 测试夹具：临时目录 ────────────────────────────────────────

let tmpRoot: string;

async function makeTmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `plugin-sdk-skill-${prefix}-`));
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

beforeEach(async () => {
  tmpRoot = await makeTmpDir('root');
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ─── frontmatter 解析 ─────────────────────────────────────────

describe('SkillLoader.loadFromDirectory - frontmatter 解析', () => {
  it('完整 frontmatter 解析（kebab-case 键 + 字符串/布尔/列表值）', async () => {
    await writeSkill(tmpRoot, 'reviewer', [
      '---',
      'name: reviewer',
      'description: Review code changes',
      'disable-model-invocation: false',
      'scope: project',
      'activation: recommended',
      'run-as: subagent',
      'read-only: true',
      'allowed-tools: [read, search]',
      'invocation: manual',
      'applies-to: [tag:typescript, package:@crish/agent-runtime]',
      'tags: [review, code-quality]',
      '---',
      '# Reviewer',
      'Check correctness first.',
    ].join('\n'));

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(result.skills).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    const skill = result.skills[0]!;
    expect(skill.name).toBe('reviewer');
    expect(skill.description).toBe('Review code changes');
    expect(skill.disableModelInvocation).toBe(false);
    expect(skill.scope).toBe('project');
    expect(skill.activation).toBe('recommended');
    expect(skill.runAs).toBe('subagent');
    expect(skill.readOnly).toBe(true);
    expect(skill.allowedTools).toEqual(['read', 'search']);
    expect(skill.invocation).toBe('manual');
    expect(skill.appliesTo).toEqual([
      'tag:typescript',
      'package:@crish/agent-runtime',
    ]);
    expect(skill.tags).toEqual(['review', 'code-quality']);
    expect(skill.content).toContain('# Reviewer');
    expect(skill.content).toContain('Check correctness first.');
  });

  it('最小 frontmatter（仅 name + description）', async () => {
    await writeSkill(tmpRoot, 'simple', [
      '---',
      'name: simple',
      'description: A simple skill',
      '---',
      '# Simple',
      'Body content.',
    ].join('\n'));

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0]!;
    expect(skill.name).toBe('simple');
    expect(skill.description).toBe('A simple skill');
    expect(skill.disableModelInvocation).toBe(false);
    expect(skill.scope).toBeUndefined();
  });

  it('无 frontmatter 的 SKILL.md 仍可加载（fallback name + description）', async () => {
    await writeSkill(tmpRoot, 'no-frontmatter', '# No Frontmatter\n\nBody.');

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0]!;
    // fallback name 来自目录名
    expect(skill.name).toBe('no-frontmatter');
    // fallback description 来自正文首个非标题行
    expect(skill.description).toContain('Body');
  });

  it('frontmatter 布尔值 true/false 正确解析', async () => {
    await writeSkill(tmpRoot, 'bool-test', [
      '---',
      'name: bool-test',
      'description: Boolean test',
      'disable-model-invocation: true',
      'read-only: false',
      '---',
      'Body',
    ].join('\n'));

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);
    const skill = result.skills[0]!;

    expect(skill.disableModelInvocation).toBe(true);
    // read-only: false 时字段不包含在 skill 对象中（仅 true 时设置）
    expect(skill.readOnly).toBeUndefined();
  });

  it('frontmatter 列表值（[a, b, c] 字面量）', async () => {
    await writeSkill(tmpRoot, 'list-test', [
      '---',
      'name: list-test',
      'description: List test',
      'tags: [alpha, beta, gamma]',
      '---',
      'Body',
    ].join('\n'));

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);
    const skill = result.skills[0]!;

    expect(skill.tags).toEqual(['alpha', 'beta', 'gamma']);
  });
});

// ─── 多技能加载 ───────────────────────────────────────────────

describe('SkillLoader.loadFromDirectory - 多技能加载', () => {
  it('同时加载多个技能', async () => {
    await writeSkill(tmpRoot, 'skill-a', [
      '---',
      'name: skill-a',
      'description: Skill A',
      '---',
      'Body A',
    ].join('\n'));
    await writeSkill(tmpRoot, 'skill-b', [
      '---',
      'name: skill-b',
      'description: Skill B',
      '---',
      'Body B',
    ].join('\n'));

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(result.skills).toHaveLength(2);
    const names = result.skills.map((s) => s.name);
    expect(names).toContain('skill-a');
    expect(names).toContain('skill-b');
  });

  it('单个技能加载失败不影响其他技能（diagnostics 收集）', async () => {
    await writeSkill(tmpRoot, 'valid-skill', [
      '---',
      'name: valid-skill',
      'description: Valid',
      '---',
      'Body',
    ].join('\n'));
    // 二进制文件触发诊断
    const binaryDir = join(tmpRoot, 'binary-skill');
    await mkdir(binaryDir);
    await writeFile(
      join(binaryDir, 'SKILL.md'),
      Buffer.from([0, 1, 2, 3, 4, 5]),
    );

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe('valid-skill');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(
      result.diagnostics.some((d) => d.code === 'skill-file-binary'),
    ).toBe(true);
  });

  it('跳过 . 开头与 node_modules 目录', async () => {
    await writeSkill(tmpRoot, 'real-skill', [
      '---',
      'name: real-skill',
      'description: Real',
      '---',
      'Body',
    ].join('\n'));
    await mkdir(join(tmpRoot, '.hidden'));
    await writeFile(
      join(tmpRoot, '.hidden', 'SKILL.md'),
      '---\nname: hidden\ndescription: h\n---\nBody',
    );
    await mkdir(join(tmpRoot, 'node_modules'));
    await writeFile(
      join(tmpRoot, 'node_modules', 'SKILL.md'),
      '---\nname: nm\ndescription: n\n---\nBody',
    );

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe('real-skill');
  });
});

// ─── 错误路径：诊断 ───────────────────────────────────────────

describe('SkillLoader.loadFromDirectory - 诊断', () => {
  it('目录不存在时返回诊断（skill-directory-unreadable）', async () => {
    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(
      join(tmpRoot, 'non-existent'),
    );

    expect(result.skills).toEqual([]);
    expect(
      result.diagnostics.some((d) => d.code === 'skill-directory-unreadable'),
    ).toBe(true);
  });

  it('二进制 SKILL.md → skill-file-binary 诊断', async () => {
    const skillDir = join(tmpRoot, 'binary');
    await mkdir(skillDir);
    await writeFile(
      join(skillDir, 'SKILL.md'),
      Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(result.skills).toEqual([]);
    expect(
      result.diagnostics.some((d) => d.code === 'skill-file-binary'),
    ).toBe(true);
  });

  it('超大 SKILL.md → skill-file-too-large 诊断', async () => {
    const skillDir = join(tmpRoot, 'huge');
    await mkdir(skillDir);
    await writeFile(
      join(skillDir, 'SKILL.md'),
      'x'.repeat(2048),
    );

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot, {
      maxSkillBytes: 1024,
    });

    expect(result.skills).toEqual([]);
    expect(
      result.diagnostics.some((d) => d.code === 'skill-file-too-large'),
    ).toBe(true);
  });

  it('frontmatter 缺少闭合分隔符 → skill-frontmatter-malformed', async () => {
    await writeSkill(tmpRoot, 'malformed', [
      '---',
      'name: malformed',
      'description: Malformed',
      'Body without closing delimiter',
    ].join('\n'));

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(result.skills).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) => d.code === 'skill-frontmatter-malformed',
      ),
    ).toBe(true);
  });

  it('无效技能名（含大写字母）→ skill-name-invalid 诊断', async () => {
    await writeSkill(tmpRoot, 'bad-name', [
      '---',
      'name: Bad Name',
      'description: bad',
      '---',
      'Body',
    ].join('\n'));

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    // 名称无效仍会加载（warning 不阻塞），但生成诊断
    expect(
      result.diagnostics.some((d) => d.code === 'skill-name-invalid'),
    ).toBe(true);
  });

  it('无效技能名（首尾连字符）→ skill-name-invalid 诊断', async () => {
    await writeSkill(tmpRoot, 'hyphen', [
      '---',
      'name: -hyphen-',
      'description: hyphen',
      '---',
      'Body',
    ].join('\n'));

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(
      result.diagnostics.some((d) => d.code === 'skill-name-invalid'),
    ).toBe(true);
  });

  it('空描述 → skill-description-invalid 诊断', async () => {
    await writeSkill(tmpRoot, 'no-desc', [
      '---',
      'name: no-desc',
      'description: ',
      '---',
      'Body',
    ].join('\n'));

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(
      result.diagnostics.some(
        (d) => d.code === 'skill-description-invalid',
      ),
    ).toBe(true);
  });
});

// ─── 技能→工具转换 ────────────────────────────────────────────

describe('SkillLoader.toTool - 技能转工具', () => {
  it('返回 ToolDefinition（含 name/description/inputSchema/execute）', async () => {
    const skill: PluginSkill = {
      name: 'test-skill',
      description: 'A test skill',
      filePath: '/path/SKILL.md',
      baseDir: '/path',
      content: '# Test Skill\n\nDo something.',
      disableModelInvocation: false,
    };

    const loader = new SkillLoader();
    const tool = loader.toTool(skill);

    expect(tool.name).toBe('test-skill');
    expect(tool.description).toBe('A test skill');
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema?.type).toBe('object');
    expect(typeof tool.execute).toBe('function');
  });

  it('execute 返回含 skill name + content + user input 的 text', async () => {
    const skill: PluginSkill = {
      name: 'my-skill',
      description: 'd',
      filePath: '/p',
      baseDir: '/p',
      content: 'Skill body content',
      disableModelInvocation: false,
    };

    const loader = new SkillLoader();
    const tool = loader.toTool(skill);

    const result = await tool.execute(
      { input: 'user-provided input' },
      {
        toolCallId: 'tc1',
        sessionId: 's1',
        cwd: '/',
        signal: new AbortController().signal,
        emit: () => {},
      },
    );

    expect(result.text).toContain('# Skill: my-skill');
    expect(result.text).toContain('Skill body content');
    expect(result.text).toContain('user-provided input');
  });

  it('execute 无 input 时显示 (none)', async () => {
    const skill: PluginSkill = {
      name: 'no-input-skill',
      description: 'd',
      filePath: '/p',
      baseDir: '/p',
      content: 'Body',
      disableModelInvocation: false,
    };

    const loader = new SkillLoader();
    const tool = loader.toTool(skill);

    const result = await tool.execute(
      {},
      {
        toolCallId: 'tc1',
        sessionId: 's1',
        cwd: '/',
        signal: new AbortController().signal,
        emit: () => {},
      },
    );

    expect(result.text).toContain('(none)');
  });
});

// ─── 顶层 markdown 文件加载 ───────────────────────────────────

describe('SkillLoader.loadFromDirectory - 顶层 markdown', () => {
  it('顶层目录直接含 SKILL.md 时视为单个技能', async () => {
    await writeFile(
      join(tmpRoot, 'SKILL.md'),
      [
        '---',
        'name: top-level',
        'description: Top level skill',
        '---',
        '# Top Level',
        'Body',
      ].join('\n'),
    );

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe('top-level');
  });
});

// ─── maxSkillBytes 选项 ───────────────────────────────────────

describe('SkillLoader - maxSkillBytes 选项', () => {
  it('默认 maxSkillBytes = 512KB', async () => {
    await writeSkill(tmpRoot, 'normal', [
      '---',
      'name: normal',
      'description: normal',
      '---',
      'Body',
    ].join('\n'));

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot);

    expect(result.skills).toHaveLength(1);
  });

  it('自定义 maxSkillBytes 拒绝超限文件', async () => {
    const skillDir = join(tmpRoot, 'big');
    await mkdir(skillDir);
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: big\ndescription: b\n---\n' + 'x'.repeat(500),
    );

    const loader = new SkillLoader();
    const result = await loader.loadFromDirectory(tmpRoot, {
      maxSkillBytes: 100,
    });

    expect(result.skills).toEqual([]);
    expect(
      result.diagnostics.some((d) => d.code === 'skill-file-too-large'),
    ).toBe(true);
  });
});
