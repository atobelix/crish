import React from 'react';
import { Button, Tooltip } from '../ui';
import { AppIcon, type IconName } from '../ui/icons';
import { useI18n } from '../../i18n';
import {
  extensionVerbLabelKey,
  resolveExtensionVerb,
  type ExtensionPlacement,
} from './extensionCardModel';
import styles from './ExtensionActionCard.module.css';

export interface ExtensionActionCardProps {
  name: string;
  description: string;
  badge?: string;
  icon: IconName;
  placement: ExtensionPlacement;
  installed: boolean;
  busy?: boolean;
  onAction: () => void;
  onOpen?: () => void;
}

export const ExtensionActionCard: React.FC<ExtensionActionCardProps> = ({
  name,
  description,
  badge,
  icon,
  placement,
  installed,
  busy = false,
  onAction,
  onOpen,
}) => {
  const { t } = useI18n();
  const verb = resolveExtensionVerb({ placement, installed });
  const verbLabel = t(extensionVerbLabelKey(verb.verb));
  const label = busy ? t('extensions.card.installing') : verbLabel;

  return (
    <div
      className={styles.card}
      data-open={onOpen ? 'true' : 'false'}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (!onOpen) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={styles.header}>
        <div className={styles.identity}>
          <div className={styles.icon}>
            <AppIcon name={icon} size={15} />
          </div>
          <div className={styles.titles}>
            <Tooltip content={name}>
              <span className={styles.name}>{name}</span>
            </Tooltip>
            {badge ? (
              <span className={styles.badge} data-source={badge}>
                {badge}
              </span>
            ) : null}
          </div>
        </div>
        <div
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Tooltip content={verbLabel}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.action}
              disabled={busy}
              aria-label={`${verbLabel} ${name}`}
              onClick={onAction}
            >
              {label}
            </Button>
          </Tooltip>
        </div>
      </div>
      <Tooltip content={description}>
        <div className={styles.description}>{description}</div>
      </Tooltip>
    </div>
  );
};
