#!/usr/bin/env bash
# sync-verify.sh — the upstream sync's gate on the merged oml. Commits what an
# agent left in the tree, runs FORMAT_CMD and commits what it regenerated or
# formatted, then BUILD_CMD and TEST_CMD (.github/omp-build.sh). The build may
# not change tracked files. Output also goes to $RUNNER_TEMP/verify.log.
set -euo pipefail
: "${TAG:?}" "${RUNNER_TEMP:?}"
exec > >(tee "$RUNNER_TEMP/verify.log") 2>&1
# shellcheck disable=SC1091
source .github/omp-build.sh
commit() {
	git add -A
	git diff --cached --quiet || { git commit -q -m "$1" && git show --stat --oneline HEAD; }
}
if [ "$(ulimit -Sn)" != unlimited ] && [ "$(ulimit -Sn)" -lt 65536 ]; then ulimit -Sn 65536 || true; fi
commit "Fix oml after merging upstream $TAG"
eval "$FORMAT_CMD"
commit "Regenerate and format after merging upstream $TAG"
eval "$BUILD_CMD"
eval "$TEST_CMD"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	echo "the build changed tracked files:" >&2
	git status --short --untracked-files=no >&2
	exit 1
fi
