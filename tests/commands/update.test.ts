import { describe, expect, it } from "vitest";
import {
  binaryInstallCommand, checkForUpdate, compareVersions, detectInstallation, detectInstallMethod, handleUpdateCommand,
  INSTALL_COMMAND, INSTALLER_URL, manualRecommendation,
} from "../../src/commands/update.js";

function release(tag: string, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify({ tag_name: tag }), { status })) as unknown as typeof fetch;
}

function capture() {
  const chunks: string[] = [];
  return { chunks, stream: { write: (chunk: string) => { chunks.push(chunk); return true; } } };
}

describe("update check", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("0.8.14", "0.8.13")).toBe(1);
    expect(compareVersions("v0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.8.13", "v0.8.13")).toBe(0);
    expect(compareVersions("0.8.13-rc1", "0.8.13")).toBe(0);
    expect(compareVersions("0.8", "0.8.1")).toBe(-1);
  });

  it("detects how linearctl was installed", () => {
    const none = () => false;
    expect(detectInstallMethod("/home/q/.npm-global/lib/node_modules/@qwrobinson/linearctl/dist/cli.js", none)).toBe("npm");
    expect(detectInstallMethod("/opt/homebrew/Cellar/linearctl/0.8.13/bin/linearctl", none)).toBe("homebrew");
    expect(detectInstallMethod("/home/q/src/linearctl/src/index.ts", none)).toBe("source");
    expect(detectInstallMethod("/home/q/code/linearctl/src/cli/main.ts", none)).toBe("source");
    expect(detectInstallMethod("/home/q/code/linearctl/dist/cli/main.js", none)).toBe("source");
    expect(detectInstallMethod("/home/q/.local/bin/linearctl", none)).toBe("binary");
    expect(detectInstallMethod("/usr/bin/linearctl", (p) => p === "/var/lib/dpkg/info/linearctl.list")).toBe("deb");
    expect(detectInstallMethod("/usr/bin/linearctl", (p) => p === "/var/lib/pacman/local",
      () => ["glibc-2.40-1", "linearctl-0.8.13-1"])).toBe("aur");
    expect(detectInstallMethod("/usr/bin/linearctl", none)).toBe("binary");
  });

  it("detects npm scope and prefix, other JS package managers and unknown installs", () => {
    const none = () => false;
    const pkg = "node_modules/@qwrobinson/linearctl";
    expect(detectInstallation(`/usr/local/lib/${pkg}/dist/cli/main.js`, { platform: "linux" }).npm)
      .toEqual({ scope: "global", prefix: "/usr/local", packageRoot: `/usr/local/lib/${pkg}` });
    expect(detectInstallation(`/home/q/app/${pkg}/dist/cli/main.js`, { platform: "linux" }).npm)
      .toEqual({ scope: "local", prefix: "/home/q/app", packageRoot: `/home/q/app/${pkg}` });
    const windowsGlobal = detectInstallation(`C:\\Users\\q\\AppData\\Roaming\\npm\\${pkg.replace(/\//g, "\\")}\\dist\\cli\\main.js`,
      { platform: "win32", pathExists: (p) => p === "C:\\Users\\q\\AppData\\Roaming\\npm\\linearctl.cmd" });
    expect(windowsGlobal.npm).toEqual({ scope: "global", prefix: "C:\\Users\\q\\AppData\\Roaming\\npm",
      packageRoot: `C:\\Users\\q\\AppData\\Roaming\\npm\\node_modules\\@qwrobinson\\linearctl` });
    expect(detectInstallation(`C:\\code\\app\\${pkg}\\dist\\cli\\main.js`, { platform: "win32", pathExists: none }).npm?.scope).toBe("local");
    expect(detectInstallMethod(`/home/q/.npm/_npx/1a2b/${pkg}/dist/cli/main.js`, none)).toBe("npx");
    expect(detectInstallMethod(`/home/q/.local/share/pnpm/global/5/.pnpm/@qwrobinson+linearctl@0.9.0/${pkg}/dist/cli/main.js`, none)).toBe("pnpm");
    expect(detectInstallMethod(`/home/q/.config/yarn/global/${pkg}/dist/cli/main.js`, none)).toBe("yarn");
    expect(detectInstallMethod(`/home/q/.bun/install/global/${pkg}/dist/cli/main.js`, none)).toBe("bun");
    expect(detectInstallMethod("/nix/store/abc-linearctl-0.9.0/bin/linearctl", none)).toBe("nix");
    // Run by node or bun from somewhere that is neither a checkout nor a package: unknown, never "binary".
    expect(detectInstallation("/opt/tools/linearctl", { viaInterpreter: true, pathExists: none }).method).toBe("unknown");
    expect(detectInstallation("/opt/tools/linearctl", { viaInterpreter: false, pathExists: none }).method).toBe("binary");
  });

  it("recommends linearctl --update where it can update itself, and the owner's tool elsewhere", async () => {
    const npm = "/usr/local/lib/node_modules/@qwrobinson/linearctl/dist/cli/main.js";
    const newer = await checkForUpdate({ fetchImpl: release("v0.9.0"), executablePath: npm, currentVersion: "0.8.13" });
    expect(newer).toEqual({ currentVersion: "0.8.13", latestVersion: "0.9.0", updateAvailable: true,
      installMethod: "npm", recommendation: "linearctl --update" });
    const binary = await checkForUpdate({ fetchImpl: release("v0.9.0"), executablePath: "/home/q/.local/bin/linearctl",
      currentVersion: "0.8.13", pathExists: () => false, platform: "linux" });
    expect(binary.recommendation).toBe("linearctl --update");
    const deb = await checkForUpdate({ fetchImpl: release("v0.9.0"), executablePath: "/usr/bin/linearctl",
      currentVersion: "0.8.13", pathExists: (p) => p === "/var/lib/dpkg/info/linearctl.list" });
    expect(deb.recommendation).toContain(INSTALL_COMMAND);
    expect(deb.installMethod).toBe("deb");
    const current = await checkForUpdate({ fetchImpl: release("v0.8.13"), executablePath: npm, currentVersion: "0.8.13" });
    expect(current.updateAvailable).toBe(false);
    expect(current.recommendation).toBe("Up to date");
  });

  it("keeps the installer command as the manual fallback for raw binaries", () => {
    expect(manualRecommendation({ method: "binary", executable: "/home/q/.local/bin/linearctl" }, "linux")).toBe(
      `Rerun the installer: curl -fsSL ${INSTALLER_URL} | LINEAR_NO_DEB=1 LINEAR_INSTALL_DIR='/home/q/.local/bin' sh`);
    expect(manualRecommendation({ method: "binary", executable: "/opt/my tools/it's/linearctl" }, "linux"))
      .toContain(`LINEAR_INSTALL_DIR='/opt/my tools/it'\\''s' sh`);
    expect(manualRecommendation({ method: "binary", executable: "C:\\Users\\q\\bin\\linearctl.exe" }, "win32")).toContain("install.ps1");
    expect(binaryInstallCommand("/x/linearctl")).toContain("LINEAR_INSTALL_DIR='/x'");
  });

  it("reports an unreachable release check without guessing", async () => {
    const result = await checkForUpdate({ fetchImpl: release("", 503), executablePath: "/home/q/.local/bin/linearctl",
      currentVersion: "0.8.13", pathExists: () => false });
    expect(result.latestVersion).toBeNull();
    expect(result.updateAvailable).toBeNull();
    expect(result.error).toBe("GitHub answered 503");
  });

  it("prints stable JSON and a usage error for anything but check or install", async () => {
    const out = capture();
    const code = await handleUpdateCommand(["check"], { json: true, jsonEnvelope: false, stdout: out.stream as never,
      fetchImpl: release("v0.9.0"), executablePath: "/home/q/.local/bin/linearctl", currentVersion: "0.8.13",
      pathExists: () => false });
    expect(code).toBe(0);
    expect(Object.keys(JSON.parse(out.chunks.join("")))).toEqual(
      ["currentVersion", "latestVersion", "updateAvailable", "installMethod", "recommendation"]);
    const envelope = capture();
    await handleUpdateCommand(["check"], { json: false, jsonEnvelope: true, stdout: envelope.stream as never,
      fetchImpl: release("", 503), executablePath: "/home/q/.local/bin/linearctl", currentVersion: "0.8.13",
      pathExists: () => false });
    const failed = JSON.parse(envelope.chunks.join(""));
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).toMatchObject({ category: "general", message: "GitHub answered 503" });
    expect(failed.meta.sourceLayer).toBe("curated");
    const err = capture();
    expect(await handleUpdateCommand(["now"], { json: false, jsonEnvelope: false, stderr: err.stream as never })).toBe(5);
    expect(err.chunks.join("")).toContain("linearctl update check");
    for (const args of [[], ["now"], ["check", "extra"], ["install", "extra"]]) {
      const usage = capture();
      expect(await handleUpdateCommand(args, { json: false, jsonEnvelope: true, stdout: usage.stream as never })).toBe(5);
      const body = JSON.parse(usage.chunks.join(""));
      expect(body.ok).toBe(false);
      expect(body.errors[0]).toMatchObject({ category: "validation", message: "usage: linearctl update check [--json] | linearctl update install [--dry-run] [--json] (alias: linearctl --update)" });
    }
  });
});
