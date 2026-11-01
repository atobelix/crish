/**
 * 设置 · 规则：作用域选择 + 常驻全文编辑器；成功静默，仅失败提示。
 * 壳组件：作用域 Select（「当前规则」卡首行）+ 全文 Textarea（页面主体，
 * 进页即可编辑）+ 页尾保存行（写入位置提示 + 保存按钮）；
 * 状态/持久化/引擎同步见 useRulesState，纯函数见 settingsRulesLib。
 * 保存语义与原全文编辑弹层一致：显式保存——解析行 → 本机写入 → 引擎同步。
 * 切换作用域即换载该作用域的全文（未保存草稿不跨作用域保留）。
 */
import React, { useId } from 'react';

import styles from './SettingsRulesTab.module.css';
import { Button, Select, Textarea } from '@/components/ui';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { useRulesState } from './useRulesState';
import { useI18n } from '../../i18n';

type Props = {
  onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsRulesTab: React.FC<Props> = ({
  onBlockingOverlayChange,
}) => {
  // 本页已无二级弹层（原全文编辑 Dialog 已并入常驻编辑器），此回调不再触发；
  // 仍接收以保持 SettingsPanel 的页签装配契约不变（同 SettingsProfileTab 口径）。
  void onBlockingOverlayChange;
  const { t } = useI18n();
  const {
    scopeKey,
    setScopeKey,
    editorText,
    setEditorText,
    dirty,
    saving,
    loadError,
    loaded,
    scopeLabel,
    storagePath,
    scopeOptions,
    retryLoad,
    handleSaveRules,
  } = useRulesState();

  const scopeSelectId = useId();
  const editorId = useId();

  if (!loaded && loadError) {
    return (
      <SettingsPage title={t('settings.rules.pageTitle', '规则')}>
        <SettingsSection>
          <SettingsCard>
            <SettingsRow
              title={<span role="alert">{loadError}</span>}
              control={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label={t(
                    'settings.rules.reloadRulesAria',
                    '重新加载规则'
                  )}
                  onClick={retryLoad}
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

  if (!loaded) {
    return (
      <SettingsPage title={t('settings.rules.pageTitle', '规则')}>
        <SettingsSection>
          <SettingsCard>
            <SettingsRow title={t('common.loading', '加载中…')} />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title={t('settings.rules.pageTitle', '规则')}>
      <SettingsSection
        title={t('settings.rules.currentRulesSection', '当前规则 ({scope})', {
          scope: scopeLabel,
        })}
      >
        <SettingsCard>
          {/* 作用域选择留在卡内首行（页面右上）：核心操作控件与其作用的
              编辑面同处一卡，切换即换载下方全文 */}
          <SettingsRow
            title={t('settings.rules.scopeLabel', '规则作用域')}
            control={
              <>
                <label htmlFor={scopeSelectId} className="sr-only">
                  {t('settings.rules.scopeLabel', '规则作用域')}
                </label>
                <Select
                  id={scopeSelectId}
                  value={scopeKey}
                  options={scopeOptions.map((o) => ({
                    id: o.value,
                    label: o.label,
                    ...(o.hint !== undefined ? { hint: o.hint } : {}),
                  }))}
                  onChange={setScopeKey}
                  disabled={saving}
                  size="sm"
                />
              </>
            }
          />
          {/* 常驻全文编辑器：进页即为可编辑状态，不再经弹层中转 */}
          <SettingsRow
            vertical
            title={
              <label htmlFor={editorId}>
                {t('settings.rules.editorTitle', '规则全文')}
              </label>
            }
            control={
              <Textarea
                bare
                id={editorId}
                className={styles.editorTextarea}
                value={editorText}
                onChange={(e) => setEditorText(e.target.value)}
                spellCheck={false}
                disabled={saving}
                aria-label={t('settings.rules.editorAria', '{scope}规则正文', {
                  scope: scopeLabel,
                })}
                placeholder={t(
                  'settings.rules.editorPlaceholder',
                  '每行一条规则；# 开头为标题'
                )}
              />
            }
          />
        </SettingsCard>

        {/* 页尾操作行：卡外呈现，与其他设置页操作行同口径；左侧为写入位置
            提示（区分当前项目文件与全局设置），右侧为显式保存 */}
        <div className={styles.actionsBar}>
          <span className={styles.storageHint}>
            {t('settings.rules.storageHint', '保存后写入 {path}', {
              path: storagePath,
            })}
          </span>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => {
              void handleSaveRules();
            }}
            disabled={!dirty || saving}
            aria-busy={saving || undefined}
          >
            {saving
              ? t('settings.rules.saving', '保存中…')
              : t('common.save', '保存')}
          </Button>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
};
