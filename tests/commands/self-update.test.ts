import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";
import {
  extractSingleZipEntry, handleSelfUpdate, parseChecksums, releaseAssetName, selfUpdate,
  type CommandRun, type RunCommand, type SelfUpdateOptions,
} from "../../src/commands/self-update.js";
import { RELEASES_URL } from "../../src/commands/update.js";
import packageJson from "../../package.json" with { type: "json" };

const NEW_BINARY = Buffer.from("#!/bin/sh\necho 'linearctl 0.11.0'\n");
const OLD_BINARY = Buffer.from("old linearctl 0.10.0\n");
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const temps: string[] = [];
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "linearctl-self-update-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try { chmodSync(dir, 0o755); } catch { /* ignore */ }
  }
});

/** A zip with one stored-deflate entry, as Compress-Archive writes it. */
function zipOf(name: string, content: Buffer): Buffer {
  const data = deflateRawSync(content);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + nameBytes.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, eocd]);
}

interface FakeRelease {
  tag?: string;
  asset?: string;
  body?: Buffer;
  checksum?: string;
  checksums?: boolean;
  status?: number;
  assetStatus?: number;
}

function releaseFetch(release: FakeRelease = {}) {
  const tag = release.tag ?? "v0.11.0";
  const asset = release.asset ?? "linearctl-linux-x64";
  const body = release.body ?? NEW_BINARY;
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === RELEASES_URL) {
      if (release.status) return new Response("{}", { status: release.status });
      const assets = [{ name: asset, browser_download_url: `https://dl.test/${asset}` }];
      if (release.checksums !== false) assets.push({ name: "checksums.txt", browser_download_url: "https://dl.test/checksums.txt" });
      return new Response(JSON.stringify({ tag_name: tag, assets }), { status: 200 });
    }
    if (url === "https://dl.test/checksums.txt") {
      return new Response(`${release.checksum ?? sha(body)}  ${asset}\n${"0".repeat(64)}  other.deb\n`);
    }
    if (url === `https://dl.test/${asset}`) return new Response(new Uint8Array(body), { status: release.assetStatus ?? 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function fakeRun(handlers: Partial<Record<"version" | "view" | "install", (args: string[], cwd?: string) => CommandRun>> = {}) {
  const calls: { command: string; args: string[]; cwd?: string | undefined }[] = [];
  const run: RunCommand = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    const ok = (stdout: string): CommandRun => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "--version") return handlers.version?.(args) ?? ok("linearctl 0.11.0\n");
    if (args[0] === "view") return handlers.view?.(args, options.cwd) ?? ok("0.11.0\n");
    if (args[0] === "install") return handlers.install?.(args, options.cwd) ?? ok("");
    return { status: 127, stdout: "", stderr: "unexpected command" };
  };
  return { run, calls };
}

function binaryInstall(name = "linearctl") {
  const dir = tempDir();
  const executable = join(dir, name);
  writeFileSync(executable, OLD_BINARY, { mode: 0o755 });
  return { dir, executable };
}

function baseOptions(overrides: Partial<SelfUpdateOptions>): SelfUpdateOptions {
  return { json: true, jsonEnvelope: false, currentVersion: "0.10.0", platform: "linux", arch: "x64",
    pathExists: () => false, listDir: () => [], ...overrides };
}

function capture() {
  const chunks: string[] = [];
  return { chunks, text: () => chunks.join(""), stream: { write: (chunk: string) => { chunks.push(chunk); return true; } } };
}

