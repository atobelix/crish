/**
 * 设置 · 关于 —— 静态数据与系统信息 helper（自 SettingsAboutTab 拆出）
 *
 * 包含：
 * - SystemInfo 类型与 getSystemInfo / formatSystemInfo
 * - MPL-2.0 弱互惠组件披露清单 (MPL_DEPENDENCIES)
 * - 随附字体许可清单 (BUNDLED_FONTS)
 * - 宽松开源协议清单 (PERMISSIVE_LICENSES)
 */

/** 产品版本。跟整段开发走，不随单次提交递增。 */
export const PRODUCT_VERSION = '0.1.1';

export const REPOSITORY_URL = 'https://github.com/atobelix/crish';

export const SECURITY_ADVISORY_URL = `${REPOSITORY_URL}/security/advisories`;

export interface SystemInfo {
  appVersion: string;
  kernelVersion: string;
  os: string;
  architecture: string;
  runtime: string;
}

export function getSystemInfo(): SystemInfo {
  let os = 'Windows';
  let architecture = 'x64';
  let runtime = 'Tauri';

  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent || '';
    const platform =
      (navigator as unknown as { userAgentData?: { platform?: string } })
        .userAgentData?.platform ||
      navigator.platform ||
      '';

    if (/win/i.test(platform) || /windows/i.test(ua)) {
      os = 'Windows';
    } else if (/mac/i.test(platform) || /macintosh/i.test(ua)) {
      os = 'macOS';
    } else if (/linux/i.test(platform) || /linux/i.test(ua)) {
      os = 'Linux';
    } else if (platform) {
      os = platform;
    }

    if (/arm64|aarch64/i.test(ua) || /arm64|aarch64/i.test(platform)) {
      architecture = 'arm64';
    } else if (
      /x86_64|win64|wow64|x64/i.test(ua) ||
      /x86_64|x64/i.test(platform)
    ) {
      architecture = 'x64';
    }
  }

  if (typeof window !== 'undefined') {
    const w = window as unknown as {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
      isTauri?: boolean;
    };
    if (w.__TAURI__ || w.__TAURI_INTERNALS__ || w.isTauri) {
      runtime = 'Tauri';
    }
  }

  return {
    appVersion: `v${PRODUCT_VERSION}`,
    kernelVersion: `v${PRODUCT_VERSION}`,
    os,
    architecture,
    runtime,
  };
}

export function formatSystemInfo(info: SystemInfo = getSystemInfo()): string {
  return [
    `Crish Desktop: ${info.appVersion}`,
    `Conex Kernel: ${info.kernelVersion}`,
    `OS: ${info.os}`,
    `Architecture: ${info.architecture}`,
    `Runtime: ${info.runtime}`,
  ].join('\n');
}

export interface MplDependency {
  name: string;
  sourceType: 'crates.io' | 'npm' | 'crates.io / npm';
  url: string;
  description: string;
}

export const MPL_DEPENDENCIES: MplDependency[] = [
  {
    name: 'bitmaps',
    sourceType: 'crates.io',
    url: 'https://crates.io/crates/bitmaps',
    description: '固定容量的高效位图数据结构',
  },
  {
    name: 'cssparser',
    sourceType: 'crates.io',
    url: 'https://crates.io/crates/cssparser',
    description: '符合 CSS Syntax Level 3 规范的解析器',
  },
  {
    name: 'cssparser-macros',
    sourceType: 'crates.io',
    url: 'https://crates.io/crates/cssparser-macros',
    description: 'cssparser 过程宏支持库',
  },
  {
    name: 'im',
    sourceType: 'crates.io',
    url: 'https://crates.io/crates/im',
    description: '不可变集合与持久化数据结构库',
  },
  {
    name: 'sized-chunks',
    sourceType: 'crates.io',
    url: 'https://crates.io/crates/sized-chunks',
    description: '不可变集合底层定长分块缓冲区',
  },
  {
    name: 'lightningcss',
    sourceType: 'crates.io / npm',
    url: 'https://crates.io/crates/lightningcss',
    description: '极速 CSS 转换、压缩与 AST 解析工具',
  },
  {
    name: '@parcel/watcher',
    sourceType: 'npm',
    url: 'https://www.npmjs.com/package/@parcel/watcher',
    description: '跨平台原生文件系统监听组件',
  },
];

export interface BundledFont {
  name: string;
  license: string;
  copyright: string;
}

export const BUNDLED_FONTS: BundledFont[] = [
  {
    name: 'Inter',
    license: 'SIL Open Font License 1.1 (OFL-1.1)',
    copyright: 'Copyright (c) 2016-2024 Rasmus Andersson',
  },
  {
    name: 'JetBrains Mono',
    license: 'SIL Open Font License 1.1 (OFL-1.1)',
    copyright: 'Copyright (c) 2020 JetBrains s.r.o.',
  },
  {
    name: 'IBM Plex',
    license: 'SIL Open Font License 1.1 (OFL-1.1)',
    copyright: 'Copyright (c) 2017 IBM Corp.',
  },
];

export const PERMISSIVE_LICENSES = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Unicode-3.0',
];
