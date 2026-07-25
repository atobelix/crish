import React, { Suspense, lazy } from 'react';
import { ChevronDown } from 'lucide-react';
import styles from '../ChatCard.module.css';
import { Tooltip } from '../settings/SettingsUI';
import { getActiveProfile, resolveDisplayModelId } from '../../api/providerProfiles';

const ModelBadgePickerMenu = lazy(() =>
  import('../ModelBadgePickerMenu').then((m) => ({ default: m.ModelBadgePickerMenu })),
);

interface ChatHeaderProps {
  engineModel: string;
  needsModelSetup: boolean;
  showModelPicker: boolean;
  showModelDropdown: boolean;
  onToggleModelDropdown: () => void;
  onCloseModelDropdown: () => void;
  modelSelectorRef: React.RefObject<HTMLDivElement | null>;
}

export const ChatHeader: React.FC<ChatHeaderProps> = React.memo(({
  engineModel,
  needsModelSetup,
  showModelPicker,
  showModelDropdown,
  onToggleModelDropdown,
  onCloseModelDropdown,
  modelSelectorRef,
}) => {
  if (!showModelPicker) return null;

  const displayName = resolveDisplayModelId(engineModel) || engineModel || (needsModelSetup ? '填写模型' : '无可用模型');
  const profile = getActiveProfile();
  const tooltipContent = profile
    ? `${profile.name} · ${displayName}`
    : '服务商与模型（可在设置中更改）';

  return (
    <Tooltip content={tooltipContent}>
      <div
        ref={modelSelectorRef}
        className={`${styles.modelBadge} ${showModelDropdown ? styles.active : ''}`}
        onMouseDown={(e) => {
          e.stopPropagation();
          onToggleModelDropdown();
        }}
        style={{ cursor: 'pointer', position: 'relative' }}
      >
        <span
          className={styles.modelText}
          style={{
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            flex: 1,
            textAlign: 'left',
          }}
        >
          {displayName}
        </span>
        <ChevronDown
          size={14}
          style={{ opacity: 0.6, marginLeft: 6, flexShrink: 0 }}
        />
        {showModelDropdown && (
          <Suspense fallback={null}>
            <ModelBadgePickerMenu
              activeModel={engineModel}
              onClose={onCloseModelDropdown}
            />
          </Suspense>
        )}
      </div>
    </Tooltip>
  );
});

ChatHeader.displayName = 'ChatHeader';
