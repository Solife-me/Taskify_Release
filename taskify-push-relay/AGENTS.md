# AGENTS.md

This is the StartOS package for Taskify's push relay. The application source and protocol tests
live in the sibling `push-relay/` package. `startos/` pins its published multi-architecture image.

- Run `npm test`, `npm run check` and `npm run build`. Packing needs `make`, with `start-cli`
  installed. Application changes and tests belong in `../push-relay`.
- The relay image is published when a new `../push-relay/package.json` version is merged to
  `main`; the workflow then tags it `push-relay-v<version>`.
- Change the image pin only after the exact public tag exists with both architectures. Keep
  package revisions after the colon for package-only changes to the same relay version.
