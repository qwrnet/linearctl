# Distribution and updates

linearctl ships as a raw binary on GitHub Releases (installed by `install.sh`, `install.ps1` or a
manual download), a `.deb` installed by `install.sh` on Debian and Ubuntu, and the npm package
`@qwrobinson/linearctl`. More channels (Homebrew, AUR, apt repositories) may follow. This page is
the policy for how each one updates.

## Policy

- **`linearctl --update` updates what linearctl owns.** It replaces a GitHub Releases binary with
  the latest release, and updates an npm install by running npm. `linearctl update install` is the
  same command, for scripts and help discovery.
- **The package manager owns its installs.** dpkg, Homebrew, the AUR, pnpm, Yarn, Bun, Nix and the
  like install, upgrade and remove linearctl. The CLI never replaces a binary another package
  manager installed: doing so would leave its database describing files that are no longer there.
  For those installs `--update` prints the owning tool's command and changes nothing. The npm path
  doesn't break this rule: it asks npm to do the update.
- **Verify before replacing, and never leave a broken CLI.** A binary update downloads the release
  asset and `checksums.txt`, refuses anything whose SHA-256 doesn't match, runs the new binary's
  `--version`, and only then renames it over the old one in the same directory. Any failure leaves
  the installed binary as it was.
- **`linearctl update check` advises and never mutates.** It compares the installed version with the
  latest GitHub release and names the update command.

## Detecting the install method

The method comes from the executable's real path, after symlinks are resolved: the release binary's
own path, or for a Node install the entry script under `node_modules`. A binary in a custom
directory, or reached through a link such as `~/.local/bin/linearctl`, is found where it really
lives, and that is the file that gets replaced.

| Real path | Method | `--update` does |
|---|---|---|
| the release binary, anywhere not listed below | `binary` | downloads, verifies and replaces it |
| `<prefix>/lib/node_modules/@qwrobinson/linearctl/` (Unix), `<prefix>\node_modules\...` beside `linearctl.cmd` (Windows) | `npm`, global | `npm install --global --prefix <prefix> @qwrobinson/linearctl@<latest>` |
| `<project>/node_modules/@qwrobinson/linearctl/` | `npm`, project | `npm install --prefix <project> @qwrobinson/linearctl@<latest>` |
| `/usr/bin/linearctl` owned by dpkg | `deb` | prints: rerun `install.sh`, which installs the new `.deb` with `sudo dpkg -i` |
| `/usr/bin/linearctl` owned by pacman | `aur` | prints: your AUR helper, for example `yay -Syu linearctl` |
| under Homebrew's `Cellar` | `homebrew` | prints: `brew upgrade linearctl` |
| under pnpm, Yarn or Bun global stores | `pnpm`, `yarn`, `bun` | prints that tool's update command |
| npx's cache (`_npx`) | `npx` | prints: `npx --yes @qwrobinson/linearctl@latest` |
| `/nix/store/` | `nix` | prints: update the flake or channel |
| a checkout's `src/` or `dist/` | `source` | prints: `git pull && bun install && bun run build` |
| run by node or bun from anywhere else | `unknown` | prints: reinstall with the installer or npm |

A `/usr/bin/linearctl` that no package database lists is a raw binary someone copied there; it's
updated like any other, which needs `sudo linearctl --update`.

The Debian package is deliberately not updated in place. dpkg owns `/usr/bin/linearctl`, and
replacing it would need root and leave dpkg's file list and version wrong. Rerunning `install.sh`
downloads the new `.deb`, verifies it against the same `checksums.txt`, and installs it with
`sudo dpkg -i`.

## Failures

| Failure | Result |
|---|---|
| GitHub or npm can't be reached | `failed`, exit 1, nothing downloaded or changed |
| no release asset for this OS/arch (for example Windows on arm64) | `failed`, with the installer as the next step |
| missing `checksums.txt`, no entry for the asset, or a mismatch | `failed`; the download is discarded |
| the new binary doesn't print `linearctl <version>` | `failed`; the staged file is removed |
| the install directory or npm prefix isn't writable | `failed`, naming the path and the command to rerun with permission (for example `sudo linearctl --update`) |
| npm exits non-zero | `failed`, with npm's last error lines and the npm command to rerun; npm keeps the previous version on a failed install |

On Windows the running `linearctl.exe` can't be overwritten, so it is renamed aside to
`linearctl.exe.old-<id>`, the new one is moved into place, and the old copy is deleted then or by the
next update. If the second rename fails, the original is renamed back.

## Updating, by install method

| Installed with | Update with |
|---|---|
| `install.sh` (raw binary) | `linearctl --update` (or rerun `install.sh`) |
| `install.sh` on Debian/Ubuntu (`.deb`) | rerun `install.sh`, which installs the new `.deb` |
| `install.ps1` (Windows) | `linearctl --update` (or rerun `install.ps1` as in the README's Windows section) |
| npm | `linearctl --update` (or `npm install -g @qwrobinson/linearctl@latest`) |
| Homebrew (future) | `brew upgrade linearctl` |
| AUR (future) | your AUR helper, for example `yay -Syu linearctl` |
| a source checkout | `git pull && bun install && bun run build` |

`linearctl update check --json` returns `currentVersion`, `latestVersion`, `updateAvailable`,
`installMethod` and `recommendation`. When GitHub can't be reached it returns
`latestVersion: null` and an `error`, and exits 1. The JSON from `linearctl --update --json` is
described in [commands](commands.md#update).

## Why a global `--update` flag

An earlier version of this policy kept self-update out of the CLI, and planned it only as a
subcommand. `--update` now exists because users expect it and shouldn't have to look up how they
installed linearctl. It is safe as a flag because it only works on its own: `linearctl --update`
with any command, such as `linearctl issue list --update`, is a usage error, so nobody can pass it
to another command by accident. `--dry-run` shows the plan without changing anything.
