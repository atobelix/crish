import React, { useEffect, useState } from 'react';
import { Globe, FileCode, ArrowRight } from 'lucide-react';
import { getPreviewUrl, setPreviewUrl } from '../../api/previewBrowserStore';
import styles from './LeafToolTabStrip.module.css';

export interface SidePanelLauncherHubProps {
  onOpenPanel: (panelId: string) => void;
  detectedPort?: number | null;
}

const CANDIDATE_PORTS = [5173, 3000, 4000, 8080, 8000, 3001, 5000];

/**
 * 探测本地正在运行的服务端口（Vite/Next/Web 等）
 */
export async function detectActiveServicePort(
  ports: number[] = CANDIDATE_PORTS,
  timeoutMs = 600
): Promise<number | null> {
  if (typeof fetch !== 'function') return null;

  // 优先尝试最近访问过的本地端口
  let prioritizedPorts = [...ports];
  try {
    const lastUrl = getPreviewUrl();
    if (lastUrl && lastUrl.includes('localhost:')) {
      const match = lastUrl.match(/localhost:(\d+)/);
      if (match && match[1]) {
        const p = parseInt(match[1], 10);
        prioritizedPorts = [p, ...prioritizedPorts.filter((x) => x !== p)];
      }
    }
  } catch {
    /* swallow-ok */
  }

  const probe = async (port: number): Promise<number> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(`http://localhost:${port}`, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);
      return port;
    } catch {
      clearTimeout(timer);
      throw new Error(`Port ${port} unreachable`);
    }
  };

  try {
    return await Promise.any(prioritizedPorts.map(probe));
  } catch {
    return null;
  }
}

export const SidePanelLauncherHub: React.FC<SidePanelLauncherHubProps> = ({
  onOpenPanel,
  detectedPort,
}) => {
  const [activePort, setActivePort] = useState<number | null>(
    detectedPort ?? null
  );

  useEffect(() => {
    if (detectedPort !== undefined) {
      setActivePort(detectedPort);
      return;
    }

    let isMounted = true;
    detectActiveServicePort()
      .then((port) => {
        if (isMounted && port) {
          setActivePort(port);
        }
      })
      .catch(() => {
        /* swallow-ok */
      });

    return () => {
      isMounted = false;
    };
  }, [detectedPort]);

  const handleOpenActiveService = (port: number) => {
    const url = `http://localhost:${port}`;
    try {
      setPreviewUrl(url);
    } catch {
      /* swallow-ok */
    }
    onOpenPanel('preview');
  };

  return (
    <div
      className={`${styles.launcherHubWrapper} side-panel-launcher-hub-wrapper`}
      data-testid="side-panel-launcher-hub-wrapper"
    >
      <div
        className={`${styles.launcherHub} side-panel-launcher-hub`}
        data-testid="side-panel-launcher-hub"
      >
        <div className={`${styles.launcherCardsGroup} launcher-cards-group`}>
          {activePort && (
            <button
              type="button"
              className={`${styles.launcherCard} ${styles.activePortCard} side-panel-launcher-card side-panel-active-port-card`}
              onClick={() => handleOpenActiveService(activePort)}
              data-testid="launcher-card-active-service"
            >
              <div
                className={`${styles.launcherCardIconBox} ${styles.activePortIconBox} launcher-card-icon-box`}
              >
                <span className={styles.activePortDot} />
              </div>
              <div className={styles.launcherCardText}>
                <span
                  className={`${styles.launcherCardTitle} launcher-card-title`}
                >
                  运行中的服务: http://localhost:{activePort} (点击在右侧预览)
                </span>
              </div>
              <ArrowRight size={14} className={styles.activePortArrow} />
            </button>
          )}
          <button
            type="button"
            className={`${styles.launcherCard} side-panel-launcher-card`}
            onClick={() => onOpenPanel('preview')}
            data-testid="launcher-card-preview"
          >
            <div
              className={`${styles.launcherCardIconBox} launcher-card-icon-box`}
            >
              <Globe size={16} strokeWidth={1.8} />
            </div>
            <div className={styles.launcherCardText}>
              <span
                className={`${styles.launcherCardTitle} launcher-card-title`}
              >
                浏览器
              </span>
            </div>
          </button>
          <button
            type="button"
            className={`${styles.launcherCard} side-panel-launcher-card`}
            onClick={() => onOpenPanel('files')}
            data-testid="launcher-card-files"
          >
            <div
              className={`${styles.launcherCardIconBox} launcher-card-icon-box`}
            >
              <FileCode size={16} strokeWidth={1.8} />
            </div>
            <div className={styles.launcherCardText}>
              <span
                className={`${styles.launcherCardTitle} launcher-card-title`}
              >
                代码产物与文件
              </span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};
