import schplitt from '@schplitt/eslint-config'

export default schplitt().overrideRules({
  // scripts run as ES modules with top-level await
  'antfu/no-top-level-await': 'off',
})
