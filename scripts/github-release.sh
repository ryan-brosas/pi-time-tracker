#!/usr/bin/env bash
# Called only after npm publishing succeeds. Never move a tag or overwrite a release.
set -euo pipefail

: "${GH_REPO:?repository is required}" "${GITHUB_SHA:?release commit is required}"
: "${RELEASE_VERSION:?version is required}" "${RELEASE_TARBALL:?tarball path is required}"
if [[ ! -f "$RELEASE_TARBALL" ]]; then
  echo "Release tarball is missing: $RELEASE_TARBALL" >&2
  exit 1
fi

tag="v$RELEASE_VERSION"
# --target is ignored for an existing tag. Check its peeled commit first; a
# failed lookup must not look like an absent tag (pipefail propagates it).
tag_sha=$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}" | tail -n 1 | cut -f 1)
if [[ -n "$tag_sha" && "$tag_sha" != "$GITHUB_SHA" ]]; then
  echo "Tag $tag points to another commit; refusing to release $GITHUB_SHA under it." >&2
  exit 1
fi

flags=(--latest)
if [[ "$RELEASE_VERSION" == *-* ]]; then flags=(--prerelease --latest=false); fi
gh release create "$tag" "$RELEASE_TARBALL" \
  --repo "$GH_REPO" \
  --target "$GITHUB_SHA" \
  --title "pi-time-tracker v$RELEASE_VERSION" \
  --generate-notes \
  --notes "npm package: https://www.npmjs.com/package/pi-time-tracker/v/$RELEASE_VERSION. The attached tarball is the package published to npm." \
  "${flags[@]}"
