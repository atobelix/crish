import React from 'react';
import styles from './SettingsUI.module.css';
import { G2Surface } from '../ui/G2Surface';

export const SettingsPage: React.FC<{
  title: string;
  children: React.ReactNode;
  meta?: React.ReactNode;
  fillViewport?: boolean;
}> = ({ title, children, meta, fillViewport }) => (
  <div
    className={`${styles.settingsUiPage} ${fillViewport ? styles.fillViewport + ' fill-viewport' : ''} settings-ui-page`}
  >
    <header className={`${styles.settingsUiPageHead} settings-ui-page-head`}>
      <div className={`${styles.settingsUiHeadInline} settings-ui-head-inline`}>
        <h2 className={`${styles.settingsUiPageTitle} settings-ui-page-title`}>
          {title}
        </h2>
        {meta}
      </div>
    </header>
    <div
      className={`${styles.settingsUiPageBody} ${fillViewport ? styles.fillViewportBody + ' fill-viewport-body' : ''} settings-ui-page-body`}
    >
      {children}
    </div>
  </div>
);

export const SettingsHeadTools: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = '' }) => (
  <div
    className={`${styles.settingsHeadTools}${className ? ` ${className}` : ''}`}
  >
    {children}
  </div>
);

export const SettingsSection: React.FC<{
  title?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ title, children, className = '' }) => (
  <section
    className={`${styles.settingsUiSection} settings-ui-section${className ? ` ${className}` : ''}`}
  >
    {title && (
      <h3
        className={`${styles.settingsUiSectionTitle} settings-ui-section-title`}
      >
        {title}
      </h3>
    )}
    <div
      className={`${styles.settingsUiSectionContent} settings-ui-section-content`}
    >
      {children}
    </div>
  </section>
);

export const SettingsCard: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  // G² 形状接入（G² 推广第一波槽 C）：设置卡正典的单一包点——根节点即
  // G2Surface（r16 档），底色/描边走同路径层（暗色卡面色经 --settings-card-bg
  // 在卡类上定义、继承进形状层），内容经同路径 clip 承载（.settingsUiCard 的
  // overflow:hidden 由 [data-g2-mode] 规则放行）。行子元素由 contentStyle
  // 的 flex 纵列承接，与原卡根 flex 语义一致。
  <G2Surface
    radius="r16"
    fill="var(--settings-card-bg, var(--cover-card-bg, var(--bg-card)))"
    stroke="var(--border-subtle)"
    clip
    className={`${styles.settingsUiCard} settings-ui-card`}
    contentStyle={{
      display: 'flex',
      flexDirection: 'column',
      flex: '1 1 auto',
      minHeight: 0,
    }}
  >
    {children}
  </G2Surface>
);

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
      {icon && (
        <div className={`${styles.settingsUiRowIcon} settings-ui-row-icon`}>
          {icon}
        </div>
      )}
      <div className={`${styles.settingsUiRowBody} settings-ui-row-body`}>
        <div className={`${styles.settingsUiRowTitle} settings-ui-row-title`}>
          {title}
        </div>
        {desc && (
          <div className={`${styles.settingsUiRowDesc} settings-ui-row-desc`}>
            {desc}
          </div>
        )}
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

/**
 * 共享空态（设置各页统一口径）：图标 + 标题 + 副文案 + 可选动作，居中成块。
 * 签名定死为 icon/title/description/action，后续批次只消费不改。
 */
export interface SettingsEmptyProps {
  /** 空态图标（如 AppIcon 节点） */
  icon?: React.ReactNode;
  /** 空态标题 */
  title: React.ReactNode;
  /** 空态副文案 */
  description?: React.ReactNode;
  /** 可选动作（如引导按钮） */
  action?: React.ReactNode;
}

export const SettingsEmpty: React.FC<SettingsEmptyProps> = ({
  icon,
  title,
  description,
  action,
}) => (
  <div className={`${styles.settingsEmpty} settings-empty`}>
    {icon && (
      <div className={`${styles.settingsEmptyIcon} settings-empty-icon`}>
        {icon}
      </div>
    )}
    <div className={`${styles.settingsEmptyTitle} settings-empty-title`}>
      {title}
    </div>
    {description && (
      <div className={`${styles.settingsEmptyDesc} settings-empty-desc`}>
        {description}
      </div>
    )}
    {action && (
      <div className={`${styles.settingsEmptyAction} settings-empty-action`}>
        {action}
      </div>
    )}
  </div>
);
