/**
 * 设备身份识别与解析引擎
 *
 * 与桌面端 apps/crish-desktop/src/components/account/deviceIdentity.ts
 * 同源同逻辑（逐字移植，2026-11-03）：用户裁决「设备描述以桌面端为真源」，
 * 两端必须产出同一描述——解析规则、型号字典、命名升降级口径只许在此类
 * 单一实现内演进，禁止在呈现层另写近似解析。桌面侧规则变更时须同步回
 * 本文件（反之亦然），deviceIdentity.test.ts 的关键用例与桌面同构。
 *
 * 职责：
 * 1. 深度解析 User-Agent、设备名、平台代号，准确识别设备类型（电脑/手机/平板）；
 * 2. 手机端：精准识别华为、小米、苹果、三星、vivo、OPPO 等品牌、系列与具体型号；
 * 3. 电脑端：精准识别 Windows (11/10)、macOS、Linux，提取计算机名与设备名；
 * 4. 智能排重与动态升降级：手机优先展示系列；当列表中出现同系列的多台手机时，自动升级显示为具体型号以做区分！
 */

export type DeviceCategory =
  'desktop' | 'laptop' | 'phone' | 'tablet' | 'unknown';

export interface ParsedDeviceInfo {
  category: DeviceCategory;
  /** 品牌（如 Apple, Xiaomi, HUAWEI, Samsung 等） */
  brand?: string;
  /** 系列名称（如 iPhone, 华为 P 系列, 华为 Mate 系列, 小米手机, Galaxy S 系列） */
  series: string;
  /** 具体型号（如 华为 P40 Pro, 华为 P50, iPhone 15 Pro, 小米 14） */
  model?: string;
  /** 电脑设备名 / 计算机名（如 DESKTOP-R7P8N9） */
  computerName?: string;
  /** 操作系统名称（如 Windows 11, macOS, Linux） */
  os?: string;
  /** 最终展示名称 */
  displayName: string;
}

// ── 知名手机型号代号静态字典 ──────────────────────────────────────

const EXACT_PHONE_MODELS: Record<
  string,
  { brand: string; series: string; model: string }
> = {
  // 华为 P 系列
  'ELS-AN00': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P40 Pro' },
  'ELS-TN00': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P40 Pro' },
  'ELS-AN10': {
    brand: 'HUAWEI',
    series: '华为 P 系列',
    model: '华为 P40 Pro+',
  },
  'ANA-AN00': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P40' },
  'ANA-TN00': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P40' },
  'JAD-AL50': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P50' },
  'JAD-AL00': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P50' },
  'JAD-AN00': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P50' },
  'JAD-AL60': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P50E' },
  'ABR-AL00': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P50 Pro' },
  'ABR-AL60': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P50 Pro' },
  'VOG-AL00': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P30' },
  'VOG-AL10': { brand: 'HUAWEI', series: '华为 P 系列', model: '华为 P30 Pro' },
  // 华为 Pura 系列
  'BRA-AL00': {
    brand: 'HUAWEI',
    series: '华为 P/Pura 系列',
    model: '华为 Pura 70',
  },
  'HBP-AL00': {
    brand: 'HUAWEI',
    series: '华为 P/Pura 系列',
    model: '华为 Pura 70 Pro',
  },
  'HBN-AL00': {
    brand: 'HUAWEI',
    series: '华为 P/Pura 系列',
    model: '华为 Pura 70 Ultra',
  },
  // 华为 Mate 系列
  'ALN-AL00': {
    brand: 'HUAWEI',
    series: '华为 Mate 系列',
    model: '华为 Mate 60',
  },
  'ALN-AL80': {
    brand: 'HUAWEI',
    series: '华为 Mate 系列',
    model: '华为 Mate 60 Pro',
  },
  'ALN-AL10': {
    brand: 'HUAWEI',
    series: '华为 Mate 系列',
    model: '华为 Mate 60 RS',
  },
  'NOH-AN00': {
    brand: 'HUAWEI',
    series: '华为 Mate 系列',
    model: '华为 Mate 40 Pro',
  },
  'NOP-AN00': {
    brand: 'HUAWEI',
    series: '华为 Mate 系列',
    model: '华为 Mate 40 Pro+',
  },
  'TAS-AN00': {
    brand: 'HUAWEI',
    series: '华为 Mate 系列',
    model: '华为 Mate 30',
  },
  'LIO-AN00': {
    brand: 'HUAWEI',
    series: '华为 Mate 系列',
    model: '华为 Mate 30 Pro',
  },
  // 小米 / Redmi 系列
  '23116PN5BC': { brand: 'Xiaomi', series: '小米手机', model: '小米 14' },
  '23127PN0CC': { brand: 'Xiaomi', series: '小米手机', model: '小米 14 Pro' },
  '24031PN0DC': { brand: 'Xiaomi', series: '小米手机', model: '小米 14 Ultra' },
  '24129PN74C': { brand: 'Xiaomi', series: '小米手机', model: '小米 15' },
  '24127PN0CC': { brand: 'Xiaomi', series: '小米手机', model: '小米 15 Pro' },
  '2311DRK48C': { brand: 'Xiaomi', series: 'Redmi K 系列', model: 'Redmi K70' },
  '2407FRK8EC': {
    brand: 'Xiaomi',
    series: 'Redmi K 系列',
    model: 'Redmi K70 至尊版',
  },
  '22127RK46C': {
    brand: 'Xiaomi',
    series: 'Redmi K 系列',
    model: 'Redmi K60 Pro',
  },
  // Apple iPhone 内部标识
  'iphone16,1': { brand: 'Apple', series: 'iPhone', model: 'iPhone 15 Pro' },
  'iphone16,2': {
    brand: 'Apple',
    series: 'iPhone',
    model: 'iPhone 15 Pro Max',
  },
  'iphone15,4': { brand: 'Apple', series: 'iPhone', model: 'iPhone 15' },
  'iphone15,5': { brand: 'Apple', series: 'iPhone', model: 'iPhone 15 Plus' },
  'iphone15,2': { brand: 'Apple', series: 'iPhone', model: 'iPhone 14 Pro' },
  'iphone15,3': {
    brand: 'Apple',
    series: 'iPhone',
    model: 'iPhone 14 Pro Max',
  },
  'iphone14,7': { brand: 'Apple', series: 'iPhone', model: 'iPhone 14' },
  'iphone14,8': { brand: 'Apple', series: 'iPhone', model: 'iPhone 14 Plus' },
  'iphone14,2': { brand: 'Apple', series: 'iPhone', model: 'iPhone 13 Pro' },
  'iphone14,3': {
    brand: 'Apple',
    series: 'iPhone',
    model: 'iPhone 13 Pro Max',
  },
  'iphone14,5': { brand: 'Apple', series: 'iPhone', model: 'iPhone 13' },
  'iphone13,2': { brand: 'Apple', series: 'iPhone', model: 'iPhone 12' },
  'iphone13,3': { brand: 'Apple', series: 'iPhone', model: 'iPhone 12 Pro' },
};

