import React, { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../core/EditorStore';
import { getCoordinatesFromIndex, getGlobalIndexFromDOMNode } from '../core/measure';

interface HiddenInputProps {
    containerRef: React.RefObject<HTMLDivElement | null>;
}

export const HiddenInput: React.FC<HiddenInputProps> = ({ containerRef }) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const { cursorPos, insertText, deleteText, setCursorPos, text } = useEditorStore();
    const [coords, setCoords] = useState<{ top: number; left: number; height: number } | null>(null);

    // Sync physical coordinates whenever cursor or text changes
    useEffect(() => {
        if (!containerRef.current) return;
        
        // Update active token for Live Preview syntax hiding
        const oldTokenActives = containerRef.current.querySelectorAll('.is-active-token');
        for (let i = 0; i < oldTokenActives.length; i++) {
            oldTokenActives[i].classList.remove('is-active-token');
        }
        const tokens = containerRef.current.querySelectorAll('[data-token-start]');
        for (let i = 0; i < tokens.length; i++) {
            const start = parseInt(tokens[i].getAttribute('data-token-start') || '0', 10);
            const len = parseInt(tokens[i].getAttribute('data-token-length') || '0', 10);
            if (cursorPos >= start && cursorPos <= start + len) {
                tokens[i].classList.add('is-active-token');
            }
        }

        // Update active line for line-level rendering (e.g. horizontal rules)
        const oldLineActives = containerRef.current.querySelectorAll('.is-active-line');
        for (let i = 0; i < oldLineActives.length; i++) {
            oldLineActives[i].classList.remove('is-active-line');
        }
        const lines = containerRef.current.querySelectorAll('[data-line-start]');
        for (let i = 0; i < lines.length; i++) {
            const start = parseInt(lines[i].getAttribute('data-line-start') || '0', 10);
            const len = parseInt(lines[i].getAttribute('data-line-length') || '0', 10);
            if (cursorPos >= start && cursorPos <= start + len) {
                lines[i].classList.add('is-active-line');
            }
        }

        const rect = getCoordinatesFromIndex(cursorPos, containerRef.current);
        if (rect) {
            const containerRect = containerRef.current.getBoundingClientRect();
            setCoords({
                top: rect.top - containerRect.top + containerRef.current.scrollTop,
                left: rect.left - containerRect.left + containerRef.current.scrollLeft,
                height: rect.height
            });
        }
    }, [cursorPos, text, containerRef]);

    useEffect(() => {
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
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
                    const range = selection.getRangeAt(0);
                    if (!containerRef.current) return;
                    
                    const startGlobal = getGlobalIndexFromDOMNode(range.startContainer, range.startOffset, containerRef.current);
                    const endGlobal = getGlobalIndexFromDOMNode(range.endContainer, range.endOffset, containerRef.current);
                    
                    if (startGlobal !== null && endGlobal !== null) {
                        e.preventDefault();
                        useEditorStore.getState().deleteSelection(startGlobal, endGlobal);
                        selection.removeAllRanges();
                        textareaRef.current?.focus();
                    }
                }
            }
        };

        window.addEventListener('click', handleGlobalClick);
        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => {
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
            insertText('\n');
        }
        // ArrowUp / ArrowDown MVP: just skip line (very complex to implement physics mapping).
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
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
