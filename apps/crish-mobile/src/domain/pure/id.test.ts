// 客户端幂等 id 生成单测（D4 §12.3 utils/id.ts）：
// 格式（prefix 前缀 + 时间基 + 序列 + 随机段）、前缀覆盖、进程内唯一性。
import { nextId } from './id';

describe('nextId（D4 §12.3 客户端幂等 id）', () => {
  it('缺省前缀为 id，且格式为 <prefix>_<base36>', () => {
    const id = nextId();
    expect(id.startsWith('id_')).toBe(true);
    expect(id.length).toBeGreaterThan('id_'.length);
    // 除前缀外全部为 base36 字符（数字 + 小写字母）
    expect(/^id_[0-9a-z]+$/.test(id)).toBe(true);
  });

  it('自定义前缀（msgId / requestId 等业务前缀）', () => {
    expect(nextId('msgId').startsWith('msgId_')).toBe(true);
    expect(nextId('requestId').startsWith('requestId_')).toBe(true);
    expect(nextId('').startsWith('_')).toBe(true);
  });

  it('进程内唯一性：连续生成不重复（随机段 + 序列兜底）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = nextId('op');
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});
