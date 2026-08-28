import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

const shape = z.object({
  teamID: z.string(),
  keyID: z.string(),
  privateKey: z.string(),
  topic: z.string(),
})

export type APNsConfiguration = z.infer<typeof shape>

export const apnsConfigJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: 'apns.json' },
  shape,
)
