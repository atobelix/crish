/**
 * 对话底栏模型选择：紧凑加号式菜单
 * - 扁平列表切换模型（不折供应商、不手填 id）
 * - 思考强度四档（写入 settings.defaultThinkingLevel）
 * - 配置跳转设置
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import './ModelPicker.css';
import {
  resolvePreferredModelSelection,
  setActiveProfileId as setStoredProfileId,
} from '../api/providerProfiles';
import {
  formatModelDisplayName,
  getModelMeta,
  listPickerProfiles,
} from '../api/modelCatalog';
import { onUiEvent } from '../api/uiEvents';
import {
  clientApi,
  type ThinkingLevel,
  THINKING_LEVEL_IDS,
} from '../api/clientApi';
import { useLayoutStore } from '../store/layoutStore';
import { getWorkspacePath } from '../api/projectStore';

type Props = {
  open: boolean;
  onClose: () => void;
  engineModel?: string | null;
  busy?: boolean;
  error?: string;
  onSelect: (profileId: string, model: string) => void;
  onOpenSettings: () => void;
  onToast?: (msg: string) => void;
};

type FlatModel = {
  key: string;
  profileId: string;
  profileName: string;
  model: string;
  label: string;
};

const THINKING_OPTS: { id: ThinkingLevel; label: string }[] = [
  { id: 'off', label: '关闭' },
  { id: 'minimal', label: '极低' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
];

function normalizeThinking(raw: unknown): ThinkingLevel {
  const s = String(raw || '').trim().toLowerCase();
  if ((THINKING_LEVEL_IDS as readonly string[]).includes(s)) return s as ThinkingLevel;
  return 'medium';
}

export const ModelPicker: React.FC<Props> = ({
  open,
  onClose,
  engineModel,
  busy,
  error,
  onSelect,
  onOpenSettings,
}) => {
  const uid = useId().replace(/:/g, '');
  const [tick, setTick] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const appSettings = useLayoutStore((s) => s.appSettings);
  const setAppSettings = useLayoutStore((s) => s.setAppSettings);
  const thinking = normalizeThinking(appSettings?.defaultThinkingLevel);

  const resolved = useMemo(() => {
    void tick;
    return resolvePreferredModelSelection({ engineModel });
  }, [tick, engineModel]);

  const activeProfileId = resolved?.profileId ?? null;
  const activeModel = resolved?.model || '';

  const flatModels = useMemo((): FlatModel[] => {
    void tick;
    const profiles = listPickerProfiles().filter((p) => p.enabled !== false);
    const out: FlatModel[] = [];
    for (const p of profiles) {
      const models = (p.models || []).filter((m) => {
        const meta = getModelMeta(p.id, m);
        return meta.enabled !== false;
      });
      for (const m of models) {
        out.push({
          key: `${p.id}::${m}`,
          profileId: p.id,
          profileName: p.name,
          model: m,
          label: formatModelDisplayName(p.id, m),
        });
      }
    }
    // 当前活动但不在列表：补一行
    if (activeProfileId && activeModel) {
      const hit = out.some(
        (x) => x.profileId === activeProfileId && x.model === activeModel,
      );
      if (!hit) {
        out.unshift({
          key: `${activeProfileId}::orphan::${activeModel}`,
          profileId: activeProfileId,
          profileName:
            listPickerProfiles().find((p) => p.id === activeProfileId)?.name ||
            activeProfileId,
          model: activeModel,
          label: formatModelDisplayName(activeProfileId, activeModel),
        });
      }
    }
    return out;
  }, [tick, activeProfileId, activeModel]);

  useEffect(() => {
    if (!open) return;
    setTick((n) => n + 1);
  }, [open, engineModel]);

  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const off1 = onUiEvent('model-changed', bump);
    const off2 = onUiEvent('profiles-changed', bump);
    return () => {
      off1();
      off2();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDoc);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open, onClose]);

  const setThinking = async (level: ThinkingLevel) => {
    try {
      const cwd = getWorkspacePath() || '__global__';
      const merged = await clientApi.saveSettingsEx(cwd, 'global', {
        defaultThinkingLevel: level,
      });
      setAppSettings(merged);
    } catch {
      // 本机先写，避免 UI 卡死
      const cur = useLayoutStore.getState().appSettings || {};
      setAppSettings({ ...cur, defaultThinkingLevel: level });
    }
  };

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      className="mpick mpick--slim mpick--menu"
      role="menu"
      aria-label="切换模型"
      aria-busy={busy ? true : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      {error ? (
        <button
          type="button"
          className="mpick-error mpick-error--action"
          onClick={() => {
            onClose();
            onOpenSettings();
          }}
        >
          <span className="mpick-error-text">{error}</span>
          <span className="mpick-error-link">设置</span>
        </button>
      ) : null}

      <div className="mpick-think" role="group" aria-label="思考强度">
        <span className="mpick-think-label">思考</span>
        <div className="mpick-think-chips">
          {THINKING_OPTS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="menuitemradio"
              aria-checked={thinking === opt.id}
              className={`mpick-think-chip${thinking === opt.id ? ' is-on' : ''}`}
              disabled={busy}
              onClick={() => void setThinking(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mpick-section-label" aria-hidden>
        模型
      </div>
      <div className="mpick-scroll" role="none">
        {flatModels.length === 0 ? (
          <div className="mpick-empty" role="status">
            <span className="mpick-empty-title">暂无可用模型</span>
            <span className="mpick-empty-hint">到设置添加服务商并配置模型列表</span>
            <button
              type="button"
              className="mpick-link-btn"
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
            >
              去设置
            </button>
          </div>
        ) : (
          flatModels.map((item) => {
            const selected =
              item.profileId === activeProfileId && item.model === activeModel;
            return (
              <button
                key={item.key}
                id={`${uid}-opt-${item.key}`}
                type="button"
                role="menuitem"
                className={`mpick-menu-item${selected ? ' is-selected' : ''}`}
                disabled={busy}
                aria-current={selected ? 'true' : undefined}
                title={`${item.profileName} · ${item.model}`}
                onClick={() => {
                  if (busy) return;
                  setStoredProfileId(item.profileId);
                  onSelect(item.profileId, item.model);
                  onClose();
                }}
              >
                <span className="mpick-menu-item-main">
                  <span className="mpick-menu-item-name">{item.label}</span>
                  <span className="mpick-menu-item-meta">{item.profileName}</span>
                </span>
                {selected ? (
                  <Lucide.Check size={14} className="mpick-check" aria-hidden />
                ) : null}
              </button>
            );
          })
        )}
      </div>

      <div className="mpick-footer">
        <button
          type="button"
          className="mpick-footer-btn"
          onClick={() => {
            onClose();
            onOpenSettings();
          }}
          title="配置模型与密钥"
        >
          <Lucide.Settings size={14} aria-hidden />
          去设置配置
        </button>
      </div>
    </div>
  );
};
