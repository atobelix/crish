import React from 'react';
import { Select, Switch } from '../ui';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';

export interface SchemaProperty {
  key: string;
  type: 'boolean' | 'select' | 'string' | 'range' | 'color' | 'preset-grid' | 'font-selector' | 'toggle-group';
  title: string;
  desc?: string;
  options?: { value: string; label: string; hint?: string }[];
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  showValue?: boolean;
  presets?: { id: string; name: string; preview: string }[];
  category?: 'sans' | 'mono';
  previewText?: string;
  toggleOptions?: { value: string; label: string; icon?: string }[];
}

export interface SchemaSection {
  title: string;
  properties: SchemaProperty[];
}

export interface SettingsSchemaRendererProps {
  schema: SchemaSection[];
  values: object | null;
  onSave: (updates: Record<string, unknown>) => void | Promise<unknown>;
  ready: boolean;
}

export const SettingsSchemaRenderer: React.FC<SettingsSchemaRendererProps> = React.memo(({
  schema,
  values,
  onSave,
  ready,
}) => {
  const idsMap = React.useRef<Record<string, string>>({});

  const getElementId = (key: string) => {
    if (!idsMap.current[key]) {
      idsMap.current[key] = `settings-field-${key}-${Math.random().toString(36).slice(2, 9)}`;
    }
    return idsMap.current[key];
  };

  if (!values) {
    return (
      <SettingsSection>
        <SettingsCard>
          <SettingsRow title={<span className="settings-list-empty">加载中…</span>} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <>
      {schema.map((section, sIdx) => (
        <SettingsSection key={sIdx} title={section.title}>
          <SettingsCard>
            {section.properties.map((prop) => {
              const domId = getElementId(prop.key);
              const val = (values as Record<string, unknown>)[prop.key];

              let control: React.ReactNode = null;

              if (prop.type === 'boolean') {
                const checked = Boolean(val);
                control = (
                  <Switch
                    id={domId}
                    checked={checked}
                    disabled={!ready}
                    onCheckedChange={(next) => {
                      void onSave({ [prop.key]: next });
                    }}
                  />
                );
              } else if (prop.type === 'select') {
                control = (
                  <Select
                    className="settings-personalize-select"
                    value={String(val || '')}
                    options={(prop.options || []).map((o) => ({
                      id: o.value,
                      label: o.label,
                      ...(o.hint !== undefined ? { hint: o.hint } : {}),
                    }))}
                    onChange={(v) => {
                      void onSave({ [prop.key]: v });
                    }}
                    disabled={!ready}
                    placeholder={prop.placeholder || '请选择…'}
                  />
                );
              } else if (prop.type === 'string') {
                control = (
                  <input
                    id={domId}
                    type="text"
                    className="ui-text-input settings-text-input"
                    value={String(val || '')}
                    disabled={!ready}
                    placeholder={prop.placeholder || ''}
                    onChange={(e) => {
                      void onSave({ [prop.key]: e.target.value });
                    }}
                    style={{
                      padding: '4px 8px',
                      borderRadius: 'var(--radius-sm, 6px)',
                      border: '1px solid var(--border-color)',
                      background: 'var(--bg-card)',
                      color: 'var(--text-primary)',
                      fontSize: 'var(--font-size-sm)',
                      fontFamily: 'inherit',
                      width: '180px',
                    }}
                  />
                );
              } else if (prop.type === 'range') {
                const numVal = Number(val ?? prop.min ?? 0);
                control = (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      id={domId}
                      type="range"
                      min={prop.min ?? 0}
                      max={prop.max ?? 100}
                      step={prop.step ?? 1}
                      value={numVal}
                      disabled={!ready}
                      onChange={(e) => void onSave({ [prop.key]: Number(e.target.value) })}
                      style={{ cursor: 'pointer', accentColor: 'var(--text-primary)', height: 4, width: 100 }}
                    />
                    {prop.showValue && (
                      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', minWidth: 40, textAlign: 'right', fontWeight: 600 }}>
                        {numVal}{prop.unit ?? ''}
                      </span>
                    )}
                  </div>
                );
              } else if (prop.type === 'color') {
                control = (
                  <input
                    id={domId}
                    type="color"
                    // 待确认：颜色选择器默认值（纯黑）是功能数据而非样式 token，暂不迁移
                    value={String(val || '#000000')}
                    disabled={!ready}
                    onChange={(e) => void onSave({ [prop.key]: e.target.value })}
                    style={{ cursor: 'pointer', border: '1px solid var(--border-color)', borderRadius: 6, width: 40, height: 24, padding: 0, background: 'transparent' }}
                  />
                );
              } else if (prop.type === 'preset-grid') {
                control = (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 8 }}>
                    {(prop.presets || []).map((preset) => {
                      const isSelected = val === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          disabled={!ready}
                          onClick={() => void onSave({ [prop.key]: preset.id })}
                          style={{
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                            padding: 8, borderRadius: 8, cursor: 'pointer',
                            border: isSelected ? '2px solid var(--accent-color)' : '1px solid var(--border-color)',
                            background: 'var(--bg-card)', color: 'var(--text-primary)',
                            position: 'relative', transition: 'border-color 0.15s',
                          }}
                        >
                          {preset.preview && (
                            <div style={{ width: 32, height: 32, borderRadius: 6, background: preset.preview }} />
                          )}
                          <span style={{ fontSize: 'var(--font-size-xs)', textAlign: 'center', lineHeight: 1.3 }}>{preset.name}</span>
                          {isSelected && (
                            <span style={{ position: 'absolute', top: 2, right: 2, fontSize: 12, color: 'var(--accent-color)' }}>✓</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              } else if (prop.type === 'font-selector') {
                control = (
                  <Select
                    className="settings-personalize-select"
                    value={String(val || '')}
                    options={(prop.options || []).map((o) => ({
                      id: o.value,
                      label: o.label,
                      ...(o.hint !== undefined ? { hint: o.hint } : {}),
                    }))}
                    onChange={(v) => void onSave({ [prop.key]: v })}
                    disabled={!ready}
                    placeholder={prop.placeholder || '请选择…'}
                  />
                );
              } else if (prop.type === 'toggle-group') {
                control = (
                  <div className="ui-segment">
                    {(prop.toggleOptions || []).map((opt) => {
                      const isActive = String(val) === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          className={`ui-segment-item${isActive ? ' active' : ''}`}
                          disabled={!ready}
                          aria-pressed={isActive}
                          onClick={() => void onSave({ [prop.key]: opt.value })}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                );
              }

               return (
                <SettingsRow
                  key={prop.key}
                  title={
                    prop.type === 'boolean' || prop.type === 'string' || prop.type === 'range' || prop.type === 'color' ? (
                      <label htmlFor={domId} className="settings-ui-row-label">
                        {prop.title}
                      </label>
                    ) : (
                      <span id={domId}>{prop.title}</span>
                    )
                  }
                  desc={prop.desc}
                  control={control}
                  vertical={prop.type === 'preset-grid'}
                />
              );
            })}
          </SettingsCard>
        </SettingsSection>
      ))}
    </>
  );
});

SettingsSchemaRenderer.displayName = 'SettingsSchemaRenderer';
