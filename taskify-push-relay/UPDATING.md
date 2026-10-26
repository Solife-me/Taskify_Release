# Updating

## Determining the upstream version

The relay is Taskify's own service: its source is `src/` in this directory, in the
`Solife-me/Taskify_Release` repository, not a published image. Its version is `version` in
`package.json`. A change to `src/` that ships is a new relay version, decided with the change.

## Applying the bump

1. Set the new version in `package.json`, then run `npm install` so `package-lock.json` records it.
2. Set `version` in `startos/versions/current.ts` to `<relay version>:0`. For a package-only
   change on the same relay version, raise the revision after the colon instead. Edit the file in
   place: a new file under `startos/versions/` is only for a version whose migration does work.
3. Write `releaseNotes` for this release alone: what changed, and anything the update asks of the
   operator.
4. The image is built from this directory's `Dockerfile` (`dockerBuild` in
   `startos/manifest/index.ts`), so there is no tag to move. Pin Node in both `FROM` lines to the
   same release as the `engines` range in `package.json`.
