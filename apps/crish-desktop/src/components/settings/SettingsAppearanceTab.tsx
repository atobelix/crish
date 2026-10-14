/**
 * 设置 · 外观：主题、密度、字体与阅读相关选项；改完即生效，仅失败提示。
 * 状态与副作用逻辑已提取到 useAppearanceSettings；本组件仅负责渲染。
 */
import React from 'react';
import { Button, Select } from '../ui';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { FontSettingsSection } from './FontSettingsSection';
import { SettingsSchemaRenderer } from './SettingsSchemaRenderer';
import { useAppearanceSettings } from './useAppearanceSettings';
import { useI18n, type SupportedLanguage } from '../../i18n';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsAppearanceTab: React.FC<Props> = ({
  _onBlockingOverlayChange,
}) => {
  void _onBlockingOverlayChange;
  const { language, setLanguage, t } = useI18n();
  const {
    visibilityRef,
    settings,
    loadError,
    saving,
    setLoadError,
    setLoadTick,
    allValues,
    appearanceSchema,
    save,
    handleSave,
    resetAppearance,
  } = useAppearanceSettings();

  if (loadError && !settings) {
    return (
      <SettingsPage title={t('nav.appearance', '外观')}>
        <SettingsSection title={t('common.error', '错误')}>
          <SettingsCard>
            <SettingsRow
              title={<span role="alert">{loadError}</span>}
              control={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setLoadError(null);
                    setLoadTick((n) => n + 1);
                  }}
                >
                  {t('common.retry', '重试')}
                </Button>
              }
            />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  if (!settings) {
    return (
      <SettingsPage title={t('nav.appearance', '外观')}>
        <SettingsSection>
          <SettingsCard>
            <SettingsRow
              title={<span>{t('common.loading', '加载中…')}</span>}
            />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  return (
    <div ref={visibilityRef}>
      <SettingsPage title={t('nav.appearance', '外观')}>
        {/* 语言设置 / Language setting */}
        <SettingsSection title={t('settings.general.language')}>
          <SettingsCard>
            <SettingsRow
              title={t('settings.general.language')}
              desc={t('settings.general.languageDesc')}
              control={
                <Select
                  size="sm"
                  value={language}
                  options={[
                    { id: 'zh-CN', label: '简体中文' },
                    { id: 'en-US', label: 'English' },
                  ]}
                  onChange={(newLang) => {
                    setLanguage(newLang as SupportedLanguage);
                  }}
                />
              }
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSchemaRenderer
          schema={appearanceSchema}
          values={allValues}
          onSave={handleSave}
          ready
        />

        {/*
          字体设置（FontSettingsSection）保留为手写控件，原因：
          - 包含字体加载状态、预览文本、异步字体加载等复杂交互
          - 与 fontStore 深度耦合，不适合 Schema 抽象
        */}
        <SettingsSection
          title={t('settings.appearance.groupTypography', '字体与排版')}
        >
          <SettingsCard>
            <FontSettingsSection
              onPersistSettings={async (fonts) => {
                const ok = await save({ fonts });
                if (!ok) {
                  throw new Error(
                    t('settings.frame.saveFailed', '字体设置未写入 settings')
                  );
                }
              }}
            />
          </SettingsCard>
        </SettingsSection>

        {/*
          「重置外观」按钮保留为手写控件，原因：
          - 不是数据绑定控件，而是一次性动作按钮
          - SchemaRenderer 目前没有 "button"/"action" 类型
          - 若用 Schema 实现需新增 type，超出当前需求范围
        */}
        <SettingsSection title={t('common.more', '其他')}>
          <SettingsCard>
            <SettingsRow
              title={t('settings.frame.reset', '重置外观')}
              control={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    void resetAppearance();
                  }}
                >
                  {t('common.reset', '重置')}
                </Button>
              }
            />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    </div>
  );
};
