#!/usr/bin/env bash
# release-natives.sh — installs the native addon of upstream release TAG into
# packages/natives/native/ for the sync's format and repair steps.
#
# Taken from the release's omp-linux-x64 binary, which embeds the addon: npm
# gets the pi-natives packages minutes after the GitHub release is published,
# while the release assets are there from the start. The binary extracts the
# addon variant this CPU selects into PI_NATIVES_DIR/<version>/ when it loads.
set -euo pipefail
: "${TAG:?}" "${UPSTREAM:?}" "${RUNNER_TEMP:?}"
dir="$RUNNER_TEMP/release-natives"
rm -rf "$dir"
mkdir -p "$dir/natives"
gh release download "$TAG" -R "$UPSTREAM" -D "$dir" -p omp-linux-x64 -p SHA256SUMS.txt
(cd "$dir" && grep -E ' \*?omp-linux-x64$' SHA256SUMS.txt | sha256sum -c -)
chmod +x "$dir/omp-linux-x64"
HOME="$dir/home" PI_NATIVES_DIR="$dir/natives" "$dir/omp-linux-x64" --smoke-test >/dev/null
shopt -s nullglob
addons=("$dir/natives"/*/*.node)
[ "${#addons[@]}" -gt 0 ] || { echo "no addon extracted from omp-linux-x64 $TAG" >&2; exit 1; }
mkdir -p packages/natives/native
cp "${addons[@]}" packages/natives/native/
printf 'native addon: %s\n' "${addons[@]##*/}"
