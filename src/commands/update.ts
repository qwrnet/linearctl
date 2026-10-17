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

export const RELEASES_URL = "https://api.github.com/repos/qwrnet/linearctl/releases/latest";
export const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/qwrnet/linearctl/main/install.sh | sh";
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
}

const RECOMMENDATIONS: Record<InstallMethod, string> = {
  npm: "npm install -g @qwrobinson/linearctl@latest",
  homebrew: "brew upgrade linearctl",
  aur: "Update with your AUR helper (for example: yay -Syu linearctl)",
  deb: `Rerun the installer, which installs the new .deb: ${INSTALL_COMMAND}`,
  binary: `Rerun the installer: ${INSTALL_COMMAND}`,
  source: "git pull && bun install && bun run build",
};

/** How linearctl was installed, from where its executable lives; a guess, never a reason to mutate it. */
export function detectInstallMethod(
  executablePath: string,
  pathExists: (path: string) => boolean = existsSync,
  listDir: (path: string) => string[] = (path) => readdirSync(path),
): InstallMethod {
  const path = executablePath.replace(/\\/g, "/");
  if (path.includes("/node_modules/@qwrobinson/linearctl/")) return "npm";
  if (path.includes("/Cellar/") || path.includes("/homebrew/") || path.includes("/.linuxbrew/")) return "homebrew";
  if (/\/(src|dist)\/[^/]+\.(ts|js)$/.test(path) && !path.includes("/node_modules/")) return "source";
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
  let executable = options.executablePath ?? process.argv[1] ?? process.execPath;
  if (!options.executablePath) {
    try {
      executable = realpathSync(executable);
    } catch {
      // Keep the unresolved path.
    }
  }
  const installMethod = detectInstallMethod(executable, options.pathExists, options.listDir);
  const recommendation = RECOMMENDATIONS[installMethod];
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
  const { stdout, stderr } = commandIO(options);
  const [subcommand] = positionals;
  if (subcommand !== "check") {
    stderr.write("Error: usage: linearctl update check [--json]\n");
    return ExitCode.ValidationError;
  }
  const result = await checkForUpdate(options);
  if (options.json || options.jsonEnvelope) {
    stdout.write(`${JSON.stringify(options.jsonEnvelope ? { ok: !result.error, data: result } : result, null, 2)}\n`);
  } else {
    stdout.write(`Current version: ${result.currentVersion}\n`);
    stdout.write(`Latest release:  ${result.latestVersion ?? `unknown (${result.error})`}\n`);
    stdout.write(`Installed via:   ${result.installMethod}\n`);
    stdout.write(result.updateAvailable === false ? "Up to date.\n" : `To update: ${result.recommendation}\n`);
  }
  return result.error ? ExitCode.GeneralError : ExitCode.Success;
}
