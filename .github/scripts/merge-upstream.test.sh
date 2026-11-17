#!/usr/bin/env bash
# merge-upstream: ancestor skip, --no-ff message, foreign workflows deleted, resume.
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/merge-upstream.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.invalid

git init -q -b main "$tmp/repo"
cd "$tmp/repo"
git config user.name Test
git config user.email test@example.invalid
mkdir -p .github/workflows packages/demo
printf 'base\n' > README.md
printf 'ci\n' > .github/workflows/ci.yml
printf '## [Unreleased]\n\n### Added\n\n- carried\n\n## [1.0.0] - 2026-01-01\n' > packages/demo/CHANGELOG.md
git add .
git commit -qm base
git tag v1.0.0

git checkout -q -b oml
rm .github/workflows/ci.yml
printf 'sync\n' > .github/workflows/omp-sync.yml
printf 'build\n' > .github/workflows/omp.yml
printf '## [Unreleased]\n\n### Added\n\n- carried\n- oml-only\n\n## [1.0.0] - 2026-01-01\n' > packages/demo/CHANGELOG.md
git add -A
git commit -qm 'oml workflows'
oml="$(git rev-parse HEAD)"

out="$(TAG=v1.0.0 "$script")"
[ "$(sed -n 's/^status=//p' <<< "$out")" = ancestor ]
[ "$(git rev-parse HEAD)" = "$oml" ]

git checkout -q main
printf 'upstream readme\n' > README.md
printf 'ci changed\n' > .github/workflows/ci.yml
printf 'new\n' > .github/workflows/new.yml
printf '## [Unreleased]\n\n### Added\n\n- upstream\n\n## [1.0.0] - 2026-01-01\n' > packages/demo/CHANGELOG.md
git add .
git commit -qm 'v1.1.0'
git tag v1.1.0

git checkout -q oml
out="$(TAG=v1.1.0 "$script")"
[ "$(sed -n 's/^status=//p' <<< "$out")" = clean ]
[ "$(git log -1 --format=%s)" = "Merge upstream v1.1.0 into oml" ]
[ "$(git rev-parse HEAD^1)" = "$oml" ]
[ "$(git rev-parse HEAD^2)" = "$(git rev-parse v1.1.0)" ]
[ "$(cat README.md)" = "upstream readme" ]
[ ! -e .github/workflows/ci.yml ]
[ ! -e .github/workflows/new.yml ]
[ -e .github/workflows/omp-sync.yml ]
grep -q '^- oml-only$' packages/demo/CHANGELOG.md
grep -q '^- upstream$' packages/demo/CHANGELOG.md

git checkout -q main
printf 'tag side\n' > README.md
printf 'ci again\n' > .github/workflows/ci.yml
git add .
git commit -qm 'v1.2.0'
git tag v1.2.0
git checkout -q oml
printf 'oml side\n' > README.md
git add README.md
git commit -qm 'oml readme'
set +e
out="$(TAG=v1.2.0 "$script" 2>"$tmp/err")"
st=$?
set -e
[ "$st" -eq 2 ]
[ "$(sed -n 's/^status=//p' <<< "$out")" = conflict ]
grep -q README.md "$tmp/repo/failure.json"
[ ! -e .github/workflows/ci.yml ]
printf 'resolved\n' > README.md
git add README.md
out="$(TAG=v1.2.0 "$script")"
[ "$(sed -n 's/^status=//p' <<< "$out")" = clean ]
set +e
out="$(TAG=v1.2.0 FORMAT_CMD='printf formatted >> README.md' "$script")"
st=$?
set -e
[ "$st" -eq 2 ]
[ "$(sed -n 's/^status=//p' <<< "$out")" = format ]
grep -q formatted README.md
[ "$(git log -1 --format=%s)" = "Merge upstream v1.2.0 into oml" ]

echo "PASS: merge-upstream ancestor, workflows deleted, resume, format"
