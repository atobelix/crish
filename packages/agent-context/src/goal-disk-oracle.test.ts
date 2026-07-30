import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateDiskOracle } from './goal-disk-oracle';

describe('goal-disk-oracle', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))
    );
  });

  it('passes when required files exist and contain expected text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oracle-'));
    dirs.push(dir);
    await writeFile(join(dir, 'out.txt'), 'goal complete marker\n', 'utf8');
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify({ status: 'ok' }),
      'utf8'
    );

    const result = await evaluateDiskOracle({
      cwd: dir,
      checks: [
        { kind: 'exists', path: 'out.txt' },
        { kind: 'contains', path: 'out.txt', substring: 'goal complete' },
        {
          kind: 'json-path',
          path: 'result.json',
          pointer: '/status',
          equals: 'ok',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(3);
  });

  it('fails when evidence is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oracle-'));
    dirs.push(dir);

    const result = await evaluateDiskOracle({
      cwd: dir,
      checks: [{ kind: 'exists', path: 'missing.txt' }],
    });

    expect(result.ok).toBe(false);
    expect(result.checks[0]?.ok).toBe(false);
  });
});
