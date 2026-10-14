import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 规则：短规则、预设与全文编辑；成功静默，仅失败提示。
 * 壳组件：作用域选择 + 规则列表 + 快速添加 + 全文编辑弹层装配；
 * 状态/持久化/引擎同步见 useRulesState，纯函数见 settingsRulesLib，
 * 全文弹层见 RulesEditorDialog。
 */
import React, { useId, useRef, useState } from 'react';

import styles from './SettingsRulesTab.module.css';
import { Button, Input, Select, Tooltip } from '../ui';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { useRulesState } from './useRulesState';
import { RULE_PRESETS, normalizeRuleLine } from './settingsRulesLib';
import { RulesEditorDialog } from './RulesEditorDialog';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';

type Props = {
  onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsRulesTab: React.FC<Props> = ({
  onBlockingOverlayChange,
}) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const state = useRulesState({
    onBlockingOverlayChange,
  });
  const {
    scopeKey,
    setScopeKey,
    customRules,
    editorText,
    setEditorText,
    editingOpen,
    setEditingOpen,
    saving,
    loadError,
    loaded,
    scopeLabel,
    storagePath,
    scopeOptions,
    ruleCount,
    retryLoad,
    handleSaveRules,
    addRuleIfNew,
    handleDeleteCustomRule,
  } = state;

  const [newRuleText, setNewRuleText] = useState('');

  const fullEditorBtnRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  const addInputId = useId();
  const scopeSelectId = useId();

  const busy = saving;

  const handleAddCustomRule = () => {
    void addRuleIfNew(newRuleText).then((ok) => {
      if (ok) {
        setNewRuleText('');
        // 成功静默：输入清空 + 列表增长
        addInputRef.current?.focus();
      }
    });
  };

  const handleAddPreset = (preset: string) => {
    void addRuleIfNew(preset);
  };

  const openFullEditor = () => {
    if (!state.isGlobal && !scopeKey) {
      showToast(t('settings.rules.selectProjectFirst', '请先选择项目'));
      return;
    }
    setEditingOpen(true);
  };

  if (!loaded && loadError) {
    return (
      <div className="settings-pane settings-pane--modern settings-pane--rules">
        <header className="settings-page-head">
          <div className="settings-head-inline">
            <h2 className="settings-page-title">
              {t('settings.rules.pageTitle', '规则')}
            </h2>
          </div>
        </header>
        <section
          className="settings-group"
          aria-label={t('common.error', '错误')}
        >
          <div className="settings-list">
            <div className="settings-list-row settings-list-row--rule">
              <div className="settings-list-copy">
                <div
                  className="settings-list-title settings-list-empty"
                  role="alert"
                >
                  {loadError}
                </div>
              </div>
              <div className="settings-list-control">
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
              </div>
            </div>
          </div>
        </section>
      </div>
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

  const headerMeta = (
    <div className={styles.headerMetaRow}>
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
        disabled={busy}
        size="sm"
      />
      <Tooltip
        content={t('settings.rules.editFullTextTooltip', '编辑{scope}全文', {
          scope: scopeLabel,
        })}
      >
        <Button
          ref={fullEditorBtnRef}
          type="button"
          variant="secondary"
          size="sm"
          onClick={openFullEditor}
          aria-label={t('settings.rules.editFullTextAria', '编辑{scope}全文', {
            scope: scopeLabel,
          })}
          disabled={busy}
        >
          {t('settings.rules.editFullText', '编辑全文')}
        </Button>
      </Tooltip>
    </div>
  );

  return (
    <SettingsPage
      title={t('settings.rules.pageTitle', '规则')}
      meta={headerMeta}
    >
      <SettingsSection
        title={t('settings.rules.currentRulesSection', '当前规则 ({scope})', {
          scope: scopeLabel,
        })}
      >
        <SettingsCard>
          {ruleCount === 0 ? (
            <SettingsRow
              title={
                <span className="settings-list-empty">
                  {t('settings.rules.noRulesYet', '还没有规则')}
                </span>
              }
              desc={t(
                'settings.rules.noRulesDesc',
                '可点下方常用项，或自己输入'
              )}
            />
          ) : (
            customRules.map((rule, idx) => (
              <SettingsRow
                key={`${idx}-${rule.slice(0, 24)}`}
                title={
                  <Tooltip content={rule}>
                    <span className="settings-rule-item-text">{rule}</span>
                  </Tooltip>
                }
                control={
                  <Tooltip
                    content={t(
                      'settings.rules.deleteRuleTooltip',
                      '删除此规则'
                    )}
                  >
                    <Button
                      type="button"
                      onClick={() => handleDeleteCustomRule(idx)}
                      variant="danger"
                      size="sm"
                      aria-label={t(
                        'settings.rules.deleteRuleAria',
                        '删除规则：{rule}',
                        { rule }
                      )}
                      disabled={busy}
                      icon={<AppIcon name="trash" size={14} aria-hidden />}
                    />
                  </Tooltip>
                }
              />
            ))
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('settings.rules.quickAddSection', '快速添加')}>
        <SettingsCard>
          <div className={styles.sectionRow}>
            <div className={styles.labelCol}>
              <span className={styles.labelTitle}>
                {t('settings.rules.presetsTitle', '常用')}
              </span>
              <span className={styles.labelDesc}>
                {t('settings.rules.presetsDesc', '一键加入')}
              </span>
            </div>
            <div className={styles.presetGroup}>
              {RULE_PRESETS.map((preset) => {
                const exists = customRules.some(
                  (r) => normalizeRuleLine(r) === normalizeRuleLine(preset)
                );
                return (
                  <Tooltip
                    key={preset}
                    content={
                      exists
                        ? t('settings.rules.presetAlreadyAdded', '已添加')
                        : t(
                            'settings.rules.addPresetTooltip',
                            '添加：{preset}',
                            {
                              preset,
                            }
                          )
                    }
                  >
                    <Button
                      bare
                      type="button"
                      className={styles.presetChip}
                      onClick={() => handleAddPreset(preset)}
                      disabled={exists || busy}
                      aria-label={
                        exists
                          ? t(
                              'settings.rules.presetAlreadyAddedAria',
                              '已添加：{preset}',
                              { preset }
                            )
                          : t(
                              'settings.rules.addPresetAria',
                              '添加预设：{preset}',
                              { preset }
                            )
                      }
                    >
                      {preset}
                    </Button>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          <div className={styles.sectionRowNoBorder}>
            <div className={styles.labelCol}>
              <label htmlFor={addInputId} className={styles.labelTitle}>
                {t('settings.rules.customTitle', '自定义')}
              </label>
              <span className={styles.labelDesc}>
                {t('settings.rules.customDesc', '输入后添加')}
              </span>
            </div>
            <div className={styles.inputGroup}>
              <Input
                ref={addInputRef}
                id={addInputId}
                size="sm"
                placeholder={t(
                  'settings.rules.customRulePlaceholder',
                  '写一条规则…'
                )}
                value={newRuleText}
                onChange={(e) => setNewRuleText(e.target.value)}
                className={styles.inputGrow}
                disabled={busy}
                aria-label={t('settings.rules.customRuleAria', '自定义规则')}
                autoComplete="off"
                spellCheck={false}
                onEnter={handleAddCustomRule}
              />
              <Tooltip
                content={t(
                  'settings.rules.addShortRuleTooltip',
                  '加入{scope}短规则',
                  { scope: scopeLabel }
                )}
              >
                <Button
                  type="button"
                  onClick={handleAddCustomRule}
                  variant="secondary"
                  size="sm"
                  className={styles.actionBtn}
                  disabled={busy || !normalizeRuleLine(newRuleText)}
                  aria-label={t('settings.rules.addRuleAria', '添加规则')}
                >
                  {t('common.add', '添加')}
                </Button>
              </Tooltip>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 全文编辑器：ui/Dialog 基座装配（T05.2 #7 已收敛） */}
      <RulesEditorDialog
        open={editingOpen}
        scopeLabel={scopeLabel}
        storagePath={storagePath}
        saving={saving}
        editorText={editorText}
        onEditorTextChange={setEditorText}
        initialFocusRef={textareaRef}
        onClose={() => setEditingOpen(false)}
        onSave={() => {
          void handleSaveRules();
        }}
      />
    </SettingsPage>
  );
};
