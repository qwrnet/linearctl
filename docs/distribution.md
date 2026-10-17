# Distribution and updates

linearctl ships as a raw binary (`install.sh`), a `.deb` installed by that script on Debian and
Ubuntu, and the npm package `@qwrobinson/linearctl`. More channels (Homebrew, AUR, apt
repositories) may follow. This page is the policy for how each one updates.

## Policy

- **The package manager owns its installs.** npm, Homebrew, the AUR, apt and the like install,
  upgrade and remove linearctl. The CLI never replaces a package-managed binary: doing so would
  leave the package database describing files that are no longer there.
- **The CLI checks and advises; it doesn't mutate.** `linearctl update check` compares the
  installed version with the latest GitHub release, guesses the install method from where the
  executable lives, and prints the command that updates it. It writes nothing.
- **Self-update, if it is ever added, is explicit and limited to raw binary installs** (curl or
  `install.sh`). It would be a subcommand (`linearctl update install`), never a global flag.

## Updating, by install method

| Installed with | Update with |
|---|---|
| `install.sh` (raw binary) | rerun `install.sh` |
| `install.sh` on Debian/Ubuntu (`.deb`) | rerun `install.sh`, which installs the new `.deb` |
| npm | `npm install -g @qwrobinson/linearctl@latest` |
| Homebrew (future) | `brew upgrade linearctl` |
| AUR (future) | your AUR helper, for example `yay -Syu linearctl` |
| a source checkout | `git pull && bun install && bun run build` |

`linearctl update check --json` returns `currentVersion`, `latestVersion`, `updateAvailable`,
`installMethod` and `recommendation`. When GitHub can't be reached it returns
`latestVersion: null` and an `error`, and exits 1.

## Why no global `--update` flag

A flag that replaces the running binary reads like an option to whatever command it's attached
to, is easy to pass by accident in scripts and agent runs, and would have to refuse on every
package-managed install anyway. A subcommand keeps the action named, discoverable in help, and
separate from read-only commands.
