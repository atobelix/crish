import React from 'react';

import styles from './PreviewStartPage.module.css';
import { AppIcon, ICON_SIZE } from '@/components/ui/icons';
import { Button, Tooltip } from '@/components/ui';
import { useI18n } from '../../i18n';
import { getPreviewFavicon } from '../../api/previewBrowserStore';

export interface PreviewStartPageProps {
  activePorts: number[];
  recentPages: string[];
  onNavigate: (url: string) => void;
}

function formatDisplayHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    const clean = url.replace(/^https?:\/\//, '');
    const slashIdx = clean.indexOf('/');
    return slashIdx >= 0 ? clean.slice(0, slashIdx) : clean || url;
  }
}

function getFaviconUrl(url: string): string | null {
  const cached = getPreviewFavicon(url);
  if (cached) return cached;
  try {
    const u = new URL(url);
    if (u.protocol.startsWith('http')) {
      return `${u.origin}/favicon.ico`;
    }
  } catch {
    // ignore
  }
  return null;
}

const RowFavicon: React.FC<{ url: string; host: string }> = ({ url, host }) => {
  const [imgFailed, setImgFailed] = React.useState(false);
  const faviconUrl = getFaviconUrl(url);
  const isLocal =
    host.includes('localhost') ||
    host.includes('127.0.0.1') ||
    /^\d+\.\d+\.\d+\.\d+/.test(host);

  if (faviconUrl && !imgFailed) {
    return (
      <img
        src={faviconUrl}
        alt=""
        className={styles.favicon}
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <AppIcon
      name={isLocal ? 'terminal' : 'globe'}
      size={ICON_SIZE.md}
      className={styles.icon}
      aria-hidden="true"
    />
  );
};

/**
 * 极简浏览器起始页：
 * - 按行显示（Row-based），布局整洁利落；
 * - 规范字体与行高体系（line-height 1.4，杜绝字符下沉被 overflow 裁切）；
 * - 严谨灰度对比（主文本 --text-primary，次要信息 --text-tertiary）；
 * - 大圆角（12px），0 描边，图标不加任何多余背景衬底；
 * - 运行中的本地服务：有端口探测到则单行呈现，没有就是没有，绝不多加戏；
 * - 零位移动效，零多余次要描述。
 */
export const PreviewStartPage: React.FC<PreviewStartPageProps> = ({
  activePorts,
  recentPages,
  onNavigate,
}) => {
  const { t } = useI18n();
  const hasContent = activePorts.length > 0 || recentPages.length > 0;

  if (!hasContent) {
    return <div className={styles.emptyCanvas} aria-hidden="true" />;
  }

  return (
    <div
      className={styles.container}
      role="region"
      aria-label={t('workspace.preview.quickAccess')}
    >
      <div className={styles.list}>
        {/* 运行中的本地服务：有的话也只是显示一行而已，没有就是没有 */}
        {activePorts.map((port) => (
          <Tooltip
            key={port}
            content={t('workspace.preview.runningService', { port })}
          >
            <Button
              variant="ghost"
              className={styles.rowItem}
              onClick={() => onNavigate(`http://localhost:${port}`)}
              aria-label={t('workspace.preview.runningService', { port })}
            >
              <span className={styles.liveDot} aria-hidden="true" />
              <span className={styles.portText}>localhost:{port}</span>
            </Button>
          </Tooltip>
        ))}

        {/* 最近访问：按行规整排列 */}
        {recentPages.length > 0 && (
          <div className={styles.sectionTitle}>
            {t('workspace.preview.recentPages')}
          </div>
        )}
        {recentPages.map((url) => {
          const host = formatDisplayHost(url);

          return (
            <Tooltip
              key={url}
              content={t('workspace.preview.openRecent', { host })}
            >
              <Button
                variant="ghost"
                className={styles.rowItem}
                onClick={() => onNavigate(url)}
                aria-label={t('workspace.preview.openRecent', { host })}
              >
                <RowFavicon url={url} host={host} />
                <span className={styles.rowText}>{host}</span>
              </Button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
};
