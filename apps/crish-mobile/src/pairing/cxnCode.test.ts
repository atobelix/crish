// CXN 码规范单测（D3 §4.1 / pair.rs PairCode 语义对拍）
// 覆盖：标准化容错（大小写/前缀/分隔符/空白）、非法字符（0/O/1/I/L）、
// 长度错误、前缀误剥防护、display 回显、生成（字符集/格式/注入随机源）

import {
  formatPairCode,
  generatePairCode,
  isValidPairCode,
  normalizePairCode,
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
} from './cxnCode';

describe('normalizePairCode（pair.rs PairCode::normalize 语义对拍）', () => {
  it('大小写 / 前缀 / 分隔符 / 空白全部容错并归一为 12 位大写', () => {
    const cases = [
      'CXN-7K4P-Q2MB-9XRT',
      'cxn-7k4p-q2mb-9xrt',
      '7K4P-Q2MB-9XRT',
      '7K4PQ2MB9XRT',
      ' cxn-7k4p-q2mb-9xrt ',
      '7k4p-q2mb-9xrt',
    ];
    for (const raw of cases) {
      const r = normalizePairCode(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data).toBe('7K4PQ2MB9XRT');
      }
    }
  });

  it('长度错误拒绝（12 位是硬约束）', () => {
    expect(normalizePairCode('7K4PQ2MB9XRTE').ok).toBe(false); // 13 位
    expect(normalizePairCode('SHORT12').ok).toBe(false); // 短码
    expect(normalizePairCode('').ok).toBe(false);
    expect(normalizePairCode('12345678901').ok).toBe(false); // 11 位
    expect(normalizePairCode('1234567890123').ok).toBe(false); // 13 位
  });

  it('非法字符拒绝（含 0/O/1/I/L 混淆字符）', () => {
    expect(normalizePairCode('7K4PQ2MB9XR0').ok).toBe(false); // 含 0
    expect(normalizePairCode('CXN-7K4P-Q2MB-9XLO').ok).toBe(false); // 含 L/O
    expect(normalizePairCode('CXN-7K4P-Q21B-9XRT').ok).toBe(false); // 含 1
    expect(normalizePairCode('CXN-7K4P-Q2MB-9XII').ok).toBe(false); // 含 I
    expect(normalizePairCode('1234-5678-90AB').ok).toBe(false); // 含 0/1
  });

  it('前缀误剥防护：裸 12 位码以 CXN 起头属正常码，不得剥前缀', () => {
    // "CXN" + 9 位合法字符 = 12 位裸码：长度不超 12，不触发剥前缀
    const r = normalizePairCode('CXN7K4PQ2MB9');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toBe('CXN7K4PQ2MB9');
    }
    // 13+ 位以 CXN 起头（如带前缀的分隔输入）才剥前缀：已在容错用例覆盖，
    // 此处再显式验证剥前缀产物长度恰为 12
    const stripped = normalizePairCode('CXN-7K4P-Q2MB-9XRT');
    expect(stripped).toEqual({ ok: true, data: '7K4PQ2MB9XRT' });
  });

  it('isValidPairCode 与 normalizePairCode 同真值', () => {
    expect(isValidPairCode('CXN-7K4P-Q2MB-9XRT')).toBe(true);
    expect(isValidPairCode('not-a-code')).toBe(false);
    expect(isValidPairCode('')).toBe(false);
  });
});

describe('formatPairCode（display 回显，pair.rs PairCode::display 对拍）', () => {
  it('12 位码 → CXN-XXXX-XXXX-XXXX', () => {
    const r = formatPairCode('7K4PQ2MB9XRT');
    expect(r).toEqual({ ok: true, data: 'CXN-7K4P-Q2MB-9XRT' });
  });

  it('容错输入同样可格式化（先归一后分组）', () => {
    const r = formatPairCode('cxn-7k4p-q2mb-9xrt');
    expect(r).toEqual({ ok: true, data: 'CXN-7K4P-Q2MB-9XRT' });
  });

  it('非法输入返回错误', () => {
    expect(formatPairCode('bad!').ok).toBe(false);
    expect(formatPairCode('123456789012').ok).toBe(false); // 长度 12 但含 1/0 非法字符
  });
});

describe('generatePairCode（字符集均匀采样）', () => {
  it('生成的码恰 12 位且全部字符来自字符集', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const code = generatePairCode();
      expect(code.length).toBe(PAIR_CODE_LENGTH);
      for (const c of code) {
        expect(PAIR_CODE_ALPHABET).toContain(c);
      }
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(1); // 随机性冒烟：200 次不应全相同
  });

  it('注入确定性随机源 → 可复现（rand 返回固定索引）', () => {
    // rand 恒返回 0 → 全部取字符集第 0 个字符（A 的 12 连）
    const zero = generatePairCode(() => 0);
    expect(zero).toBe('AAAAAAAAAAAA');
    // rand 恒返回 1 → 越界钳制到末位字符（9）
    const one = generatePairCode(() => 1);
    expect(one).toBe('999999999999');
  });

  it('生成的码可经 normalizePairCode 往返', () => {
    for (let i = 0; i < 20; i += 1) {
      const code = generatePairCode();
      const r = normalizePairCode(code);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data).toBe(code);
      }
    }
  });
});
