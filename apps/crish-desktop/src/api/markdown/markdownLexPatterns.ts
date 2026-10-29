/** 围栏代码行模式（MarkdownBlockScanner 与草稿闭合器共用）。 */
export const codeFenceOpenPattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;
export const codeFenceClosePattern = /^( {0,3})(`{3,}|~{3,})\s*$/;
