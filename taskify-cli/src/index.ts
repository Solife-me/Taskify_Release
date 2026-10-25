#!/usr/bin/env node
import { runCli } from "./cli.js";
import { onConfigLoaded } from "./config.js";
import { applyCliRelaySettings } from "./shared/relaySettings.js";

// Every relay client in a run follows the selected profile: its NIP-13 floor, native-speed
// mining and the persistent relay-info cache (NIP-11 limits, learned PoW targets).
onConfigLoaded(applyCliRelaySettings);
applyCliRelaySettings({});

// NDK relay objects maintain long-lived housekeeping timers by design. All command actions have
// returned and completed their cleanup before this sole executable hard-exit boundary runs.
process.exit(await runCli(process.argv));
