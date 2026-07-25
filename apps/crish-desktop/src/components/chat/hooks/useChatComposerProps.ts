import { useState, useCallback, useRef, useEffect } from 'react';
import type { SkillSlashCommand } from '../../api/skillsApi';
import { clientApi } from '../../api/clientApi';
import { getSkillSlashCommandsCached } from '../../api/skillsApi';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { sessionRuntimeRegistry } from '../../api/SessionRuntimeRegistry';
import type { Attachment } from '../../api/SessionRuntimeRegistry';
import { COMPOSER_SEED_EVENT, takeComposerSeed } from '../../api/composerSeed';
import { onUiEvent } from '../../api/uiEvents';
import { isDemoMode } from '../../api/appMode';

export function useChatComposerProps(activeSessionId: string | null | undefined, setComposerDraft: (sid: string, d: string) => void, composerDrafts: Record<string, string>) {
  const [chatInput, setChatInputState] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [attachments, setAttachments] = useState<ChatAttachment[]>(() => activeSessionId ? (sessionRuntimeRegistry.get(activeSessionId).attachments ?? []) as ChatAttachment[] : []);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [pickerInlineError, setPickerInlineError] = useState('');
  const [localMsgFilter, setLocalMsgFilter] = useState('');
  const [showMsgFilter, setShowMsgFilter] = useState(false);
  const [projectTick, setProjectTick] = useState(0);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelSelectorRef = useRef<HTMLDivElement>(null);
  const msgFilterInputRef = useRef<HTMLInputElement>(null);
  const prevSessionIdRef = useRef(activeSessionId);
  const [skillSlash, setSkillSlash] = useState<SkillSlashCommand[]>([]);
  const [skillCommandsEnabled, setSkillCommandsEnabled] = useState(true);
  const activeSessionIdRef = useRef(activeSessionId);

  useEffect(() => { activeSessionIdRef.current = activeSessionId; setChatInputState(activeSessionId ? (composerDrafts[activeSessionId] || '') : ''); }, [activeSessionId]);
  useEffect(() => { const prevId = prevSessionIdRef.current; if (prevId && prevId !== activeSessionId) sessionRuntimeRegistry.save(prevId, { attachments: attachments as Attachment[] }); prevSessionIdRef.current = activeSessionId || ''; if (activeSessionId) setAttachments((sessionRuntimeRegistry.get(activeSessionId).attachments ?? []) as ChatAttachment[]); else setAttachments([]); setLocalMsgFilter(''); setShowMsgFilter(false); }, [activeSessionId]);

  const setChatInput = useCallback((textOrFn: React.SetStateAction<string>) => { setChatInputState((prev) => { const next = typeof textOrFn === 'function' ? textOrFn(prev) : textOrFn; const sid = activeSessionIdRef.current; if (sid) setComposerDraft(sid, next); return next; }); }, [setComposerDraft]);

  useEffect(() => { const apply = (text: string) => { const t = text.trim(); if (!t) return; setChatInput(t); }; const seed = takeComposerSeed(); if (seed) apply(seed); const onSeed = (e: Event) => { const d = (e as CustomEvent<{ text?: string }>).detail; if (d?.text) apply(d.text); }; window.addEventListener(COMPOSER_SEED_EVENT, onSeed); return () => window.removeEventListener(COMPOSER_SEED_EVENT, onSeed); }, [setChatInput]);
  const canSend = Boolean(chatInput.trim() || attachments.length > 0);
  const addAttachments = useCallback((items: ChatAttachment[]) => { if (!items.length) return; setAttachments((prev) => { const names = new Set(prev.map((p) => p.name)); const next = items.filter((n) => !names.has(n.name)); const uniqued = items.filter((n) => names.has(n.name)).map((n, i) => { if (!n.dataUrl) return null; const base = n.name.replace(/(\.[^.]+)?$/, ''); const ext = (n.name.match(/(\.[^.]+)$/) || [])[1] || ''; return { ...n, name: `${base}-${Date.now()}-${i}${ext}` }; }).filter(Boolean) as ChatAttachment[]; return [...prev, ...next, ...uniqued]; }); }, []);
  const handlePasteImage = useCallback(async (e: React.ClipboardEvent<HTMLElement>) => { const items = e.clipboardData?.items; if (!items?.length) return; const imageFiles: File[] = []; for (const item of Array.from(items)) { if (!item.type.startsWith('image/')) continue; const file = item.getAsFile(); if (file) imageFiles.push(file); } if (!imageFiles.length) return; e.preventDefault(); try { const { blobToImageAttachment } = await import('../../api/imageProcessing'); const next: ChatAttachment[] = []; for (const f of imageFiles) next.push(await blobToImageAttachment(f, f.name || undefined)); addAttachments(next); } catch {} }, [addAttachments]);
  useEffect(() => { const h = (e: MouseEvent) => { if (modelSelectorRef.current && !modelSelectorRef.current.contains(e.target as Node)) setShowModelDropdown(false); }; if (showModelDropdown) { document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); } }, [showModelDropdown]);
  useEffect(() => { if (showMsgFilter) window.requestAnimationFrame(() => msgFilterInputRef.current?.focus()); }, [showMsgFilter]);
  useEffect(() => { const offs = [onUiEvent('project-changed', () => setProjectTick((n) => n + 1)), onUiEvent('open-project-picker', () => setShowProjectPicker(true)), onUiEvent('toggle-msg-filter', () => { setShowMsgFilter((v) => { const next = !v; if (!next) setLocalMsgFilter(''); return next; }); })]; return () => offs.forEach((f) => f()); }, []);

  const BASE_SLASH = [{ cmd: '/grill-me', desc: '对齐提问，暂不实施' }, { cmd: '/teamwork', desc: '协作看板' }, { cmd: '/browser', desc: '预览浏览器' }, ...(isDemoMode() ? [{ cmd: '/goal', desc: '多轮推进直至完成' }, { cmd: '/learn', desc: '记住一条规则' }, { cmd: '/schedule', desc: '定时任务' }, { cmd: '/simulate', desc: '演示流水线' }] : [])];
  useEffect(() => { let cancelled = false; const load = async (force = false) => { try { const settings = await clientApi.getSettings(); if (cancelled) return; const on = settings?.enableSkillCommands !== false; setSkillCommandsEnabled(on); if (!on) { setSkillSlash([]); return; } const { commands } = await getSkillSlashCommandsCached(force); if (!cancelled) setSkillSlash(commands); } catch {} }; void load(); const h = () => { void load(true); }; window.addEventListener('crish-skills-changed', h); return () => { cancelled = true; window.removeEventListener('crish-skills-changed', h); }; }, []);
  const filteredCommands = BASE_SLASH.concat(skillCommandsEnabled ? skillSlash.map((s) => ({ cmd: s.cmd, desc: s.desc })) : []).filter((c) => c.cmd.toLowerCase().startsWith(chatInput.toLowerCase()));
  const loadSkillSlash = useCallback(async () => { if (!skillCommandsEnabled) return; try { const { commands } = await getSkillSlashCommandsCached(false); setSkillSlash(commands); } catch {} }, [skillCommandsEnabled]);

  return { chatInput, setChatInput, isComposing, setIsComposing, slashMenuOpen, setSlashMenuOpen, slashSelectedIndex, setSlashSelectedIndex, attachments, setAttachments, fileInputRef, canSend, handlePasteImage, addAttachments, modelSelectorRef, showModelDropdown, setShowModelDropdown, showPlusMenu, setShowPlusMenu, pickerInlineError, setPickerInlineError, localMsgFilter, setLocalMsgFilter, showMsgFilter, setShowMsgFilter, msgFilterInputRef, projectTick, setProjectTick, showProjectPicker, setShowProjectPicker, filteredCommands, loadSkillSlash, skillCommandsEnabled };
}
