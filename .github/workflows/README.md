# CI — the two gates (typecheck / build)

The plugin's sources import their HOST packages (`@deepseek-ai/*`) from a
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
   exports `DSH_CHECKOUT` (which `tsconfig.base.json` candidates honor), and rewrites
   the absolute candidates to the snapshot path.

Without provisioning the job fails fast with a notice instead of faking a
green run: the sources cannot be checked against host packages that are not
there.

## Why the base config is committed with absolute path candidates

`tsconfig.base.json` resolves the host packages through a candidates list
tried in order: the two operators' own checkout locations (Windows `D:/…`,
Ubuntu `~/.local/…`). CI rewrites them with `sed`; extra machines append
their candidate rather than editing the existing ones.

## Test suite

The vitest suite was removed from the repository on 2026-11-14 (operator
decision; the regression asset lives in git history up to and including
tag `v0.9.8` — `git checkout v0.9.8 -- tests/ vitest.config.ts` restores it
along with the vitest devDependency). `verify` is typecheck + build.
