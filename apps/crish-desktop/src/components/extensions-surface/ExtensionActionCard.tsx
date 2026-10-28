import React from 'react';
import { Button, Tooltip } from '@/components/ui';
import { AppIcon, type IconName } from '@/components/ui/icons';
import { useI18n } from '../../i18n';
import {
  extensionVerbLabelKey,
  resolveExtensionVerb,
  type ExtensionPlacement,
  type ExtensionVerbName,
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

function resolveVerbIcon(verb: ExtensionVerbName): IconName {
  if (verb === 'install') return 'download';
  if (verb === 'import') return 'folder-input';
  return 'trash';
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
  const verbIcon = resolveVerbIcon(verb.verb);

  return (
    <div
      className={styles.card}
      data-open={onOpen ? 'true' : 'false'}
      data-installed={installed ? 'true' : 'false'}
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
            <AppIcon name={icon} size={17} />
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
          className={styles.actionsGroup}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Tooltip content={verbLabel}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.action}
              data-verb={verb.verb}
              disabled={busy}
              aria-label={`${verbLabel} ${name}`}
              onClick={onAction}
            >
              <AppIcon name={verbIcon} size={12} />
              <span>{label}</span>
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
