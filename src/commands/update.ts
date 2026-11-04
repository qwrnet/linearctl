/**
 * `linearctl update check` compares the installed version with the latest GitHub release and says
 * how to update. `linearctl update install` (alias `linearctl --update`) performs the update for
 * the two install methods linearctl owns, a GitHub Releases binary and an npm install, and explains
 * the next step for everything a different package manager owns (docs/distribution.md).
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import packageJson from "../../package.json" with { type: "json" };
import { commandIO, type CommandOutputOptions } from "../core/runtime/options.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import { emitValidationError } from "../core/output/validation-error.js";
import { handleSelfUpdate, type SelfUpdateOptions } from "./self-update.js";

export const RELEASES_URL = "https://api.github.com/repos/qwrnet/linearctl/releases/latest";
export const INSTALLER_URL = "https://raw.githubusercontent.com/qwrnet/linearctl/main/install.sh";
export const INSTALL_COMMAND = `curl -fsSL ${INSTALLER_URL} | sh`;
export const WINDOWS_INSTALL_COMMAND =
  "Rerun install.ps1 as in the README's Windows section (download https://raw.githubusercontent.com/qwrnet/linearctl/main/install.ps1 and run it)";
export const NPM_PACKAGE = "@qwrobinson/linearctl";
export const SELF_UPDATE_COMMAND = "linearctl --update";
const CHECK_TIMEOUT_MS = 5_000;

export type InstallMethod =
  | "npm" | "npx" | "pnpm" | "yarn" | "bun"
  | "homebrew" | "aur" | "deb" | "nix"
  | "binary" | "source" | "unknown";

export interface Installation {
  method: InstallMethod;
  /** The resolved executable (or, for JS installs, the entry script). */
  executable: string;
  /** npm installs: whether `npm install` ran with --global, and the prefix it used. */
  npm?: { scope: "global" | "local"; prefix: string; packageRoot: string };
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  installMethod: InstallMethod;
  recommendation: string;
  error?: string;
}

export interface DetectionOptions {
  pathExists?: (path: string) => boolean;
  listDir?: (path: string) => string[];
  platform?: NodeJS.Platform;
  /** True when node or bun runs a script; false for the standalone release binary. */
  viaInterpreter?: boolean;
}

export interface UpdateCommandOptions extends CommandOutputOptions, Omit<SelfUpdateOptions, "stdout" | "stderr"> {
  fetchImpl?: typeof fetch;
  executablePath?: string;
  currentVersion?: string;
  pathExists?: (path: string) => boolean;
  listDir?: (path: string) => string[];
  platform?: NodeJS.Platform;
  viaInterpreter?: boolean;
}

const MANUAL_RECOMMENDATIONS: Partial<Record<InstallMethod, string>> = {
  npx: `npx fetches the package on each run: use npx --yes ${NPM_PACKAGE}@latest, or install it with npm install --global ${NPM_PACKAGE}`,
  pnpm: `Update with pnpm: pnpm add --global ${NPM_PACKAGE}@latest (or pnpm update ${NPM_PACKAGE} in the project)`,
  yarn: `Update with Yarn: yarn global add ${NPM_PACKAGE}@latest (or yarn up ${NPM_PACKAGE} in the project)`,
  bun: `Update with Bun: bun add --global ${NPM_PACKAGE}@latest`,
  homebrew: "brew upgrade linearctl",
  aur: "Update with your AUR helper (for example: yay -Syu linearctl)",
  deb: `The Debian package owns /usr/bin/linearctl, so linearctl does not replace it. Rerun the installer, which installs the new .deb with sudo dpkg -i: ${INSTALL_COMMAND}`,
  nix: "Nix owns this install: update the flake or channel that provides linearctl",
  source: "git pull && bun install && bun run build",
  unknown: `linearctl could not tell how it was installed. Reinstall with the installer (${INSTALL_COMMAND}) or npm (npm install --global ${NPM_PACKAGE}@latest)`,
};

/** Install methods `linearctl --update` performs itself; every other method gets a next step. */
export function canSelfUpdate(method: InstallMethod): boolean {
  return method === "binary" || method === "npm";
}

/** The manual next step for [installation], used when linearctl will not or cannot update itself. */
export function manualRecommendation(installation: Installation, platform: NodeJS.Platform = process.platform): string {
  const { method } = installation;
  if (method === "binary") {
    return platform === "win32" ? `Rerun the installer: ${WINDOWS_INSTALL_COMMAND}`
      : `Rerun the installer: ${binaryInstallCommand(installation.executable)}`;
  }
  if (method === "npm") return npmInstallCommand(installation, "latest");
  if (method === "unknown" && installation.npm) {
    return `linearctl could not tell which package manager owns ${installation.npm.prefix} (it needs exactly one lockfile). ` +
      `Update ${NPM_PACKAGE} with that project's package manager, for example: ${npmInstallCommand(installation, "latest")}`;
  }
  return MANUAL_RECOMMENDATIONS[method] ?? MANUAL_RECOMMENDATIONS.unknown!;
}

