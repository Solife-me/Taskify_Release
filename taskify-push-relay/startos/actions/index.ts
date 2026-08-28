import { sdk } from '../sdk'
import { configureAPNs } from './configureAPNs'

export const actions = sdk.Actions.of().addAction(configureAPNs)
