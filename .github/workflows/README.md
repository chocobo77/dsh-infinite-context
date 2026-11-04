# CI — the three gates (typecheck / test / build)

The plugin's test suite imports its HOST packages (`@deepseek-ai/*`) from a
DSH checkout, and that checkout is a **local source snapshot without a public
repository** — a plain GitHub runner cannot provision it. The gates therefore
run where a checkout exists (the two dev machines, via the `pre-push` hook and
`npm run verify`), and this workflow exists for the case where a runner CAN
see one:

## Provisioning a runner

1. Push the DSH source snapshot to a **private** repository (it must contain
   the built libs under `packages/*/lib` and `vendor/*/lib`, exactly like the
   install layout).
2. Set the repository variable `DSH_CHECKOUT_REPO` (and optionally
   `DSH_CHECKOUT_REF`, default `master`), plus `DSH_CHECKOUT_TOKEN` if the
   snapshot repo is private.
3. Re-run this workflow. The job clones the snapshot to `${{ github.workspace }}/dsh`,
   exports `DSH_CHECKOUT` (which `vitest.config.ts` honors), and rewrites
   `tsconfig.typecheck.json`'s absolute candidates to the snapshot path.

Without `DSH_CHECKOUT` the job fails fast with a notice instead of faking a
green run: the suite cannot execute against host packages that are not there.

## Why the typecheck config is committed with absolute path candidates

`tsconfig.typecheck.json` resolves the host packages through a candidates
list tried in order: `DSH_CHECKOUT` env-aware relative paths, then the two
operators' own checkout locations (Windows `D:/…`, Ubuntu `~/.local/…`). CI
exports `DSH_CHECKOUT`; a dev machine hits its own candidate. Extra machines
append their candidate rather than editing the existing ones.
