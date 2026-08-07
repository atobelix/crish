import React, { useLayoutEffect, useState, useEffect } from 'react';
import { useEditorStore } from '../core/EditorStore';
import { getCoordinatesFromIndex } from '../core/measure';

interface CursorLayerProps {
    containerRef: React.RefObject<HTMLDivElement | null>;
}

export const CursorLayer: React.FC<CursorLayerProps> = ({ containerRef }) => {
    const cursorPos = useEditorStore(state => state.cursorPos);
    const [coords, setCoords] = useState<{ top: number; left: number; height: number; bottom: number } | null>(null);
    const [hasSelection, setHasSelection] = useState(false);

    useEffect(() => {
        const handleSelectionChange = () => {
            const selection = window.getSelection();
            setHasSelection(selection ? selection.toString().length > 0 : false);
        };
        document.addEventListener('selectionchange', handleSelectionChange);
        return () => document.removeEventListener('selectionchange', handleSelectionChange);
    }, []);

    // Sync physical coordinates synchronously BEFORE browser paint to eliminate 1-frame lag
    useLayoutEffect(() => {
        if (!containerRef.current) return;
        
        // 0. Remove old active tokens
        const oldTokenActives = containerRef.current.querySelectorAll('.is-active-token');
        for (let i = 0; i < oldTokenActives.length; i++) {
            oldTokenActives[i].classList.remove('is-active-token');
        }

        // 1. Mark active token (for specific token styling)
        const tokens = containerRef.current.querySelectorAll('[data-token-start]');
        for (let i = 0; i < tokens.length; i++) {
            const start = parseInt(tokens[i].getAttribute('data-token-start') || '0', 10);
            const len = parseInt(tokens[i].getAttribute('data-token-length') || '0', 10);
            
            if (cursorPos >= start && cursorPos <= start + len) {
                tokens[i].classList.add('is-active-token');
            } else {
                // For line prefixes (headings, lists), activate if cursor is anywhere on the line
                const classList = tokens[i].classList;
                if (classList.contains('token-heading-prefix') || 
                    classList.contains('token-list-bullet') || 
                    classList.contains('token-list-number') || 
                    classList.contains('token-list-task')) {
                    
                    const lineBlock = tokens[i].closest('[data-line-start]');
                    if (lineBlock) {
                        const lineStart = parseInt(lineBlock.getAttribute('data-line-start') || '0', 10);
                        const lineLen = parseInt(lineBlock.getAttribute('data-line-length') || '0', 10);
                        if (cursorPos >= lineStart && cursorPos <= lineStart + lineLen) {
                            tokens[i].classList.add('is-active-token');
                        }
                    }
                }
            }
        }

        const rect = getCoordinatesFromIndex(cursorPos, containerRef.current);
        if (rect && containerRef.current) {
            const containerRect = containerRef.current.getBoundingClientRect();
            setCoords({
                top: rect.top - containerRect.top + containerRef.current.scrollTop,
                left: rect.left - containerRect.left + containerRef.current.scrollLeft,
                height: rect.height,
                bottom: rect.bottom - containerRect.top + containerRef.current.scrollTop
            });
        }
    }, [cursorPos, containerRef]);

    if (!coords || hasSelection) return null;

    return (
        <div 
            key={cursorPos}
            className="cursor-caret" 
            style={{
                position: 'absolute',
                top: `${coords.top}px`,
                left: `${coords.left}px`,
                height: `${coords.height}px`,
                width: '1px',
                backgroundColor: 'var(--black)',
                animation: 'blink 1s step-end infinite',
                zIndex: 50,
                pointerEvents: 'none'
            }}
        />
    );
};
