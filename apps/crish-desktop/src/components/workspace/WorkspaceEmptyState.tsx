import * as Lucide from 'lucide-react';
import './WorkspaceEmptyState.css';

export function WorkspaceEmptyState({
  wsId,
  onActivate,
}: {
  wsId: string;
  onActivate?: () => void;
}) {
  return (
    <div
      className="workspace-empty-state"
      role="status"
      aria-live="polite"
      data-ws-id={wsId}
      data-empty="true"
      onPointerDown={onActivate}
    >
      <div className="empty-state-icon-wrapper">
        <Lucide.LayoutPanelLeft
          size={32}
          strokeWidth={1.5}
          aria-hidden
        />
      </div>
      <div className="empty-state-title">
        工作区暂无面板
      </div>
      <div className="empty-state-desc">
        从侧栏打开对话，或用标签栏「+」添加文件、终端、预览等面板。
      </div>
    </div>
  );
}
