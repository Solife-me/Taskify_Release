# Updating

## Determining the upstream version

The relay is Taskify's own service. Its source and application version live in sibling package
`../push-relay`. This directory contains only the StartOS package and pins a published image.

## Applying the bump

1. Set the new version in `../push-relay/package.json`, then regenerate that lockfile.
2. Push `push-relay-v<relay version>` and confirm the workflow publishes a public amd64/arm64
   manifest. Never point the package at an image that does not exist yet.
3. Pin that exact tag in `startos/manifest/index.ts`.
4. Set `version` in `startos/versions/current.ts` to `<relay version>:0`. For a package-only
   change on the same relay version, raise the revision after the colon instead. Edit the file in
   place: a new file under `startos/versions/` is only for a version whose migration does work.
5. Write `releaseNotes` for this release alone: what changed, and anything the update asks of the
   operator.
6. Pin Node in both `FROM` lines in `../push-relay/Dockerfile` to the same release as its
   `engines` range.
