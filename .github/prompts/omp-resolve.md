# Resolve an upstream merge into oml

You run unattended in GitHub Actions. Nobody will answer.

The checkout is `ompweb-dev/oh-my-pi` on `oml`, in the middle of `git merge --no-ff --no-commit <tag>`, where `<tag>` is the upstream (`can1357/oh-my-pi`) release below. Dependencies are installed and the release's native addon is in `packages/natives/native`; do not delete it.

Resolve every unmerged path listed below so that oml keeps its carried behavior and takes the release's changes. Read both sides (`git diff`, `git log --oneline --merge -- <path>`, `git show <tag>:<path>`) before you choose.

When you finish, no conflict markers may remain. Do not commit, abort or restart the merge: the workflow stages and commits your resolution, then formats, builds and tests it, and gives any failure to a later round.

## Do not

- Push, open issues or pull requests, or edit `.github/`.
- Restore a deleted `.github/workflows/*` file or add an upstream workflow. Only `omp-sync.yml` and `omp.yml` stay.
- Run `bun run gen:models`: it queries providers live and rewrites the catalog to whatever they list today. For a `packages/catalog/src/models.json` conflict, take the release's file (`git checkout --theirs`), then re-add each model oml added over the previous upstream tag, decoding and re-encoding with `openModelCatalog` and `encodeModelCatalog` (`packages/catalog/src/model-catalog-format.ts`). Re-encoding the release's catalog unchanged must reproduce it byte for byte.
- Delete, skip or weaken a test, or edit a test to match broken behavior.

End with a short summary: each conflicted file and how you resolved it.
