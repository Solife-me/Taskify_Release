# AGENTS.md

This is the StartOS package for Taskify's push relay. The application source and protocol tests
live in the sibling `push-relay/` package. `startos/` pins its published multi-architecture image.

- Run `npm test`, `npm run check` and `npm run build`. Packing needs `make`, with `start-cli`
  installed. Application changes and tests belong in `../push-relay`.
- A maintainer publishes a relay image from `push-relay/` by pushing the exact tag
  `push-relay-v<../push-relay/package.json version>`. The workflow tests the relay and publishes
  both amd64 and arm64 to GHCR. Agents never create or push that tag.
- Change the image pin only after the exact public tag exists with both architectures. Keep
  package revisions after the colon for package-only changes to the same relay version.
