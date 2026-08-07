import React, { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../core/EditorStore';
import { getCoordinatesFromIndex, getGlobalIndexFromDOMNode, getArrowNavigationIndex } from '../core/measure';

interface HiddenInputProps {
    containerRef: React.RefObject<HTMLDivElement | null>;
}

export const HiddenInput: React.FC<HiddenInputProps> = ({ containerRef }) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const cursorPos = useEditorStore(state => state.cursorPos);
    const insertText = useEditorStore(state => state.insertText);
    const deleteText = useEditorStore(state => state.deleteText);
    const setCursorPos = useEditorStore(state => state.setCursorPos);
    const setSelection = useEditorStore(state => state.setSelection);
    const [coords, setCoords] = useState<{ top: number; left: number; height: number } | null>(null);
    const [isComposing, setIsComposing] = useState(false);
    const updateActiveElements = (cursor: number, selStart?: number, selEnd?: number) => {
        if (!containerRef.current) return;
        
        const hasRange = selStart !== undefined && selEnd !== undefined && selStart < selEnd;

        // Update active tokens
        const tokens = containerRef.current.querySelectorAll('[data-token-start]');
        for (let i = 0; i < tokens.length; i++) {
            const start = parseInt(tokens[i].getAttribute('data-token-start') || '0', 10);
            const len = parseInt(tokens[i].getAttribute('data-token-length') || '0', 10);
            const end = start + len;
            
            let isActive = false;
            if (hasRange) {
                if (start < selEnd && end > selStart) {
                    isActive = true;
                }
            } else {
                if (cursor >= start && cursor <= end) {
                    isActive = true;
                }
            }

            if (isActive) {
                tokens[i].classList.add('is-active-token');
            } else {
                tokens[i].classList.remove('is-active-token');
            }
        }

        // Update active lines
        const lines = containerRef.current.querySelectorAll('[data-line-start]');
        for (let i = 0; i < lines.length; i++) {
            const start = parseInt(lines[i].getAttribute('data-line-start') || '0', 10);
            const len = parseInt(lines[i].getAttribute('data-line-length') || '0', 10);
            const end = start + len;
            
            let isActive = false;
            if (hasRange) {
                if (start < selEnd && end >= selStart) {
                    isActive = true;
                }
            } else {
                if (cursor >= start && cursor <= end) {
                    isActive = true;
                }
            }

            if (isActive) {
                lines[i].classList.add('is-active-line');
            } else {
                lines[i].classList.remove('is-active-line');
            }
        }
    };

    // Sync physical coordinates whenever cursor or text changes
    useEffect(() => {
        if (!containerRef.current) return;
        
        updateActiveElements(cursorPos);

        const rect = getCoordinatesFromIndex(cursorPos, containerRef.current);
        if (rect) {
            const containerRect = containerRef.current.getBoundingClientRect();
            const top = rect.top - containerRect.top + containerRef.current.scrollTop;
            const left = rect.left - containerRect.left + containerRef.current.scrollLeft;
            setCoords({ top, left, height: rect.height });

            const cTop = containerRef.current.scrollTop;
            const cHeight = containerRef.current.clientHeight;
            if (top < cTop) {
                containerRef.current.scrollTop = Math.max(0, top - 40);
            } else if (top + rect.height > cTop + cHeight) {
                containerRef.current.scrollTop = top + rect.height - cHeight + 40;
            }
        }
    }, [cursorPos, containerRef]);

    useEffect(() => {
        const handleSelectionChange = () => {
            if (!containerRef.current) return;
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
                updateActiveElements(useEditorStore.getState().cursorPos);
                return;
            }

            const range = selection.getRangeAt(0);
            if (!containerRef.current.contains(range.commonAncestorContainer)) {
                return;
            }

            const startIdx = getGlobalIndexFromDOMNode(range.startContainer, range.startOffset, containerRef.current);
            const endIdx = getGlobalIndexFromDOMNode(range.endContainer, range.endOffset, containerRef.current);

            if (startIdx !== null && endIdx !== null) {
                const s = Math.min(startIdx, endIdx);
                const e = Math.max(startIdx, endIdx);
                useEditorStore.getState().setSelection(s, e);
                updateActiveElements(useEditorStore.getState().cursorPos, s, e);
            }
        };

        // Keep focus
        const handleGlobalClick = () => {
            // If text is selected on the screen, DO NOT steal focus!
            // Stealing focus will immediately destroy the user's DOM text selection.
            const selection = window.getSelection();
            if (selection && selection.toString().length > 0) {
                return;
            }
            textareaRef.current?.focus();
        };

        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Backspace' || e.key === 'Delete') {
                const state = useEditorStore.getState();
                if (state.selectionStart !== state.selectionEnd) {
                    e.preventDefault();
                    state.deleteSelection(state.selectionStart, state.selectionEnd);
                    window.getSelection()?.removeAllRanges();
                    textareaRef.current?.focus();
                }
            }
        };

        document.addEventListener('selectionchange', handleSelectionChange);
        window.addEventListener('click', handleGlobalClick);
        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => {
            document.removeEventListener('selectionchange', handleSelectionChange);
            window.removeEventListener('click', handleGlobalClick);
            window.removeEventListener('keydown', handleGlobalKeyDown);
        };
    }, [containerRef]);

    const fastCursorMove = (newPos: number) => {
        setCursorPos(newPos);
        // We don't need manual dom manipulation here anymore, since useEffect handles it on cursorPos change
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            fastCursorMove(cursorPos - 1);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            fastCursorMove(cursorPos + 1);
        } else if (e.key === 'Backspace') {
            e.preventDefault();
            deleteText(true);
        } else if (e.key === 'Delete') {
            e.preventDefault();
            deleteText(false);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (isComposing) return;
            insertText('\n');
        } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const currentText = useEditorStore.getState().text;
            setSelection(0, currentText.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (containerRef.current) {
                const targetIdx = getArrowNavigationIndex(cursorPos, 'up', containerRef.current);
                if (targetIdx !== null) fastCursorMove(targetIdx);
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (containerRef.current) {
                const targetIdx = getArrowNavigationIndex(cursorPos, 'down', containerRef.current);
                if (targetIdx !== null) fastCursorMove(targetIdx);
            }
        } else if (e.key === 'Home') {
            e.preventDefault();
            let lineStart = 0;
            const currentText = useEditorStore.getState().text;
            for (let i = cursorPos; i >= 0; i--) {
                if (i === 0 || currentText[i - 1] === '\n') {
                    lineStart = i;
                    break;
                }
            }
            fastCursorMove(lineStart);
        } else if (e.key === 'End') {
            e.preventDefault();
            const currentText = useEditorStore.getState().text;
            let lineEnd = currentText.length;
            for (let i = cursorPos; i < currentText.length; i++) {
                if (currentText[i] === '\n') {
                    lineEnd = i;
                    break;
                }
            }
            fastCursorMove(lineEnd);
        }
    };

    const handleCompositionStart = () => {
        setIsComposing(true);
    };

    const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
        setIsComposing(false);
        if (e.data) {
            insertText(e.data);
        }
        if (textareaRef.current) textareaRef.current.value = '';
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (isComposing) return;
        const value = e.target.value;
        if (value) {
            insertText(value);
            // reset textarea so we can catch next input cleanly
            e.target.value = '';
        }
    };

    if (!coords) return null;

    return (
        <textarea
            ref={textareaRef}
            value=""
            onKeyDown={handleKeyDown}
            onChange={handleInput}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            style={{
                position: 'absolute',
                top: `${coords.top}px`,
                left: `${coords.left}px`,
                width: '1px',
                height: `${coords.height}px`,
                opacity: 0,
                padding: 0,
                border: 'none',
                overflow: 'hidden',
                resize: 'none',
                outline: 'none',
                pointerEvents: 'none'
            }}
            spellCheck="false"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
        />
    );
};
