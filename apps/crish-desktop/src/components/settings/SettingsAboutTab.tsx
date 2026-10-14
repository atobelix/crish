/**
 * 设置 · 关于 (SettingsAboutTab)
 *
 * 落实 P1-LIC-02：应用版本、Conex 内核、开源许可证与第三方版权披露。
 * 包含：
 * - 应用品牌与版本展示 (Crish Desktop v0.1.0, Conex Kernel v0.1.0)
 * - 主许可证 (MIT License, Copyright (c) 2026 Conex Community)
 * - 第三方许可证披露 (可折叠 / 模态框)：
 *   - 宽松开源协议：MIT, Apache-2.0, BSD-2/3, ISC, Unicode
 *   - MPL-2.0 Section 3.1/3.2 弱互惠组件披露 (bitmaps, cssparser, cssparser-macros, im, sized-chunks, lightningcss, @parcel/watcher)
 *   - 随附字体 (SIL OFL-1.1: Inter, JetBrains Mono, IBM Plex)
 *   - 商业 LLM 商标合理使用声明 (OpenAI, Anthropic, Google Gemini, DeepSeek)
 * - 复制系统信息按钮
 * - GitHub 源码仓库与安全漏洞报告外链
 */

import React, { useCallback, useMemo, useState } from 'react';
import { copyTextToClipboard } from '@crish/shared-utils';
import { useToast } from '../../services/toast/ToastContext';
import { Button, Dialog, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';
import {
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from './SettingsUI';
import styles from './SettingsAboutTab.module.css';
import { useI18n } from '../../i18n';

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
    appVersion: 'v0.1.0',
    kernelVersion: 'v0.1.0',
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

interface ThirdPartyDisclosureContentProps {
  idPrefix?: string;
}

const ThirdPartyDisclosureContent: React.FC<
  ThirdPartyDisclosureContentProps
> = ({ idPrefix = 'about' }) => {
  const { t } = useI18n();
  return (
    <div
      className={styles.thirdPartyDisclosure}
      data-testid={`${idPrefix}-disclosure-content`}
    >
      {/* 1. 宽松开源协议 */}
      <div className={styles.subSection}>
        <h4 className={styles.subSectionTitle}>
          <AppIcon name="blocks" size={14} />
          <span>
            {t(
              'about.permissiveTitle',
              '宽松开源依赖 (Permissive Open-Source Libraries)'
            )}
          </span>
        </h4>
        <p className={styles.subSectionDesc}>
          {t(
            'about.permissiveDesc',
            'Crish Desktop 使用并包含了众多遵循宽松开源协议（Permissive Open-Source Licenses）的优秀依赖项。这些项目以其各自协议授权分发，完整的版权声明与许可条款均保留在各自源代码及分发包中：'
          )}
        </p>
        <div className={styles.pillsRow}>
          {PERMISSIVE_LICENSES.map((lic) => (
            <span key={lic} className={styles.pill}>
              {lic}
            </span>
          ))}
        </div>
      </div>

      {/* 2. MPL-2.0 弱互惠组件披露 */}
      <div className={styles.subSection}>
        <h4 className={styles.subSectionTitle}>
          <AppIcon name="file-text" size={14} />
          <span>
            {t(
              'about.weakCopyleftTitle',
              '弱互惠型依赖开源披露 (Weak Copyleft — MPL-2.0 Section 3.1 & 3.2)'
            )}
          </span>
        </h4>
        <p className={styles.subSectionDesc}>
          {t(
            'about.weakCopyleftDesc',
            '根据 Mozilla Public License 2.0 (MPL-2.0) 第 3.1 条与第 3.2 条要求，本项目特此公开以下以未修改库形式（Unmodified library form）直接引用的第三方组件。您可通过下述链接直接访问并获取其完整源代码：'
          )}
        </p>
        <div className={styles.depTable}>
          {MPL_DEPENDENCIES.map((dep) => (
            <div key={dep.name} className={styles.depItem}>
              <div className={styles.depInfo}>
                <span className={styles.depName}>{dep.name}</span>
                <span className={styles.depForm}>
                  {t('about.unmodifiedForm', '未修改库形式 (Unmodified)')}
                </span>
              </div>
              <div className={styles.depActions}>
                <span className={styles.licenseBadge}>MPL-2.0</span>
                <a
                  href={dep.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.depLink}
                  aria-label={`${dep.name} on ${dep.sourceType}`}
                >
                  <span>{dep.sourceType}</span>
                  <AppIcon name="external-link" size={12} />
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 3. 随附字体授权 */}
      <div className={styles.subSection}>
        <h4 className={styles.subSectionTitle}>
          <AppIcon name="palette" size={14} />
          <span>
            {t(
              'about.fontsTitle',
              '随附字体许可声明 (Bundled Fonts — SIL OFL-1.1)'
            )}
          </span>
        </h4>
        <p className={styles.subSectionDesc}>
          {t(
            'about.fontsDesc',
            '本项目随附并使用了以下开源字体家族，均遵循 SIL Open Font License 1.1 (SIL OFL-1.1) 协议分发：'
          )}
        </p>
        <div className={styles.fontGrid}>
          {BUNDLED_FONTS.map((font) => (
            <div key={font.name} className={styles.fontCard}>
              <div className={styles.fontName}>{font.name}</div>
              <div className={styles.fontMeta}>{font.license}</div>
              <div className={styles.fontCopyright}>{font.copyright}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 4. 商业模型商标合理使用声明 */}
      <div className={styles.subSection}>
        <h4 className={styles.subSectionTitle}>
          <AppIcon name="shield" size={14} />
          <span>
            {t(
              'about.trademarkTitle',
              '商业模型商标合理使用声明 (Commercial LLM Trademark Fair Use)'
            )}
          </span>
        </h4>
        <div className={styles.noticeBox}>
          {t(
            'about.trademarkDesc',
            'OpenAI、Anthropic、Google Gemini、DeepSeek 等商标及其相关标识均为其各自所有者的财产。Crish Desktop 与 Conex Kernel 为独立开发的开源软件客户端，仅在模型连接、协议适配与兼容性说明的合理使用（Fair Use）范围内使用上述商标，不代表与各商标所有者存在从属、赞助、授权或许可关联关系。'
          )}
        </div>
      </div>
    </div>
  );
};

type Props = {
  onBlockingOverlayChange?: (open: boolean) => void;
  _onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsAboutTab: React.FC<Props> = ({
  onBlockingOverlayChange,
  _onBlockingOverlayChange,
}) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const systemInfo = useMemo(() => getSystemInfo(), []);

  const handleCopySystemInfo = useCallback(async () => {
    const text = formatSystemInfo(systemInfo);
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      showToast(t('about.copySysInfoSuccess', '系统信息已复制到剪贴板'));
      setTimeout(() => setCopied(false), 2000);
    }
  }, [systemInfo, showToast, t]);

  const handleSetModalOpen = useCallback(
    (open: boolean) => {
      setIsModalOpen(open);
      onBlockingOverlayChange?.(open);
      _onBlockingOverlayChange?.(open);
    },
    [onBlockingOverlayChange, _onBlockingOverlayChange]
  );

  return (
    <SettingsPage title={t('about.title', '关于')}>
      {/* 应用品牌与版本信息 */}
      <SettingsSection title={t('about.appInfo', '应用信息')}>
        <SettingsCard>
          <div className={styles.brandHeader}>
            <div className={styles.brandLogo} aria-hidden="true">
              <AppIcon name="bot" size={28} />
            </div>
            <div className={styles.brandDetails}>
              <div className={styles.brandTitleRow}>
                <h3 className={styles.brandName}>Crish Desktop</h3>
                <span className={styles.versionBadge} data-testid="app-version">
                  {systemInfo.appVersion}
                </span>
              </div>
              <p className={styles.brandDesc}>
                {t(
                  'about.description',
                  '现代化本地优先自主 Agent 桌面工作台与多模型协作开发环境'
                )}
              </p>
            </div>
          </div>

          <SettingsRow
            title={t('about.kernelVersion', '内核版本')}
            desc={t('about.kernelDesc', 'Rust 内核会话引擎与调度编排核心')}
            control={
              <span className={styles.monoBadge} data-testid="kernel-version">
                Conex Kernel {systemInfo.kernelVersion}
              </span>
            }
          />

          <SettingsRow
            title={t('about.systemArch', '系统与运行架构')}
            desc={`${systemInfo.os} · ${systemInfo.architecture} (${systemInfo.runtime})`}
            control={
              <Tooltip
                content={t(
                  'about.copySysInfoTooltip',
                  '复制操作系统、应用版本与内核架构信息'
                )}
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleCopySystemInfo}
                  data-testid="copy-system-info-btn"
                  aria-label={
                    copied
                      ? t('common.copied', '已复制')
                      : t('about.copySysInfo', '复制系统信息')
                  }
                >
                  <AppIcon name={copied ? 'check' : 'copy'} size={14} />
                  <span>
                    {copied
                      ? t('common.copied', '已复制')
                      : t('about.copySysInfo', '复制系统信息')}
                  </span>
                </Button>
              </Tooltip>
            }
          />
        </SettingsCard>
      </SettingsSection>

      {/* 主开源许可证 */}
      <SettingsSection title={t('about.openSourceLicense', '开源许可证')}>
        <SettingsCard>
          <SettingsRow
            title={t('about.primaryLicense', '主许可证 (Primary License)')}
            desc="MIT License"
            control={<span className={styles.licenseBadge}>MIT</span>}
          />
          <div
            className={styles.copyrightNotice}
            data-testid="copyright-notice"
          >
            Copyright (c) 2026 Conex Community
          </div>
          <div className={styles.licenseText}>
            {t(
              'about.mitLicenseText',
              '本软件基于 MIT 许可证开放源代码。允许任何人免费获得本软件及其相关文档的副本，不受限制地处理本软件，包括但不限于使用、复制、修改、合并、发布、分发、再许可和/或出售本软件副本的权利。'
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 第三方开源许可证与版权披露 */}
      <SettingsSection
        title={t('about.thirdPartyTitle', '第三方开源协议与披露')}
      >
        <SettingsCard>
          <SettingsRow
            title={t('about.thirdPartyNotices', '第三方开源依赖与许可证')}
            desc={t(
              'about.thirdPartyDesc',
              '包含宽松协议依赖、MPL-2.0 弱互惠组件披露、SIL OFL-1.1 字体授权与商业模型商标使用声明'
            )}
            control={
              <div className={styles.thirdPartyControls}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setIsExpanded((prev) => !prev)}
                  data-testid="toggle-licenses-btn"
                >
                  <AppIcon
                    name={isExpanded ? 'chevron-up' : 'chevron-down'}
                    size={14}
                  />
                  <span>
                    {isExpanded
                      ? t(
                          'settings.about.collapseThirdPartyLicenses',
                          '收起第三方许可证'
                        )
                      : t(
                          'settings.about.viewThirdPartyLicenses',
                          '查看第三方许可证'
                        )}
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => handleSetModalOpen(true)}
                  data-testid="open-licenses-modal-btn"
                >
                  <AppIcon name="external-link" size={14} />
                  <span>
                    {t('about.viewFullLicenseModal', '弹窗查看完整协议')}
                  </span>
                </Button>
              </div>
            }
          />

          {isExpanded && <ThirdPartyDisclosureContent idPrefix="inline" />}
        </SettingsCard>
      </SettingsSection>

      {/* 社区与支持 */}
      <SettingsSection title={t('about.communityTitle', '社区与支持')}>
        <SettingsCard>
          <SettingsRow
            title={t('about.githubRepo', 'GitHub 源码仓库')}
            desc="https://github.com/conex-community/crish"
            control={
              <a
                href="https://github.com/conex-community/crish"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.externalLink}
                data-testid="github-link"
              >
                <span>{t('about.visitRepo', '访问仓库')}</span>
                <AppIcon name="external-link" size={12} />
              </a>
            }
          />

          <SettingsRow
            title={t('about.securityReport', '安全漏洞报告')}
            desc={t(
              'about.securityReportDesc',
              '如发现安全隐患或漏洞，请通过 GitHub Security Advisory 或 security@conex.dev 报告'
            )}
            control={
              <a
                href="https://github.com/conex-community/crish/security/advisories"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.externalLink}
                data-testid="security-report-link"
              >
                <span>{t('about.submitVulnerability', '提交漏洞')}</span>
                <AppIcon name="shield" size={12} />
              </a>
            }
          />
        </SettingsCard>
      </SettingsSection>

      {/* 第三方开源许可证模态弹窗 */}
      <Dialog
        open={isModalOpen}
        onClose={() => handleSetModalOpen(false)}
        title={t('about.thirdPartyModalTitle', '第三方开源许可证与版权披露')}
        size="lg"
      >
        <div className={styles.modalBody}>
          <ThirdPartyDisclosureContent idPrefix="modal" />
        </div>
      </Dialog>
    </SettingsPage>
  );
};
