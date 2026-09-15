/** 配置文档事务只处理读、校验和保存；不承载编辑器的滚动与搜索状态。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readModelsYamlIpc,
  saveModelsYamlTextIpc,
  validateModelsYamlIpc,
} from '../../api/modelsCatalogIpc';
import {
  ensureModelsCatalogLoaded,
  getModelsCatalogPath,
} from '../../api/modelsCatalogStore';

export interface YamlSyntaxError {
  line: number;
  column?: number;
  message: string;
}

/** 从 Rust InvalidInput 消息中提取「第 L 行 第 C 列」结构化位置（单一错误文本协议） */
export function parseLineColumnFromMessage(message: string): {
  line?: number;
  column?: number;
} {
  const m = /第\s*(\d+)\s*行(?:\s*第\s*(\d+)\s*列)?/.exec(message);
  if (!m) return {};
  return {
    line: m[1] ? Number(m[1]) : undefined,
    column: m[2] ? Number(m[2]) : undefined,
  };
}

export function useYamlDocumentTransaction({
  open,
  onSaved,
}: {
  open: boolean;
  onSaved?: () => void;
}) {
  const [code, setCode] = useState<string>('');
  const [originalCode, setOriginalCode] = useState<string>('');
  const [template, setTemplate] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string>(getModelsCatalogPath());
  const [loading, setLoading] = useState<boolean>(open);
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [syntaxError, setSyntaxError] = useState<YamlSyntaxError | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const revisionRef = useRef<string | null>(null);
  const documentEpoch = useRef(0);
  const savingRef = useRef(false);
  const codeRef = useRef(code);
  codeRef.current = code;
  // 1. 读取配置文件
  const loadConfigFile = useCallback(async () => {
    const epoch = ++documentEpoch.current;
    revisionRef.current = null;
    setLoading(true);
    try {
      const res = await readModelsYamlIpc();
      if (epoch !== documentEpoch.current) return;

      if (res.ok) {
        revisionRef.current = res.data.revision;
        setFilePath(res.data.path);
        setTemplate(res.data.template);
        setCode(res.data.content);
        setOriginalCode(res.data.content);
        setServiceError(null);
        const pe = res.data.parseError;
        setSyntaxError(
          pe
            ? {
                line: pe.line ?? 1,
                column: pe.column ?? 1,
                message: pe.message,
              }
            : null
        );
        return;
      }

      setServiceError(res.error);
      setSyntaxError(null);
    } catch (error) {
      if (epoch === documentEpoch.current)
        setServiceError(error instanceof Error ? error.message : String(error));
    } finally {
      if (epoch === documentEpoch.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadConfigFile();
      setSaveSuccess(false);
      setSyntaxError(null);
      setServiceError(null);
    }
    return () => {
      documentEpoch.current += 1;
    };
  }, [open, loadConfigFile]);

  // 2. 实时语法诊断
  useEffect(() => {
    if (!open || serviceError || loading) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const res = await validateModelsYamlIpc(code);
      if (cancelled) return;
      if (!res.ok) {
        setServiceError(res.error);
        return;
      }

      setServiceError(null);
      setSyntaxError(
        res.data.valid
          ? null
          : {
              line: res.data.line ?? 1,
              column: res.data.column ?? 1,
              message: res.data.message || 'YAML 语法格式错误',
            }
      );
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, open, serviceError, loading]);

  // 5. 保存
  const handleSave = async () => {
    if (
      syntaxError ||
      serviceError ||
      savingRef.current ||
      loading ||
      !revisionRef.current
    )
      return;
    const submittedCode = code;
    const epoch = documentEpoch.current;
    savingRef.current = true;
    setSaving(true);
    try {
      const res = await saveModelsYamlTextIpc(
        submittedCode,
        revisionRef.current
      );
      if (!res.ok) {
        if (epoch !== documentEpoch.current) return;
        if (res.kind === 'REVISION_CONFLICT' || res.code !== 'INVALID_CONFIG') {
          setServiceError(res.error);
        } else {
          const pos = parseLineColumnFromMessage(res.error);
          setSyntaxError({
            line: pos.line ?? 1,
            column: pos.column ?? 1,
            message: res.error,
          });
        }
        return;
      }

      if (epoch === documentEpoch.current) {
        revisionRef.current = res.data.revision;
        setFilePath(res.data.path);
        setOriginalCode(res.data.content);
        if (codeRef.current === submittedCode) setCode(res.data.content);
        setSaveSuccess(codeRef.current === submittedCode);
      }
      const refresh = await ensureModelsCatalogLoaded(true);
      if (!refresh.ok && epoch === documentEpoch.current) {
        setServiceError('配置已保存，目录刷新失败：' + refresh.error);
      }
      onSaved?.();
    } catch (error) {
      if (epoch === documentEpoch.current)
        setServiceError(error instanceof Error ? error.message : String(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return {
    code,
    setCode,
    originalCode,
    template,
    filePath,
    loading,
    saving,
    saveSuccess,
    syntaxError,
    serviceError,
    loadConfigFile,
    handleSave,
  };
}
