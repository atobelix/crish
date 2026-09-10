import { useState, useEffect } from 'react';
import { readTextFile } from '../../../api/workspaceFsApi';

export interface PlainCodeState {
  plainCode: string;
  plainLoading: boolean;
  plainTruncated: boolean;
  plainLineCount: number;
}

/**
 * 纯文本/源码加载：只经 workspaceFsApi.readTextFile（含路径沙箱）。
 * 禁止越界后回落 localFileReader / shell 读盘。
 */
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
        const res = await readTextFile(filePath, 20000);
        if (active) {
          setPlainCode(res.content || '');
          setPlainTruncated(Boolean(res.truncated));
          setPlainLineCount(res.lineCount || 0);
        }
      } catch (err) {
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
