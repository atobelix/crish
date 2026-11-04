// 与桌面端 deviceIdentity.test.ts 同构的关键用例（jest 口径）：
// 两端解析引擎逐字同源，此处钉住用户现场设备与命名升降级口径，
// 任一端规则漂移先在此变红。
import { parseDeviceInfo, resolveDeviceDisplayNames } from './deviceIdentity';

describe('deviceIdentity 设备身份解析引擎', () => {
  it('正确解析电脑操作系统与计算机名', () => {
    const pc = parseDeviceInfo({
      deviceName: 'DESKTOP-R7P8N9 · Windows',
      userAgent: 'Crish/1.0 (Windows NT 10.0; Win64; x64)',
    });
    expect(pc.category).toBe('desktop');
    expect(pc.computerName).toBe('DESKTOP-R7P8N9');
    expect(pc.os).toBe('Windows 11');
    expect(pc.displayName).toBe('DESKTOP-R7P8N9 · Windows 11');
  });

  it('正确解析笔记本与 macOS', () => {
    const mac = parseDeviceInfo({
      deviceName: 'MacBook Pro',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });
    expect(mac.category).toBe('laptop');
    expect(mac.os).toBe('macOS');
  });

  it('手机精确展示具体型号（如 iPhone 15 Pro、小米 14），无型号时回落展示系列', () => {
    const resolved = resolveDeviceDisplayNames([
      {
        name: 'iPhone 15 Pro',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)',
      },
      {
        name: 'Xiaomi 14',
        userAgent: 'Mozilla/5.0 (Linux; Android 14; 23116PN5BC)',
      },
      {
        name: 'iPhone',
        userAgent: 'Mozilla/5.0 (iPhone; CPU OS 15_0 like Mac OS X)',
      },
    ]);
    expect(resolved[0]!.parsed.displayName).toBe('iPhone 15 Pro');
    expect(resolved[1]!.parsed.displayName).toBe('小米 14');
    expect(resolved[2]!.parsed.displayName).toBe('iPhone');
  });

  it('多部手机各自精确展示具体型号', () => {
    const resolved = resolveDeviceDisplayNames([
      {
        name: 'iPhone 15 Pro',
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) iPhone16,1',
      },
      {
        name: 'iPhone 13',
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) iPhone14,5',
      },
      { name: 'DESKTOP-PC', userAgent: 'Windows NT 10.0' },
    ]);
    expect(resolved[0]!.parsed.displayName).toBe('iPhone 15 Pro');
    expect(resolved[1]!.parsed.displayName).toBe('iPhone 13');
    expect(resolved[2]!.parsed.displayName).toContain('DESKTOP-PC');
  });

  it('精准识别用户现场的华为 P40 Pro (ELS-AN00)，杜绝误识别为电脑', () => {
    const p40 = parseDeviceInfo({ deviceName: 'ELS-AN00' });
    expect(p40.category).toBe('phone');
    expect(p40.series).toBe('华为 P 系列');
    expect(p40.model).toBe('华为 P40 Pro');
    // 精确展示型号
    expect(p40.displayName).toBe('华为 P40 Pro');
  });

  it('多部手机均精确展示具体型号，即使相同型号多次登录', () => {
    const mixed = resolveDeviceDisplayNames([
      { name: 'ELS-AN00' },
      { name: 'JAD-AL50' },
    ]);
    expect(mixed[0]!.parsed.displayName).toBe('华为 P40 Pro');
    expect(mixed[1]!.parsed.displayName).toBe('华为 P50');

    const dup = resolveDeviceDisplayNames([
      { name: 'ELS-AN00' },
      { name: 'ELS-AN00' },
    ]);
    expect(dup[0]!.parsed.displayName).toBe('华为 P40 Pro');
    expect(dup[1]!.parsed.displayName).toBe('华为 P40 Pro');
  });

  it('空输入回落「设备」，当前设备无名时回落「当前电脑」', () => {
    expect(parseDeviceInfo({}).displayName).toBe('设备');
    expect(parseDeviceInfo({ isCurrent: true }).displayName).toBe('当前电脑');
  });
});