/**
 * The installer command that replaces the raw binary at [executable]: into its own directory, and
 * never as a .deb, which would land in /usr/bin and leave this copy shadowing it on PATH.
 */
export function binaryInstallCommand(executable: string): string {
  const path = executable.replace(/\\/g, "/");
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  return `curl -fsSL ${INSTALLER_URL} | LINEAR_NO_DEB=1 LINEAR_INSTALL_DIR=${shellQuote(dir)} sh`;
}

/** The npm arguments that update [installation] in its own scope and prefix. */
export function npmInstallArgs(installation: Installation, version: string): string[] {
  const npm = installation.npm;
  const spec = `${NPM_PACKAGE}@${version}`;
  if (!npm) return ["install", "--global", spec];
  return npm.scope === "global"
    ? ["install", "--global", "--prefix", npm.prefix, spec]
    : ["install", "--prefix", npm.prefix, spec];
}

export function npmInstallCommand(installation: Installation, version: string): string {
  return ["npm", ...npmInstallArgs(installation, version)].map(displayArg).join(" ");
}

function displayArg(arg: string): string {
  return /^[\w@./:=+~\\-]+$/.test(arg) ? arg : shellQuote(arg);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? (index === 0 ? "/" : ".") : path.slice(0, index);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function nativePath(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.replace(/\//g, "\\") : path;
}

const PROJECT_LOCKFILES: [string, InstallMethod][] = [
  ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"], ["yarn.lock", "yarn"],
  ["pnpm-lock.yaml", "pnpm"], ["bun.lock", "bun"], ["bun.lockb", "bun"],
];

/** The package manager whose lockfile [project] holds; "unknown" when none or several do. */
function projectPackageManager(project: string, platform: NodeJS.Platform, pathExists: (path: string) => boolean): InstallMethod {
  const managers = new Set(PROJECT_LOCKFILES
    .filter(([file]) => pathExists(nativePath(`${project}/${file}`, platform)))
    .map(([, manager]) => manager));
  return managers.size === 1 ? [...managers][0]! : "unknown";
}

/**
 * How linearctl was installed, from where its (symlink-resolved) executable or entry script lives
 * and whether node/bun runs it. Only "binary" and "npm" are ever updated in place.
 */
export function detectInstallation(executablePath: string, options: DetectionOptions = {}): Installation {
  const pathExists = options.pathExists ?? existsSync;
  const listDir = options.listDir ?? ((path: string) => readdirSync(path));
  const platform = options.platform ?? process.platform;
  const executable = executablePath;
  const path = executablePath.replace(/\\/g, "/");
  const lower = path.toLowerCase();
  const result = (method: InstallMethod): Installation => ({ method, executable });

  if (lower.startsWith("/nix/store/")) return result("nix");
  if (path.includes("/Cellar/") || path.includes("/homebrew/") || path.includes("/.linuxbrew/")) return result("homebrew");

  const marker = `/node_modules/${NPM_PACKAGE}/`;
  const markerIndex = path.lastIndexOf(marker);
  if (markerIndex >= 0) {
    if (lower.includes("/.pnpm/") || lower.includes("/pnpm/global/") || lower.includes("/pnpm-global/")) return result("pnpm");
    if (lower.includes("/.bun/install/global/")) return result("bun");
    if (lower.includes("/yarn/global/") || lower.includes("/yarn/data/global/") || lower.includes("/.yarn/")) return result("yarn");
    if (lower.includes("/_npx/")) return result("npx");
    const packageRoot = path.slice(0, markerIndex + marker.length - 1);
    const parent = dirname(path.slice(0, markerIndex + "/node_modules".length));
    // npm's global layout: <prefix>/lib/node_modules on Unix, <prefix>\node_modules on Windows,
    // where the prefix also holds the linearctl.cmd shim. Anything else is a project install.
    let scope: "global" | "local" = "local";
    let prefix = parent;
    if (platform === "win32") {
      if (pathExists(nativePath(`${parent}/linearctl.cmd`, platform))) scope = "global";
    } else if (basename(parent) === "lib") {
      scope = "global";
      prefix = dirname(parent);
    }
    const npm = { scope, prefix: nativePath(prefix, platform), packageRoot: nativePath(packageRoot, platform) };
    if (scope === "global") return { method: "npm", executable, npm };
    // A project's node_modules may belong to Yarn, pnpm or Bun without any marker in the path: let
    // its lockfile say. Only a project npm alone locks is updated with npm.
    return { method: projectPackageManager(prefix, platform, pathExists), executable, npm };
  }

  // A checkout run directly: bun src/cli/main.ts, node dist/cli/main.js (or src/index.ts).
  if (/\/(src|dist)\/(.+\/)?[^/]+\.(ts|js)$/.test(path)) return result("source");
  if (options.viaInterpreter) return result("unknown");

  if (path === "/usr/bin/linearctl") {
    try {
      if (pathExists("/var/lib/pacman/local") &&
          listDir("/var/lib/pacman/local").some((entry) => entry.startsWith("linearctl-"))) return result("aur");
    } catch {
      // Unreadable package database: fall through.
    }
    if (pathExists("/var/lib/dpkg/info/linearctl.list")) return result("deb");
  }
  return result("binary");
}

/** How linearctl was installed, from where its executable lives; a guess, never a reason to mutate it. */
export function detectInstallMethod(
  executablePath: string,
  pathExists: (path: string) => boolean = existsSync,
  listDir: (path: string) => string[] = (path) => readdirSync(path),
): InstallMethod {
  return detectInstallation(executablePath, { pathExists, listDir }).method;
}

/**
 * The running installation: a Bun-compiled release reports a virtual script path (/$bunfs/...), so
 * its executable is execPath; under node or bun (npm installs, a checkout) the script path is what
 * was installed. Symlinks (npm's bin links, a ~/.local/bin link to a custom location) are resolved.
 */
export function currentInstallation(options: Partial<UpdateCommandOptions> = {}): Installation {
  const runtime = process.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const script = process.argv[1];
  const viaInterpreter = options.viaInterpreter ??
    (/^(node|bun)(\.exe)?$/.test(runtime) && script !== undefined && !script.startsWith("/$bunfs") && !/^[A-Z]:[\\/]~BUN/i.test(script));
  let executable = options.executablePath ?? (viaInterpreter && script ? script : process.execPath);
  if (!options.executablePath) {
    try {
      executable = realpathSync(executable);
    } catch {
      // Keep the unresolved path.
    }
  }
  return detectInstallation(executable, {
    viaInterpreter: options.executablePath ? options.viaInterpreter ?? false : viaInterpreter,
    ...(options.pathExists ? { pathExists: options.pathExists } : {}),
    ...(options.listDir ? { listDir: options.listDir } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });
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

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface LatestRelease {
  version: string;
  tag: string;
  assets: ReleaseAsset[];
}

/** The latest published (non-prerelease) GitHub release and its downloadable assets. */
export async function fetchLatestRelease(fetchImpl: typeof fetch, currentVersion: string): Promise<LatestRelease> {
  const response = await fetchImpl(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `linearctl/${currentVersion}` },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const body = (await response.json()) as { tag_name?: unknown; assets?: unknown };
  if (typeof body.tag_name !== "string" || !body.tag_name) throw new Error("no release tag in GitHub's answer");
  const assets = Array.isArray(body.assets)
    ? body.assets.flatMap((asset: { name?: unknown; browser_download_url?: unknown }) =>
      typeof asset?.name === "string" && typeof asset.browser_download_url === "string"
        ? [{ name: asset.name, url: asset.browser_download_url }] : [])
    : [];
  return { version: body.tag_name.replace(/^v/, ""), tag: body.tag_name, assets };
}

export async function checkForUpdate(options: Partial<UpdateCommandOptions> = {}): Promise<UpdateCheckResult> {
  const currentVersion = options.currentVersion ?? packageJson.version;
  const installation = currentInstallation(options);
  const installMethod = installation.method;
  const recommendation = canSelfUpdate(installMethod) ? SELF_UPDATE_COMMAND
    : manualRecommendation(installation, options.platform);
  try {
    const { version: latestVersion } = await fetchLatestRelease(options.fetchImpl ?? fetch, currentVersion);
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
    return { currentVersion, latestVersion, updateAvailable, installMethod,
      recommendation: updateAvailable ? recommendation : "Up to date" };
  } catch (error) {
    return { currentVersion, latestVersion: null, updateAvailable: null, installMethod, recommendation,
      error: error instanceof Error ? error.message : "update check failed" };
  }
}

const USAGE = "usage: linearctl update check [--json] | linearctl update install [--dry-run] [--json] (alias: linearctl --update)";

export async function handleUpdateCommand(positionals: string[], options: UpdateCommandOptions): Promise<number> {
  const [subcommand] = positionals;
  if (positionals.length !== 1 || (subcommand !== "check" && subcommand !== "install")) {
    return emitValidationError(USAGE, options);
  }
  if (subcommand === "install") return handleSelfUpdate(options);

  const { stdout } = commandIO(options);
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
