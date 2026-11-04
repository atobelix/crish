import { describe, expect, it } from 'vitest';
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
    const items = [
      {
        id: '1',
        name: 'iPhone 15 Pro',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)',
      },
      {
        id: '2',
        name: 'Xiaomi 14',
        userAgent: 'Mozilla/5.0 (Linux; Android 14; 23116PN5BC)',
      },
      {
        id: '3',
        name: 'iPhone',
        userAgent: 'Mozilla/5.0 (iPhone; CPU OS 15_0 like Mac OS X)',
      },
    ];

    const resolved = resolveDeviceDisplayNames(items);
    // 精确型号手机直接展示具体型号
    expect(resolved[0].parsed.displayName).toBe('iPhone 15 Pro');
    expect(resolved[1].parsed.displayName).toBe('小米 14');
    // 无法提取具体代数的 iPhone 回落展示系列 "iPhone"
    expect(resolved[2].parsed.displayName).toBe('iPhone');
  });

  it('多部同系列手机时，升级展示具体型号以区分重复', () => {
    const items = [
      {
        id: '1',
        name: 'iPhone 15 Pro',
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) iPhone16,1',
      },
      {
        id: '2',
        name: 'iPhone 13',
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) iPhone14,5',
      },
      {
        id: '3',
        name: 'DESKTOP-PC',
        userAgent: 'Windows NT 10.0',
      },
    ];

    const resolved = resolveDeviceDisplayNames(items);
    // 出现两台 iPhone，升级展示为具体型号
    expect(resolved[0].parsed.displayName).toBe('iPhone 15 Pro');
    expect(resolved[1].parsed.displayName).toBe('iPhone 13');
    // 电脑展示设备名
    expect(resolved[2].parsed.displayName).toContain('DESKTOP-PC');
  });

  it('支持根据国内型号代码解析（如小米 14、华为 Mate 60 Pro）', () => {
    const huawei = parseDeviceInfo({
      userAgent:
        'Mozilla/5.0 (Linux; Android 12; ALN-AL80 Build/HUAWEIALN-AL80)',
    });
    expect(huawei.series).toBe('华为 Mate 系列');
    expect(huawei.model).toBe('华为 Mate 60 Pro');

    const xiaomi = parseDeviceInfo({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; 23116PN5BC Build/UKQ1.230804.001)',
    });
    expect(xiaomi.series).toBe('小米手机');
    expect(xiaomi.model).toBe('小米 14');
  });

  it('精准识别用户现场出现的华为 P40 Pro (ELS-AN00) 和 P50 (JAD-AL50)，杜绝误识别为电脑', () => {
    const p40 = parseDeviceInfo({
      deviceName: 'ELS-AN00',
    });
    expect(p40.category).toBe('phone');
    expect(p40.series).toBe('华为 P 系列');
    expect(p40.model).toBe('华为 P40 Pro');

    const p50 = parseDeviceInfo({
      deviceName: 'JAD-AL50',
    });
    expect(p50.category).toBe('phone');
    expect(p50.series).toBe('华为 P 系列');
    expect(p50.model).toBe('华为 P50');

    // 识别为华为精确型号：P40 Pro 和 P50
    const resolved = resolveDeviceDisplayNames([
      { id: '1', name: 'ELS-AN00' },
      { id: '2', name: 'JAD-AL50' },
    ]);
    expect(resolved[0].parsed.displayName).toBe('华为 P40 Pro');
    expect(resolved[1].parsed.displayName).toBe('华为 P50');
  });

  it('同一手机型号多次登录时保持精准型号（如 华为 P40 Pro），用户明确要求精确到型号', () => {
    const resolved = resolveDeviceDisplayNames([
      { id: '1', name: 'ELS-AN00' },
      { id: '2', name: 'ELS-AN00' },
    ]);
    expect(resolved[0].parsed.displayName).toBe('华为 P40 Pro');
    expect(resolved[1].parsed.displayName).toBe('华为 P40 Pro');
  });
});
