import { useState, useEffect } from 'react';
import {
  readTextFile,
  isAbsoluteFsPath,
  resolveWorkspacePath,
} from '../../../api/workspaceFsApi';
import { readLocalTextBestEffort } from '../../../api/localFileReader';

export interface PlainCodeState {
  plainCode: string;
  plainLoading: boolean;
  plainTruncated: boolean;
  plainLineCount: number;
}

export function usePlainCodeLoader(filePath: string): PlainCodeState {
  const [plainCode, setPlainCode] = useState<string>('');
  const [plainLoading, setPlainLoading] = useState<boolean>(false);
  const [plainTruncated, setPlainTruncated] = useState(false);
  const [plainLineCount, setPlainLineCount] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      setPlainLoading(true);
      setPlainTruncated(false);
      setPlainLineCount(0);
      try {
        const isAbsolute = isAbsoluteFsPath(filePath);
        const inWorkspace = Boolean(resolveWorkspacePath(filePath));

        if (isAbsolute && !inWorkspace) {
          const localText = await readLocalTextBestEffort(filePath);
          if (active && typeof localText === 'string') {
            setPlainCode(localText);
            setPlainTruncated(localText.length >= 512000);
            setPlainLineCount(localText.split('\n').length);
            return;
          }
        }

        const res = await readTextFile(filePath, 20000);
        if (active) {
          setPlainCode(res.content || '');
          setPlainTruncated(Boolean(res.truncated));
          setPlainLineCount(res.lineCount || 0);
        }
      } catch (err) {
        try {
          const localText = await readLocalTextBestEffort(filePath);
          if (active && typeof localText === 'string') {
            setPlainCode(localText);
            setPlainTruncated(localText.length >= 512000);
            setPlainLineCount(localText.split('\n').length);
            return;
          }
        } catch {
          /* swallow */
        }
        if (active) {
          setPlainCode(`读取源码失败：${String(err)}`);
        }
      } finally {
        if (active) {
          setPlainLoading(false);
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [filePath]);

  return { plainCode, plainLoading, plainTruncated, plainLineCount };
}