// ── 手机正则规则库 ──────────────────────────────────────────

interface PhoneRegexRule {
  brand: string;
  series: string;
  pattern: RegExp;
  extractModel: (match: RegExpExecArray) => string;
}

const PHONE_REGEX_RULES: PhoneRegexRule[] = [
  // Apple iPhone
  {
    brand: 'Apple',
    series: 'iPhone',
    pattern:
      /iPhone\s*(1[1-7](?:\s*(?:Pro\s*Max|Pro|Plus|mini))?|[X|V|I|S|E]+(?:\s*Max)?)/i,
    extractModel: (m) => `iPhone ${(m[1] ?? '').trim()}`,
  },
  {
    brand: 'Apple',
    series: 'iPhone',
    pattern: /\biPhone\b/i,
    extractModel: () => 'iPhone',
  },
  // 小米 / Redmi
  {
    brand: 'Xiaomi',
    series: '小米手机',
    pattern: /(?:Xiaomi|MI)\s*([0-9]{1,2}(?:\s*(?:Ultra|Pro|Lite))?)/i,
    extractModel: (m) => `小米 ${(m[1] ?? '').trim()}`,
  },
  {
    brand: 'Xiaomi',
    series: 'Redmi K 系列',
    pattern: /Redmi\s*K([0-9]{2}(?:\s*(?:Pro|Ultra|Gaming))?)/i,
    extractModel: (m) => `Redmi K${(m[1] ?? '').trim()}`,
  },
  {
    brand: 'Xiaomi',
    series: 'Redmi Note 系列',
    pattern: /Redmi\s*Note\s*([0-9]{1,2}(?:\s*(?:Pro\+|Pro|Turbo))?)/i,
    extractModel: (m) => `Redmi Note ${(m[1] ?? '').trim()}`,
  },
  // 华为 Mate 系列
  {
    brand: 'HUAWEI',
    series: '华为 Mate 系列',
    pattern: /(?:HUAWEI\s*)?Mate\s*([0-9]{2}(?:\s*(?:Pro\+|Pro|RS|E))?)/i,
    extractModel: (m) => `华为 Mate ${(m[1] ?? '').trim()}`,
  },
  // 华为 P / Pura 系列
  {
    brand: 'HUAWEI',
    series: '华为 P/Pura 系列',
    pattern:
      /(?:HUAWEI\s*)?(?:Pura|P)\s*([0-9]{2}(?:\s*(?:Ultra|Pro\+|Pro|Art))?)/i,
    extractModel: (m) => `华为 Pura ${(m[1] ?? '').trim()}`,
  },
  // 华为 nova 系列
  {
    brand: 'HUAWEI',
    series: '华为 nova 系列',
    pattern: /(?:HUAWEI\s*)?nova\s*([0-9]{1,2}(?:\s*(?:Pro|Ultra|SE))?)/i,
    extractModel: (m) => `华为 nova ${(m[1] ?? '').trim()}`,
  },
  // 三星 Galaxy S / Z
  {
    brand: 'Samsung',
    series: 'Galaxy S 系列',
    pattern: /(?:Galaxy\s*)?S(2[0-4](?:\s*(?:Ultra|Plus|\+|FE))?)/i,
    extractModel: (m) => `Galaxy S${(m[1] ?? '').trim()}`,
  },
  {
    brand: 'Samsung',
    series: 'Galaxy Z 系列',
    pattern: /(?:Galaxy\s*)?Z\s*(Fold|Flip)\s*([0-9])/i,
    extractModel: (m) => `Galaxy Z ${m[1] ?? ''} ${m[2] ?? ''}`,
  },
  {
    brand: 'Samsung',
    series: 'Galaxy S 系列',
    pattern: /SM-S(9[0-2][168][0-9A-Z]?)/i,
    extractModel: (m) => {
      const sub = (m[1] ?? '').substring(0, 3);
      if (sub === '928') return 'Galaxy S24 Ultra';
      if (sub === '921') return 'Galaxy S24';
      if (sub === '918') return 'Galaxy S23 Ultra';
      return 'Galaxy S 系列';
    },
  },
  // Google Pixel
  {
    brand: 'Google',
    series: 'Pixel 系列',
    pattern: /Pixel\s*([0-9]{1,2}(?:\s*(?:Pro|a|Fold))?)/i,
    extractModel: (m) => `Pixel ${(m[1] ?? '').trim()}`,
  },
  // 荣耀 / vivo / OPPO / 一加
  {
    brand: 'Honor',
    series: '荣耀 Magic 系列',
    pattern: /(?:Honor\s*)?Magic\s*([0-9](?:\s*(?:Pro|Ultimate))?)/i,
    extractModel: (m) => `荣耀 Magic ${(m[1] ?? '').trim()}`,
  },
  {
    brand: 'vivo',
    series: 'vivo X 系列',
    pattern: /vivo\s*X([0-9]{2,3}(?:\s*(?:Pro\+|Pro|Ultra))?)/i,
    extractModel: (m) => `vivo X${(m[1] ?? '').trim()}`,
  },
  {
    brand: 'OPPO',
    series: 'OPPO Find 系列',
    pattern: /(?:OPPO\s*)?Find\s*X([0-9](?:\s*(?:Ultra|Pro))?)/i,
    extractModel: (m) => `OPPO Find X${(m[1] ?? '').trim()}`,
  },
  {
    brand: 'OnePlus',
    series: '一加手机',
    pattern: /(?:OnePlus|一加)\s*([0-9]{1,2}(?:\s*Pro|R|T)?)/i,
    extractModel: (m) => `一加 ${(m[1] ?? '').trim()}`,
  },
  // 华为/荣耀工信部型号通配：形如 ELS-AN00, JAD-AL50, NOH-AN00
  {
    brand: 'HUAWEI',
    series: '华为手机',
    pattern: /\b([A-Z]{3}-[A-Z0-9]{4,5})\b/,
    extractModel: (m) => `华为 ${(m[1] ?? '').trim()}`,
  },
];

