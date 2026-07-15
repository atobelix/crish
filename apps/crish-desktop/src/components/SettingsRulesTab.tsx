/**
 * 设置 · 规则：自定义规范列表 / 编辑全局或项目规则文件
 */
import React, { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import { clientApi, type Settings } from '../api/clientApi';
import { getWorkspacePath } from '../api/projectStore';
import { syncRulesToDaemon, textToRuleLines } from '../api/rulesApi';

type Props = {
  onShowToast: (msg: string) => void;
  /** 二级弹层打开时通知父级，避免 Esc 直接关掉整个设置页 */
  onBlockingOverlayChange?: (blocking: boolean) => void;
};

export const SettingsRulesTab: React.FC<Props> = ({
  onShowToast,
  onBlockingOverlayChange,
}) => {
  const cwd = getWorkspacePath() || '__global__';
  const hasWorkspace =
    typeof localStorage !== 'undefined' && Boolean(localStorage.getItem('crish_workspace'));

  const [customRules, setCustomRules] = useState<string[]>([]);
  const [globalRules, setGlobalRules] = useState('');
  const [projectRules, setProjectRules] = useState('');
  const [newRuleText, setNewRuleText] = useState('');
  const [editingRuleFileType, setEditingRuleFileType] = useState<'global' | 'project' | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sets = await clientApi.getSettingsEx(cwd);
        if (cancelled || !sets) return;
        const rulesJoined = (sets.customRules || []).join('\n');
        setCustomRules(sets.customRules || []);
        setGlobalRules(
          rulesJoined ||
            '# 全局规则\n\n- 在敏感修改前先征得确认\n- 保持既有代码风格与格式\n',
        );
        setProjectRules('# 项目规则\n\n（打开项目后可在此补充项目专属约定）\n');
      } catch (err) {
        onShowToast('读取规则失败：' + String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, onShowToast]);

  useEffect(() => {
    onBlockingOverlayChange?.(Boolean(editingRuleFileType));
    return () => onBlockingOverlayChange?.(false);
  }, [editingRuleFileType, onBlockingOverlayChange]);

  useEffect(() => {
    if (!editingRuleFileType) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setEditingRuleFileType(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editingRuleFileType]);

  const persistCustomRules = async (rules: string[]) => {
    try {
      const merged = await clientApi.saveSettingsEx(cwd, 'global', { customRules: rules } as Partial<Settings>);
      setCustomRules(merged.customRules || rules);
    } catch (err) {
      onShowToast('更新设置失败：' + String(err));
    }
  };

  const handleSaveRules = async (scopeType: 'global' | 'project') => {
    const text = scopeType === 'global' ? globalRules : projectRules;
    const lines = textToRuleLines(text);
    await persistCustomRules(lines);
    const sync = await syncRulesToDaemon({
      globalText: globalRules,
      projectText: projectRules,
    });
    if (sync.daemonSynced) {
      onShowToast(
        scopeType === 'global'
          ? '全局规则已保存并同步到引擎'
          : '项目规则已保存并同步到引擎',
      );
    } else {
      onShowToast(
        sync.error
          ? `规则已保存在本机；引擎未同步：${sync.error}`
          : '规则已保存在本机；引擎未连接时仅本地生效',
      );
    }
    if (sync.truncated) {
      onShowToast('规则较长，同步到引擎时已截断（本机仍保留全文）');
    }
  };

  const handleAddCustomRule = () => {
    const text = newRuleText.trim();
    if (!text) {
      onShowToast('请输入规则内容');
      return;
    }
    if (customRules.includes(text)) {
      onShowToast('该规则已存在');
      return;
    }
    void persistCustomRules([...customRules, text]);
    setNewRuleText('');
    onShowToast('智能体规范规则已添加');
  };

  const handleDeleteCustomRule = (index: number) => {
    const updated = customRules.filter((_, i) => i !== index);
    void persistCustomRules(updated);
    onShowToast('智能体规范规则已删除');
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
        <div>
          <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
            {hasWorkspace ? '当前项目规则' : '全局规则'}
          </h4>
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
            {hasWorkspace
              ? `作用于：${localStorage.getItem('crish_workspace')}`
              : '尚未打开项目时，这里编辑的是全局规则'}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            onClick={() => setEditingRuleFileType(hasWorkspace ? 'project' : 'global')}
            className="ui-btn ui-btn-secondary ui-btn-sm"
          >
            编辑规则文件
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span className="settings-field-label">已添加的规则规范列表</span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {customRules.map((rule, idx) => (
            <div key={idx} className="settings-card-row" style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '11.5px', color: 'var(--text-primary)', lineHeight: '1.4' }}>{rule}</span>
              </div>
              <button
                type="button"
                onClick={() => handleDeleteCustomRule(idx)}
                className="ui-btn ui-btn-ghost danger"
                style={{ marginLeft: 12, flexShrink: 0 }}
                title="删除规则"
              >
                <Lucide.Trash2 size={14} />
              </button>
            </div>
          ))}
          {customRules.length === 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textAlign: 'center', padding: '24px', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
              暂无细化规范，请在下方输入框添加日常开发的零碎规范。
            </div>
          )}
        </div>
      </div>

      <div className="settings-card-row" style={{ gap: 10 }}>
        <span className="settings-field-label">添加新规范</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            placeholder="输入规则内容，例如: 提交代码前确保完成 lint 测试"
            value={newRuleText}
            onChange={(e) => setNewRuleText(e.target.value)}
            className="settings-field-input"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={handleAddCustomRule}
            className="ui-btn ui-btn-secondary ui-btn-sm"
          >
            添加
          </button>
        </div>
      </div>

      {editingRuleFileType && (
        <div
          className="custom-modal-backdrop"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(4px)',
            zIndex: 20000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: '580px',
              background: 'var(--bg-elevated, var(--bg-primary))',
              borderRadius: '12px',
              boxShadow: 'var(--shadow-2xl)',
              border: '1px solid var(--border-color)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
              <span className="settings-modal-title">
                {editingRuleFileType === 'global' ? '编辑全局规则' : '编辑当前项目规则'}
              </span>
              <button
                onClick={() => setEditingRuleFileType(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}
              >
                <Lucide.X size={16} />
              </button>
            </div>

            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', margin: 0 }}>
                {editingRuleFileType === 'global'
                  ? '修改全局规则文本。保存后写入本机设置（正式版暂不自动写仓库 AGENTS.md）。'
                  : '修改当前工作区相关规则。保存后写入本机设置，后续可对接项目文件。'}
              </p>

              <textarea
                className="settings-field-input"
                value={editingRuleFileType === 'global' ? globalRules : projectRules}
                onChange={(e) => {
                  if (editingRuleFileType === 'global') {
                    setGlobalRules(e.target.value);
                  } else {
                    setProjectRules(e.target.value);
                  }
                }}
                rows={12}
                style={{
                  width: '100%',
                  minHeight: 220,
                  height: 'auto',
                  padding: '10px 12px',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  resize: 'vertical',
                  lineHeight: 1.5,
                }}
              />

              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={() => setEditingRuleFileType(null)}
                  className="settings-btn-secondary"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleSaveRules(editingRuleFileType);
                    setEditingRuleFileType(null);
                  }}
                  className="settings-btn-primary"
                >
                  保存规则文件
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
