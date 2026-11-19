#!/usr/bin/env bash
# sync-merge-check.sh — commits an agent's resolution of the merge of $TAG.
# Refuses leftover conflict markers in the files that conflicted ($FAILURE's
# `conflicts`), stages the tree and lets merge-upstream.sh commit the merge.
# Exits 0 once $TAG is merged into HEAD.
set -euo pipefail
: "${TAG:?}" "${FAILURE:?}"
mapfile -t conflicts < <(jq -r '.conflicts[]' "$FAILURE")
bad=0
for f in "${conflicts[@]}"; do
	[ -f "$f" ] || continue
	if grep -nE '^(<<<<<<<|>>>>>>>)( |$)' -- "$f"; then
		echo "conflict markers left in $f" >&2
		bad=1
	fi
done
[ "$bad" -eq 0 ] || exit 1
git add -A
out="$(FAILURE="$RUNNER_TEMP/merge-check.json" "$(dirname "$0")/merge-upstream.sh")" || true
printf '%s\n' "$out"
case "$(sed -n 's/^status=//p' <<< "$out")" in
	clean | ancestor) ;;
	*) exit 1 ;;
esac