// ── 电脑与操作系统解析 ──────────────────────────────────────────

const LAPTOP_KEYWORDS =
  /MacBook|ThinkPad|Surface\s*Laptop|Yoga|ZenBook|MateBook|Gram/i;

function isComputerEnvironment(hint: string): boolean {
  return /Windows|Win64|x86_64|x64|Macintosh|macOS|Darwin|Linux|Desktop|Laptop/i.test(
    hint
  );
}

function parseComputerInfo(
  hint: string,
  rawName?: string
): { os: string; computerName?: string; isLaptop: boolean } {
  let os = '';
  if (/Windows/i.test(hint)) {
    os =
      /Windows NT 10.0/i.test(hint) || /Windows 11/i.test(hint)
        ? 'Windows 11'
        : 'Windows';
  } else if (/Macintosh|macOS|Darwin/i.test(hint)) {
    os = 'macOS';
  } else if (/Linux/i.test(hint)) {
    os = 'Linux';
  }

  let computerName: string | undefined;
  if (rawName && rawName.trim()) {
    const clean = (rawName.split('·')[0] ?? '').trim();
    if (
      clean &&
      !/^(Windows|macOS|Linux|Unknown|未知设备|Crish Desktop|电脑)$/i.test(
        clean
      ) &&
      !/^[A-Z]{3}-[A-Z0-9]{4,5}$/i.test(clean) // 排除形如 ELS-AN00 的手机代号
    ) {
      computerName = clean;
    }
  }

  const isLaptop =
    LAPTOP_KEYWORDS.test(hint) || LAPTOP_KEYWORDS.test(rawName || '');
  return { os: os || '电脑', computerName, isLaptop };
}

