# AGENTS.md

This is the StartOS package for Taskify's push relay, and also the relay itself:
- `src/` and `test/` are the relay's own source and tests;
- `startos/` packages them, building the image from the local `Dockerfile`.

- Run `npm test`, `npm run check` and `npm run build` (the StartOS bundle). Packing needs
  `make`, with `start-cli` installed.
- A maintainer publishes a relay image by pushing the exact tag
  `push-relay-v<package.json version>`. The workflow tests the relay and publishes both amd64 and
  arm64 to GHCR. Agents never create or push that tag.
- The relay's state is `relay.sqlite`, through `RelayStore` only. Don't read or write `state.json`:
  `importLegacyState` is its one reader, for upgrades from releases before 0.5.0.
- Store tests go through the store's public API, and check durability by reopening the store. The
  one exception is the task cache's on-disk columns, which are a privacy property.
- Never put an account, device, relay or board secret in the task cache. It must not be able to
  tell which Taskify identity asked for an event.
