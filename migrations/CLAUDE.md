# Migrations

## Adding a Migration

1. Write `migrations/<YYYYMMDDNNNN>-<slug>.ts` in the same commit as the change it cleans up after, exporting `up(context)`.
2. Add an `EXPIRES: <date>` comment, set to when every machine will have run `scripts/install` since the change. `scripts/lint-expired` fails the `lint` job when the marker is missing and again once the date passes. It is not a pre-commit hook, so a local commit passes either way.
3. Export `platform = "darwin"` or `"linux"` when the work applies to one platform only.
4. Add `migrations/<same-name>.test.ts` that drives `up` against a sandbox home.

When an `EXPIRES:` date passes, delete the migration file. Deleting one is safe at any time.

## Writing `up`

- Read every path from `context` (`home`, `config`, `data`, `applications`, `root`, `installed`), never from the environment.
- Use `removeCask` for a cask. `removeFormula` checks `brew list` without `--cask` and treats every cask as already gone.
- `removeTree` removes only paths under `context.home`, `context.config`, or `context.data`. Call `node:fs` yourself for anything else.
- Before removing a symlink, check `ownedLink`, so a link someone repointed survives. Before removing a directory, check `isEmpty`.
- Never escalate to root. When removing an app under `context.applications` or running `mas uninstall` needs root, report the path to remove by hand and return without throwing.
- Make `up` safe to rerun. A failure stops the run without stamping the version, and the next install retries it.
- Expect `up` never to run on a fresh machine. The runner stamps the latest version there, so convergence must handle a fresh install on its own.

## Ordering

`scripts/install` runs migrations after `brew bundle` and before `scripts/install-symlinks`. A cleanup that must happen before `brew bundle` reads the Brewfile cannot be a migration, as with `scripts/install-cask-variants`. A migration can clear a path so a new link can be laid there.
