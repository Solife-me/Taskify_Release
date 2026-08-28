import { configureAPNs } from '../actions/configureAPNs'
import { i18n } from '../i18n'
import { sdk } from '../sdk'

export const initializeService = sdk.setupOnInit(async (effects, kind) => {
  if (kind !== 'install') return
  await sdk.action.createOwnTask(effects, configureAPNs, 'critical', {
    reason: i18n('Configure Apple Push credentials before starting the relay'),
  })
})
