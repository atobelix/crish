/**
 * Golden vectors for skillStableId / hashTextSha256Hex.
 * Run from monorepo root:
 *   node --experimental-strip-types apps/crish-desktop/scripts/skillId.selftest.mjs
 * or from apps/crish-desktop:
 *   node --experimental-strip-types scripts/skillId.selftest.mjs
 */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillIdUrl = pathToFileURL(join(__dirname, '../src/api/skillId.ts')).href;

const { hashTextSha256Hex, skillStableId } = await import(skillIdUrl);

function nodeSha(value) {
  return createHash('sha256').update(value).digest('hex');
}

const cases = [
  '',
  'abc',
  'my-skill:/tmp/x/SKILL.md',
  'name:C:\\Users\\foo\\SKILL.md',
  '中文:skill',
  'a'.repeat(1000),
];

let failed = 0;
for (const c of cases) {
  const expect = nodeSha(c);
  const got = hashTextSha256Hex(c);
  if (got !== expect) {
    failed += 1;
    console.error('FAIL hash', JSON.stringify(c.slice(0, 40)), '\n  got   ', got, '\n  expect', expect);
  } else {
    console.log('OK  hash', JSON.stringify(c.slice(0, 40)));
  }
}

const goldenSkillId = skillStableId('my-skill', '/tmp/x/SKILL.md');
const expectSkillId = `skill_${nodeSha('my-skill:/tmp/x/SKILL.md').slice(0, 12)}`;
if (goldenSkillId !== expectSkillId || goldenSkillId !== 'skill_95cfb221d00f') {
  failed += 1;
  console.error('FAIL skillStableId', goldenSkillId, 'expected', expectSkillId);
} else {
  console.log('OK  skillStableId', goldenSkillId);
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll golden vectors passed.');
