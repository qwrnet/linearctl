/**
 * `linearctl --update` (also `linearctl update install`): update the running linearctl in place.
 *
 * - A GitHub Releases binary is replaced by the latest release asset for this OS and architecture,
 *   verified against the release's checksums.txt and run once (`--version`) before an atomic swap,
 *   so a failed download, bad checksum or missing permission leaves the installed binary untouched.
 * - An npm install is updated through npm in its own scope (global or project) and prefix.
 * - Every other install (Debian package, Homebrew, AUR, pnpm, Yarn, Bun, npx, Nix, a checkout or an
 *   unrecognized location) is left alone: the result explains the next step instead.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import packageJson from "../../package.json" with { type: "json" };
import { commandIO, type CommandOutputOptions } from "../core/runtime/options.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import {
  canSelfUpdate, compareVersions, currentInstallation, fetchLatestRelease, manualRecommendation, NPM_PACKAGE,
  npmInstallArgs, npmInstallCommand, type Installation, type InstallMethod, type LatestRelease,
} from "./update.js";

const DOWNLOAD_TIMEOUT_MS = 300_000;
const NPM_TIMEOUT_MS = 600_000;
const VERIFY_TIMEOUT_MS = 60_000;

export interface CommandRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type RunCommand = (command: string, args: string[], options: { cwd?: string | undefined; timeoutMs: number }) => CommandRun;

export interface SelfUpdateOptions extends CommandOutputOptions {
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  executablePath?: string;
  currentVersion?: string;
  pathExists?: (path: string) => boolean;
  listDir?: (path: string) => string[];
  platform?: NodeJS.Platform;
  arch?: string;
  viaInterpreter?: boolean;
  runCommand?: RunCommand;
}

export type SelfUpdateStatus = "updated" | "up-to-date" | "would-update" | "manual" | "failed";

export interface SelfUpdateResult {
  status: SelfUpdateStatus;
  updated: boolean;
  currentVersion: string;
  targetVersion: string | null;
  installMethod: InstallMethod;
  executable: string;
  /** Binary updates: the release asset downloaded (or, on a dry run, that would be). */
  asset?: string;
  /** npm updates: the npm command run (or, on a dry run, that would run). */
  command?: string;
  /** The next step when linearctl did not update itself, or after an update. */
  recommendation?: string;
  error?: string;
}

class UpdateFailure extends Error {
  constructor(message: string, readonly recommendation?: string) {
    super(message);
  }
}

export function defaultRunCommand(command: string, args: string[], options: { cwd?: string | undefined; timeoutMs: number }): CommandRun {
  // npm is npm.cmd on Windows, which Node only runs through a shell; quote every argument for cmd.
  const viaShell = process.platform === "win32" && command === "npm";
  const result = viaShell
    ? spawnSync([command, ...args].map((arg) => `"${arg.replace(/"/g, '""')}"`).join(" "),
      { shell: true, cwd: options.cwd, encoding: "utf8", timeout: options.timeoutMs, windowsHide: true })
    : spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", timeout: options.timeoutMs, windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}) };
}

/** The release asset for an OS and architecture, or undefined where no release build exists. */
export function releaseAssetName(platform: NodeJS.Platform, arch: string): string | undefined {
  if (arch !== "x64" && arch !== "arm64") return undefined;
  if (platform === "linux" || platform === "darwin") return `linearctl-${platform}-${arch}`;
  if (platform === "win32" && arch === "x64") return "linearctl-windows-x64.zip";
  return undefined;
}

/** `sha256  name` lines from checksums.txt, keyed by name. */
export function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (match) checksums.set(match[2]!, match[1]!.toLowerCase());
  }
  return checksums;
}

