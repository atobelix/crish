import React from 'react';
import { mcpStateLabel } from '../../../api/mcpApi';
import { Tooltip } from '../../Tooltip';
import type { InstalledExtension, CatalogEntry, ExtensionKind } from '../../../api/extensionCatalog';

type ExpandMode = 'detail' | 'config';

interface ExtensionExpandBodyProps {
  kind: ExtensionKind;
  item: InstalledExtension | CatalogEntry;
  mode: ExpandMode;
  onManage: (kind: 'skill' | 'mcp') => void;
  onToggleMcpServer?: (serverId: string, start: boolean) => void;
}

function renderSkillBody(item: InstalledExtension | CatalogEntry, mode: ExpandMode, onManage: (kind: 'skill' | 'mcp') => void) {
  const isInstalled = 'skillPath' in item || 'skillRaw' in item;
  const installedItem = isInstalled ? (item as InstalledExtension) : null;
  const entry = !isInstalled ? (item as CatalogEntry) : null;
  if (mode === 'detail') {
    return (
      <div className="ext-inline-panel">
        {installedItem?.skillPath ? <Tooltip content={installedItem.skillPath}><div className="ext-detail-meta">{installedItem.skillPath}</div></Tooltip> : null}
        <pre className="ext-detail-md" tabIndex={0}>
          {(installedItem && (installedItem.skillRaw || installedItem.skillContent || '# 暂无 SKILL.md 内容')) || (entry ? `# ${entry.name}\n\n${entry.description}\n\n安装后可在本机技能目录中查看完整 SKILL.md。` : '# 暂无内容')}
        </pre>
      </div>
    );
  }
  return (
    <div className="ext-inline-panel">
      <p className="ext-detail-desc">{installedItem?.fromSystem ? '可在高级管理中编辑路径、同步与更多选项。' : '安装后的技能可在本机技能目录维护；高级入口提供完整管理。'}</p>
      <div className="ext-detail-actions"><button type="button" className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect" onClick={() => onManage('skill')}>高级管理</button></div>
    </div>
  );
}

function renderMcpBody(item: InstalledExtension | CatalogEntry, mode: ExpandMode, onManage: (kind: 'skill' | 'mcp') => void, onToggleMcpServer?: (serverId: string, start: boolean) => void) {
  const installedItem = 'mcpId' in item || 'mcpTools' in item ? (item as InstalledExtension) : null;
  const entry = !installedItem ? (item as CatalogEntry) : null;
  if (mode === 'detail') {
    return (
      <div className="ext-inline-panel">
        {installedItem ? (<div className="ext-detail-meta">{[installedItem.mcpState ? `状态 ${mcpStateLabel(installedItem.mcpState)}` : null, installedItem.mcpTransport ? `传输 ${installedItem.mcpTransport}` : null, installedItem.mcpTools?.length ? `${installedItem.mcpTools.length} 个工具` : null].filter(Boolean).join(' · ') || '本机 MCP 服务'}</div>
        ) : <p className="ext-detail-desc">{entry?.description}{entry?.installRef ? `\n引用：${entry.installRef}` : ''}</p>}
        {installedItem?.mcpTools && installedItem.mcpTools.length > 0 ? (<ul className="ext-inline-tool-preview">{installedItem.mcpTools.map((t) => <li key={t}>{t}</li>)}</ul>) : null}
      </div>
    );
  }
  return (
    <div className="ext-inline-panel">
      {installedItem?.mcpId ? (
        <div className="ext-detail-actions">
          <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect" onClick={() => onToggleMcpServer?.(installedItem.mcpId!, true)}>启动服务</button>
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect" onClick={() => onToggleMcpServer?.(installedItem.mcpId!, false)}>停止服务</button>
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect" onClick={() => onManage('mcp')}>高级管理</button>
        </div>
      ) : <p className="ext-detail-desc">安装并连接后可在此启停服务与开关工具。</p>}
    </div>
  );
}

function renderPluginBody(item: InstalledExtension | CatalogEntry, mode: ExpandMode) {
  const desc = item.description;
  const ref = 'installRef' in item && item.installRef ? item.installRef : undefined;
  return (
    <div className="ext-inline-panel">
      <div className="ext-detail-md">{desc}{mode === 'config' ? '\n\n此插件已安装，可在任务与对话流程中使用。' : '\n\n安装后会写入本机扩展包列表，供工作台加载。'}{ref ? `\n\n引用：${ref}` : ''}</div>
    </div>
  );
}

export const ExtensionExpandBody: React.FC<ExtensionExpandBodyProps> = React.memo(({ kind, item, mode, onManage, onToggleMcpServer }) => {
  if (kind === 'skill') return <>{renderSkillBody(item, mode, onManage)}</>;
  if (kind === 'mcp') return <>{renderMcpBody(item, mode, onManage, onToggleMcpServer)}</>;
  return <>{renderPluginBody(item, mode)}</>;
});
