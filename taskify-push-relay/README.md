# Taskify Push Relay for StartOS

This directory is the StartOS package for the Taskify Push Relay. The relay application, Dockerfile
and protocol tests live in [`../push-relay`](../push-relay/). The package pins the public
multi-architecture image rather than carrying a second copy of the application source.

## Build

```sh
npm ci
npm test
npm run check
npm run build
make arm   # aarch64
make x86   # x86_64
```

The package installs the image pinned in `startos/manifest/index.ts`. Publish and verify that exact
image before changing the pin; see [`UPDATING.md`](UPDATING.md) for the required release order.

## Configuration and data

- Persistent relay state is stored in the encrypted `main` volume as `relay.sqlite`.
- Existing `state.json` data is imported once by relay 0.5.0 and retained as
  `state.json.imported`.
- Configure Apple Push, FCM and Web Push through the StartOS actions. Never commit credentials or
  an APNs `.p8` key.
- The daemon runs as the image's unprivileged `node` user; a package oneshot assigns the mounted
  volume before it starts.

Package updates from releases before 0.5.0 cannot be downgraded after the SQLite import.
