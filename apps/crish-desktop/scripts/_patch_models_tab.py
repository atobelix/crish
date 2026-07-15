from pathlib import Path

p = Path(__file__).resolve().parents[1] / "src" / "components" / "SettingsPanel.tsx"
t = p.read_text(encoding="utf-8")
start = t.find("          {/* TAB 2: MODELS */}")
end = t.find("              {/* Add Custom Provider Modal Overlay */}")
if start < 0 or end < 0:
    raise SystemExit(f"markers not found {start} {end}")

new = r'''          {/* TAB 2: MODELS — multi profile */}
          {activeTab === 'models' && (
            <>
              <div style={{ marginBottom: 12 }}>
                <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>AI 模型</h4>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
                  多服务商配置；点击模型即可启用并写入引擎。当前：
                  {' '}{engineStatus?.model || '未读取'}
                  {engineStatus?.hasApiKey === false ? ' · 引擎未配置密钥' : ''}
                </p>
                {profileInlineError && (
                  <div className="model-picker-error" style={{ marginTop: 8 }}>{profileInlineError}</div>
                )}
              </div>

              <div className="settings-fields-stack" style={{ gap: 12 }}>
                {profiles.map((p) => (
                  <div key={p.id} className="settings-card-row" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                        <span className={`status-badge ${p.hasKey || p.apiKey ? 'available' : 'unconfigured'}`}>
                          <span className="status-dot" style={{ width: 5, height: 5, borderRadius: '50%' }} />
                          {p.hasKey || p.apiKey ? '已配置' : '未配置'}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label className="settings-field-label">接口地址</label>
                      <input
                        className="settings-field-input"
                        value={p.baseUrl}
                        onChange={(e) => {
                          const next = profiles.map((x) =>
                            x.id === p.id ? { ...x, baseUrl: e.target.value } : x,
                          );
                          setProfiles(next);
                          upsertProfile({ ...p, baseUrl: e.target.value });
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label className="settings-field-label">API 密钥</label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="password"
                          className="settings-field-input"
                          style={{ flex: 1 }}
                          placeholder={p.hasKey || p.apiKey ? '已保存 · 输入以覆盖' : '粘贴密钥'}
                          value={draftKeys[p.id] ?? ''}
                          onChange={(e) => setDraftKeys((d) => ({ ...d, [p.id]: e.target.value }))}
                        />
                        <button
                          type="button"
                          className="ui-btn ui-btn-sm ui-btn-secondary"
                          onClick={() => {
                            const v = (draftKeys[p.id] || '').trim();
                            if (!v) {
                              setProfileInlineError('请输入密钥后再保存');
                              return;
                            }
                            setProfiles(setProfileKey(p.id, v));
                            setDraftKeys((d) => ({ ...d, [p.id]: '' }));
                            setProfileInlineError('');
                          }}
                        >
                          保存密钥
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="settings-field-label">模型</label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                        {p.models.map((m) => (
                          <button
                            key={m}
                            type="button"
                            className={`model-chip ${engineStatus?.model === m ? 'on' : ''}`}
                            onClick={async () => {
                              setProfileInlineError('');
                              const res = await activateProfileModel(p.id, m);
                              if (!res.ok) {
                                setProfileInlineError(
                                  res.error === 'not_connected'
                                    ? networkUserMessage()
                                    : '启用失败，请检查密钥与地址',
                                );
                                return;
                              }
                              setEngineStatus(await fetchEngineStatus());
                            }}
                          >
                            {m}
                            <span
                              role="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setProfiles(removeModelFromProfile(p.id, m));
                              }}
                              style={{ marginLeft: 4, opacity: 0.5 }}
                            >
                              ×
                            </span>
                          </button>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <input
                          className="settings-field-input"
                          style={{ flex: 1 }}
                          placeholder="添加模型 ID"
                          value={draftModelName[p.id] || ''}
                          onChange={(e) =>
                            setDraftModelName((d) => ({ ...d, [p.id]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const name = (draftModelName[p.id] || '').trim();
                              if (name) {
                                setProfiles(addModelToProfile(p.id, name));
                                setDraftModelName((d) => ({ ...d, [p.id]: '' }));
                              }
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="ui-btn ui-btn-secondary ui-btn-sm"
                          onClick={() => {
                            const name = (draftModelName[p.id] || '').trim();
                            if (name) {
                              setProfiles(addModelToProfile(p.id, name));
                              setDraftModelName((d) => ({ ...d, [p.id]: '' }));
                            }
                          }}
                        >
                          添加
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

'''

t = t[:start] + new + t[end:]
p.write_text(t, encoding="utf-8")
print("ok", start, end)
