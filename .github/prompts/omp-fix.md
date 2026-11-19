# Fix oml after an upstream merge

You run unattended in GitHub Actions. Nobody will answer.

The checkout is `ompweb-dev/oh-my-pi` on `oml`, with the upstream (`can1357/oh-my-pi`) release below merged and committed. Dependencies are installed and the release's native addon is in `packages/natives/native`; do not delete it.

The sync's gate failed. `.github/scripts/sync-verify.sh` runs, from `.github/omp-build.sh`, `FORMAT_CMD` (generation and formatting), `BUILD_CMD` (natives, `bun check`, binary, smoke test) and `TEST_CMD`. The tail of its log is below.

Find the cause and fix it at its source. Usually oml's carried changes (patches, `packages/ompweb-runner`) no longer fit an API the release changed: adapt oml's code to the release, keeping the carried behavior. Re-run the failing command to confirm, then run `.github/scripts/sync-verify.sh` (it commits your changes, which is fine).

## Do not

- Push, open issues or pull requests, or edit `.github/`.
- Run `bun run gen:models`: it queries providers live and rewrites the catalog. `bun run gen:compat` is offline and fine.
- Delete, skip or weaken a test, drop one from `TEST_CMD`, or edit a test to match broken behavior. If a carried test fails because the release changed the behavior it covers on purpose, adapt the carried code; when that is impossible, stop and say so.
- Rewrite or amend existing commits.

End with a short summary: what failed, why, and what you changed.
