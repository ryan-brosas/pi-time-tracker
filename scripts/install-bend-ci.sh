#!/usr/bin/env bash
# Isolated Linux x64 CI compiler, never an upgrade of the user's Bend installation.
set -euo pipefail

version=2.0.31
sha256=f7dbecc8ef5991fe15d9953b8b33911bc62a120c735e2e5902aa031e22055bad
# Digest verified against the official install.sh and the GitHub release asset.
url="https://github.com/bendlang/bend/releases/download/v${version}/bend-${version}-linux-x64.tar.gz"
destination=${1:?Usage: bash scripts/install-bend-ci.sh NEW_DIRECTORY}
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'This CI installer supports Linux x64 only.' >&2
  exit 1
fi
if [[ -e $destination ]]; then
  echo 'Refusing to replace an existing Bend directory.' >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --max-time 120 "$url" -o "$tmp/bend.tar.gz"
printf '%s  %s\n' "$sha256" "$tmp/bend.tar.gz" | sha256sum --check --status
mkdir -p "$destination"
tar -xzf "$tmp/bend.tar.gz" -C "$destination" --strip-components=1
export BEND_NO_TELEMETRY=1
"$destination/bin/bend" version
