/**
 * 对话底栏模型选择：只负责切换；配置/扫描/测试在设置页。
 */
import React, { useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import './ModelPicker.css';
import {
  getActiveModelId,
  getActiveProfileId,
  setActiveProfileId as setStoredProfileId,
} from '../api/providerProfiles';
import {
  getModelMeta,
  listPickerProfiles,
} from '../api/modelCatalog';

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

export const ModelPicker: React.FC<Props> = ({
  open,
  onClose,
  engineModel,
  busy,
  error,
  onSelect,
  onOpenSettings,
}) => {
  const [tick, setTick] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const activeProfileId = getActiveProfileId();
  const activeModel = engineModel || getActiveModelId() || '';

  const profiles = useMemo(() => {
    void tick;
    return listPickerProfiles();
  }, [tick]);

  const configured = useMemo(
    () => profiles.filter((p) => p.hasKey || Boolean(p.apiKey?.trim())),
    [profiles],
  );

  useEffect(() => {
    if (!open) return;
    const id = getActiveProfileId();
    if (id) setExpanded((e) => ({ ...e, [id]: true }));
    setTick((n) => n + 1);
  }, [open]);

  if (!open) return null;

  return (
    <div className="mpick mpick--slim" role="listbox" aria-label="选择模型" onClick={(e) => e.stopPropagation()}>
      {error ? (
        <button
          type="button"
          className="mpick-error mpick-error--action"
          onClick={() => {
            onClose();
            onOpenSettings();
          }}
          title="打开模型设置"
        >
          <span className="mpick-error-text">{error}</span>
          <span className="mpick-error-link">打开设置</span>
        </button>
      ) : null}

      <div className="mpick-scroll">
        {configured.length === 0 ? (
          <div className="mpick-empty">
            尚未配置可用服务商
            <button type="button" className="mpick-link-btn" onClick={onOpenSettings}>
              去设置
            </button>
          </div>
        ) : (
          configured.map((p) => {
            const isOpen = Boolean(expanded[p.id]);
            const providerDisabled = p.enabled === false;
            const models = (p.models || []).filter((m) => {
              const meta = getModelMeta(p.id, m);
              return meta.enabled !== false;
            });
            const activeHere = activeProfileId === p.id;

            return (
              <div
                key={p.id}
                className={`mpick-provider ${activeHere ? 'is-active' : ''} ${providerDisabled ? 'is-disabled' : ''}`}
              >
                <button
                  type="button"
                  className="mpick-provider-main"
                  onClick={() => setExpanded((e) => ({ ...e, [p.id]: !e[p.id] }))}
                  disabled={busy || providerDisabled}
                >
                  <Lucide.ChevronRight
                    size={14}
                    className={`mpick-chev ${isOpen ? 'open' : ''}`}
                  />
                  <Lucide.Server size={14} className="mpick-provider-ico" />
                  <span className="mpick-provider-text">
                    <span className="mpick-provider-name">{p.name}</span>
                    <span className="mpick-provider-meta">{models.length} 个模型</span>
                  </span>
                </button>

                {isOpen ? (
                  <div className="mpick-models">
                    {models.length === 0 ? (
                      <div className="mpick-empty-models">暂无可用模型</div>
                    ) : (
                      models.map((m) => {
                        const selected = activeHere && activeModel === m;
                        return (
                          <button
                            key={m}
                            type="button"
                            className={`mpick-model-main mpick-model-main--row ${selected ? 'is-selected' : ''}`}
                            disabled={busy || providerDisabled}
                            title={m}
                            onClick={() => {
                              setStoredProfileId(p.id);
                              onSelect(p.id, m);
                              onClose();
                            }}
                          >
                            <Lucide.Sparkles size={14} className="mpick-model-ico" />
                            <span className="mpick-model-name" title={m}>
                              {m}
                            </span>
                            {selected ? <Lucide.Check size={14} className="mpick-check" /> : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </div>
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
        >
          <Lucide.Settings size={14} />
          管理服务商与密钥
        </button>
      </div>
    </div>
  );
};
