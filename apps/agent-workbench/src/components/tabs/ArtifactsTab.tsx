import { useState, useEffect } from 'preact/hooks';
import type { JSX } from 'preact';
import { tauriBridge, type ArtifactRecord } from '../../core/tauri-bridge';
import { isBackendNotWiredResult } from '../../core/tauri-command-registry';
import { warnBridgeDiagnostic, isCommandUsable } from './shared';
import { formatFileSize } from '../utils';
import { IconRefresh, IconSpinner, IconPackage, IconArtifact, IconX } from '../icons';

export default function ArtifactsTab() {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);


  useEffect(() => {
    loadArtifacts();
  }, []);

  async function loadArtifacts() {
    setLoading(true);
    try {
      const result = await tauriBridge.listArtifacts();
      if (isBackendNotWiredResult(result)) {
        setArtifacts([]);
        return;
      }
      setArtifacts(Array.isArray(result) ? result : []);
    } catch (error) {
      warnBridgeDiagnostic(error);
      setArtifacts([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleViewArtifact(uri: string) {
    setLoadingContent(true);
    setArtifactContent(null);
    try {
      const content = await tauriBridge.getArtifactContent(uri);
      if (typeof content === 'string') {
        setArtifactContent(content);
        setSelectedArtifact(uri);
      }
    } catch (error) {
      warnBridgeDiagnostic(error);
    } finally {
      setLoadingContent(false);
    }
  }

  return (
    <div class="repl-rs-tab-content-inner">
      <div class="repl-rs-section">
        <div class="repl-rs-section-header">
          <span class="repl-rs-section-title">产物</span>
          <button class="repl-rs-btn-sm" onClick={loadArtifacts} disabled={loading}>
            <IconRefresh /> 刷新
          </button>
        </div>
        {loading ? (
          <div class="repl-rs-loading"><IconSpinner /> 加载中...</div>
        ) : (() => {
          if (artifacts.length === 0) {
            return (
              <div class="repl-rs-empty-center">
                <span class="repl-rs-item-icon"><IconPackage /></span>
                <span class="repl-rs-item-meta">
                  {isCommandUsable('workbench_list_artifacts') ? '暂无产物' : '产物功能未接入（后端 artifact adapter 未配置）'}
                </span>
              </div>
            );
          }
          return (
            <div class="repl-rs-artifact-list">
              {artifacts.map(a => (
                <div
                  key={a.id}
                  class={`repl-rs-artifact-item ${selectedArtifact === a.uri ? 'active' : ''}`}
                  onClick={() => void handleViewArtifact(a.uri)}
                >
                  <IconArtifact />
                  <span class="repl-rs-artifact-name">{a.name}</span>
                  <span class="repl-rs-artifact-type">{a.type}</span>
                  {a.size > 0 && <span class="repl-rs-artifact-size">{formatFileSize(a.size)}</span>}
                </div>
              ))}
            </div>
          );
        })()}

        {selectedArtifact && (
          <div class="repl-rs-artifact-preview">
            <div class="repl-rs-artifact-preview-header">
              <span class="repl-rs-artifact-preview-name">{selectedArtifact.split('/').pop()}</span>
              <button class="repl-rs-btn-icon" onClick={() => { setSelectedArtifact(null); setArtifactContent(null); }}>
                <IconX />
              </button>
            </div>
            {loadingContent ? (
              <div class="repl-rs-loading"><IconSpinner /> 加载中...</div>
            ) : artifactContent ? (
              <pre class="repl-rs-artifact-content">{artifactContent}</pre>
            ) : (
              <div class="repl-rs-empty-inline">无法加载内容</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}