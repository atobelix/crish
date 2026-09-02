import React from 'react';
import { Button, Input, SegmentedControl, Select, Slider, Switch } from '../ui';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import uiStyles from './SettingsUI.module.css';

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
  toggleOptions?: {
    value: string;
    label: React.ReactNode;
    icon?: React.ReactNode;
    badge?: React.ReactNode;
  }[];
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
          <SettingsRow title={<span className={uiStyles.listEmpty}>加载中…</span>} />
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
                    className={uiStyles.controlSelect}
                    size="sm"
                    value={String(val ?? '')}
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
                  <div className={uiStyles.controlInput}>
                    <Input
                      id={domId}
                      size="sm"
                      value={String(val || '')}
                      disabled={!ready}
                      placeholder={prop.placeholder || ''}
                      onChange={(e) => {
                        void onSave({ [prop.key]: e.target.value });
                      }}
                    />
                  </div>
                );
              } else if (prop.type === 'range') {
                const numVal = Number(val ?? prop.min ?? 0);
                control = (
                  <div className={uiStyles.controlRange}>
                    <Slider
                      aria-label={prop.title}
                      min={prop.min ?? 0}
                      max={prop.max ?? 100}
                      step={prop.step ?? 1}
                      value={numVal}
                      disabled={!ready}
                      onChange={(next) => {
                        void onSave({ [prop.key]: next });
                      }}
                      className={uiStyles.controlRangeSlider}
                    />
                    {prop.showValue && (
                      <span className={uiStyles.controlRangeValue}>
                        {numVal}
                        {prop.unit ?? ''}
                      </span>
                    )}
                  </div>
                );
              } else if (prop.type === 'color') {
                control = (
                  <input
                    id={domId}
                    type="color"
                    className={uiStyles.controlColor}
                    value={String(val || '#000000')}
                    disabled={!ready}
                    onChange={(e) => void onSave({ [prop.key]: e.target.value })}
                  />
                );
              } else if (prop.type === 'preset-grid') {
                control = (
                  <div className={uiStyles.presetGrid}>
                    {(prop.presets || []).map((preset) => {
                      const isSelected = val === preset.id;
                      return (
                        <Button
                          key={preset.id}
                          type="button"
                          variant={isSelected ? 'secondary' : 'ghost'}
                          size="sm"
                          disabled={!ready}
                          aria-pressed={isSelected}
                          className={uiStyles.presetItem}
                          onClick={() => void onSave({ [prop.key]: preset.id })}
                        >
                          {preset.preview ? (
                            <span
                              className={uiStyles.presetSwatch}
                              style={{ background: preset.preview }}
                            />
                          ) : null}
                          <span className={uiStyles.presetName}>{preset.name}</span>
                        </Button>
                      );
                    })}
                  </div>
                );
              } else if (prop.type === 'font-selector') {
                control = (
                  <Select
                    className={uiStyles.controlSelect}
                    size="sm"
                    value={String(val ?? '')}
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
                  <SegmentedControl
                    aria-label={prop.title}
                    size="panel"
                    className={uiStyles.controlSegment}
                    value={String(val ?? '')}
                    disabled={!ready}
                    options={(prop.toggleOptions || []).map((opt) => ({
                      value: opt.value,
                      label: opt.label,
                      icon: opt.icon,
                      badge: opt.badge,
                    }))}
                    onChange={(v) => {
                      void onSave({ [prop.key]: v });
                    }}
                  />
                );
              }

              return (
                <SettingsRow
                  key={prop.key}
                  title={
                    prop.type === 'boolean' || prop.type === 'string' || prop.type === 'range' || prop.type === 'color' ? (
                      <label htmlFor={domId} className={uiStyles.settingsUiRowLabel}>
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
