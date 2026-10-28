import { AppIcon } from '@/components/ui/icons';
import type { SelectOptionItem } from '@/components/ui';
import { openWithHostOpener, type HostOpener } from '../../api/hostOpenersApi';
import { logInternalError } from '../../api/userFacingErrors';

interface FileViewerMenuOptionsInput {
  absolutePath: string;
  fileOpeners: HostOpener[];
  openDefaultLabel: string;
  onCopyAbsolutePath: () => void;
  onCopyRelativePath: () => void;
  onLocateInFiles: () => void;
  onOpenDefault: () => void;
  onOpenSystemExplorer: () => void;
}

export function createFileViewerMenuOptions({
  absolutePath,
  fileOpeners,
  openDefaultLabel,
  onCopyAbsolutePath,
  onCopyRelativePath,
  onLocateInFiles,
  onOpenDefault,
  onOpenSystemExplorer,
}: FileViewerMenuOptionsInput): SelectOptionItem[] {
  const options: SelectOptionItem[] = [
    {
      id: 'open-file-path',
      label: '打开文件路径',
      icon: <AppIcon name="folder-open" size={14} aria-hidden />,
      onClick: onOpenSystemExplorer,
    },
    {
      id: 'copy-rel-path',
      label: '复制相对路径',
      icon: <AppIcon name="copy" size={14} aria-hidden />,
      onClick: onCopyRelativePath,
    },
    {
      id: 'copy-abs-path',
      label: '复制绝对路径',
      icon: <AppIcon name="file-code" size={14} aria-hidden />,
      onClick: onCopyAbsolutePath,
    },
    {
      id: 'open-with-default',
      label: '选择打开方式',
      hint: openDefaultLabel,
      icon: <AppIcon name="external-link" size={14} aria-hidden />,
      onClick: onOpenDefault,
    },
  ];

  for (const opener of fileOpeners) {
    options.push({
      id: `open-with-${opener.id}`,
      label: `用 ${opener.displayName} 打开`,
      icon: opener.iconDataUrl ? (
        <img
          src={opener.iconDataUrl}
          width={14}
          height={14}
          alt=""
          style={{ flexShrink: 0, objectFit: 'contain' }}
        />
      ) : (
        <AppIcon
          name="app-window"
          size={14}
          style={{ flexShrink: 0, color: 'var(--text-secondary)' }}
        />
      ),
      onClick: () => {
        void openWithHostOpener(opener.id, absolutePath).catch((error) =>
          logInternalError('components/files/FileViewerCard/openWith', error)
        );
      },
    });
  }

  options.push({
    id: 'locate-tree',
    label: '在应用文件树中定位',
    icon: <AppIcon name="locate" size={14} aria-hidden />,
    onClick: onLocateInFiles,
  });

  return options;
}
