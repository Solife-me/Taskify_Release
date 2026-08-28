import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v_0_4_1_0 = VersionInfo.of({
  version: '0.4.1:0',
  releaseNotes: {
    en_US: 'Initial Taskify NIP-17 push relay release for StartOS 0.4.1.',
    es_ES:
      'Versión inicial del relé push NIP-17 de Taskify para StartOS 0.4.1.',
    de_DE: 'Erste Version des Taskify NIP-17-Push-Relays für StartOS 0.4.1.',
    pl_PL:
      'Pierwsze wydanie przekaźnika push NIP-17 Taskify dla StartOS 0.4.1.',
    fr_FR: 'Première version du relais push NIP-17 Taskify pour StartOS 0.4.1.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
