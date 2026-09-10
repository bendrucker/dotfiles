# CLAUDE.md - Dotfiles Repository

This is a personal dotfiles repository for macOS with Linux compatibility. The repo uses a topic-based organization structure for shell configuration, tools, and application settings.

## Repository Structure

- **bin/**: Executable scripts added to `$PATH`
- **topic/**: Each topic is a directory (e.g., `git/`, `zsh/`, `docker/`)
  - `*.zsh`: Shell configuration files loaded by zsh
  - `path.zsh`: Loaded first for `$PATH` setup
  - `completion.zsh`: Deferred until after first prompt renders (via `precmd` hook)
  - `install.sh`: Topic installer for non-symlink setup (e.g., plugin managers, system config)
  - `reload.sh`: Tells an already-running program to re-read its config (see [Config Reloads](#config-reloads))
  - `Brewfile`: Homebrew packages for the topic
- **`*/symlinks.conf`**: Per-topic declarative symlink maps (`source:target`) discovered and processed by `scripts/install-symlinks`
- **scripts/**: Bootstrap and setup scripts
- **packages/**: Shared TypeScript, imported by specifier rather than by relative path
- **scripts/shell/**: The POSIX shell libraries that run before bun exists

### Shared Modules

`packages/` holds the TypeScript that `bin/` scripts and tests have in common. The root `package.json` maps each one to a subpath specifier, so an import names `#jobs/report` instead of counting `../` up from wherever it sits.

| Specifier | What it holds |
| --- | --- |
| `#harness` | The `bun test` harness for driving shell scripts |
| `#history-secrets` | The commands the two history filters must drop, and the ordinary ones they must keep |
| `#jobs/*` | What the unattended jobs share: output capture, failure reporting, the sync gate, canonical JSON |
| `#migrations/*` | What a one-time migration is, and the runner behind `bin/dotfiles-migrate` |
| `#worktree/*` | Worktrunk state, forge queries, column alignment |
| `#plugins` | The installed Claude Code plugins |

