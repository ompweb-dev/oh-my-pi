# Repair an upstream merge into oml

You run unattended in GitHub Actions. Nobody will answer. Finish the merge or stop and explain why.

`failure.json` (`step` is `merge`):

- `tag`: upstream release to merge, already fetched
- `reason`: `conflict` (unmerged paths in `conflicts`) or `format` (`FORMAT_CMD` failed or changed files)
- `log`: tail of the failing output

## Layout

`$GITHUB_WORKSPACE` is `ompweb-dev/oh-my-pi` on `oml`, remotes `origin` (this fork) and `upstream` (`can1357/oh-my-pi`). `TAG` is set. The release's native addon is already in `packages/natives/native`; do not delete it.

`.github/omp-build.sh` defines `FORMAT_CMD` (`bun install --frozen-lockfile >/dev/null && bun run gen:compat && bun run fmt:tools`).

## What to do

Run the script with `FORMAT_CMD` set, as the workflow checks it: `source .github/omp-build.sh && FORMAT_CMD="$FORMAT_CMD" .github/scripts/merge-upstream.sh`. It merges `$TAG` with `--no-ff` and deletes every `.github/workflows/*` that is not `omp-sync.yml` or `omp.yml`. Modify/delete conflicts on those files stay deleted. Do not restore them and do not add an upstream workflow.

- `conflict`: resolve the listed files so oml keeps its carried behavior and takes the release's changes. Do not commit. Re-run the script; it commits `Merge upstream <tag> into oml`.
- `format`: the merge is committed. Run `eval "$FORMAT_CMD"`, fix whatever makes it fail, and commit the result as a follow-up. Do not amend the merge commit.

Re-run the script (with `FORMAT_CMD`) until it prints `status=ancestor`. It reports `status=format` after a resolved conflict too, when the merged tree is not formatted.

## Do not

- Push, open issues or pull requests, or edit `.github/` except to keep foreign workflow files deleted.
- Rebase or push a pull-request branch. A patch reaches oml only as a commit on oml. Closing an upstream PR does not remove it; that takes an explicit revert on oml.
- Delete, skip, or weaken a test, and do not edit a test to match broken behavior.

Write `$RUNNER_TEMP/repair-notes.md` before you exit: what stopped, what you changed, and why. If you cannot finish, write why there and exit non-zero.
