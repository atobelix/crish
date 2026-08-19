/**
 * 融合触发：一条弱分割胶囊，左真模型槽、右思考档。
 * 模型由宿主 rightActions（ModelBadgePicker）注入；思考接 settings + thinkingGear。
 * 禁止写死 Claude 3.7；禁止品牌绿光晕；自定义 Tooltip，无原生 title。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ComposerFusedTrigger.module.css';
import { Menu, Tooltip } from '../ui';
import {
  THINKING_LEVEL_LABELS,
  fetchDescribeEffortsSnapshot,
  resolveCatalogEfforts,
  thinkingLevelOptionsFor,
} from '../../api/thinkingGear';
import { getActiveModelId } from '../../api/provider-profiles/profileActiveSelection';
import {
  getAppSettings,
  setAppSettings,
} from '../../api/store-access/settingsAccess';
import { clientApi } from '../../api/clientApi';
import { onUiEvent } from '../../api/uiEvents';
import { useSettingsStore } from '../../store/settingsStore';

export type ComposerFusedTriggerProps = {
  children?: React.ReactNode;
};

function levelLabel(value: string): string {
  if (!value || value === 'default') return '提供方默认';
  return THINKING_LEVEL_LABELS[value] ?? value;
}

export const ComposerFusedTrigger: React.FC<ComposerFusedTriggerProps> = ({
  children,
}) => {
  const stored = useSettingsStore(
    (s) => s.appSettings?.defaultThinkingLevel ?? 'default'
  );
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState(() => getActiveModelId() ?? '');
  const [tick, setTick] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void fetchDescribeEffortsSnapshot().then(() => setTick((n) => n + 1));
  }, []);

  useEffect(() => {
    const off = onUiEvent('model-changed', (detail) => {
      if (detail?.model) setModelId(String(detail.model));
      else setModelId(getActiveModelId() ?? '');
      setTick((n) => n + 1);
    });
    return off;
  }, []);

  const options = thinkingLevelOptionsFor(resolveCatalogEfforts(modelId));
  const current = stored || 'default';
  const currentLabel = levelLabel(current);

  const selectLevel = useCallback(async (value: string) => {
    const prev = getAppSettings();
    setAppSettings({
      ...(prev ?? {}),
      defaultThinkingLevel: value,
    });
    try {
      await clientApi.updateSettings({ defaultThinkingLevel: value });
    } catch {
      /* swallow-ok: 本机设置写失败不阻断 UI */
    }
    setOpen(false);
  }, []);

  const menuOptions = options.map((o) => ({
    id: o.value,
    label: o.label,
    onClick: () => {
      void selectLevel(o.value);
    },
  }));

  return (
    <div
      className={styles.capsule}
      data-testid="composer-fused-trigger"
      data-catalog-tick={tick}
    >
      {children ? <div className={styles.left}>{children}</div> : null}
      {children ? <span className={styles.divider} aria-hidden /> : null}
      <div className={styles.right}>
        <Tooltip
          content={`思考档位：${currentLabel}`}
          disabled={open}
          side="top"
        >
          <button
            ref={btnRef}
            type="button"
            className={`${styles.thinkBtn} ${open ? styles.isOpen : ''}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`思考档位：${currentLabel}`}
            data-testid="composer-thinking-trigger"
            onClick={() => setOpen((v) => !v)}
          >
            <span>{currentLabel}</span>
            <Lucide.ChevronDown
              size={11}
              className={styles.chev}
              aria-hidden
            />
          </button>
        </Tooltip>
        <Menu
          openState={{ open, onOpenChange: setOpen }}
          anchor={btnRef}
          options={menuOptions}
          position={{ side: 'top', align: 'end', sideOffset: 6 }}
          panel={{ contentClassName: styles.menu }}
          renderItem={(opt) => {
            const selected = opt.id === current;
            return (
              <button
                key={opt.id}
                type="button"
                className={`${styles.item} ${selected ? styles.isSelected : ''}`}
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  opt.onClick?.();
                }}
              >
                <span>{opt.label}</span>
                {selected ? (
                  <Lucide.Check
                    size={12}
                    className={styles.check}
                    aria-hidden
                  />
                ) : null}
              </button>
            );
          }}
        />
      </div>
    </div>
  );
};
