import React from 'react';
import { createPortal } from 'react-dom';
import './SettingsUI.css';

export const SettingsPage: React.FC<{
  title: string;
  children: React.ReactNode;
  meta?: React.ReactNode;
}> = ({ title, children, meta }) => (
  <div className="settings-ui-page">
    <header className="settings-ui-page-head">
      <div className="settings-ui-head-inline">
        <h2 className="settings-ui-page-title">{title}</h2>
        {meta}
      </div>
    </header>
    <div className="settings-ui-page-body">{children}</div>
  </div>
);

export const SettingsSection: React.FC<{
  title?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, children }) => (
  <section className="settings-ui-section">
    {title && <h3 className="settings-ui-section-title">{title}</h3>}
    <div className="settings-ui-section-content">{children}</div>
  </section>
);

export const SettingsCard: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => <div className="settings-ui-card">{children}</div>;

export const SettingsRow: React.FC<{
  icon?: React.ReactNode;
  title: React.ReactNode;
  desc?: React.ReactNode;
  control?: React.ReactNode;
  onClick?: () => void;
  className?: string;
}> = ({ icon, title, desc, control, onClick, className = '' }) => {
  const Component = onClick ? 'button' : 'div';
  return (
    <Component
      className={`settings-ui-row ${onClick ? 'settings-ui-row-clickable' : ''} ${className}`}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
    >
      {icon && <div className="settings-ui-row-icon">{icon}</div>}
      <div className="settings-ui-row-body">
        <div className="settings-ui-row-title">{title}</div>
        {desc && <div className="settings-ui-row-desc">{desc}</div>}
      </div>
      {control && (
        <div
          className="settings-ui-row-control"
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
          className="modern-select-tooltip"
          style={{
            position: 'fixed',
            top: rect.top - 8,
            left: rect.left + rect.width / 2,
            transform: 'translate(-50%, -100%)',
            zIndex: 20060,
          }}
        >
          <div className="modern-select-tooltip-inner">{content}</div>
          <div className="modern-select-tooltip-arrow" />
        </div>,
        document.body
      )}
    </>
  );
};