describe("release helpers", () => {
  it("maps the OS and architecture to the release asset", () => {
    expect(releaseAssetName("linux", "x64")).toBe("linearctl-linux-x64");
    expect(releaseAssetName("linux", "arm64")).toBe("linearctl-linux-arm64");
    expect(releaseAssetName("darwin", "arm64")).toBe("linearctl-darwin-arm64");
    expect(releaseAssetName("win32", "x64")).toBe("linearctl-windows-x64.zip");
    expect(releaseAssetName("win32", "arm64")).toBeUndefined();
    expect(releaseAssetName("freebsd", "x64")).toBeUndefined();
    expect(releaseAssetName("linux", "ia32")).toBeUndefined();
  });

  it("parses sha256sum output", () => {
    const checksums = parseChecksums(`${"A".repeat(64)}  linearctl-linux-x64\r\n${"b".repeat(64)} *linearctl.zip\nbad line\n`);
    expect(checksums.get("linearctl-linux-x64")).toBe("a".repeat(64));
    expect(checksums.get("linearctl.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts the single root-level executable from the Windows ZIP", () => {
    expect(extractSingleZipEntry(zipOf("linearctl.exe", NEW_BINARY), "linearctl.exe")).toEqual(NEW_BINARY);
    expect(() => extractSingleZipEntry(zipOf("bin/linearctl.exe", NEW_BINARY), "linearctl.exe")).toThrow(/must hold only linearctl.exe/);
    expect(() => extractSingleZipEntry(Buffer.from("not a zip"), "linearctl.exe")).toThrow(/not a ZIP/);
  });
});

describe("linearctl --update: GitHub Releases binary", () => {
  it("replaces the binary with the verified release, keeping its mode", async () => {
    const { dir, executable } = binaryInstall();
    chmodSync(executable, 0o750);
    const { fetchImpl } = releaseFetch();
    const { run, calls } = fakeRun();
    const result = await selfUpdate(baseOptions({ executablePath: executable, fetchImpl, runCommand: run }));
    expect(result).toMatchObject({ status: "updated", updated: true, currentVersion: "0.10.0", targetVersion: "0.11.0",
      installMethod: "binary", executable, asset: "linearctl-linux-x64" });
    expect(readFileSync(executable)).toEqual(NEW_BINARY);
    if (process.platform !== "win32") expect(statSync(executable).mode & 0o777).toBe(0o750);
    expect(readdirSync(dir)).toEqual(["linearctl"]);
    // The staged copy ran before the swap.
    expect(calls[0]!.args).toEqual(["--version"]);
    expect(calls[0]!.command).toMatch(/\.linearctl-update-[0-9a-f]+$/);
  });

  it("reports up to date without downloading", async () => {
    const { executable } = binaryInstall();
    const { fetchImpl, calls } = releaseFetch({ tag: "v0.10.0" });
    const out = capture();
    const code = await handleSelfUpdate(baseOptions({ json: false, stdout: out.stream as never, executablePath: executable, fetchImpl }));
    expect(code).toBe(0);
    expect(out.text()).toBe("linearctl 0.10.0 is up to date (latest: 0.10.0).\n");
    expect(calls).toEqual([RELEASES_URL]);
    expect(readFileSync(executable)).toEqual(OLD_BINARY);
  });

  it("plans without downloading on --dry-run", async () => {
    const { executable } = binaryInstall();
    const { fetchImpl, calls } = releaseFetch();
    const out = capture();
    const code = await handleSelfUpdate(baseOptions({ dryRun: true, stdout: out.stream as never, executablePath: executable, fetchImpl }));
    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toMatchObject({ status: "would-update", updated: false, targetVersion: "0.11.0", asset: "linearctl-linux-x64" });
    expect(calls).toEqual([RELEASES_URL]);
    expect(readFileSync(executable)).toEqual(OLD_BINARY);
  });

  const failures: { name: string; release: FakeRelease; run?: Parameters<typeof fakeRun>[0]; error: RegExp }[] = [
    { name: "a checksum mismatch", release: { checksum: "f".repeat(64) }, error: /checksum mismatch/ },
    { name: "a missing checksums.txt", release: { checksums: false }, error: /no checksums\.txt/ },
    { name: "a failed download", release: { assetStatus: 502 }, error: /could not download linearctl-linux-x64: HTTP 502/ },
    { name: "a release without this platform", release: { asset: "linearctl-darwin-arm64" }, error: /has no linearctl-linux-x64 asset/ },
    { name: "a binary that does not run", release: {},
      run: { version: () => ({ status: 1, stdout: "", stderr: "exec format error" }) }, error: /did not run \(exec format error\)/ },
    { name: "an unreachable GitHub", release: { status: 503 }, error: /latest release: GitHub answered 503/ },
  ];
  for (const failure of failures) {
    it(`leaves the installed binary untouched on ${failure.name}`, async () => {
      const { dir, executable } = binaryInstall();
      const { fetchImpl } = releaseFetch(failure.release);
      const out = capture();
      const err = capture();
      const code = await handleSelfUpdate(baseOptions({ json: false, stdout: out.stream as never, stderr: err.stream as never,
        executablePath: executable, fetchImpl, runCommand: fakeRun(failure.run).run }));
      expect(code).toBe(1);
      expect(err.text()).toMatch(failure.error);
      expect(out.text()).toContain("Next step: Rerun the installer: curl -fsSL");
      expect(readFileSync(executable)).toEqual(OLD_BINARY);
      expect(readdirSync(dir)).toEqual(["linearctl"]);
    });
  }

  it.skipIf(process.platform === "win32" || isRoot)("explains a directory it cannot write", async () => {
    const { dir, executable } = binaryInstall();
    chmodSync(dir, 0o555);
    const result = await selfUpdate(baseOptions({ executablePath: executable, fetchImpl: releaseFetch().fetchImpl, runCommand: fakeRun().run }));
    chmodSync(dir, 0o755);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/no permission to write .* \(EACCES\); the installed linearctl was not changed/);
    expect(result.recommendation).toContain("sudo linearctl --update");
    expect(readFileSync(executable)).toEqual(OLD_BINARY);
  });

  it("refuses a platform without a release build", async () => {
    const { executable } = binaryInstall();
    const result = await selfUpdate(baseOptions({ executablePath: executable, platform: "freebsd", fetchImpl: releaseFetch().fetchImpl }));
    expect(result).toMatchObject({ status: "failed", error: "no linearctl release is built for freebsd-x64" });
  });

  it("swaps a Windows executable by renaming the running one aside", async () => {
    const { dir, executable } = binaryInstall("linearctl.exe");
    writeFileSync(`${executable}.old-deadbeef`, "left by a previous update");
    const { fetchImpl } = releaseFetch({ asset: "linearctl-windows-x64.zip", body: zipOf("linearctl.exe", NEW_BINARY) });
    const { run, calls } = fakeRun();
    const result = await selfUpdate(baseOptions({ platform: "win32", executablePath: executable, fetchImpl, runCommand: run }));
    expect(result).toMatchObject({ status: "updated", asset: "linearctl-windows-x64.zip" });
    expect(readFileSync(executable)).toEqual(NEW_BINARY);
    expect(calls[0]!.command).toMatch(/\.linearctl-update-[0-9a-f]+\.exe$/);
    expect(readdirSync(dir)).toEqual(["linearctl.exe"]);
  });
});

// npm tests use the real filesystem: on Windows, a global install is recognised by its linearctl.cmd shim.
const npmOptions = (overrides: Partial<SelfUpdateOptions>) =>
  baseOptions({ platform: process.platform, viaInterpreter: true, pathExists: existsSync, ...overrides });

function npmInstall(layout: "global" | "local") {
  const root = tempDir();
  // npm's global layout is <prefix>/lib/node_modules on Unix, and <prefix>\\node_modules beside a .cmd shim on Windows.
  const windowsGlobal = layout === "global" && process.platform === "win32";
  const modules = layout === "global" && !windowsGlobal ? join(root, "lib", "node_modules") : join(root, "node_modules");
  if (windowsGlobal) writeFileSync(join(root, "linearctl.cmd"), "");
  const packageRoot = join(modules, "@qwrobinson", "linearctl");
  mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "0.10.0" }));
  const script = join(packageRoot, "dist", "cli", "main.js");
  writeFileSync(script, "");
  return { root, packageRoot, script };
}

