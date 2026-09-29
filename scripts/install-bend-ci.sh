#!/usr/bin/env bash
# Isolated Linux x64 CI compiler plus the matching build-time source, never an
# upgrade of the user's Bend installation. Versions and digests come from
# scripts/bend-toolchain.json so the pin has one owner.
set -euo pipefail

destination=${1:?Usage: bash scripts/install-bend-ci.sh NEW_DIRECTORY}
config=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bend-toolchain.json
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'This CI installer supports Linux x64 only.' >&2
  exit 1
fi
if [[ -e $destination ]]; then
  echo 'Refusing to replace an existing Bend directory.' >&2
  exit 1
fi

# Bun ships with the project toolchain; it reads the pin without a second copy.
read -r version binary_url binary_sha source_url source_sha < <(BEND_PIN="$config" bun -e 'const c = await Bun.file(process.env.BEND_PIN).json(); console.log([c.version, c.binaryUrl, c.binarySha256, c.sourceUrl, c.sourceSha256].join(" "));')

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch() { curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --max-time 180 "$1" -o "$2"; }
fetch "$binary_url" "$tmp/bend.tar.gz"
printf '%s  %s\n' "$binary_sha" "$tmp/bend.tar.gz" | sha256sum --check --status || { echo 'Bend binary archive failed its checksum' >&2; exit 1; }
fetch "$source_url" "$tmp/bend-source.tar.gz"
printf '%s  %s\n' "$source_sha" "$tmp/bend-source.tar.gz" | sha256sum --check --status || { echo 'Bend source archive failed its checksum' >&2; exit 1; }

mkdir -p "$destination/source"
tar -xzf "$tmp/bend.tar.gz" -C "$destination" --strip-components=1
tar -xzf "$tmp/bend-source.tar.gz" -C "$destination/source" --strip-components=1
export BEND_NO_TELEMETRY=1 BEND_NO_UPDATE=1
found=$("$destination/bin/bend" version 2>&1)
if [[ $found != *"$version"* ]]; then
  echo "Expected Bend $version but found: $found" >&2
  exit 1
fi
echo "$found (source: $destination/source)"
