import { i18n } from './i18n'
import { sdk } from './sdk'
import { relayPort } from './utils'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const multi = sdk.MultiHost.of(effects, 'relay')
  const origin = await multi.bindPort(relayPort, {
    protocol: 'http',
    preferredExternalPort: 80,
  })
  const relay = sdk.createInterface(effects, {
    name: i18n('NIP-17 Push Relay'),
    id: 'relay',
    description: i18n('HTTPS registration API and WebSocket Nostr relay.'),
    type: 'api',
    masked: false,
    schemeOverride: null,
    username: null,
    path: '',
    query: {},
  })
  return [await origin.export([relay])]
})
