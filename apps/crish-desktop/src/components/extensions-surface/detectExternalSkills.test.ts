// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectExternalSkills,
  DEFAULT_PRESET_EXTERNAL_SKILLS,
  parseSkillMarkdown,
  isBuiltinSkillPath,
  isBuiltinSkill,
  filterOutBuiltinSkills,
  isDisallowedSkillName,
  isQualifiedSkill,
  DISALLOWED_SKILL_NAMES,
  SCAN_TARGETS,
} from './detectExternalSkills';
import * as tauriInvoke from '../../api/tauriInvoke';

describe('detectExternalSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default preset skills when fallback is enabled and no files found', async () => {
    vi.spyOn(tauriInvoke, 'invokeResult').mockResolvedValue({
      status: 'missing',
    } as any);
    const result = await detectExternalSkills();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual(DEFAULT_PRESET_EXTERNAL_SKILLS);

    // 确认所有预设的 isBuiltin 恒为 false
    for (const skill of result) {
      expect(skill.isBuiltin).toBe(false);
      expect(isBuiltinSkill(skill)).toBe(false);
      expect(isBuiltinSkillPath(skill.filePath)).toBe(false);
      expect(isBuiltinSkillPath(skill.skillDir)).toBe(false);
    }

    // 确认已彻底剔除 automation、generative_ui 等系统自带技能
    const skillNames = result.map((s) => s.name.toLowerCase());
    expect(skillNames).not.toContain('automation');
    expect(skillNames).not.toContain('generative_ui');
    expect(skillNames).not.toContain('generative-ui');
    expect(skillNames).not.toContain('disk-cleanup');
    expect(skillNames).not.toContain('babysit');

    // 确认完整包含 5 大官方通用标准技能
    expect(skillNames).toContain('code-review');
    expect(skillNames).toContain('repo-to-resume-tailor');
    expect(skillNames).toContain('resume-master');
    expect(skillNames).toContain('chinese-encoding-guard');
    expect(skillNames).toContain('de-ai-academic-cn');

    // 确认每个预设都携带高质量、非空的完整正文指令模板
    for (const skill of result) {
      expect(skill.content).toBeDefined();
      expect(skill.content?.trim().length).toBeGreaterThan(100);
      expect(isQualifiedSkill(skill)).toBe(true);
    }
  });

  it('SCAN_TARGETS only contains user-installed skill directories and no builtin paths', () => {
    expect(SCAN_TARGETS.length).toBe(5);

    const scannedDirs = SCAN_TARGETS.map((t) => t.getDir('/fake/home'));
    expect(scannedDirs).toEqual([
      '/fake/home/.gemini/antigravity/skills',
      '/fake/home/.claude/skills',
      '/fake/home/.codex/skills',
      '/fake/home/.cursor/skills',
      '/fake/home/.agents/skills',
    ]);

    for (const target of SCAN_TARGETS) {
      expect(target.isBuiltin).toBe(false);
      const dir = target.getDir('/home/user');
      expect(isBuiltinSkillPath(dir)).toBe(false);
      expect(dir).not.toContain('builtin');
      expect(dir).not.toContain('.system');
    }
  });

  it('identifies builtin skill paths and builtin skill objects correctly', () => {
    // 跨平台与大小写、Windows 反斜杠
    expect(
      isBuiltinSkillPath(
        '/Users/foo/.gemini/antigravity/builtin/skills/automation'
      )
    ).toBe(true);
    expect(
      isBuiltinSkillPath(
        'C:\\Users\\foo\\.gemini\\antigravity\\builtin\\skills\\automation'
      )
    ).toBe(true);
    expect(
      isBuiltinSkillPath(
        'C:\\Users\\foo\\BUILTIN\\skills\\automation\\SKILL.md'
      )
    ).toBe(true);
    expect(isBuiltinSkillPath('/opt/system/.system/skills/secret')).toBe(true);
    expect(isBuiltinSkillPath('C:\\Users\\foo\\.system\\skills\\secret')).toBe(
      true
    );
    expect(isBuiltinSkillPath('C:\\Users\\foo\\.System\\skills\\secret')).toBe(
      true
    );
    expect(isBuiltinSkillPath('C:\\Users\\foo/builtin\\skills/test')).toBe(
      true
    );
    expect(isBuiltinSkillPath('C:\\Users\\foo/mixed/.System\\skills')).toBe(
      true
    );
    expect(isBuiltinSkillPath('builtin')).toBe(true);
    expect(isBuiltinSkillPath('.system')).toBe(true);
    expect(isBuiltinSkillPath('builtin/my-skill')).toBe(true);
    expect(isBuiltinSkillPath('builtin\\my-skill')).toBe(true);
    expect(isBuiltinSkillPath('.system/my-skill')).toBe(true);
    expect(isBuiltinSkillPath('.system\\my-skill')).toBe(true);
    expect(isBuiltinSkillPath('C:\\app\\builtin')).toBe(true);
    expect(isBuiltinSkillPath('/app/.system')).toBe(true);

    // 正常用户路径（不误判）
    expect(
      isBuiltinSkillPath('/Users/foo/.gemini/antigravity/skills/custom-skill')
    ).toBe(false);
    expect(
      isBuiltinSkillPath('/Users/foo/.claude/skills/chinese-encoding-guard')
    ).toBe(false);
    expect(
      isBuiltinSkillPath('C:\\Users\\foo\\.codex\\skills\\de-ai-academic-cn')
    ).toBe(false);
    expect(
      isBuiltinSkillPath('C:\\Users\\foo\\my-builtin-tools\\SKILL.md')
    ).toBe(false);
    expect(isBuiltinSkillPath('C:/Users/foo/custom.system.pkg/SKILL.md')).toBe(
      false
    );

    expect(isBuiltinSkill({ isBuiltin: true })).toBe(true);
    expect(
      isBuiltinSkill({
        filePath: '/test/path/builtin/skill/SKILL.md',
        isBuiltin: false,
      })
    ).toBe(true);
    expect(
      isBuiltinSkill({
        skillDir: 'C:\\test\\system\\.system\\skill',
        isBuiltin: false,
      })
    ).toBe(true);
    expect(
      isBuiltinSkill({
        dirPath: 'C:\\test\\BUILTIN\\tool',
        isBuiltin: false,
      })
    ).toBe(true);
    expect(
      isBuiltinSkill({
        filePath: '/test/normal/skills/my-skill/SKILL.md',
        isBuiltin: false,
      })
    ).toBe(false);

    const list = [
      {
        name: 'builtin-1',
        filePath: '/app/builtin/skills/1',
        isBuiltin: false,
      },
      { name: 'user-1', filePath: '/home/.claude/skills/1', isBuiltin: false },
      { name: 'system-1', filePath: '/app/.system/skills/2', isBuiltin: false },
      {
        name: 'builtin-flag',
        filePath: '/home/.codex/skills/3',
        isBuiltin: true,
      },
      { name: 'user-2', filePath: '/home/.codex/skills/4', isBuiltin: false },
    ];
    const filtered = filterOutBuiltinSkills(list as any);
    expect(filtered.map((s) => s.name)).toEqual(['user-1', 'user-2']);
  });

  it('parses real SKILL.md files from external candidate directories', async () => {
    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_list_directory' &&
          args?.path?.includes('.gemini/antigravity/skills')
        ) {
          return {
            status: 'ok',
            data: {
              items: [{ name: 'my-custom-skill', is_dir: true }],
            },
          } as any;
        }
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('my-custom-skill/SKILL.md')
        ) {
          return {
            status: 'ok',
            data: {
              content:
                '---\nname: my-custom-skill\ndescription: 自定义测试技能\n---\n\n# 技能正文',
            },
          } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalSkills({ fallback: false });
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('my-custom-skill');
    expect(result[0].description).toBe('自定义测试技能');
    expect(result[0].source).toBe('Antigravity');
    expect(result[0].isBuiltin).toBe(false);
  });

  it('filters out system builtin and .system skills during detection', async () => {
    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_list_directory' &&
          args?.path?.includes('.gemini/antigravity/skills')
        ) {
          return {
            status: 'ok',
            data: {
              items: [
                { name: 'user-skill', is_dir: true },
                { name: 'builtin', is_dir: true },
                { name: '.system', is_dir: true },
              ],
            },
          } as any;
        }
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('user-skill/SKILL.md')
        ) {
          return {
            status: 'ok',
            data: {
              content:
                '---\nname: user-skill\ndescription: 正常用户技能\n---\n说明',
            },
          } as any;
        }
        if (cmd === 'workbench_read_file_content') {
          return {
            status: 'ok',
            data: {
              content:
                '---\nname: should-be-filtered\ndescription: 内置技能\n---\n',
            },
          } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalSkills({ fallback: false });
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('user-skill');
    expect(result.some((s) => s.name === 'should-be-filtered')).toBe(false);
  });

  it('parses frontmatter and titles correctly with parseSkillMarkdown', () => {
    const res1 = parseSkillMarkdown(
      '---\nname: test-skill\ndescription: 描述信息\n---\n正文'
    );
    expect(res1.name).toBe('test-skill');
    expect(res1.description).toBe('描述信息');

    const res2 = parseSkillMarkdown('# 纯标题技能\n第一行说明文字');
    expect(res2.name).toBe('纯标题技能');
    expect(res2.description).toBe('第一行说明文字');
  });

  it('detects Claude Code user skills correctly', async () => {
    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_list_directory' &&
          args?.path?.includes('.claude/skills')
        ) {
          return {
            status: 'ok',
            data: {
              items: [{ name: 'chinese-encoding-guard', is_dir: true }],
            },
          } as any;
        }
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('chinese-encoding-guard/SKILL.md')
        ) {
          return {
            status: 'ok',
            data: {
              content:
                '---\nname: chinese-encoding-guard\ndescription: 检查中文编码与防乱码\n---\n说明',
            },
          } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalSkills({ fallback: false });
    const claudeSkill = result.find((s) => s.name === 'chinese-encoding-guard');
    expect(claudeSkill).toBeDefined();
    expect(claudeSkill?.source).toBe('Claude Code');
    expect(claudeSkill?.id).toBe(
      'ext-skill-claude-code-chinese-encoding-guard'
    );
    expect(claudeSkill?.description).toBe('检查中文编码与防乱码');
    expect(claudeSkill?.isBuiltin).toBe(false);
  });

  it('detects Codex skills and synthesizes fallback when SKILL.md is missing', async () => {
    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_list_directory' &&
          args?.path?.includes('.codex/skills')
        ) {
          return {
            status: 'ok',
            data: {
              items: [
                { name: 'custom-tool-sync', is_dir: true },
                { name: 'de-ai-academic-cn', is_dir: true },
              ],
            },
          } as any;
        }
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('custom-tool-sync/SKILL.md')
        ) {
          return {
            status: 'ok',
            data: {
              content:
                '---\nname: custom-tool-sync\ndescription: 自定义同步工具技能\n---\n\n## 技能正文\n提供多端环境规则与工具配置的无缝同步功能。',
            },
          } as any;
        }
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('de-ai-academic-cn/SKILL.md')
        ) {
          return {
            status: 'ok',
            data: {
              content:
                '---\nname: de-ai-academic-cn\ndescription: 学术论文去AI痕迹\n---\n\n## 技能正文\n面向学术论文与科研报告的高质量中文设计、排版与矢量绘图规范。',
            },
          } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalSkills({ fallback: false });
    const toolSkill = result.find((s) => s.name === 'custom-tool-sync');
    expect(toolSkill).toBeDefined();
    expect(toolSkill?.source).toBe('Codex');
    expect(toolSkill?.id).toBe('ext-skill-codex-custom-tool-sync');
    expect(toolSkill?.description).toBe('自定义同步工具技能');
    expect(toolSkill?.isBuiltin).toBe(false);

    const academicSkill = result.find((s) => s.name === 'de-ai-academic-cn');
    expect(academicSkill).toBeDefined();
    expect(academicSkill?.source).toBe('Codex');
    expect(academicSkill?.id).toBe('ext-skill-codex-de-ai-academic-cn');
    expect(academicSkill?.description).toBe('学术论文去AI痕迹');
    expect(academicSkill?.isBuiltin).toBe(false);
  });

  it('supplements non-detected sources with fallback presets without any builtin leakage', async () => {
    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_list_directory' &&
          args?.path?.includes('.claude/skills')
        ) {
          return {
            status: 'ok',
            data: {
              items: [{ name: 'chinese-encoding-guard', is_dir: true }],
            },
          } as any;
        }
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('chinese-encoding-guard/SKILL.md')
        ) {
          return {
            status: 'ok',
            data: {
              content:
                '---\nname: chinese-encoding-guard\ndescription: 检查中文编码与防乱码\n---\n说明',
            },
          } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalSkills({ fallback: true });
    expect(result.length).toBeGreaterThan(1);

    for (const skill of result) {
      expect(skill.isBuiltin).toBe(false);
      expect(isBuiltinSkill(skill)).toBe(false);
      expect(isBuiltinSkillPath(skill.filePath)).toBe(false);
      expect(isBuiltinSkillPath(skill.skillDir)).toBe(false);
      expect(skill.name).not.toBe('automation');
      expect(skill.name).not.toBe('generative_ui');
    }
  });

  it('correctly identifies disallowed skills with isDisallowedSkillName and DISALLOWED_SKILL_NAMES', () => {
    expect(DISALLOWED_SKILL_NAMES.has('disk-cleanup')).toBe(true);
    expect(DISALLOWED_SKILL_NAMES.has('babysit')).toBe(true);
    expect(DISALLOWED_SKILL_NAMES.has('loop')).toBe(true);
    expect(DISALLOWED_SKILL_NAMES.has('statusline')).toBe(true);
    expect(DISALLOWED_SKILL_NAMES.has('update-cli-config')).toBe(true);

    expect(isDisallowedSkillName('disk-cleanup')).toBe(true);
    expect(isDisallowedSkillName('babysit')).toBe(true);
    expect(isDisallowedSkillName('loop')).toBe(true);
    expect(isDisallowedSkillName('statusline')).toBe(true);
    expect(isDisallowedSkillName('update-cli-config')).toBe(true);
    expect(isDisallowedSkillName('update-cursor-settings')).toBe(true);
    expect(isDisallowedSkillName('firecrawl-scrape')).toBe(true);
    expect(isDisallowedSkillName('firecrawl-agent')).toBe(true);
    expect(isDisallowedSkillName('automation')).toBe(true);

    // 标准通用技能绝不可被误判为禁用
    expect(isDisallowedSkillName('code-review')).toBe(false);
    expect(isDisallowedSkillName('repo-to-resume-tailor')).toBe(false);
    expect(isDisallowedSkillName('resume-master')).toBe(false);
    expect(isDisallowedSkillName('chinese-encoding-guard')).toBe(false);
    expect(isDisallowedSkillName('de-ai-academic-cn')).toBe(false);
  });

  it('validates skill quality with isQualifiedSkill', () => {
    // 禁用名称
    expect(isQualifiedSkill({ name: 'disk-cleanup' })).toBe(false);
    expect(isQualifiedSkill({ name: 'babysit' })).toBe(false);

    // 内置或系统路径
    expect(
      isQualifiedSkill({
        name: 'my-tool',
        filePath: '/app/builtin/skills/my-tool/SKILL.md',
      })
    ).toBe(false);

    // 内容太短或空正文
    expect(
      isQualifiedSkill({
        name: 'custom-tool',
        content: '',
      })
    ).toBe(false);
    expect(
      isQualifiedSkill({
        name: 'custom-tool',
        content: 'too short',
      })
    ).toBe(false);

    // 显式禁用模型调用的技能
    expect(
      isQualifiedSkill({
        name: 'custom-tool',
        content:
          '---\nname: custom-tool\ndisable-model-invocation: true\n---\n这是一段很长的说明文字但是模型调用被禁用了',
      })
    ).toBe(false);

    // 合格技能
    expect(
      isQualifiedSkill({
        name: 'code-review',
        content:
          '---\nname: code-review\ndescription: 智能代码检视\n---\n这是一段长达五十字的专业代码检视指导说明，包含详细步骤与规范。',
      })
    ).toBe(true);
  });

  it('filters out impure and empty skills during external directory scanning', async () => {
    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_list_directory' &&
          args?.path?.includes('.agents/skills')
        ) {
          return {
            status: 'ok',
            data: {
              items: [
                { name: 'babysit', is_dir: true },
                { name: 'loop', is_dir: true },
                { name: 'statusline', is_dir: true },
                { name: 'empty-skill', is_dir: true },
                { name: 'qualified-custom', is_dir: true },
              ],
            },
          } as any;
        }
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('qualified-custom/SKILL.md')
        ) {
          return {
            status: 'ok',
            data: {
              content:
                '---\nname: qualified-custom\ndescription: 合格的自定义技能\n---\n这是一段长达五十字的合格技能正文内容，指导模型如何执行特定任务。',
            },
          } as any;
        }
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('empty-skill/SKILL.md')
        ) {
          return {
            status: 'ok',
            data: {
              content: '',
            },
          } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalSkills({ fallback: false });
    const names = result.map((s) => s.name);
    expect(names).not.toContain('babysit');
    expect(names).not.toContain('loop');
    expect(names).not.toContain('statusline');
    expect(names).not.toContain('empty-skill');
    expect(names).toContain('qualified-custom');
  });
});