/** The one file in a release ZIP, which must be [name] at the archive's root. */
export function extractSingleZipEntry(zip: Uint8Array, name: string): Buffer {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("the release archive is not a ZIP file");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files: { name: string; method: number; compressedSize: number; size: number; localOffset: number }[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("the release archive is corrupt");
    const nameLength = buf.readUInt16LE(offset + 28);
    const entry = {
      method: buf.readUInt16LE(offset + 10),
      compressedSize: buf.readUInt32LE(offset + 20),
      size: buf.readUInt32LE(offset + 24),
      localOffset: buf.readUInt32LE(offset + 42),
      name: buf.toString("utf8", offset + 46, offset + 46 + nameLength),
    };
    if (!entry.name.endsWith("/")) files.push(entry);
    offset += 46 + nameLength + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
  const [file] = files;
  if (files.length !== 1 || file === undefined || file.name !== name) {
    throw new Error(`the release archive must hold only ${name}; it holds ${files.map((f) => f.name).join(", ") || "nothing"}`);
  }
  if (buf.readUInt32LE(file.localOffset) !== 0x04034b50) throw new Error("the release archive is corrupt");
  const start = file.localOffset + 30 + buf.readUInt16LE(file.localOffset + 26) + buf.readUInt16LE(file.localOffset + 28);
  const data = buf.subarray(start, start + file.compressedSize);
  const content = file.method === 0 ? Buffer.from(data)
    : file.method === 8 ? inflateRawSync(data)
    : undefined;
  if (content === undefined) throw new Error(`the release archive uses unsupported compression method ${file.method}`);
  if (content.length !== file.size) throw new Error("the release archive is corrupt");
  return content;
}

async function download(fetchImpl: typeof fetch, url: string, what: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "User-Agent": `linearctl/${packageJson.version}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new UpdateFailure(`could not download ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new UpdateFailure(`could not download ${what}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function permissionMessage(error: unknown, path: string, retry: string): UpdateFailure | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") return undefined;
  return new UpdateFailure(`no permission to write ${path} (${code}); the installed linearctl was not changed`, retry);
}

/** Remove binaries a previous Windows update renamed aside (they can't be deleted while running). */
function removeStaleBinaries(executable: string): void {
  const dir = dirname(executable);
  const prefix = `${basename(executable)}.old-`;
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(prefix)) {
        try { unlinkSync(join(dir, entry)); } catch { /* still running or not ours to remove */ }
      }
    }
  } catch {
    // An unreadable directory surfaces later, when the update stages its file.
  }
}

async function updateBinary(
  installation: Installation, release: LatestRelease, options: SelfUpdateOptions, base: SelfUpdateResult,
  log: (line: string) => void,
): Promise<SelfUpdateResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchImpl = options.fetchImpl ?? fetch;
  const run = options.runCommand ?? defaultRunCommand;
  const fallback = manualRecommendation(installation, platform);
  const assetName = releaseAssetName(platform, arch);
  if (assetName === undefined) throw new UpdateFailure(`no linearctl release is built for ${platform}-${arch}`, fallback);
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  const checksums = release.assets.find((candidate) => candidate.name === "checksums.txt");
  if (!asset) throw new UpdateFailure(`release ${release.tag} has no ${assetName} asset`, fallback);
  if (!checksums) throw new UpdateFailure(`release ${release.tag} has no checksums.txt; refusing to install an unverified binary`, fallback);
  if (options.dryRun) return { ...base, status: "would-update", asset: assetName };

  const executable = installation.executable;
  const dir = dirname(executable);
  const windows = platform === "win32";
  const retry = windows
    ? `Run linearctl --update from an account that can write ${dir}, or ${fallback.charAt(0).toLowerCase()}${fallback.slice(1)}`
    : `Rerun with permission to write ${dir} (for example: sudo linearctl --update), or ${fallback.charAt(0).toLowerCase()}${fallback.slice(1)}`;
  try {
    accessSync(dir, constants.W_OK);
  } catch (error) {
    throw permissionMessage(error, dir, retry) ?? error;
  }
  if (windows) removeStaleBinaries(executable);

  log(`Downloading ${assetName} from release ${release.tag}...`);
  const expected = parseChecksums((await download(fetchImpl, checksums.url, "checksums.txt")).toString("utf8")).get(assetName);
  if (!expected) throw new UpdateFailure(`checksums.txt in ${release.tag} has no entry for ${assetName}; refusing to install`, fallback);
  const archive = await download(fetchImpl, asset.url, assetName);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    throw new UpdateFailure(`checksum mismatch for ${assetName} (expected ${expected}, got ${actual}); the installed linearctl was not changed`, fallback);
  }
  log("Checksum verified.");
  let binary: Buffer;
  try {
    binary = windows ? extractSingleZipEntry(archive, "linearctl.exe") : archive;
  } catch (error) {
    throw new UpdateFailure(error instanceof Error ? error.message : String(error), fallback);
  }

  // Stage next to the executable, so the final rename is atomic and never crosses filesystems.
  const staged = join(dir, `.linearctl-update-${randomBytes(6).toString("hex")}${windows ? ".exe" : ""}`);
  try {
    try {
      writeFileSync(staged, binary, { mode: 0o700, flag: "wx" });
      if (!windows) chmodSync(staged, (statSync(executable).mode & 0o777) | 0o100);
    } catch (error) {
      throw permissionMessage(error, dir, retry) ?? error;
    }
    const check = run(staged, ["--version"], { timeoutMs: VERIFY_TIMEOUT_MS });
    const reported = check.stdout.trim();
    if (check.status !== 0 || reported !== `linearctl ${release.version}`) {
      const why = check.error?.message ?? (reported || check.stderr.trim() || `exit ${check.status}`);
      throw new UpdateFailure(`the downloaded binary did not run (${why}); the installed linearctl was not changed`, fallback);
    }
    try {
      if (windows) {
        // A running .exe can't be replaced, but it can be renamed aside.
        const aside = `${executable}.old-${randomBytes(4).toString("hex")}`;
        renameSync(executable, aside);
        try {
          renameSync(staged, executable);
        } catch (error) {
          renameSync(aside, executable);
          throw error;
        }
        try { unlinkSync(aside); } catch { /* removed by the next update */ }
      } else {
        renameSync(staged, executable);
      }
    } catch (error) {
      throw permissionMessage(error, executable, retry) ?? error;
    }
  } finally {
    if (existsSync(staged)) {
      try { unlinkSync(staged); } catch { /* best effort */ }
    }
  }
  return { ...base, status: "updated", updated: true, asset: assetName,
    recommendation: "Update agent skills to match this version: linearctl skills install" };
}

function tail(text: string): string {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-5).join(" | ");
}

function npmLatestVersion(installation: Installation, run: RunCommand): string {
  const result = run("npm", ["view", `${NPM_PACKAGE}@latest`, "version"],
    { cwd: installation.npm?.prefix, timeoutMs: VERIFY_TIMEOUT_MS });
  const version = result.stdout.trim().split(/\r?\n/).pop()?.trim().replace(/^"|"$/g, "") ?? "";
  if (result.error || result.status !== 0 || !/^\d+\.\d+\.\d+/.test(version)) {
    const why = result.error?.message ?? (tail(result.stderr) || `exit ${result.status}`);
    throw new UpdateFailure(`could not ask npm for the latest ${NPM_PACKAGE} version: ${why}`, npmInstallCommand(installation, "latest"));
  }
  return version;
}

function updateNpm(
  installation: Installation, target: string, options: SelfUpdateOptions, base: SelfUpdateResult,
  log: (line: string) => void,
): SelfUpdateResult {
  const npm = installation.npm!;
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? defaultRunCommand;
  const args = npmInstallArgs(installation, target);
  const command = npmInstallCommand(installation, target);
  if (options.dryRun) return { ...base, status: "would-update", command };

  const modules = npm.scope === "global" && platform !== "win32" ? join(npm.prefix, "lib", "node_modules") : join(npm.prefix, "node_modules");
  try {
    accessSync(modules, constants.W_OK);
  } catch (error) {
    const sudo = platform === "win32" ? `Run it from an account that can write ${modules}: ${command}` : `Run it with permission to write ${modules} (for example: sudo ${command})`;
    throw permissionMessage(error, modules, sudo) ?? error;
  }

  log(`Running ${command}`);
  const result = run("npm", args, { cwd: npm.prefix, timeoutMs: NPM_TIMEOUT_MS });
  let installed: string | undefined;
  try {
    installed = (JSON.parse(readFileSync(join(npm.packageRoot, "package.json"), "utf8")) as { version?: string }).version;
  } catch {
    installed = undefined;
  }
  if (result.error || result.status !== 0) {
    const why = result.error?.message ?? (tail(result.stderr) || `exit ${result.status}`);
    // npm can fail after it has already changed files (a project's postinstall script, say), so
    // report what is installed now rather than assuming nothing changed.
    if (installed !== base.currentVersion) {
      return { ...base, status: "failed", updated: installed === target, command,
        error: `npm exited with an error after changing ${npm.packageRoot}, which now reports version ${installed ?? "unknown"}: ${why}`,
        recommendation: `Check npm's output in ${npm.prefix}, then rerun: ${command}` };
    }
    throw new UpdateFailure(`npm could not update ${NPM_PACKAGE}; ${base.currentVersion} is still installed: ${why}`, command);
  }
  if (installed !== target) {
    throw new UpdateFailure(`npm finished, but ${npm.packageRoot} reports version ${installed ?? "unknown"} instead of ${target}`, command);
  }
  return { ...base, status: "updated", updated: true, command,
    recommendation: "Update agent skills to match this version: linearctl skills install" };
}

