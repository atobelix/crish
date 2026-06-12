/**
 * FileEditSummary - 文件变更总览组件
 */

import { useState } from 'preact/hooks';
import type { ChangedFile } from '../../core/app-state';
import {
  IconChevronRight, IconFileCode, IconFilePlus, IconFileMinus,
} from '../icons';
import { truncatePath } from '../utils';

function FileEditRow({ file, onClick }: { file: ChangedFile; onClick: () => void }) {
  const fileName = file.path.split(/[\\/]/).pop() || file.path;
  const dirPath = file.path.split(/[\\/]/).slice(0, -1).join('/');
  return (
    <div class="repl-file-edit-row" onClick={onClick}>
      <div class="repl-file-edit-row-left">
        <span class="repl-file-edit-row-icon">
          {file.status === 'created' ? <IconFilePlus /> : file.status === 'deleted' ? <IconFileMinus /> : <IconFileCode />}
        </span>
        <span class="repl-file-edit-row-path">{fileName}</span>
        {dirPath && <span class="repl-file-edit-dir">{truncatePath(dirPath, 30)}</span>}
      </div>
      <div class="repl-file-edit-row-changes">
        {file.addedLines > 0 && <span class="repl-file-edit-add">+{file.addedLines}</span>}
        {file.removedLines > 0 && <span class="repl-file-edit-del">-{file.removedLines}</span>}
      </div>
    </div>
  );
}

export function FileEditSummary({ changedFiles, onFileClick }: { changedFiles: ChangedFile[]; onFileClick: (path: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  if (changedFiles.length === 0) return null;

  const created = changedFiles.filter(f => f.status === 'created');
  const modified = changedFiles.filter(f => f.status === 'modified');
  const deleted = changedFiles.filter(f => f.status === 'deleted');
  const totalAdded = changedFiles.reduce((sum, f) => sum + f.addedLines, 0);
  const totalRemoved = changedFiles.reduce((sum, f) => sum + f.removedLines, 0);

  return (
    <div class="repl-file-edit-summary">
      <div class="repl-file-edit-summary-header" onClick={() => setExpanded(!expanded)}>
        <div class="repl-file-edit-summary-title">
          <IconFileCode />
          <span>文件变更</span>
          <span class="repl-file-edit-summary-count">{changedFiles.length}</span>
          <span class="repl-file-edit-summary-stats">
            {totalAdded > 0 && <span class="repl-file-edit-add">+{totalAdded}</span>}
            {totalRemoved > 0 && <span class="repl-file-edit-del">-{totalRemoved}</span>}
          </span>
        </div>
        <span class={`repl-chat-tool-arrow${expanded ? ' expanded' : ''}`}><IconChevronRight /></span>
      </div>
      {expanded && (
        <div class="repl-file-edit-summary-body">
          {created.length > 0 && (
            <div class="repl-file-edit-summary-group">
              <div class="repl-file-edit-summary-group-label"><IconFilePlus /> 新建 ({created.length})</div>
              {created.map(f => <FileEditRow key={f.path} file={f} onClick={() => onFileClick(f.path)} />)}
            </div>
          )}
          {modified.length > 0 && (
            <div class="repl-file-edit-summary-group">
              <div class="repl-file-edit-summary-group-label"><IconFileCode /> 修改 ({modified.length})</div>
              {modified.map(f => <FileEditRow key={f.path} file={f} onClick={() => onFileClick(f.path)} />)}
            </div>
          )}
          {deleted.length > 0 && (
            <div class="repl-file-edit-summary-group">
              <div class="repl-file-edit-summary-group-label"><IconFileMinus /> 删除 ({deleted.length})</div>
              {deleted.map(f => <FileEditRow key={f.path} file={f} onClick={() => onFileClick(f.path)} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}