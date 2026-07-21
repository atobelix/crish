/* Progressive rule: flag !important as warning (historical debt must not block commits). */
module.exports = {
  rules: {
    'declaration-no-important': [true, { severity: 'warning' }],
  },
};
