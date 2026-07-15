/**
 * 渐进约束：禁止在样式中新增 !important（历史债需逐步消）。
 * 用法：npx stylelint "apps/crish-desktop/src/styles/**/*.css"
 */
module.exports = {
  rules: {
    'declaration-no-important': true,
  },
};
