import { sdk } from '../sdk'
import { configureAPNs } from './configureAPNs'
import { configureFCM } from './configureFCM'
import { configureWebPush } from './configureWebPush'

export const actions = sdk.Actions.of()
  .addAction(configureAPNs)
  .addAction(configureFCM)
  .addAction(configureWebPush)
