// 二维码载荷解析单测（对齐 Rust pairing.rs qr_data_for 格式 + 非法格式兜底）
// 覆盖：合法解析（IPv4/主机名/带前缀码/小写容错）、scheme 错误、缺 @、
// 缺 host:port、端口非法（非数字/越界）、code 非法、formatQrPayload 对称往返

import {
  formatQrPayload,
  parseQrPayload,
  QR_MAX_PORT,
  QR_MIN_PORT,
} from './qrPayload';

describe('parseQrPayload（crish-pair:// 载荷，Rust qr_data_for 对拍）', () => {
  it('解析标准载荷 → { code, host, port }（code 为标准化 12 位）', () => {
    const r = parseQrPayload(
      'crish-pair://CXN-7K4P-Q2MB-9XRT@192.168.1.23:8765'
    );
    expect(r).toEqual({
      ok: true,
      data: { code: '7K4PQ2MB9XRT', host: '192.168.1.23', port: 8765 },
    });
  });

  it('code 段容错：小写 / 无前缀 / 无分隔符均可解析', () => {
    const cases = [
      'crish-pair://cxn-7k4p-q2mb-9xrt@192.168.1.23:8765',
      'crish-pair://7K4P-Q2MB-9XRT@192.168.1.23:8765',
      'crish-pair://7K4PQ2MB9XRT@192.168.1.23:8765',
    ];
    for (const raw of cases) {
      const r = parseQrPayload(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.code).toBe('7K4PQ2MB9XRT');
        expect(r.data.host).toBe('192.168.1.23');
        expect(r.data.port).toBe(8765);
      }
    }
  });

  it('主机名与端口边界（1 / 65535）可解析', () => {
    const r1 = parseQrPayload(
      'crish-pair://CXN-7K4P-Q2MB-9XRT@crish-desktop.local:1'
    );
    expect(r1).toEqual({
      ok: true,
      data: { code: '7K4PQ2MB9XRT', host: 'crish-desktop.local', port: 1 },
    });
    const r2 = parseQrPayload(
      `crish-pair://CXN-7K4P-Q2MB-9XRT@10.0.0.8:${QR_MAX_PORT}`
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.data.port).toBe(QR_MAX_PORT);
    }
  });

  it('scheme 错误拒绝（含文档早期 conex-pair 形态）', () => {
    expect(
      parseQrPayload('conex-pair://CXN-7K4P-Q2MB-9XRT@192.168.1.23:8765').ok
    ).toBe(false);
    expect(parseQrPayload('http://192.168.1.23:8765').ok).toBe(false);
    expect(parseQrPayload('crish-pair').ok).toBe(false);
    expect(parseQrPayload('crish-pair://').ok).toBe(false);
  });

  it('缺 @ 分隔 / 缺 host:port / host 空 → 拒绝', () => {
    expect(parseQrPayload('crish-pair://CXN-7K4P-Q2MB-9XRT@').ok).toBe(false);
    expect(parseQrPayload('crish-pair://CXN-7K4P-Q2MB-9XRT').ok).toBe(false);
    expect(parseQrPayload('crish-pair://@192.168.1.23:8765').ok).toBe(false);
    expect(parseQrPayload('crish-pair://CXN-7K4P-Q2MB-9XRT@:8765').ok).toBe(
      false
    );
    expect(
      parseQrPayload('crish-pair://CXN-7K4P-Q2MB-9XRT@192.168.1.23:').ok
    ).toBe(false);
  });

  it('端口非法拒绝（非数字 / 越界）', () => {
    expect(
      parseQrPayload('crish-pair://CXN-7K4P-Q2MB-9XRT@192.168.1.23:abc').ok
    ).toBe(false);
    expect(
      parseQrPayload('crish-pair://CXN-7K4P-Q2MB-9XRT@192.168.1.23:0').ok
    ).toBe(false);
    expect(
      parseQrPayload('crish-pair://CXN-7K4P-Q2MB-9XRT@192.168.1.23:65536').ok
    ).toBe(false);
    expect(
      parseQrPayload('crish-pair://CXN-7K4P-Q2MB-9XRT@192.168.1.23:8765.0').ok
    ).toBe(false);
  });

  it('code 段非法拒绝（非法字符 / 长度错）', () => {
    expect(
      parseQrPayload('crish-pair://BAD-CODE-0123@192.168.1.23:8765').ok
    ).toBe(false);
    expect(
      parseQrPayload('crish-pair://CXN-7K4P-Q2MB@192.168.1.23:8765').ok
    ).toBe(false);
  });
});

describe('formatQrPayload（对称面：Rust qr_data_for 逐字节对拍）', () => {
  it('构造载荷与 Rust 生成形态一致', () => {
    const r = formatQrPayload({
      code: '7K4PQ2MB9XRT',
      host: '192.168.1.23',
      port: 8765,
    });
    expect(r).toEqual({
      ok: true,
      data: 'crish-pair://CXN-7K4P-Q2MB-9XRT@192.168.1.23:8765',
    });
  });

  it('code 容错输入（展示形态）同样构造', () => {
    const r = formatQrPayload({
      code: 'cxn-7k4p-q2mb-9xrt',
      host: '10.0.0.8',
      port: 8765,
    });
    expect(r).toEqual({
      ok: true,
      data: 'crish-pair://CXN-7K4P-Q2MB-9XRT@10.0.0.8:8765',
    });
  });

  it('非法输入拒绝（code 非法 / host 空 / port 越界）', () => {
    expect(formatQrPayload({ code: 'bad!', host: 'h', port: 8765 }).ok).toBe(
      false
    );
    expect(
      formatQrPayload({ code: '7K4PQ2MB9XRT', host: '', port: 8765 }).ok
    ).toBe(false);
    expect(
      formatQrPayload({ code: '7K4PQ2MB9XRT', host: 'h', port: 0 }).ok
    ).toBe(false);
    expect(
      formatQrPayload({
        code: '7K4PQ2MB9XRT',
        host: 'h',
        port: QR_MIN_PORT - 1,
      }).ok
    ).toBe(false);
    expect(
      formatQrPayload({
        code: '7K4PQ2MB9XRT',
        host: 'h',
        port: QR_MAX_PORT + 1,
      }).ok
    ).toBe(false);
  });

  it('formatQrPayload → parseQrPayload 往返一致', () => {
    const built = formatQrPayload({
      code: '7K4PQ2MB9XRT',
      host: '192.168.1.23',
      port: 8765,
    });
    if (!built.ok) {
      throw new Error('构造失败');
    }
    const parsed = parseQrPayload(built.data);
    expect(parsed).toEqual({
      ok: true,
      data: { code: '7K4PQ2MB9XRT', host: '192.168.1.23', port: 8765 },
    });
  });
});
