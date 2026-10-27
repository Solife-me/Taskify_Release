# AGENTS.md

This is the Taskify Push Relay application. The sibling `taskify-push-relay/` directory is only
its StartOS package and must consume a published, versioned image rather than application source.

- Run `npm test` and `npm audit --omit=dev --audit-level=high`. Build the production image with
  `docker build --tag taskify-push-relay:local .`.
- A release is a version bump in `package.json` merged to `main`. The image workflow publishes
  that version for amd64 and arm64 once, then tags it `push-relay-v<version>`. Relay changes that
  keep a published version are never released, so bump the version with any change meant to ship.
- Relay state is `relay.sqlite`, accessed through `RelayStore` only. Do not read or write
  `state.json`: `importLegacyState` is its one reader, for upgrades from releases before 0.5.0.
- Store tests go through the store's public API and check durability by reopening the store. The
  one exception is the task cache's on-disk columns, which are a privacy property.
- Never put an account, device, relay or board secret in the task cache. It must not be able to
  tell which Taskify identity asked for an event.
