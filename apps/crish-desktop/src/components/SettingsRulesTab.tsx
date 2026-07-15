/**
 * 设置 · 规则：自定义规范列表 / 编辑全局或项目规则文件
 * Design system v2：settings-pane--modern + group/list/feature
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

/** 一键添加的常用工程规范（与手动添加走同一路径） */
const RULE_PRESETS: string[] = [
  '修改前先说明方案并等待确认',
  '保持既有代码风格，不随意重构无关代码',
  '提交前确保通过 lint / 测试',
  '不要提交密钥、token 或本地环境文件',
  '优先最小改动，避免大范围无关修改',
];

export const SettingsRulesTab: React.FC<Props> = ({
  onShowToast,
  onBlockingOverlayChange,
}) => {
  const cwd = getWorkspacePath() || '__global__';
  const workspacePath =
    typeof localStorage !== 'undefined' ? localStorage.getItem('crish_workspace') : null;
  const hasWorkspace = Boolean(workspacePath);

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

  const addRuleIfNew = (text: string, successMsg = '智能体规范规则已添加') => {
    const trimmed = text.trim();
    if (!trimmed) {
      onShowToast('请输入规则内容');
      return false;
    }
    if (customRules.includes(trimmed)) {
      onShowToast('该规则已存在');
      return false;
    }
    void persistCustomRules([...customRules, trimmed]);
    onShowToast(successMsg);
    return true;
  };

  const handleAddCustomRule = () => {
    if (addRuleIfNew(newRuleText)) {
      setNewRuleText('');
    }
  };

  const handleAddPreset = (preset: string) => {
    addRuleIfNew(preset, '已添加预设规范');
  };

  const handleDeleteCustomRule = (index: number) => {
    const updated = customRules.filter((_, i) => i !== index);
    void persistCustomRules(updated);
    onShowToast('智能体规范规则已删除');
  };

  return (
    <div className="settings-pane settings-pane--modern">
      <header className="settings-page-head">
        <h2 className="settings-page-title">规则</h2>
        <p className="settings-page-desc">
          约束智能体的行为边界：编码风格、确认节奏、禁止操作等。短规则适合日常约定；长文规则可在下方编辑全文。
        </p>
      </header>

      {/* 作用域：工作区 + 打开全文编辑 */}
      <section className="settings-group" aria-label="作用域">
        <div className="settings-group-label">作用域</div>
        <div className="settings-list settings-list--spaced">
          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-title">
                {hasWorkspace ? '当前工作区' : '全局（未打开项目）'}
              </div>
              <div
                className={
                  hasWorkspace
                    ? 'settings-list-sub settings-list-sub--mono'
                    : 'settings-list-sub'
                }
                title={workspacePath || undefined}
              >
                {hasWorkspace
                  ? workspacePath
                  : '尚未打开项目时，短规则与全局规则文件作用于所有对话。'}
              </div>
            </div>
            <div className="settings-list-stack-controls">
              <div className="settings-list-stack-actions">
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => setEditingRuleFileType('global')}
                >
                  编辑全局规则
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => {
                    if (!hasWorkspace) {
                      onShowToast('请先打开项目后再编辑项目规则');
                      return;
                    }
                    setEditingRuleFileType('project');
                  }}
                  disabled={!hasWorkspace}
                  title={
                    hasWorkspace
                      ? '编辑当前工作区的项目规则'
                      : '打开项目后可编辑项目规则'
                  }
                >
                  编辑项目规则
                </button>
              </div>
              {!hasWorkspace ? (
                <div className="settings-list-sub">
                  项目规则需在工作区内生效；可在空对话页选择或打开项目。
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* 自定义短规则列表 */}
      <section className="settings-group" aria-label="短规则">
        <div className="settings-group-label">短规则</div>
        {customRules.length === 0 ? (
          <p className="settings-list-sub" style={{ margin: 0 }}>
            暂无细化规范。可从下方预设一键添加，或自行输入日常开发约定。
          </p>
        ) : (
          <div className="settings-list">
            {customRules.map((rule, idx) => (
              <div key={`${idx}-${rule.slice(0, 24)}`} className="settings-list-row">
                <div className="settings-list-copy">
                  <div className="settings-list-title" style={{ fontWeight: 400 }}>
                    {rule}
                  </div>
                </div>
                <div className="settings-list-control">
                  <button
                    type="button"
                    onClick={() => handleDeleteCustomRule(idx)}
                    className="ui-btn ui-btn-ghost ui-btn-sm danger"
                    title="删除规则"
                    aria-label={`删除规则：${rule}`}
                  >
                    <Lucide.Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 快速预设 */}
      <section className="settings-group" aria-label="快速添加">
        <div className="settings-group-label">快速添加</div>
        <div className="settings-list settings-list--spaced">
          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-sub" style={{ marginTop: 0 }}>
                常用工程约定，点击即可加入短规则（已存在的不会重复添加）。
              </div>
            </div>
            <div className="settings-list-stack-controls">
              <div className="settings-list-stack-actions">
                {RULE_PRESETS.map((preset) => {
                  const exists = customRules.includes(preset);
                  return (
                    <button
                      key={preset}
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      onClick={() => handleAddPreset(preset)}
                      disabled={exists}
                      title={exists ? '已添加' : `添加：${preset}`}
                      style={{
                        maxWidth: '100%',
                        whiteSpace: 'normal',
                        height: 'auto',
                        minHeight: 28,
                        padding: '6px 10px',
                        textAlign: 'left',
                        lineHeight: 1.35,
                        opacity: exists ? 0.45 : 1,
                      }}
                    >
                      {preset}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 手动添加 */}
      <section className="settings-group" aria-label="添加规范">
        <div className="settings-group-label">添加规范</div>
        <div className="settings-list settings-list--spaced">
          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-title">自定义短规则</div>
              <div className="settings-list-sub">
                一句话约束即可，例如：提交代码前确保完成 lint 测试
              </div>
            </div>
            <div className="settings-list-stack-controls">
              <div className="settings-list-stack-actions">
                <input
                  type="text"
                  placeholder="输入规则内容…"
                  value={newRuleText}
                  onChange={(e) => setNewRuleText(e.target.value)}
                  className="settings-field-input"
                  style={{ flex: 1, minWidth: 160 }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddCustomRule();
                  }}
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
          </div>
        </div>
      </section>

      {/* 同步 / AGENTS.md 提示 */}
      <section className="settings-group" aria-label="说明">
        <div className="settings-group-label">说明</div>
        <div className="settings-feature">
          <div className="settings-feature-title">规则如何生效</div>
          <div className="settings-feature-body">
            保存全局 / 项目规则全文后，会写入本机设置，并在引擎已连接时同步为 scoped
            context，供智能体在对话中遵循。引擎未连接时仅本机生效。正式版暂不自动写入仓库
            AGENTS.md；若项目已有 AGENTS.md / Claude.md，引擎侧仍可按仓库约定读取。
          </div>
        </div>
      </section>

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
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-rules-modal-title"
            style={{
              width: 'min(580px, calc(100vw - 32px))',
              background: 'var(--bg-elevated, var(--bg-primary))',
              borderRadius: 12,
              boxShadow: 'var(--shadow-2xl)',
              border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 16,
                padding: '18px 20px 14px',
                borderBottom: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  id="settings-rules-modal-title"
                  style={{
                    margin: 0,
                    fontSize: 16,
                    fontWeight: 600,
                    letterSpacing: '-0.02em',
                    color: 'var(--text-primary)',
                    lineHeight: 1.3,
                  }}
                >
                  {editingRuleFileType === 'global' ? '编辑全局规则' : '编辑项目规则'}
                </div>
                <p
                  style={{
                    margin: '6px 0 0',
                    fontSize: 12.5,
                    color: 'var(--text-tertiary)',
                    lineHeight: 1.45,
                  }}
                >
                  {editingRuleFileType === 'global'
                    ? '适用于所有对话。保存后写入本机，并在引擎连接时同步（暂不自动写 AGENTS.md）。'
                    : '适用于当前工作区。保存后写入本机设置，后续可对接项目文件。'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingRuleFileType(null)}
                className="ui-btn ui-btn-ghost ui-btn-sm"
                aria-label="关闭"
                style={{ flexShrink: 0 }}
              >
                <Lucide.X size={16} />
              </button>
            </div>

            <div
              style={{
                padding: '16px 20px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
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
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  resize: 'vertical',
                  lineHeight: 1.5,
                }}
              />

              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'flex-end',
                }}
              >
                <button
                  type="button"
                  onClick={() => setEditingRuleFileType(null)}
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleSaveRules(editingRuleFileType);
                    setEditingRuleFileType(null);
                  }}
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                >
                  保存规则
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
