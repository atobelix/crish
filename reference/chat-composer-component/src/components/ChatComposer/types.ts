/* ==========================================================================
   ChatComposer Component Suite - TypeScript Type Definitions
   ========================================================================== */

export interface AttachedFile {
  id: string;
  name: string;
  size?: string;
  type: 'document' | 'image' | 'pdf' | 'table' | 'code';
  url?: string;
  fileObject?: File;
}

export interface SkillTag {
  id: string;
  name: string;
  description?: string;
}

export interface ChatComposerProps {
  files?: AttachedFile[];
  skills?: SkillTag[];
  placeholder?: string;
  permissionLabel?: string;
  modelName?: string;
  disabled?: boolean;
  onSend?: (message: string, files: AttachedFile[]) => void;
  onFileAdd?: (files: File[]) => void;
  onFileRemove?: (fileId: string) => void;
  onFilePreview?: (file: AttachedFile) => void;
}
