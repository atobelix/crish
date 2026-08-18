import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 外观：主题、密度、字体与阅读相关选项；改完即生效，仅失败提示。
 * 状态与副作用逻辑已提取到 useAppearanceSettings；本组件仅负责渲染。
 */
import React from 'react';
import { Button } from '../ui';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { FontSettingsSection } from './FontSettingsSection';
import { SettingsSchemaRenderer } from './SettingsSchemaRenderer';
import { useAppearanceSettings } from './useAppearanceSettings';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsAppearanceTab: React.FC<Props> = ({ _onBlockingOverlayChange }) => {
  const { showToast } = useToast();
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
    applyDensity,
    handleSave,
  } = useAppearanceSettings();

  if (loadError && !settings) {
    return (
      <SettingsPage title="外观">
        <SettingsSection title="错误">
          <SettingsCard>
            <SettingsRow
              title={
                <span className="settings-list-empty" role="alert">
                  {loadError}
                </span>
              }
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
                  重试
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
      <SettingsPage title="外观">
        <SettingsSection>
          <SettingsCard>
            <SettingsRow
              title={<span className="settings-list-empty">加载中…</span>}
            />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  return (
    <div ref={visibilityRef}>
      <SettingsPage title="外观">
        <SettingsSchemaRenderer
          schema={appearanceSchema}
          values={allValues}
          onSave={handleSave}
          ready={!saving}
        />

        {/*
          字体设置（FontSettingsSection）保留为手写控件，原因：
          - 包含字体加载状态、预览文本、异步字体加载等复杂交互
          - 与 fontStore 深度耦合，不适合 Schema 抽象
        */}
        <SettingsSection title="字体">
          <SettingsCard>
            <FontSettingsSection
              
              onPersistSettings={async (fonts) => {
                const ok = await save({ fonts });
                if (!ok) {
                  throw new Error('字体设置未写入 settings');
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
        <SettingsSection title="其他">
          <SettingsCard>
            <SettingsRow
              title="重置外观"
              control={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    void (async () => {
                      try {
                        const { DEFAULT_FONT_PREFS, setFontPreferences } =
                          await import('../../api/fontStore');
                        const ok = await save({
                          theme: 'default',
                          hideThinkingBlock: false,
                          markdown: {
                            ...(settings.markdown || {}),
                            codeBlockIndent: '  ',
                          },
                          fonts: { ...DEFAULT_FONT_PREFS },
                        });
                        if (!ok) return;
                        // D3：主题走 save 路径（settingsStore → themeProjection 投影），
                        // 不再直调 setTheme（crish_theme 单一写端 = themeProjection）
                        await setFontPreferences({ ...DEFAULT_FONT_PREFS });
                        applyDensity('medium');
                      } catch (err) {
                        showToast('重置失败：' + String(err));
                      }
                    })();
                  }}
                >
                  重置
                </Button>
              }
            />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    </div>
  );
};
