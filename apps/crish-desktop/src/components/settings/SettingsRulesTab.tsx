import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 规则：短规则、预设与全文编辑；成功静默，仅失败提示。
 * 壳组件：作用域选择 + 规则列表 + 快速添加 + 全文编辑弹层装配；
 * 状态/持久化/引擎同步见 useRulesState，纯函数见 settingsRulesLib，
 * 全文弹层见 RulesEditorDialog。
 */
import React, { useId, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './SettingsRulesTab.module.css';
import { Button, Select, Tooltip } from '../ui';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { useRulesState } from './useRulesState';
import {
  RULE_PRESETS,
  normalizeRuleLine,
} from './settingsRulesLib';
import { RulesEditorDialog } from './RulesEditorDialog';

type Props = {
  onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsRulesTab: React.FC<Props> = ({ onBlockingOverlayChange }) => {
  const { showToast: _showToast } = useToast();
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
      showToast('请先选择项目');
      return;
    }
    setEditingOpen(true);
  };

  if (!loaded && loadError) {
    return (
      <div className="settings-pane settings-pane--modern settings-pane--rules">
        <header className="settings-page-head">
          <div className="settings-head-inline">
            <h2 className="settings-page-title">规则</h2>
          </div>
        </header>
        <section className="settings-group" aria-label="错误">
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
                  aria-label="重新加载规则"
                  onClick={retryLoad}
                >
                  重试
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
      <SettingsPage title="规则">
        <SettingsSection>
          <SettingsCard>
            <SettingsRow title="加载中…" />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  const headerMeta = (
    <div className="settings-head-tools settings-head-tools--rules">
      <div className="settings-head-tools-row">
        <label htmlFor={scopeSelectId} className="sr-only">
          规则作用域
        </label>
        <Select
          value={scopeKey}
          options={scopeOptions.map((o) => ({
            id: o.value,
            label: o.label,
            ...(o.hint !== undefined ? { hint: o.hint } : {}),
          }))}
          onChange={setScopeKey}
          disabled={busy}
          className="settings-rules-scope-select"
        />
        <Tooltip content={`编辑${scopeLabel}全文`}>
          <Button
            ref={fullEditorBtnRef}
            type="button"
            variant="secondary"
            size="sm"
            onClick={openFullEditor}
            aria-label={`编辑${scopeLabel}全文`}
            disabled={busy}
          >
            编辑全文
          </Button>
        </Tooltip>
      </div>
    </div>
  );

  return (
    <SettingsPage title="规则" meta={headerMeta}>
      <SettingsSection title={`当前规则 (${scopeLabel})`}>
        <SettingsCard>
          {ruleCount === 0 ? (
            <SettingsRow
              title={<span className="settings-list-empty">还没有规则</span>}
              desc="可点下方常用项，或自己输入"
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
                  <Tooltip content="删除此规则">
                    <Button
                      type="button"
                      onClick={() => handleDeleteCustomRule(idx)}
                      variant="danger"
                      size="sm"
                      aria-label={`删除规则：${rule}`}
                      disabled={busy}
                      icon={<Lucide.Trash2 size={14} aria-hidden />}
                    />
                  </Tooltip>
                }
              />
            ))
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="快速添加">
        <SettingsCard>
          <div className={styles.sectionRow}>
            <div className={styles.labelCol}>
              <span className={styles.labelTitle}>常用</span>
              <span className={styles.labelDesc}>一键加入</span>
            </div>
            <div className={styles.presetGroup}>
              {RULE_PRESETS.map((preset) => {
                const exists = customRules.some(
                  (r) => normalizeRuleLine(r) === normalizeRuleLine(preset),
                );
                return (
                  <Tooltip key={preset} content={exists ? '已添加' : `添加：${preset}`}>
                    <button
                      type="button"
                      className={`settings-rule-preset${exists ? ' is-disabled' : ''}`}
                      onClick={() => handleAddPreset(preset)}
                      disabled={exists || busy}
                      aria-label={
                        exists ? `已添加：${preset}` : `添加预设：${preset}`
                      }
                    >
                      {preset}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          <div className={styles.sectionRowNoBorder}>
            <div className={styles.labelCol}>
              <label htmlFor={addInputId} className={styles.labelTitle}>自定义</label>
              <span className={styles.labelDesc}>输入后添加</span>
            </div>
            <div className={styles.inputGroup}>
              <input
                ref={addInputRef}
                id={addInputId}
                type="text"
                placeholder="写一条规则…"
                value={newRuleText}
                onChange={(e) => setNewRuleText(e.target.value)}
                className={`settings-field-input settings-field-input--sm settings-field-input--grow ${styles.inputGrow}`}
                disabled={busy}
                aria-label="自定义规则"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddCustomRule();
                  }
                }}
              />
              <Tooltip content={`加入${scopeLabel}短规则`}>
                <Button
                  type="button"
                  onClick={handleAddCustomRule}
                  variant="secondary"
                  size="sm"
                  className={styles.actionBtn}
                  disabled={busy || !normalizeRuleLine(newRuleText)}
                  aria-label="添加规则"
                >
                  添加
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
