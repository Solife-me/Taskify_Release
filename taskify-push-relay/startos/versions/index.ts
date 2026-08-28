import { VersionGraph } from '@start9labs/start-sdk'
import { current } from './current'
import { v_0_4_1_0 } from './v0.4.1.0'
import { v_0_4_1_1 } from './v0.4.1.1'

export const versionGraph = VersionGraph.of({ current, other: [v_0_4_1_0, v_0_4_1_1] })