Bun resolves `imports` from the root `package.json` alone, so a specifier resolves with no `node_modules` and no install step. That is what keeps this compatible with the 3am jobs, which run `$HOME/.dotfiles/bin/*` under bun straight from a fast-forwarded clone. `bun.lock` covers the one devDependency in [Linting TypeScript](#linting-typescript), which no script imports, so a clone nothing has installed into still runs every one of them. Adding a runtime dependency to one of these modules would mean the job could not import it until something had installed it, so `#jobs/*`, `#migrations/*`, and everything `bin/dotfiles-sync` reaches stays dependency-free.

`scripts/shell/` is the floor underneath. `spin.sh`, `git-sync.sh`, `symlinks.sh`, and `cask-variants.sh` are sourced by `scripts/setup` and `bin/dotf` before bun or gum are installed, so they are POSIX sh sourced by relative path rather than modules resolved by specifier.

### Linting TypeScript

oxlint is the repo's one devDependency, pinned in `package.json` and tracked by Renovate's bun manager like any other. The `lint` job and the pre-commit hook both run `bun install --frozen-lockfile` before `scripts/lint-ts --deny-warnings`.

That install is what makes the pin real. `scripts/lint-ts` spawns `node_modules/.bin/oxlint` and stops with the path it wanted when nothing is there. A bare `bunx oxlint` instead fetches the latest release and ignores the version in `package.json` without saying so, which is a silent wrong-version run rather than a failure, and it spends a few hundred milliseconds re-resolving the package on every call.

`.oxlintrc.json` runs the `correctness` category plus a `no-restricted-imports` rule that rejects a path-shaped import of anything under `packages/`. That rule is what makes the specifier table above a boundary rather than a convention, since a deep relative path into another package now fails the build.

`Bun.stripANSI` is what strips escape sequences from a child's output, as `zsh/zprof/zprof-format.ts` does. Use a hand-rolled regex only to strip something narrower, the way `bin/dotfiles-upgrade` keeps OSC title text a reader wants while dropping CSI. That regex holds a literal ESC, so it needs an `oxlint-disable-next-line no-control-regex`. Turning the rule off repo-wide instead would cover three deliberate patterns at the cost of every accidental control character.

#### Size and Complexity

`.oxlintrc.json` also caps `complexity`, `max-depth`, `max-params`, `max-statements`, `max-lines-per-function`, and `max-lines`. Every threshold sits just above what the tree already contains, so the gate keeps the line where the code sits instead of asking for a refactor. `max-depth` and `max-params` sit exactly on it, at 4 and 5, so those two fail on any increase at all. Measure the tree's distribution before tightening one, rather than reaching for the next round number down.

A `**/*.test.ts` override turns off `max-lines`, `max-lines-per-function`, and `max-statements`. Those three measure the `describe` block, which is a container for cases rather than a function, so a test file grows as it covers more. `complexity`, `max-depth`, and `max-params` stay on there, since they measure the helpers inside a case.

Two functions are over a threshold and carry an `oxlint-disable-next-line` naming why. `forgePass` in `bin/wt-prune` is at complexity 31, and `main` in `bin/clone-repo` at complexity 27 and 54 statements. Both are wide rather than deep: a decision table in one, a run of flag handlers in the other. The count comes from the number of arms, and no single arm is hard to read. Everything else clusters at or below 17 and 37. Splitting either is its own change.

#### Linting the `bin/` Executables

oxlint discovers files by extension, so the `bin/` executables are invisible to it: they carry a `#!/usr/bin/env bun` shebang and no `.ts` suffix, and naming one on the command line reports no files to lint. Since they hold the largest TypeScript in the repo, the `lint` job and the pre-commit hook run `scripts/lint-ts` instead of `oxlint` directly. It symlinks each one into `tmp/lint-ts/` under a `.ts` name and lints that mirror against the same config. The mirror paths in the output are then mapped back to the real ones, so a diagnostic names the executable rather than the link, and a CI annotation lands on the right line.

The ordinary pass takes an `--ignore-pattern` for the mirror root, which is what keeps it from linting the links a second time as source. A config ignore or a `tmp/` line in `.gitignore` would not do, because both reach the mirror pass too, where a path oxlint ignores stays ignored even when named on the command line. Each run mirrors into its own directory under that root, so a hand run overlapping a pre-commit one cannot delete the links the other is reading. The mirror lives inside the repo rather than under `$TMPDIR` because the `github` formatter emits an annotation only for a path it can make relative to the working directory.

The pre-commit hook keys on `files:` rather than `types: [ts]`. The `identify` library tags an extensionless bun executable as `executable` and nothing more, so a `types`-keyed hook never fires on a change to one. The pattern matches any extensionless path rather than the two directories that hold one today, since the shebang is what decides which of them get mirrored and a directory prefix in the hook would be a second answer to that. It over-fires on a `Brewfile`, which costs one run of a linter that takes under half a second.

Nothing here finds an unused export across the `#`-specifier modules. oxlint 1.82.0 does not implement `import/no-unused-modules`, `no-unused-vars` reaches only within a file, and every candidate that would close the gap is a new dependency.

## Common Tasks

### Adding a New Tool/Topic

1. Create directory: `mkdir <topic>/`
2. Add configuration files as needed:
   - `<topic>/<tool>.zsh` for shell configuration
   - Add a `symlinks.conf` in the topic directory for config files targeting `~/.config/<tool>/`
   - `<topic>/install.sh` only if non-symlink setup is needed (plugin managers, system config)
   - `<topic>/reload.sh` only if the tool holds its config in memory and can re-read it without restarting (see [Config Reloads](#config-reloads))
   - `<topic>/Brewfile` for dependencies
3. Run `scripts/install` to install links and run topic installers

A topic is a subject, not a package. Most new tools do not earn a directory. A tool that amounts to a Brewfile line and a few aliases goes in a file inside an existing topic, named for what it does: `system/ls.zsh` holds the eza aliases, `system/networking.zsh` the dns and ip ones. Use `system/` when nothing more specific fits.

Give a tool its own directory when it has something to put there: config files to symlink, an installer, a `mise.toml`, a spec, or enough shell config that one file stops describing it. Directories are the unit someone scans to learn what this repo manages, so a wall of single-alias topics costs more than it explains.

### Managing Dependencies

- **Homebrew packages**: Add to topic-specific `Brewfile` or main `Brewfile`
- **Language versions**: Add `mise.toml` to the relevant topic directory (e.g., `go/mise.toml`)
- **Build packages**: Use `bin/build-default-packages` script

Homebrew is the default for a new tool. It links into `$HOMEBREW_PREFIX/bin`, a path that survives upgrades and is visible to every process rather than only shells that ran `mise activate`, and `brew bundle` tracks the current release. Use `mise.toml` when the version has to vary by directory, which is what mise resolves per-project: language runtimes and project-pinned tools like `terraform`. Declaring a tool in both is fine. mise's install directories come first on `$PATH`. A mise pin wins where one applies and the Homebrew copy covers everywhere else.

#### Brewfile Aggregation

The root `Brewfile` recursively loads all topic Brewfiles using:

```ruby
Dir.glob(File.join(File.dirname(__FILE__), '*', '**', 'Brewfile')) do |brewfile|
  eval(IO.read(brewfile), binding)
end
```

This means `brew bundle` from the repo root installs everything from all topic Brewfiles. The root Brewfile also conditionally skips casks/MAS in CI and some apps on corporate machines.

The root Brewfile additionally evaluates `~/Brewfile.local` when present. Use it for machine-specific packages (e.g. corporate-mandated tools) so they're managed by `brew bundle` without being flagged by `brew bundle cleanup`. See [Machine-Local Configuration](#machine-local-configuration) for the other `.local` include points.

#### mise Aggregation

Topic directories can contain `mise.toml` files for language/tool versions. The `scripts/install` script auto-discovers these and symlinks them to `~/.config/mise/conf.d/`, where mise merges them alphabetically.

Always pin mise tool versions to exact values (e.g., `"0.9.6"`, not `"latest"`). Renovate tracks `mise.toml` files and auto-merges non-major updates after a 2-week release age delay. Using `"latest"` prevents Renovate from detecting new versions. For tools not available in the mise registry, use the `github:` backend (e.g., `"github:owner/repo" = "1.2.3"`) to install pre-built release binaries.

#### Neovim Plugins

Plugins are declared in `neovim/config/init.lua` with `vim.pack.add` and no `version`, so each tracks its default branch. The pin lives in `neovim/config/nvim-pack-lock.json`. That lockfile is authoritative when present, and `vim.pack` takes every revision from it while ignoring `version`. This is what lets a fresh machine reproduce an existing one.

Updates are manual. Run `:lua vim.pack.update()`, review the confirmation buffer, `:write` to apply, then commit the lockfile diff. Renovate is not a fallback here, because nvim-treesitter publishes no tags on `main` (its tags sit on the diverged `master` branch) and lualine publishes no version tags at all.

Treesitter parsers are built against a specific nvim-treesitter revision. They break when the plugin moves ahead of them. A `PackChanged` autocommand in `neovim/config/lua/config/treesitter.lua` re-runs `treesitter.update()` on every plugin change, and `neovim/neovim.integration.test.ts` asserts that each declared language ends up with a parser that attaches a highlighter.

### Shell Configuration

- **Aliases**: Add to `<topic>/aliases.zsh`
- **Functions**: Add to `<topic>/functions.zsh`
- **PATH modifications**: Add to `<topic>/path.zsh`
- **Completions**: Add to `<topic>/completion.zsh`

### Shell History

Two stores record every command, and each filters secrets with its own engine. `packages/history-secrets.ts` holds the commands both must drop and the ordinary ones both must keep, so a pattern is never fixed in one store and left rotting in the other. Add a case there before adding a pattern anywhere.

atuin is the store that syncs. Its `secrets_filter` is on by default and matches AWS access key ids along with GitHub, GitLab, canonical Slack, Stripe, Netlify, npm and Pulumi tokens. `history_filter` in `atuin/config.toml` carries only what that list misses: a credential named rather than shaped (`FOO_TOKEN=`, `--password`, an `Authorization` header), the `sk-` vendors, and the lowercase spelling of a cloud credential name, which atuin's own case-sensitive patterns walk past.

`zsh/history-secrets.zsh` guards the plaintext copy in `$HISTFILE`, and it carries the whole list because no atuin pattern reaches that file. It cannot cover atuin in return. atuin records from `preexec`, which runs no matter what a `zshaddhistory` hook returns.

### Config File Installation

Most tool configs live under `~/.config/<tool>/` (XDG Base Directory). Symlinks are declared in per-topic `symlinks.conf` files and installed by `scripts/install-symlinks`. Topics with non-symlink setup logic (plugin managers, system config) use `install.sh`.

- Symlinks point to `~/.dotfiles` (the installed copy), **not** the development working tree. Edits in a dev checkout won't take effect until synced unless dev mode is enabled.
- A `source` may be a directory, linking the whole tree in one entry. This is what to use when a tool owns a directory of same-shaped files and you want a new file to go live without another install run. The catch is a tool that writes its own state in there, which lands in the repo too. A `.gitignore` inside the tree narrows what gets tracked. `herdr/plugins/config` mirrors `$XDG_CONFIG_HOME/herdr/plugins/config`, tracks each plugin's `config.toml`, and ignores the rest.
- A real directory sitting at a link target aborts the install with the path named. Move its contents into the repo, remove it, re-run.

### Dev Mode

`dotfiles dev enable` repoints all symlinks (both `$HOME` and `~/.config/`) from `~/.dotfiles` to the current working tree. This lets you test config changes immediately without syncing. Run `dotfiles dev disable` to restore symlinks to `~/.dotfiles`.

### Testing Changes

Config and `.zsh` files are loaded from `~/.dotfiles` by default. Edits in a dev checkout won't take effect without one of these approaches:

- **`dotfiles test`** — replaces the current shell with one using the dev working tree (temporary, session-only)
- **`dotfiles dev enable`** — persistently repoints all symlinks (home and XDG) to the dev working tree and sets a flag so new shells load dev `.zsh` files. Undo with `dotfiles dev disable`.
- **Point the tool at the worktree file** — for a config the tool can reload at runtime, name the worktree path explicitly. A reload that names the installed path follows the symlink to `~/.dotfiles` and picks up the wrong copy.
- Test dependencies: `bin/dotf` installs/updates packages

### Tests

Everything runs under `bun test`. A test sits next to what it covers and is named for it: `scripts/install-trust.test.ts` covers `scripts/install-trust`, `herdr/bin/herdr-flock.test.ts` covers that launcher. Shell scripts and TypeScript modules are tested the same way, so there is one runner and one set of conventions to learn.

`#harness` holds what a test driving a shell script needs: a sandbox to build a fake tree in, executable stubs that shadow a real command while their directory leads `$PATH`, and runners that report a script's status alongside both its streams. `shell()` runs a snippet under bash or zsh, which is how a library function gets called directly. Sourcing inside the snippet is what lets a test redefine one of the library's own functions afterwards and have the redefinition win.

A test's name and where it sits decide which CI job runs it:

- `*.test.ts` run in the `bun` job against a bare checkout. They stub whatever the script under test calls, so nothing they assert depends on the machine.
- `*.integration.test.ts` run in the `bootstrap` job on Linux and macOS, after symlinks are installed and `brew bundle` has run. They read the installed config through its symlinks, which is state only bootstrap produces.
- Tests under `.claude/skills/` run in the `skill-tests` job, whichever suffix they carry, because they need that skill's own dependencies. bun's discovery skips dot directories, so the job names the path with a leading `./` to have it read as a path rather than a filter.
- `scripts/lint-ts.test.ts` runs in the `lint` job, which installs oxlint, and the `bun` job ignores it by path. Its cases spawn the pinned binary. Keeping the `bun` job a bare checkout is what fails a runtime dependency added to a `#`-specifier module, so an install there would cost more than the split does.

An integration test carries no guard that would let it pass on an unbootstrapped machine. Failing there is correct, and the CI job is what decides when it runs. A skip guard is for a genuinely optional dependency, like the font cask that `bin/glyph-scan.integration.test.ts` needs to check a glyph renders.

#### Stubbing a Command for a zsh Script

A test that runs a script from `bin/` and replaces one of its dependencies with a stub has to isolate zsh's startup files. Those scripts use a `#!/usr/bin/env zsh` shebang, and zsh sources `~/.zshenv` on every invocation, non-interactive ones included. `zsh/.zshenv` runs `brew shellenv`, which can put `$HOMEBREW_PREFIX/bin` ahead of the stub directory, so the real command wins and the stub never runs. Point `ZDOTDIR` at an empty directory for the duration of the call. zsh then finds no `.zshenv` and leaves `$PATH` alone.

```ts
run([script, ...args], { cwd: box.dir, path: [box.bin], env: { ZDOTDIR: box.mkdir("empty") } });
```

The shape of this failure is what makes it worth documenting. It passes on a developer machine, where `HOMEBREW_PREFIX` is already exported and `brew shellenv` emits no `PATH` line, and fails in CI, where it does. Prepending to `$PATH` is enough to stub a command for a bash script, so the habit carries over and breaks silently.

### Version Updates

Recent patterns show dependency updates via PRs:
- Update `mise` tool versions in `mise/` directory
- Update Homebrew dependencies in `Brewfile`
- Use commit format: `chore(deps): update dependency <tool> to v<version>`

### Common Commit Patterns

Based on recent history:
- `chore(deps): update dependency <tool> to v<version>` - dependency updates
- `<topic>: <description>` - topic-specific changes (e.g., `mise: add Python 3.12`)
- `fix: <description>` - bug fixes
- `rm <tool>` - removing tools/configurations

### Maintenance

- Keep `Brewfile.lock.json` updated when modifying `Brewfile`
- Test bootstrap script after major changes
- Ensure Linux compatibility outside of `macos/` directory
- Use GitHub Actions for automated testing

## Machine-Local Configuration

This repo is public and installs identically on every machine. Anything specific to one machine or to an employer lives in an untracked `.local` file that the tracked config includes, and nothing in the repo reveals what those files contain. They exist. Assume a tool that shows up heavily in shell history with no topic directory is declared in one of them.

| Include point | Loaded by | What lives there |
| --- | --- | --- |
| `~/.zshenv.local` | `zsh/.zshenv`, last line | Env vars and `$PATH` entries every shell needs, including non-interactive |
| `~/.localrc`, `~/.zshrc.local` | `zsh/.zshrc`, before topic files | Interactive-only shell config |
| `~/Brewfile.local` | root `Brewfile`, last line | Employer-mandated and machine-specific packages |
| `~/.config/git/config.local` | `git/config` `[include]` | Identity, credential helper, per-org `includeIf` identities. Template in `git/config.local.example` |
| `~/.ssh/config.local` | `ssh/config` `Include` | Work hosts, jump hosts, the Secretive `Host *` fallback |

The two zsh hooks load at opposite ends. `~/.zshenv.local` comes after every `path.zsh` and can override `$PATH`. `~/.localrc` and `~/.zshrc.local` come before the topic `.zsh` files, so a topic file wins over anything they set.

Expect work tooling to be absent here: corporate cloud and SSO clients, internal CLIs, VPN clients, org-specific credential helpers. `brew bundle` evaluates `~/Brewfile.local`, so those packages install and upgrade normally and `brew bundle cleanup` leaves them alone.

Never add employer-specific tooling to a topic directory. Machines legitimately differ in what they have on `$PATH`. Before proposing a new topic for something seen in shell history, ask whether it belongs in `~/Brewfile.local` instead.

## Credentials

Coding agents run as this user and read whatever the shell reads, so a mode bit is no barrier to one. What keeps a secret away from an agent is the secret not being on disk: a login keychain the tool talks to, a Secure Enclave key, or an SSO session. Almost everything here already delegates. `gh` and `glab` keep their tokens in the login keychain, Docker in `credsStore`, Terraform through the `keychain` credentials helper, Linear in the system keyring, AWS through SSO with no static keys at all, and SSH through Secretive, whose private halves cannot be read by anything.

`credentials/bin/credential-audit` is what keeps that true of the ones it watches. Its `CREDENTIALS` table covers npm, AWS, `gh`, `glab`, Docker, and the keys under `~/.ssh`. A finding is one line carrying the subject, a verdict, and the remedy that clears it. The verdicts reach past a literal secret to a key held under a passphrase, a mode readable beyond the owner, and a file this run could not open. A credential reached through a symlink is read and reported like any other, and its mode is left to whatever repo owns the target. Silence means every credential in the table delegates. Terraform and Linear delegate as well and sit in no table: a tool absent from it is not thereby safe. It is unexamined, so the entry covering a tool belongs in the same change that installs it.

The audit reports and never removes, for the same reason `scripts/brew-drift` does. A credential in plaintext is either a leftover or the only thing keeping a login alive, and at 3am those are indistinguishable. `--enforce` is the exception, because chmod to `0600` loses nothing. `credentials/install.sh` runs it, so every install tightens what it can. The nightly report afterward carries only what a mode cannot fix. `bin/dotfiles-upgrade` files those through `reportFindings`, latched one credential at a time so a leftover key nobody has dealt with stays quiet while the rest of the set churns around it.

## Sync and Upgrade System

### Automated Nightly Upgrades (macOS)

- `macos/com.user.dotfiles-upgrade.plist` runs `bin/dotfiles-upgrade` daily at 3am
- Syncs dotfiles, runs `scripts/install`, runs `brew cleanup`, reports undeclared packages
- Creates a Things task on failure with error output

### Package Drift

`scripts/brew-drift` prints the Brewfile entries that would declare whatever is installed and declared nowhere. The nightly job runs it after `brew cleanup`, and `report_drift` in `bin/dotfiles-upgrade` files a Things to-do naming what it found. Silence means the machine matches the Brewfile.

`scripts/brew-drift` uninstalls nothing. A package no Brewfile names is either a leftover or something installed deliberately an hour ago that has not been written down yet. At 3am those are the same thing. Removing on that ambiguity loses work no one asked to lose, so the removal stays a decision made awake. Act on a to-do by declaring the package in a topic Brewfile or uninstalling it by hand.

What drift finds is narrower than that. A commit that stops declaring a package carries a migration that uninstalls it (see [Migrations](#migrations)), and `scripts/install` runs migrations well before this check sees the machine, so the leftover half of the ambiguity is handled where the decision was actually made. A finding naming something a Brewfile used to declare means a removal commit shipped without its migration. Fix the commit rather than the machine.

Omitting `--force` does not make `brew bundle cleanup` a dry run. It prints the listing, then asks whether to uninstall, and `--force` only skips the question. `scripts/brew-drift` closes stdin, so the prompt cannot be shown and the command exits 1 with the listing already printed and nothing removed. That is what stops a hand run from uninstalling anything.

`brew bundle cleanup` therefore exits nonzero whenever it printed a listing it could not act on, which is the normal result of a run that found something. `scripts/brew-drift` treats the listing as the signal and the status as decisive only when there is no output at all to read, so it exits 0 on a finding and 1 only when cleanup produced nothing. That is what lets `bin/dotfiles-upgrade` tell a finding apart from a check that could not run.

`brew bundle cleanup` is what decides "undeclared", so the answer accounts for what a hand-rolled comparison gets wrong. `brew list --cask` is the trap: it enumerates the compatibility symlinks Homebrew leaves behind when a cask is renamed, so `docker`, `google-cloud-sdk`, `logi-options-plus`, and `tailscale` all read as installed-but-undeclared while being nothing of the kind. Uninstalling one resolves the alias and takes out the cask that replaced it. Bundle cleanup also spares a formula kept alive as another package's dependency, and anything declared in `~/Brewfile.local`.

It reports the four kinds this repo's Brewfiles declare: formulae, casks, taps, and Mac App Store apps. Homebrew cleans up VS Code extensions and npm globals under the same output shape. Naming the headers rather than matching the shape keeps a package manager this repo adopts later from turning the nightly report into an extension audit. The cost is that a renamed header upstream silences that kind rather than breaking the run, because an empty parse is also what a clean machine produces.

The to-do latch keys on the sorted package set rather than on the fact of a finding. A to-do left unactioned stays quiet while the same packages are undeclared. A newly installed one reopens it under its own to-do. Sorting matters because Homebrew orders the listing by a dependency sort taken over every installed package, so installing something unrelated and declared can reshuffle the undeclared names without changing the set.

A failing drift check is contained the way a failing `reload.sh` is. The install it follows has already succeeded, and a package that is merely undeclared breaks nothing overnight.

### GitHub Transport

The nightly jobs run at 3am against a locked Mac, where Secretive refuses to sign and any SSH fetch dies on `agent refused operation`. Every repo these jobs sync is public, so `git_sync` calls `git_https_remote` to move a `github.com` origin to anonymous HTTPS before fetching. Only the fetch URL moves, because the SSH URL stays behind as the remote's `pushurl` and pushes keep the credentials they already had. The rewrite is persistent and idempotent. A clone that arrives over SSH heals on its next sync.

`claude-sync` also calls `git_https_env`, which exports the same rewrite as an `insteadOf` rule. That covers the marketplace and plugin clones Claude Code makes for itself, which it creates with `git@github.com:` URLs and re-clones on every update. An `insteadOf` rule outranks a `pushurl`, so the exports are scoped to the plugin steps rather than the whole script.

Storing an HTTPS URL does not settle which transport the fetch uses. An org that standardizes on SSH installs a `url.<base>.insteadOf` rule mapping `https://github.com/` back to `git@github.com:`, and that rule rewrites whatever is stored. Nothing written to the remote escapes it. `git_https_pin` covers that. Git applies the longest matching rule, so one keyed on the remote's full HTTPS URL and mapping it to itself outranks any broader `github.com` rule. It goes in the repo's own config and names a single URL, so every other remote is left alone. The pin is written only when git resolves the remote to one of the github SSH forms, and that SSH URL stays behind as the `pushurl`. SSH is the whole point, since it is the transport that cannot sign while the Mac is locked. A rule routing the remote to another HTTPS host is a mirror or a proxy that someone chose and that may be the only route out, so it is left in place. A rule of equal length registered earlier still wins the tie. The pin is written once and logs where the remote resolves instead, so the run that cannot win leaves the config no larger.

Only the stored URL decides whether a remote is a github remote. A rule can send some other host to github, but one that rewrites the host without keeping the repo path would have us store a URL naming a repository that does not exist, so `git_https_remote` acts on what `.git/config` holds and nothing else.

`git config --get remote.<name>.url` gives the stored URL, which is what a rewrite keys on. Never read that with `git remote get-url`: it resolves `insteadOf` rules, so it reports HTTPS while `.git/config` still holds the SSH URL, and a rewrite keyed on it silently never fires. `git ls-remote --get-url` gives the URL the fetch will actually open, which is how the pin tells whether it took.

### Manual Commands

- `dotfiles sync` — Pull latest from remote
- `dotfiles sync --bootstrap` — Sync and re-run bootstrap for symlinks
- `dotf` — Full install/update: Homebrew, brew bundle, mise install, topic installers
- `scripts/brew-drift`: Print the Brewfile entries that would declare whatever is installed and undeclared
- `dotfiles-migrate` — Run the one-time cleanups this machine hasn't run yet

### Installation Flow

`scripts/install` is the main entry point:
1. `brew bundle` — Install Brewfile dependencies
2. Symlink `*/mise.toml` → `~/.config/mise/conf.d/`
3. `mise install` — Install language runtimes
4. Run `bin/dotfiles-migrate` for the one-time cleanups this machine hasn't run
5. `scripts/install-symlinks` — Install declarative symlinks from `symlinks.conf`
6. Run topic `install.sh` scripts, including `credentials/install.sh`, which chmods credential files to `0600`
7. Run `theme/bin/theme-sync` to reconcile theme-managed configs to the active flavor
8. Run `bin/dotfiles-reload` to hand the new config to whatever is already running

### Migrations

`bin/dotfiles-migrate` runs the one-time cleanups a machine hasn't run yet. Each lives in `migrations/`, named `YYYYMMDDNNNN-slug.ts`, and exports `up(context)`. The version and the name come from the filename, so there is no version constant to fall out of sync with where the file sorts. `${XDG_STATE_HOME:-~/.local/state}/dotfiles/migration-version` records how far the machine got.

The rule for what belongs here: convergence describes the state every machine should be in and runs on every machine forever. A migration describes the transition work only a machine that predates a change has left to do. Removing a tool from a Brewfile stops declaring it and uninstalls nothing, so the removal commit carries a migration that uninstalls it. Do not put a one-time cleanup in the install path just because it is idempotent. That leaves the installer describing a machine nobody has any more, which is how `scripts/install` and `macos/install.sh` collected the dated blocks still sitting in them.

A machine with no version file and no dotfiles symlinks is fresh. It stamps the latest version and runs nothing, because it was installed after every migration was written and has none of the state they clean up.

The version file alone cannot answer that on a machine that predates the runner, since no such machine has the file. Freshness is read off the symlinks instead. A home directory or `$XDG_CONFIG_HOME` carrying a link into a dotfiles tree has had `scripts/install` run on it before and gets every migration. One carrying none is fresh. Every tree the links may point into counts: `~/.dotfiles`, the tree `~/.dotfiles-dev-mode` records, and the tree the runner is executing from. `dotfiles dev enable` repoints every link at a development worktree and writes that flag file, so reading only `~/.dotfiles` would take a dev-enabled machine for a fresh one. The flag file rather than the running tree is what answers this, because the nightly job runs `scripts/install` out of `~/.dotfiles` while the links still point at the worktree.

That reading is only available before the links are laid, which is why the runner sits ahead of `scripts/install-symlinks` rather than at the end. It is also what lets a migration clear the way for a link.

Sitting there means it runs after `brew bundle`, so a cleanup that has to happen before bundle evaluates the Brewfile cannot be a migration. `scripts/install-cask-variants` is that case. The dated herdr plugin-config block inline in `scripts/install` is not: it predates the runner and is what a migration would now be written as. Both carry `EXPIRES:` dates that retire them either way.

The version is stamped after each migration rather than once at the end, and a failure stops the run without stamping. The next install retries the one that broke and the ones after it, and never re-runs one that finished. A later migration is skipped rather than attempted, since it may assume the one before it completed. `scripts/install` downgrades a nonzero exit to a warning, the way it does for `theme-sync` and `dotfiles-reload`: this runs unattended at 3am behind convergence that has already succeeded, and a cleanup that could not finish tonight is a cleanup to retry tomorrow rather than a to-do nobody can act on until morning.

`bin/dotfiles-sync` does not run migrations. A plain `dotfiles sync` moves the tree and reloads what is already pointed at. It does not converge. The nightly job and `dotfiles sync --bootstrap` both reach them through `scripts/install`, the one hook point.

A migration may set `export const platform = "darwin" | "linux"` when the work only makes sense on one, since everything outside `macos/` has to stay Linux-compatible. A migration that the platform will never run is stamped rather than left pending forever.

`context` carries `home`, `config`, `data`, `applications`, `root`, `installed`, `platform`, and an `out` to run children through, so a migration never reads a path out of the environment and a test can hand it a sandbox. `removeFormula` uninstalls a formula a Brewfile stopped declaring, and does nothing where brew or the formula is absent. `removeCask` is the same for a cask, and exists separately because `brew list` without `--cask` answers only for formulae: it exits nonzero for an installed cask, so the formula helper would read every cask as already gone and uninstall nothing. `removeTree` removes a path, confined to the `home`, `config`, or `data` it was handed, and refuses those roots themselves. All three are named because `XDG_CONFIG_HOME` and `XDG_DATA_HOME` may point outside the home directory, and refusing a path a migration legitimately owns would strand every migration behind it. `ownedLink` says whether a symlink still resolves into one of the `installed` trees, which is how a migration removes a link this repo made without touching one someone repointed. `isEmpty` is true only of a directory holding nothing, which is what a retired `mkdir -p` left behind and what tells it apart from a directory someone has since put their own work in. A migration that means to reach further calls `node:fs` itself.

`applications` is `/Applications`, where casks and App Store apps land. It is handed over like the rest so a test can point one at a sandbox, but it is deliberately not a `removeTree` root: everything there is owned by `root:wheel` and shared with every user, so a migration that removes an app bundle calls `node:fs` itself and handles the failure. Removing one means unlinking the files inside the bundle rather than only the bundle itself, which the user cannot do for an App Store install. `mas uninstall` needs root too. A migration runs unattended at 3am and must not escalate, so it reports the path to remove by hand and carries on rather than failing every night over a leftover that harms nothing.

#### Adding a Migration

1. Write `migrations/<YYYYMMDDNNNN>-<slug>.ts` in the same commit as the change it cleans up after, exporting `up(context)`
2. Give it an `EXPIRES:` marker in a comment: `scripts/lint-expired` greps for one and fails without it
3. Add `export const platform` when the work only makes sense on macOS or on Linux
4. Add `migrations/<same-name>.test.ts` beside it, driving `up` against a sandbox home

The `EXPIRES:` marker and the runner compose rather than overlap. The runner makes the cleanup happen on the machines that still need it. The marker is what makes the file get deleted once none do. A migration that has run everywhere is exactly the cleanup that outlived its reason, so the marker's date is the author's estimate of when every machine will have run `scripts/install` since the change. Reaching it fails the `lint` job, which is the only gate: `scripts/lint-expired` is not a pre-commit hook, so a local commit passes. The fix is to delete the migration file. Deleting one is safe at any point: a machine stamped past it has nothing pending, and the stamp never moves backwards. That date is also the backstop for a migration that keeps failing, since a failure is only a warning at 3am and the `lint` job is where it surfaces.

### Config Reloads

`bin/dotfiles-reload` runs every `<topic>/reload.sh`, so a config change reaches a program that has been running for weeks instead of waiting for a restart. `scripts/install` and `dotfiles dev enable|disable` call it directly. `bin/dotfiles-sync` calls it only when the pull moved the tree, and its `--bootstrap` path reaches it through `scripts/install` instead. `herdr/` and `terminal/` are the topics that have one.

Every reload is in place. The program re-reads its config and keeps its state, sessions, and child processes. Nothing here may restart a server, kill a session, or drop in-flight work. This runs unattended from the 3am job, where a restart takes live work down with it, so a tool whose only path to new config is a restart gets no `reload.sh` and picks the change up on its next start.

A `reload.sh` self-gates. Exit 0 without work when the tool isn't installed or isn't running, since a fresh machine and CI hit both cases. Assume roughly a minute of runtime: the dispatcher caps each script there so a wedged peer can't hang the nightly job.

A failing `reload.sh` is contained on purpose. The dispatcher logs it and carries on to the rest, and both callers downgrade its exit status to a warning, so a broken reload never fails an install or the nightly job. Leave that alone. The install it follows has already succeeded, and stale in-memory config resolves itself the next time the program starts.

## Stacked PRs

Each branch in a stack lives in its own worktrunk worktree. `wt sync` owns the local side and rebases each branch onto its parent in dependency order.

1. Create base branch: `wt switch --create feature/base`
2. Work, commit, then stack next branch: `wt switch --create child-name --base=@`
3. Sync entire stack: `wt sync --push`

Publishing to GitHub runs in three steps. Start with `wt sync --push`, because `gh stack link` pushes without force and would be rejected on a freshly rebased branch. Then open each layer's PR with `/ship` or `pull-request:create`. That gets it a real body and the review passes. Then `gh stack link <bottom> ... <top>` chains the bases and registers the stack on GitHub. `link` opens a PR for any branch still missing one, with an auto-generated title and body, so let it fill gaps rather than lead. It writes no local tracking state, which is why it fits the one-worktree-per-branch layout.

`gh stack merge` lands the stack. With no argument it merges everything atomically. Pass a PR number to stop partway, and GitHub retargets and rebases the layers left open. `gh pr merge` does not work on a stacked PR. The `ghm` alias is off limits once a stack exists. Follow a merge with `wt sync --prune` to drop integrated worktrees.

`link` and `merge` are the only two `gh stack` commands to use here. Everything else (`init`, `add`, `submit`, `push`, `checkout`, `sync`, `rebase`, `modify`, `unstack`, `view`, and the `up`/`down`/`top`/`bottom`/`switch`/`trunk` navigation) reads or writes local tracking state that assumes every layer is checked out in one working tree. `submit` is the trap, since it is the command the tool's own help steers you toward. `gh stack rebase` reports success for a branch checked out in another worktree without doing anything ([gh-stack#35](https://github.com/github/gh-stack/issues/35)).

On GitLab, `glab stack` fills the same role. See the `gitlab:merge-request` skill.

## ZSH Startup Performance

Shell startup time is CI-gated (<1s). Follow these rules to avoid regressions:

- **Never call `brew --prefix`** in `.zsh` files — use `$HOMEBREW_PREFIX` (already exported by `brew shellenv` in `zshenv`)
- **Never call `$(command ...)` or `` `command` `` during startup** unless guarded — subshell forks are ~15-50ms each
- **All completions are deferred** — `completion.zsh` files are sourced via a one-shot `precmd` hook after the first prompt, not during startup. Put completion registrations (e.g., `eval "$(tool completion)"`, `compdef`) in `completion.zsh`, never in regular `.zsh` files.
- **Use `compinit -C`** — skips the security audit on every startup (directory permission check). The full audit runs during `dotfiles-upgrade`.
- **`path.zsh` is sourced only in `zshenv`** — `.zshrc` sources `.zshenv` when `DOTFILES_ZSHENV_RAN` is unset, and nothing else re-sources a path file. zsh reads its per-user `.zshenv` from `$ZDOTDIR`, `.zshenv` exports `ZDOTDIR`, and only `.zshrc` is installed there, so every zsh below the first one skips `.zshenv` and inherits a frozen `$PATH` that can predate a topic. Keep the marker unexported, or a child shell reads its parent's startup as its own. Installing a second `.zshenv` under `$ZDOTDIR` would fix the same thing by charging every `#!/usr/bin/env zsh` script ~110ms against the ~6ms a nested zsh costs now
- **File naming matters** — the zshrc filter matches `completion.zsh` (singular). Files named `completions.zsh` (plural) will be sourced eagerly in the main loop, bypassing deferral. CI enforces this in the `lint` job's completion-naming check.
- **Defer everything interactive** — anything not needed before the first prompt (completions, key bindings that shell out, etc.) should run in the `precmd` deferred hook, not during startup
- **Benchmarking**: `bench-startup` measures the current worktree; `bench-startup /path/to/other` compares two worktrees. Uses `ZDOTDIR` + `DOTFILES_USE_DEV` to isolate each worktree's rc files without modifying symlinks. Use `ZPROF=1 zsh -i -c exit` for per-file breakdown.

## Development Notes

- This is a personal configuration repo - changes should reflect actual usage
- macOS-specific items go in `macos/` directory
- Brew dependencies are managed per-topic for organization
- Shell integration follows ZSH plugin conventions
