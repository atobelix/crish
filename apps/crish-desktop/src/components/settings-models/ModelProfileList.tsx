import React, { useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  profileDisplayLabel,
  profileHasKey,
  type ProviderProfile,
} from '../../api/providerProfiles';
import { formatModelDisplayName } from '../../api/modelCatalog';
import styles from './ModelsSettingsTab.module.css';
import { Tooltip, Menu } from '../ui';
import { SafeTriangleTracker } from '../ui/internal/SafeTriangle';

interface ModelsCascadeSelectProps {
  profiles: ProviderProfile[];
  activeProfileId: string;
  activeModelId: string;
  onChange: (profileId: string, modelId: string) => void;
}

export const ModelsCascadeSelect: React.FC<ModelsCascadeSelectProps> = ({
  profiles,
  activeProfileId,
  activeModelId,
  onChange,
}) => {
  const [flyProfileId, setFlyProfileId] = useState<string | null>(null);
  const safeTrackerRef = useRef(new SafeTriangleTracker(300));
  const flyoutRef = useRef<HTMLDivElement | null>(null);

  const enabledProfiles = useMemo(() => {
    return profiles.filter((p) => p.enabled !== false && p.models.length > 0);
  }, [profiles]);

  const activeProfile = enabledProfiles.find((p) => p.id === activeProfileId);
  const activeLabel =
    activeProfile && activeModelId
      ? `${profileDisplayLabel(activeProfile).replace(/\s*\/\s*默认$/, '')} · ${formatModelDisplayName(
          activeProfile.id,
          activeModelId
        )}`
      : '请选择默认模型...';

  return (
    <Menu
      position={{ align: 'start', side: 'bottom', sideOffset: 4 }}
      trigger={
        <button
          type="button"
          className={styles.cascadeSelectTrigger}
          style={{ minWidth: '220px', justifyContent: 'space-between' }}
        >
          <span className={styles.cascadeSelectValue}>{activeLabel}</span>
          <Lucide.ChevronDown
            size={14}
            style={{ opacity: 0.6, flexShrink: 0 }}
          />
        </button>
      }
    >
      <div
        className={styles.cascadeList}
        onMouseLeave={() => {
          safeTrackerRef.current.reset();
          setFlyProfileId(null);
        }}
      >
        <div className={styles.addMenuTitle}>选择服务商与模型</div>
        {enabledProfiles.length === 0 ? (
          <div className={styles.cascadeEmpty}>暂无已启用的可用模型</div>
        ) : (
          enabledProfiles.map((p) => {
            const isFly = flyProfileId === p.id;
            const isCurrentActive = p.id === activeProfileId;
            const cleanLabel = profileDisplayLabel(p).replace(
              /\s*\/\s*默认$/,
              ''
            );

            return (
              <div
                key={p.id}
                className={`${styles.cascadeRow} ${isFly ? styles.isOpen : ''}`}
                onMouseEnter={(e) => {
                  if (flyProfileId && flyProfileId !== p.id) {
                    if (safeTrackerRef.current.isGraceActive()) {
                      const isSafe = safeTrackerRef.current.check({
                        x: e.clientX,
                        y: e.clientY,
                      });
                      if (isSafe) return;
                    }
                  }
                  setFlyProfileId(p.id);
                }}
                onMouseLeave={(e) => {
                  if (isFly && flyoutRef.current) {
                    const rect = flyoutRef.current.getBoundingClientRect();
                    safeTrackerRef.current.enter(
                      { x: e.clientX, y: e.clientY },
                      rect,
                      'right'
                    );
                  }
                }}
              >
                <span
                  style={{
                    fontWeight: isCurrentActive ? '500' : 'normal',
                    flex: 1,
                  }}
                >
                  {cleanLabel}
                </span>
                <Lucide.ChevronRight size={14} className={styles.cascadeChev} />

                {isFly && (
                  <div
                    ref={flyoutRef}
                    className={styles.cascadeFlyout}
                    onMouseEnter={() => safeTrackerRef.current.reach()}
                  >
                    {p.models.map((m) => {
                      const selected =
                        p.id === activeProfileId && m === activeModelId;
                      return (
                        <button
                          key={m}
                          type="button"
                          className={`${styles.cascadeOption} ${selected ? styles.isOn : ''}`}
                          onClick={() => {
                            onChange(p.id, m);
                            safeTrackerRef.current.reset();
                            setFlyProfileId(null);
                          }}
                        >
                          <span className={styles.cascadeOptionText}>
                            {formatModelDisplayName(p.id, m)}
                          </span>
                          {selected && (
                            <Lucide.Check
                              size={14}
                              className={styles.cascadeCheck}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Menu>
  );
};

interface ModelProfileListProps {
  profiles: ProviderProfile[];
  selectedId: string | null;
  onSelectProfile: (id: string) => void;
}

export const ModelProfileList: React.FC<ModelProfileListProps> = ({
  profiles,
  selectedId,
  onSelectProfile,
}) => {
  return (
    <aside
      className={`${styles.modelsRail} models-rail`}
      aria-label="服务商列表"
    >
      <div className={`${styles.mrlHeader} mrl-header`}>
        <h3 className="settings-ui-section-title">AI 服务商</h3>
      </div>

      <div className={`${styles.mrlList} mrl-list`} role="list">
        {profiles.length === 0 ? (
          <div className={`${styles.mrlEmpty} mrl-empty`}>还没有服务商</div>
        ) : (
          profiles.map((p) => {
            const isActive = p.id === selectedId;
            const label = profileDisplayLabel(p);
            const keyOk = profileHasKey(p);
            const enabled = p.enabled !== false;

            return (
              <button
                key={p.id}
                type="button"
                role="listitem"
                className={`${styles.mrlItem} mrl-item ${isActive ? styles.isActive + ' is-active' : ''}`}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => onSelectProfile(p.id)}
              >
                <div className={`${styles.mrlItemRowTop} mrl-item-row-top`}>
                  <Tooltip content={label}>
                    <span className={`${styles.mrlItemName} mrl-item-name`}>
                      {label}
                    </span>
                  </Tooltip>
                  <Tooltip
                    content={
                      !keyOk ? '缺少密钥' : !enabled ? '已停用' : '已配置并启用'
                    }
                  >
                    <span
                      className={`${styles.mrlItemDot} mrl-item-dot`}
                      style={{
                        background: !keyOk
                          ? 'var(--color-warning)'
                          : !enabled
                            ? 'var(--text-tertiary)'
                            : 'var(--color-active)',
                        opacity: !enabled ? 0.6 : 1,
                      }}
                    />
                  </Tooltip>
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
};
