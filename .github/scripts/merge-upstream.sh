#!/usr/bin/env bash
# merge-upstream.sh [repo] — merge $TAG into the current branch (oml). Does not push.
#
# Prints `status=ancestor|clean|conflict|format` and `sha=<head>`.
# Conflict and format write $FAILURE (default ./failure.json) and exit 2.
# An in-progress merge is resumed: foreign .github/workflows/* resolve to
# deleted (modify/delete and additions); a resolved merge is committed as
# `Merge upstream <tag> into oml`. Ours stay: $OURS_WORKFLOWS.
#
# $FORMAT_CMD, when set, runs after a merge commit (and on an ancestor, so a
# second call can check formatting). A dirty tree or a failing command is
# status=format; the follow-up is not committed here.
# Changelog files use changelog-merge beside this script, not merge=union.
set -euo pipefail

repo="${1:-.}"
tag="${TAG:?TAG required}"
failure="${FAILURE:-$repo/failure.json}"
ours="${OURS_WORKFLOWS:-omp-sync.yml omp.yml}"
changelog_glob="${CHANGELOG_GLOB:-packages/*/CHANGELOG.md}"
format_cmd="${FORMAT_CMD:-}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "merge-upstream: bad tag '$tag'" >&2; exit 1; }

cd "$repo"
git rev-parse --is-inside-work-tree >/dev/null
git config user.name >/dev/null 2>&1 || git config user.name "omp auto-integration"
git config user.email >/dev/null 2>&1 || git config user.email "omp-auto@users.noreply.github.com"

here="$(cd "$(dirname "$0")" && pwd)"
if [ -n "$changelog_glob" ] && [ -x "$here/changelog-merge" ]; then
	export GIT_CONFIG_COUNT=1
	export GIT_CONFIG_KEY_0=merge.integration-changelog.driver
	export GIT_CONFIG_VALUE_0="$here/changelog-merge %O %A %B"
	attr="$(git rev-parse --git-path info/attributes)"
	mkdir -p "$(dirname "$attr")"
	grep -qxF "$changelog_glob merge=integration-changelog" "$attr" 2>/dev/null ||
		echo "$changelog_glob merge=integration-changelog" >> "$attr"
fi

ours_has() {
	local w
	for w in $ours; do
		[ "$w" = "$1" ] && return 0
	done
	return 1
}

write_failure() { # reason log [conflicts...]
	local reason="$1" log="$2"
	shift 2
	python3 -c '
import json, sys
path, tag, reason, log, *conflicts = sys.argv[1:]
with open(path, "w") as fh:
    json.dump({"step": "merge", "tag": tag, "reason": reason, "log": log, "conflicts": conflicts}, fh, indent=2)
    fh.write("\n")
' "$failure" "$tag" "$reason" "$log" "$@"
}

emit() { # status
	echo "status=$1"
	echo "sha=$(git rev-parse HEAD)"
}

run_format() {
	[ -n "$format_cmd" ] || return 0
	local log err=0
	log="$(mktemp)"
	if ! ( eval "$format_cmd" ) >"$log" 2>&1; then
		err=1
	fi
	if [ "$err" -ne 0 ] || [ -n "$(git status --porcelain)" ]; then
		write_failure format "$(tail -n 80 "$log")"
		rm -f "$log"
		emit format
		exit 2
	fi
	rm -f "$log"
}

drop_foreign_workflows() {
	local f base
	local -a unmerged=() tracked=()
	mapfile -t unmerged < <(git diff --name-only --diff-filter=U)
	for f in "${unmerged[@]}"; do
		[ -n "$f" ] || continue
		echo "merge-upstream: unmerged $f" >&2
		case "$f" in
			.github/workflows/*)
				base="${f##*/}"
				if ours_has "$base"; then
					git checkout --ours -- "$f"
					git add -- "$f"
				else
					git rm -f -- "$f" >/dev/null
				fi
				;;
		esac
	done
	mapfile -t tracked < <(git ls-files -- .github/workflows)
	for f in "${tracked[@]}"; do
		base="${f##*/}"
		ours_has "$base" || git rm -f -- "$f" >/dev/null
	done
}

merge_head="$(git rev-parse --git-path MERGE_HEAD)"
if [ ! -f "$merge_head" ] && git merge-base --is-ancestor "$tag" HEAD; then
	run_format
	emit ancestor
	exit 0
fi

if [ ! -f "$merge_head" ]; then
	git merge --no-ff --no-commit -m "Merge upstream $tag into oml" "$tag" >/dev/null 2>&1 || true
fi
if [ ! -f "$merge_head" ]; then
	echo "merge-upstream: merge of $tag did not start" >&2
	exit 1
fi

drop_foreign_workflows
mapfile -t still < <(git diff --name-only --diff-filter=U)
if [ "${#still[@]}" -gt 0 ]; then
	write_failure conflict "unmerged: ${still[*]}" "${still[@]}"
	emit conflict
	exit 2
fi

git commit -q -m "Merge upstream $tag into oml"
run_format
emit clean
exit 0
