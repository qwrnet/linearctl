import { describe, expect, it } from "vitest";
import { checkForUpdate, compareVersions, detectInstallMethod, handleUpdateCommand, INSTALL_COMMAND, INSTALLER_URL } from "../../src/commands/update.js";

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

  it("recommends the install method's own update path, and nothing when current", async () => {
    const npm = "/x/node_modules/@qwrobinson/linearctl/dist/cli.js";
    const newer = await checkForUpdate({ fetchImpl: release("v0.9.0"), executablePath: npm, currentVersion: "0.8.13" });
    expect(newer).toEqual({ currentVersion: "0.8.13", latestVersion: "0.9.0", updateAvailable: true,
      installMethod: "npm", recommendation: "npm install -g @qwrobinson/linearctl@latest" });
    const binary = await checkForUpdate({ fetchImpl: release("v0.9.0"), executablePath: "/home/q/.local/bin/linearctl",
      currentVersion: "0.8.13", pathExists: () => false });
    expect(binary.recommendation).toBe(
      `Rerun the installer: curl -fsSL ${INSTALLER_URL} | LINEAR_NO_DEB=1 LINEAR_INSTALL_DIR='/home/q/.local/bin' sh`);
    const custom = await checkForUpdate({ fetchImpl: release("v0.9.0"), executablePath: "/opt/my tools/it's/linearctl",
      currentVersion: "0.8.13", pathExists: () => false });
    expect(custom.recommendation).toContain(`LINEAR_INSTALL_DIR='/opt/my tools/it'\\''s' sh`);
    const deb = await checkForUpdate({ fetchImpl: release("v0.9.0"), executablePath: "/usr/bin/linearctl",
      currentVersion: "0.8.13", pathExists: (p) => p === "/var/lib/dpkg/info/linearctl.list" });
    expect(deb.recommendation).toBe(`Rerun the installer, which installs the new .deb: ${INSTALL_COMMAND}`);
    const windows = await checkForUpdate({ fetchImpl: release("v0.9.0"), executablePath: "C:\\Users\\q\\bin\\linearctl.exe",
      currentVersion: "0.8.13", pathExists: () => false, platform: "win32" });
    expect(windows.recommendation).toContain("install.ps1");
    const current = await checkForUpdate({ fetchImpl: release("v0.8.13"), executablePath: npm, currentVersion: "0.8.13" });
    expect(current.updateAvailable).toBe(false);
    expect(current.recommendation).toBe("Up to date");
  });

  it("reports an unreachable release check without guessing", async () => {
    const result = await checkForUpdate({ fetchImpl: release("", 503), executablePath: "/home/q/.local/bin/linearctl",
      currentVersion: "0.8.13", pathExists: () => false });
    expect(result.latestVersion).toBeNull();
    expect(result.updateAvailable).toBeNull();
    expect(result.error).toBe("GitHub answered 503");
  });

  it("prints stable JSON and a usage error for anything but check", async () => {
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
    for (const args of [[], ["now"], ["check", "extra"]]) {
      const usage = capture();
      expect(await handleUpdateCommand(args, { json: false, jsonEnvelope: true, stdout: usage.stream as never })).toBe(5);
      const body = JSON.parse(usage.chunks.join(""));
      expect(body.ok).toBe(false);
      expect(body.errors[0]).toMatchObject({ category: "validation", message: "usage: linearctl update check [--json]" });
    }
  });
});
