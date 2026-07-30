import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { formatSkillInvocation, loadSkillsFromDirectory } from './skills';

describe('skill loader', () => {
  it('loads Agent Skills compatible SKILL.md files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-runtime-skill-'));
    const skillDir = join(root, 'reviewer');
    await mkdir(skillDir);
    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: reviewer',
        'description: Review code changes',
        'disable-model-invocation: false',
        'scope: project',
        'activation: recommended',
        'applies-to: tag:typescript, package:@crish/agent-runtime',
        'tags: review, code-quality',
        '---',
        '# Reviewer',
        'Check correctness first.',
      ].join('\n'),
      'utf8'
    );

    const result = await loadSkillsFromDirectory(root);
    expect(result.skills).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.skills[0]).toMatchObject({
      name: 'reviewer',
      description: 'Review code changes',
      scope: 'project',
      activation: 'recommended',
      appliesTo: ['tag:typescript', 'package:@crish/agent-runtime'],
      tags: ['review', 'code-quality'],
    });
    expect(
      formatSkillInvocation(result.skills[0]!, 'focus on tests')
    ).toContain('<skill name="reviewer"');
  });

  it('returns diagnostics for invalid, oversized, and binary skill files', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'agent-runtime-skill-diagnostics-')
    );
    const invalidDir = join(root, 'invalid');
    const hugeDir = join(root, 'huge');
    const binaryDir = join(root, 'binary');
    await mkdir(invalidDir);
    await mkdir(hugeDir);
    await mkdir(binaryDir);
    await writeFile(
      join(invalidDir, 'SKILL.md'),
      [
        '---',
        'name: Bad Name',
        'description: Invalid skill',
        '---',
        '# Invalid',
        'Still loadable.',
      ].join('\n'),
      'utf8'
    );
    await writeFile(join(hugeDir, 'SKILL.md'), 'large '.repeat(300), 'utf8');
    await writeFile(join(binaryDir, 'SKILL.md'), Buffer.from([0, 1, 2, 3]));

    const result = await loadSkillsFromDirectory(root, { maxSkillBytes: 1024 });

    expect(result.skills.map((skill) => skill.name)).toEqual(['Bad Name']);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'skill-name-invalid',
        'skill-file-too-large',
        'skill-file-binary',
      ])
    );
  });
});