describe("linearctl --update: npm", () => {
  for (const layout of ["global", "local"] as const) {
    it(`updates a ${layout} install in its own prefix`, async () => {
      const { root, packageRoot, script } = npmInstall(layout);
      const { run, calls } = fakeRun({
        install: () => {
          writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "0.11.0" }));
          return { status: 0, stdout: "changed 1 package", stderr: "" };
        },
      });
      const fetchImpl = (async () => { throw new Error("npm installs must not ask GitHub"); }) as unknown as typeof fetch;
      const result = await selfUpdate(npmOptions({ executablePath: script, runCommand: run, fetchImpl }));
      const expectedArgs = layout === "global"
        ? ["install", "--global", "--prefix", root, "@qwrobinson/linearctl@0.11.0"]
        : ["install", "--prefix", root, "@qwrobinson/linearctl@0.11.0"];
      expect(result).toMatchObject({ status: "updated", updated: true, installMethod: "npm", targetVersion: "0.11.0",
        command: ["npm", ...expectedArgs].join(" ") });
      expect(calls.map((call) => [call.command, ...call.args])).toEqual([
        ["npm", "view", "@qwrobinson/linearctl@latest", "version"],
        ["npm", ...expectedArgs],
      ]);
      expect(calls.every((call) => call.cwd === root)).toBe(true);
    });
  }

  it("is up to date when npm's latest is the installed version", async () => {
    const { script } = npmInstall("global");
    const { run, calls } = fakeRun({ view: () => ({ status: 0, stdout: "0.10.0\n", stderr: "" }) });
    const result = await selfUpdate(npmOptions({ executablePath: script, runCommand: run }));
    expect(result.status).toBe("up-to-date");
    expect(calls).toHaveLength(1);
  });

  it("reports an npm failure with the command to rerun", async () => {
    const { root, script } = npmInstall("global");
    const { run } = fakeRun({ install: () => ({ status: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found" }) });
    const env = capture();
    const code = await handleSelfUpdate(npmOptions({ json: false, jsonEnvelope: true, stdout: env.stream as never,
      executablePath: script, runCommand: run }));
    expect(code).toBe(1);
    const body = JSON.parse(env.text());
    expect(body.ok).toBe(false);
    expect(body.errors[0].message).toBe("npm could not update @qwrobinson/linearctl: npm error code E404 | npm error 404 Not Found");
    expect(body.errors[0].details.recommendation).toBe(`npm install --global --prefix ${root} @qwrobinson/linearctl@0.11.0`);
  });

  it("reports when npm cannot be asked for the latest version", async () => {
    const { script } = npmInstall("global");
    const { run, calls } = fakeRun({ view: () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn npm ENOENT") }) });
    const result = await selfUpdate(npmOptions({ executablePath: script, runCommand: run }));
    expect(result).toMatchObject({ status: "failed", error: "could not ask npm for the latest @qwrobinson/linearctl version: spawn npm ENOENT" });
    expect(calls).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32" || isRoot)("explains a prefix it cannot write instead of running npm", async () => {
    const { root, script } = npmInstall("global");
    chmodSync(join(root, "lib", "node_modules"), 0o555);
    const { run, calls } = fakeRun();
    const result = await selfUpdate(npmOptions({ executablePath: script, runCommand: run }));
    chmodSync(join(root, "lib", "node_modules"), 0o755);
    expect(result.status).toBe("failed");
    expect(result.recommendation).toBe(`Run it with permission to write ${join(root, "lib", "node_modules")} (for example: sudo npm install --global --prefix ${root} @qwrobinson/linearctl@0.11.0)`);
    expect(calls.map((call) => call.args[0])).toEqual(["view"]);
  });
});

describe("linearctl --update: installs it does not own", () => {
  const cases: { name: string; path: string; method: string; next: RegExp; pathExists?: (p: string) => boolean; viaInterpreter?: boolean }[] = [
    { name: "the Debian package", path: "/usr/bin/linearctl", method: "deb", next: /sudo dpkg -i/,
      pathExists: (p) => p === "/var/lib/dpkg/info/linearctl.list" },
    { name: "Homebrew", path: "/opt/homebrew/Cellar/linearctl/0.10.0/bin/linearctl", method: "homebrew", next: /brew upgrade linearctl/ },
    { name: "pnpm", path: "/home/q/.local/share/pnpm/global/5/.pnpm/@qwrobinson+linearctl@0.10.0/node_modules/@qwrobinson/linearctl/dist/cli/main.js",
      method: "pnpm", next: /pnpm add --global/, viaInterpreter: true },
    { name: "an unknown location", path: "/opt/tools/linearctl", method: "unknown", next: /could not tell how it was installed/, viaInterpreter: true },
  ];
  for (const testCase of cases) {
    it(`explains the next step for ${testCase.name} without touching it`, async () => {
      const { fetchImpl, calls } = releaseFetch();
      const { run, calls: runs } = fakeRun();
      const out = capture();
      const code = await handleSelfUpdate(baseOptions({ stdout: out.stream as never, executablePath: testCase.path, fetchImpl,
        runCommand: run, ...(testCase.pathExists ? { pathExists: testCase.pathExists } : {}),
        ...(testCase.viaInterpreter ? { viaInterpreter: true } : {}) }));
      expect(code).toBe(1);
      const result = JSON.parse(out.text());
      expect(result).toMatchObject({ status: "manual", updated: false, installMethod: testCase.method, targetVersion: "0.11.0" });
      expect(result.recommendation).toMatch(testCase.next);
      expect(calls).toEqual([RELEASES_URL]);
      expect(runs).toEqual([]);
    });
  }

  it("is up to date (exit 0) on a managed install that already runs the latest release", async () => {
    const result = await selfUpdate(baseOptions({ executablePath: "/opt/homebrew/Cellar/linearctl/0.11.0/bin/linearctl",
      currentVersion: "0.11.0", fetchImpl: releaseFetch().fetchImpl }));
    expect(result.status).toBe("up-to-date");
  });
});

describe("linearctl --update from the CLI", () => {
  const runtime = (fetchImpl: typeof fetch) => {
    const out = capture();
    const err = capture();
    return { out, err, runtime: { env: {}, stdin: Readable.from([]), stdout: out.stream as never, stderr: err.stream as never, fetchImpl } };
  };

  it("dispatches --update to update install and reports versions", async () => {
    const { out, runtime: rt } = runtime(releaseFetch({ tag: `v${packageJson.version}` }).fetchImpl);
    const code = await main(["--update", "--json"], rt);
    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toMatchObject({ status: "up-to-date", currentVersion: packageJson.version, targetVersion: packageJson.version });
  });

  it("rejects --update attached to another command", async () => {
    const { err, runtime: rt } = runtime(releaseFetch().fetchImpl);
    expect(await main(["issue", "list", "--update"], rt)).toBe(5);
    expect(err.text()).toContain("--update");
  });
});
