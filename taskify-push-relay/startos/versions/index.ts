import { VersionGraph } from '@start9labs/start-sdk'
import { current } from './current'
import { v_0_4_1_0 } from './v0.4.1.0'
import { v_0_4_1_1 } from './v0.4.1.1'
import { v_0_4_1_2 } from './v0.4.1.2'
import { v_0_4_1_3 } from './v0.4.1.3'
import { v_0_4_1_4 } from './v0.4.1.4'
import { v_0_4_1_5 } from './v0.4.1.5'
import { v_0_4_1_6 } from './v0.4.1.6'

export const versionGraph = VersionGraph.of({
  current,
  other: [
    v_0_4_1_0,
    v_0_4_1_1,
    v_0_4_1_2,
    v_0_4_1_3,
    v_0_4_1_4,
    v_0_4_1_5,
    v_0_4_1_6,
  ],
})
