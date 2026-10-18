/**
 * `linearctl update check`: compare the installed version with the latest GitHub release and say
 * how to update for the way linearctl was installed. It never replaces the binary: package
 * managers own their installs (docs/distribution.md), and a raw binary is updated by rerunning
 * install.sh.
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import packageJson from "../../package.json" with { type: "json" };
import { commandIO, type CommandOutputOptions } from "../core/runtime/options.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import { emitValidationError } from "../core/output/validation-error.js";

export const RELEASES_URL = "https://api.github.com/repos/qwrnet/linearctl/releases/latest";
export const INSTALLER_URL = "https://raw.githubusercontent.com/qwrnet/linearctl/main/install.sh";
export const INSTALL_COMMAND = `curl -fsSL ${INSTALLER_URL} | sh`;
export const WINDOWS_INSTALL_COMMAND =
  "Rerun install.ps1 as in the README's Windows section (download https://raw.githubusercontent.com/qwrnet/linearctl/main/install.ps1 and run it)";
const CHECK_TIMEOUT_MS = 5_000;

export type InstallMethod = "npm" | "homebrew" | "aur" | "deb" | "binary" | "source";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  installMethod: InstallMethod;
  recommendation: string;
  error?: string;
}

export interface UpdateCommandOptions extends CommandOutputOptions {
  fetchImpl?: typeof fetch;
  executablePath?: string;
  currentVersion?: string;
  pathExists?: (path: string) => boolean;
  listDir?: (path: string) => string[];
  platform?: NodeJS.Platform;
}

const RECOMMENDATIONS: Record<InstallMethod, string> = {
  npm: "npm install -g @qwrobinson/linearctl@latest",
  homebrew: "brew upgrade linearctl",
  aur: "Update with your AUR helper (for example: yay -Syu linearctl)",
  deb: `Rerun the installer, which installs the new .deb: ${INSTALL_COMMAND}`,
  binary: `Rerun the installer: ${INSTALL_COMMAND}`,
  source: "git pull && bun install && bun run build",
};

/**
 * The installer command that replaces the raw binary at [executable]: into its own directory, and
 * never as a .deb, which would land in /usr/bin and leave this copy shadowing it on PATH.
 */
export function binaryInstallCommand(executable: string): string {
  const path = executable.replace(/\\/g, "/");
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const quoted = `'${dir.replace(/'/g, "'\\''")}'`;
  return `curl -fsSL ${INSTALLER_URL} | LINEAR_NO_DEB=1 LINEAR_INSTALL_DIR=${quoted} sh`;
}

/** How linearctl was installed, from where its executable lives; a guess, never a reason to mutate it. */
export function detectInstallMethod(
  executablePath: string,
  pathExists: (path: string) => boolean = existsSync,
  listDir: (path: string) => string[] = (path) => readdirSync(path),
): InstallMethod {
  const path = executablePath.replace(/\\/g, "/");
  if (path.includes("/node_modules/@qwrobinson/linearctl/")) return "npm";
  if (path.includes("/Cellar/") || path.includes("/homebrew/") || path.includes("/.linuxbrew/")) return "homebrew";
  // A checkout run directly: bun src/cli/main.ts, node dist/cli/main.js (or src/index.ts).
  if (/\/(src|dist)\/(.+\/)?[^/]+\.(ts|js)$/.test(path) && !path.includes("/node_modules/")) return "source";
  if (path === "/usr/bin/linearctl") {
    try {
      if (pathExists("/var/lib/pacman/local") &&
          listDir("/var/lib/pacman/local").some((entry) => entry.startsWith("linearctl-"))) return "aur";
    } catch {
      // Unreadable package database: fall through.
    }
    if (pathExists("/var/lib/dpkg/info/linearctl.list")) return "deb";
  }
  return "binary";
}

/** -1, 0 or 1 comparing dotted numeric versions ("v0.8.13" works); prerelease suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) =>
    (version.replace(/^v/, "").split(/[-+]/)[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export async function checkForUpdate(options: Partial<UpdateCommandOptions> = {}): Promise<UpdateCheckResult> {
  const currentVersion = options.currentVersion ?? packageJson.version;
  // A Bun-compiled release reports a virtual script path (/$bunfs/...); its executable is execPath.
  // Under node or bun (npm installs, a source checkout) the script path is what was installed.
  const runtime = process.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const viaInterpreter = /^(node|bun)(\.exe)?$/.test(runtime);
  const script = process.argv[1];
  let executable = options.executablePath ??
    (viaInterpreter && script && !script.startsWith("/$bunfs") ? script : process.execPath);
  if (!options.executablePath) {
    try {
      executable = realpathSync(executable);
    } catch {
      // Keep the unresolved path.
    }
  }
  const installMethod = detectInstallMethod(executable, options.pathExists, options.listDir);
  const windows = (options.platform ?? process.platform) === "win32";
  const recommendation = installMethod !== "binary" ? RECOMMENDATIONS[installMethod]
    : windows ? `Rerun the installer: ${WINDOWS_INSTALL_COMMAND}`
    : `Rerun the installer: ${binaryInstallCommand(executable)}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `linearctl/${currentVersion}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const body = (await response.json()) as { tag_name?: unknown };
    if (typeof body.tag_name !== "string" || !body.tag_name) throw new Error("no release tag in GitHub's answer");
    const latestVersion = body.tag_name.replace(/^v/, "");
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
    return { currentVersion, latestVersion, updateAvailable, installMethod,
      recommendation: updateAvailable ? recommendation : "Up to date" };
  } catch (error) {
    return { currentVersion, latestVersion: null, updateAvailable: null, installMethod, recommendation,
      error: error instanceof Error ? error.message : "update check failed" };
  }
}

export async function handleUpdateCommand(positionals: string[], options: UpdateCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  const [subcommand] = positionals;
  if (subcommand !== "check" || positionals.length > 1) {
    return emitValidationError("usage: linearctl update check [--json]", options);
  }
  const result = await checkForUpdate(options);
  if (options.jsonEnvelope) {
    const meta = { sourceLayer: "curated" as const };
    const envelope = result.error
      ? failureEnvelope([{ category: "general", message: result.error, details: result }], meta)
      : successEnvelope(result, meta);
    stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(`Current version: ${result.currentVersion}\n`);
    stdout.write(`Latest release:  ${result.latestVersion ?? `unknown (${result.error})`}\n`);
    stdout.write(`Installed via:   ${result.installMethod}\n`);
    stdout.write(result.updateAvailable === false ? "Up to date.\n" : `To update: ${result.recommendation}\n`);
  }
  return result.error ? ExitCode.GeneralError : ExitCode.Success;
}