/**
 * 解析单个设备的基础身份信息
 */
export function parseDeviceInfo(input: {
  deviceName?: string;
  userAgent?: string;
  platform?: string;
  isCurrent?: boolean;
}): ParsedDeviceInfo {
  const {
    deviceName = '',
    userAgent = '',
    platform = '',
    isCurrent = false,
  } = input;
  const combined = `${deviceName} ${platform} ${userAgent}`.trim();

  // 1. 先检查是否精准命中已知手机型号代号字典（优先识别，避免被误判成电脑）
  for (const [code, info] of Object.entries(EXACT_PHONE_MODELS)) {
    const re = new RegExp(`\\b${code}\\b`, 'i');
    if (re.test(combined)) {
      return {
        category: 'phone',
        brand: info.brand,
        series: info.series,
        model: info.model,
        displayName: info.model || info.series,
      };
    }
  }

  // 2. 判断是否为平板
  if (/iPad/i.test(combined) || /Tablet/i.test(combined)) {
    const model = /iPad\s*Pro/i.test(combined)
      ? 'iPad Pro'
      : /iPad\s*Air/i.test(combined)
        ? 'iPad Air'
        : 'iPad';
    return {
      category: 'tablet',
      brand: 'Apple',
      series: 'iPad',
      model,
      displayName: model,
    };
  }

  // 3. 匹配手机正则规则
  for (const rule of PHONE_REGEX_RULES) {
    const match = rule.pattern.exec(combined);
    if (match) {
      const model = rule.extractModel(match);
      return {
        category: 'phone',
        brand: rule.brand,
        series: rule.series,
        model,
        displayName: model || rule.series,
      };
    }
  }

  // 4. Android / Mobile 兜底识别
  if (/Android|Mobile/i.test(combined)) {
    let series = '手机';
    if (/Xiaomi|Redmi/i.test(combined)) series = '小米手机';
    else if (/HUAWEI|Honor/i.test(combined)) series = '华为手机';
    else if (/Samsung/i.test(combined)) series = '三星手机';
    return {
      category: 'phone',
      series,
      displayName: series,
    };
  }

  // 5. 电脑设备识别
  const isPc = isCurrent || isComputerEnvironment(combined);
  if (isPc) {
    const { os, computerName, isLaptop } = parseComputerInfo(
      combined,
      deviceName
    );
    const category: DeviceCategory = isLaptop ? 'laptop' : 'desktop';

    let displayName = '';
    if (computerName) {
      displayName =
        os && !computerName.includes(os)
          ? `${computerName} · ${os}`
          : computerName;
    } else if (os && os !== '电脑') {
      displayName = os;
    } else if (
      deviceName.trim() &&
      !/^(unknown|未知设备|电脑)$/i.test(deviceName)
    ) {
      displayName = deviceName.trim();
    } else {
      displayName = isCurrent ? '当前电脑' : '电脑';
    }

    return {
      category,
      computerName,
      os,
      series: os,
      displayName,
    };
  }

  // 6. 最终兜底：若名称非空且有辨识度则展示名称，否则展示设备
  const cleanName = deviceName.trim();
  const fallback =
    cleanName && !/^(unknown|未知设备)$/i.test(cleanName) ? cleanName : '设备';

  return {
    category: 'unknown',
    series: fallback,
    displayName: fallback,
  };
}

/**
 * 列表级设备命名决策：
 * - 对于电脑：显示计算机名/具体设备名称 + 平台；
 * - 对于手机：显示系列；若列表中出现相同系列的手机，则升级显示为具体型号以做区分！
 */
export function resolveDeviceDisplayNames<
  T extends {
    name?: string;
    userAgent?: string;
    platform?: string;
    current?: boolean;
  },
>(items: T[]): Array<T & { parsed: ParsedDeviceInfo }> {
  return items.map((item) => {
    const parsed = parseDeviceInfo({
      deviceName: item.name,
      userAgent: item.userAgent,
      platform: item.platform,
      isCurrent: item.current,
    });
    // 手机设备：优先精确展示具体型号（如 华为 P40 Pro、iPhone 15 Pro、小米 14 等）；
    // 若未能识别具体型号，则展示系列名称（如 华为手机、iPhone、小米手机 等）
    if (parsed.category === 'phone') {
      parsed.displayName = parsed.model || parsed.series;
    }
    return { ...item, parsed };
  });
}
