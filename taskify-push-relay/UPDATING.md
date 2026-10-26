# Updating

## Determining the upstream version

The relay is Taskify's own service: its source is `src/` in this directory, in the
`Solife-me/Taskify_Release` repository. Its version is `version` in `package.json`. A change to
`src/` that ships is a new relay version, decided with the change.

## Applying the bump

1. Set the new version in `package.json`, then run `npm install` so `package-lock.json` records it.
2. Set `version` in `startos/versions/current.ts` to `<relay version>:0`. For a package-only
   change on the same relay version, raise the revision after the colon instead. Edit the file in
   place: a new file under `startos/versions/` is only for a version whose migration does work.
3. Write `releaseNotes` for this release alone: what changed, and anything the update asks of the
   operator.
4. Pin Node in both `FROM` lines to the same release as the `engines` range in `package.json`.
5. After the version commit reaches GitHub, a maintainer pushes the exact tag
   `push-relay-v<relay version>`. `.github/workflows/push-relay-image.yml` tests the relay and
   publishes linux/amd64 and linux/arm64 as
   `ghcr.io/solife-me/taskify-push-relay:<relay version>`.
6. Confirm the GHCR package is public and `docker manifest inspect` lists both architectures.
   New GHCR packages can begin private.

The StartOS package still builds from this directory's `Dockerfile`. Once the first published
image is confirmed public, C13-7a moves the application to `push-relay/` and changes the package
to a pinned `dockerTag` in one commit, so there is never a duplicated source tree or a package that
cannot build.
