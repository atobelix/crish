import React from 'react';
import { SettingsSelect } from '../SettingsSelect';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';

export interface SchemaProperty {
  key: string;
  type: 'boolean' | 'select' | 'string';
  title: string;
  desc?: string;
  options?: { value: string; label: string; hint?: string }[];
  placeholder?: string;
}

export interface SchemaSection {
  title: string;
  properties: SchemaProperty[];
}

export interface SettingsSchemaRendererProps {
  schema: SchemaSection[];
  values: Record<string, any> | null;
  onSave: (updates: Record<string, any>) => void | Promise<any>;
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
              const val = values[prop.key];

              let control: React.ReactNode = null;

              if (prop.type === 'boolean') {
                const checked = Boolean(val);
                control = (
                  <input
                    id={domId}
                    type="checkbox"
                    className="settings-switch settings-switch--personalize"
                    checked={checked}
                    disabled={!ready}
                    onChange={(e) => {
                      void onSave({ [prop.key]: e.target.checked });
                    }}
                  />
                );
              } else if (prop.type === 'select') {
                control = (
                  <SettingsSelect
                    className="settings-personalize-select"
                    value={String(val || '')}
                    options={prop.options || []}
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
              }

              return (
                <SettingsRow
                  key={prop.key}
                  title={
                    prop.type === 'boolean' || prop.type === 'string' ? (
                      <label htmlFor={domId} className="settings-ui-row-label">
                        {prop.title}
                      </label>
                    ) : (
                      <span id={domId}>{prop.title}</span>
                    )
                  }
                  desc={prop.desc}
                  control={control}
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
