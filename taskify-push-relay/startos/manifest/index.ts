import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'taskify-push-relay',
  title: 'Taskify Push Relay',
  license: 'MIT',
  packageRepo: 'https://github.com/Solife-me/Taskify_Release',
  upstreamRepo: 'https://github.com/Solife-me/Taskify_Release',
  marketingUrl: 'https://solife.me',
  donationUrl: null,
  description: { short, long },
  volumes: ['main'],
  images: {
    main: {
      source: {
        dockerBuild: {
          workdir: '.',
          dockerfile: 'Dockerfile',
        },
      },
      arch: ['x86_64', 'aarch64'],
    },
  },
})
