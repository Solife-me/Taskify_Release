# Updating

## Determining the upstream version

The relay is Taskify's own service. Its source and application version live in sibling package
`../push-relay`. This directory contains only the StartOS package and pins a published image.

## Applying the bump

1. Set the new version in `../push-relay/package.json`, then regenerate that lockfile.
2. Merge that bump to `main`. The `Publish push relay image` workflow publishes the version for
   amd64 and arm64 and tags it `push-relay-v<relay version>`. Confirm the image resolves before
   pinning it (`docker buildx imagetools inspect ghcr.io/solife-me/taskify-push-relay:<version>`).
   Never point the package at an image that does not exist yet.
3. Pin that exact tag in `startos/manifest/index.ts`.
4. Set `version` in `startos/versions/current.ts` to `<relay version>:0`. For a package-only
   change on the same relay version, raise the revision after the colon instead. Edit the file in
   place: a new file under `startos/versions/` is only for a version whose migration does work.
5. Write `releaseNotes` for this release alone: what changed, and anything the update asks of the
   operator.
6. Pin Node in both `FROM` lines in `../push-relay/Dockerfile` to the same release as its
   `engines` range.