/** Update the running linearctl, or explain why not; never throws. */
export async function selfUpdate(options: SelfUpdateOptions, log: (line: string) => void = () => {}): Promise<SelfUpdateResult> {
  const currentVersion = options.currentVersion ?? packageJson.version;
  const installation = currentInstallation(options);
  const platform = options.platform ?? process.platform;
  const base: SelfUpdateResult = {
    status: "failed", updated: false, currentVersion, targetVersion: null,
    installMethod: installation.method, executable: installation.executable,
  };
  let target: string | null = null;
  try {
    let release: LatestRelease | undefined;
    if (installation.method === "npm") {
      target = npmLatestVersion(installation, options.runCommand ?? defaultRunCommand);
    } else {
      try {
        release = await fetchLatestRelease(options.fetchImpl ?? fetch, currentVersion);
        target = release.version;
      } catch (error) {
        const message = `could not look up the latest release: ${error instanceof Error ? error.message : String(error)}`;
        if (canSelfUpdate(installation.method)) throw new UpdateFailure(message, manualRecommendation(installation, platform));
        return { ...base, status: "manual", recommendation: manualRecommendation(installation, platform), error: message };
      }
    }
    const withTarget = { ...base, targetVersion: target };
    if (compareVersions(target, currentVersion) <= 0) return { ...withTarget, status: "up-to-date" };
    if (!canSelfUpdate(installation.method)) {
      return { ...withTarget, status: "manual", recommendation: manualRecommendation(installation, platform) };
    }
    if (!options.dryRun) log(`Updating linearctl ${currentVersion} -> ${target} (${installation.method}: ${installation.executable})`);
    return installation.method === "npm"
      ? updateNpm(installation, target, options, withTarget, log)
      : await updateBinary(installation, release!, options, withTarget, log);
  } catch (error) {
    const failure = error instanceof UpdateFailure ? error : undefined;
    return { ...base, targetVersion: target, status: "failed",
      error: error instanceof Error ? error.message : String(error),
      recommendation: failure?.recommendation ?? manualRecommendation(installation, platform) };
  }
}

