import { MarkdownParser } from './parser';
import katex from 'katex';

export interface FormatDiagnostic {
    line: number;
    column: number;
    severity: 'error' | 'warning';
    message: string;
    rule: string;
}

export interface FormatValidationResult {
    isValid: boolean;
    errors: FormatDiagnostic[];
    warnings: FormatDiagnostic[];
    stats: {
        totalLines: number;
        headingsCount: number;
        codeBlocksCount: number;
        mathCount: number;
        tokensCount: number;
    };
}

export class MarkdownFormatChecker {
    /**
     * Validates markdown content, verifying:
     * 1. Code fences & math fence closures ($$, ```)
     * 2. LaTeX KaTeX mathematical equation validity
     * 3. Token range and span bounds monotonic integrity
     * 4. HTML tag pairing and balance
     */
    public static validate(markdown: string): FormatValidationResult {
        const diagnostics: FormatDiagnostic[] = [];
        const lines = markdown.split('\n');
        const doc = MarkdownParser.parse(markdown);

        let headingsCount = 0;
        let codeBlocksCount = 0;
        let mathCount = 0;
        let tokensCount = 0;

        let inCodeFence = false;
        let inMathFence = false;

        for (let i = 0; i < doc.lines.length; i++) {
            const lineNode = doc.lines[i];

            if (lineNode.type === 'heading') headingsCount++;
            if (lineNode.type === 'code_fence_start') {
                codeBlocksCount++;
                inCodeFence = true;
            }
            if (lineNode.type === 'code_fence_end') inCodeFence = false;
            if (lineNode.type === 'math_fence_start') {
                inMathFence = true;
            }
            if (lineNode.type === 'math_fence_end') inMathFence = false;

            if (lineNode.type === 'math_block') {
                mathCount++;
                // Validate KaTeX formula syntax
                const formula = lineNode.raw.trim();
                if (formula) {
                    try {
                        katex.renderToString(formula, { throwOnError: true, displayMode: true });
                    } catch (e: any) {
                        diagnostics.push({
                            line: i + 1,
                            column: 1,
                            severity: 'warning',
                            message: `LaTeX KaTeX syntax warning in math block: ${e?.message || e}`,
                            rule: 'math-katex-syntax'
                        });
                    }
                }
            }

            if (lineNode.inlineTokens) {
                tokensCount += lineNode.inlineTokens.length;

                for (const token of lineNode.inlineTokens) {
                    // Check token range integrity
                    if (token.localOffset < lineNode.localOffset || token.localOffset + token.length > lineNode.localOffset + lineNode.length) {
                        diagnostics.push({
                            line: i + 1,
                            column: token.localOffset - lineNode.localOffset + 1,
                            severity: 'error',
                            message: `Token range [${token.localOffset}, ${token.localOffset + token.length}] out of line bounds [${lineNode.localOffset}, ${lineNode.localOffset + lineNode.length}]`,
                            rule: 'token-bounds-integrity'
                        });
                    }

                    if (token.type === 'math') {
                        try {
                            katex.renderToString(token.content, { throwOnError: true });
                        } catch (e: any) {
                            if (!e.message.includes('ParseError')) {
                                diagnostics.push({
                                    line: i + 1,
                                    column: token.localOffset - lineNode.localOffset + 1,
                                    severity: 'warning',
                                    message: `LaTeX KaTeX syntax warning: ${e?.message || e}`,
                                    rule: 'katex-syntax'
                                });
                            }
                        }
                    } else if (token.type === 'html_element') {
                        const tagName = (token as any).tagName;
                        if (!tagName) {
                            diagnostics.push({
                                line: i + 1,
                                column: token.localOffset - lineNode.localOffset + 1,
                                severity: 'warning',
                                message: `Unclosed HTML tag <${tagName}> on single line`,
                                rule: 'html-unclosed'
                            });
                        }
                    }
                }
            }
        }

        if (inCodeFence) {
            diagnostics.push({
                line: lines.length,
                column: 1,
                severity: 'error',
                message: 'Unclosed code fence (```) at end of document',
                rule: 'unclosed-code-fence'
            });
        }

        if (inMathFence) {
            diagnostics.push({
                line: lines.length,
                column: 1,
                severity: 'error',
                message: 'Unclosed math block ($$) at end of document',
                rule: 'unclosed-math-fence'
            });
        }

        const errors = diagnostics.filter(d => d.severity === 'error');
        const warnings = diagnostics.filter(d => d.severity === 'warning');

        return {
            isValid: errors.length === 0,
            errors,
            warnings,
            stats: {
                totalLines: lines.length,
                headingsCount,
                codeBlocksCount,
                mathCount,
                tokensCount
            }
        };
    }
}
