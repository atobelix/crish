/**
 * menus — 编辑器级菜单的公开出口
 */

export { BubbleMenuBar } from './BubbleMenu';
export { SlashMenu } from './SlashMenu';
export { SlashCommandExtension } from './SlashCommandExtension';
export { BlockMenu } from './BlockMenu';
export { SLASH_COMMANDS, filterSlashCommands, CATEGORY_LABELS } from './slashCommands';
export { TEXT_COLORS, BACKGROUND_COLORS } from './colorPalette';
export type { SlashCommand, SlashCategory } from './slashCommands';
export type { PaletteColor } from './colorPalette';