function manualReason(method: InstallMethod): string {
  if (method === "unknown") return "linearctl could not tell how it was installed, so it changed nothing.";
  if (method === "source") return "This is a source checkout; linearctl changed nothing.";
  return `${method} manages this installation, so linearctl changed nothing.`;
}

export async function handleSelfUpdate(options: SelfUpdateOptions): Promise<number> {
  const { stdout, stderr } = commandIO(options);
  const human = !options.json && !options.jsonEnvelope;
  const result = await selfUpdate(options, human ? (line) => stdout.write(`${line}\n`) : () => {});
  const ok = result.status === "updated" || result.status === "up-to-date" || result.status === "would-update";

  if (options.jsonEnvelope) {
    const meta = { sourceLayer: "curated" as const, ...(options.dryRun ? { dryRun: true } : {}) };
    const message = result.error ?? `linearctl was installed with ${result.installMethod} and was not updated: ${result.recommendation}`;
    const envelope = ok ? successEnvelope(result, meta)
      : failureEnvelope([{ category: "general", message, details: result }], meta);
    stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const target = result.targetVersion ?? "unknown";
    if (result.status === "up-to-date") {
      stdout.write(`linearctl ${result.currentVersion} is up to date (latest: ${target}).\n`);
    } else if (result.status === "updated") {
      stdout.write(`Updated linearctl ${result.currentVersion} -> ${target} (${result.installMethod}: ${result.executable}).\n`);
      stdout.write(`${result.recommendation}\n`);
    } else if (result.status === "would-update") {
      stdout.write(`Would update linearctl ${result.currentVersion} -> ${target} (${result.installMethod}: ${result.executable})`);
      stdout.write(result.command ? ` with: ${result.command}\n` : ` from release asset ${result.asset}.\n`);
    } else {
      stdout.write(`Installed: ${result.currentVersion}\nLatest:    ${target}\nInstalled via: ${result.installMethod} (${result.executable})\n`);
      if (result.error) stderr.write(`Error: ${result.error}\n`);
      if (result.status === "manual") stdout.write(`${manualReason(result.installMethod)}\n`);
      stdout.write(`Next step: ${result.recommendation}\n`);
    }
  }
  return ok ? ExitCode.Success : ExitCode.GeneralError;
}
