import React from 'react';
import { createPortal } from 'react-dom';
import styles from './SettingsUI.module.css';

export const SettingsPage: React.FC<{
  title: string;
  children: React.ReactNode;
  meta?: React.ReactNode;
}> = ({ title, children, meta }) => (
  <div className={`${styles.settingsUiPage} settings-ui-page`}>
    <header className={`${styles.settingsUiPageHead} settings-ui-page-head`}>
      <div className={`${styles.settingsUiHeadInline} settings-ui-head-inline`}>
        <h2 className={`${styles.settingsUiPageTitle} settings-ui-page-title`}>{title}</h2>
        {meta}
      </div>
    </header>
    <div className={`${styles.settingsUiPageBody} settings-ui-page-body`}>{children}</div>
  </div>
);

export const SettingsSection: React.FC<{
  title?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, children }) => (
  <section className={`${styles.settingsUiSection} settings-ui-section`}>
    {title && <h3 className={`${styles.settingsUiSectionTitle} settings-ui-section-title`}>{title}</h3>}
    <div className={`${styles.settingsUiSectionContent} settings-ui-section-content`}>{children}</div>
  </section>
);

export const SettingsCard: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => <div className={`${styles.settingsUiCard} settings-ui-card`}>{children}</div>;

export const SettingsRow: React.FC<{
  icon?: React.ReactNode;
  title: React.ReactNode;
  desc?: React.ReactNode;
  control?: React.ReactNode;
  onClick?: () => void;
  className?: string;
  vertical?: boolean;
}> = ({ icon, title, desc, control, onClick, className = '', vertical }) => {
  const Component = onClick ? 'button' : 'div';
  return (
    <Component
      className={`${styles.settingsUiRow} ${onClick ? styles.settingsUiRowClickable + ' settings-ui-row-clickable' : ''} ${vertical ? styles.settingsUiRowVertical + ' settings-ui-row-vertical' : ''} settings-ui-row ${className}`}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
    >
      {icon && <div className={`${styles.settingsUiRowIcon} settings-ui-row-icon`}>{icon}</div>}
      <div className={`${styles.settingsUiRowBody} settings-ui-row-body`}>
        <div className={`${styles.settingsUiRowTitle} settings-ui-row-title`}>{title}</div>
        {desc && <div className={`${styles.settingsUiRowDesc} settings-ui-row-desc`}>{desc}</div>}
      </div>
      {control && (
        <div
          className={`${styles.settingsUiRowControl} settings-ui-row-control`}
          onClick={(e) => {
            // Prevent row click if control is clicked
            if (onClick) e.stopPropagation();
          }}
        >
          {control}
        </div>
      )}
    </Component>
  );
};

export const Tooltip: React.FC<{
  content: React.ReactNode;
  children: React.ReactElement;
  disabled?: boolean;
}> = ({ content, children, disabled }) => {
  const [hovered, setHovered] = React.useState(false);
  const [rect, setRect] = React.useState<DOMRect | null>(null);

  if (disabled || !content) return children;

  const child = children as React.ReactElement<any>;

  return (
    <>
      {React.cloneElement(child, {
        onMouseEnter: (e: React.MouseEvent) => {
          setRect(e.currentTarget.getBoundingClientRect());
          setHovered(true);
          if (child.props.onMouseEnter) child.props.onMouseEnter(e);
        },
        onMouseLeave: (e: React.MouseEvent) => {
          setHovered(false);
          if (child.props.onMouseLeave) child.props.onMouseLeave(e);
        },
      })}
      {hovered && rect && createPortal(
        <div
          className={`${styles.modernSelectTooltip} modern-select-tooltip`}
          style={{
            position: 'fixed',
            top: rect.top - 8,
            left: rect.left + rect.width / 2,
            transform: 'translate(-50%, -100%)',
            zIndex: 'var(--z-settings-tooltip)',
          }}
        >
          <div className={`${styles.modernSelectTooltipInner} modern-select-tooltip-inner`}>{content}</div>
          <div className={`${styles.modernSelectTooltipArrow} modern-select-tooltip-arrow`} />
        </div>,
        document.body
      )}
    </>
  );
};
