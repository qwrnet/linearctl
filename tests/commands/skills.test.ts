import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSkillsCommand } from "../../src/commands/skills.js";
import { EMBEDDED_SKILLS } from "../../src/generated/embedded-skills.js";

function baseOptions(overrides = {}) {
  return {
    json: true,
    jsonEnvelope: false,
    ...overrides
  };
}

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return { chunks, spy };
}

function captureStderr() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { chunks, spy };
}

describe("handleSkillsCommand", () => {
  const originalPiDir = process.env.PI_CODING_AGENT_DIR;
  beforeEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
  });
  afterEach(() => {
    if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
  });

  describe("skills list", () => {
    it("returns embedded skill names in json mode", async () => {
      const { chunks, spy } = captureStdout();

      try {
        const code = await handleSkillsCommand(["list"], baseOptions());
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(Object.keys(EMBEDDED_SKILLS).length);

        const names = parsed.map((entry: { name: string }) => entry.name);
        expect(names).toContain("linearctl");
        expect(names).toContain("linearctl-raw-gql");
      } finally {
        spy.mockRestore();
      }
    });

    it("returns filenames in list entries", async () => {
      const { chunks, spy } = captureStdout();

      try {
        await handleSkillsCommand(["list"], baseOptions());
        const parsed = JSON.parse(chunks.join(""));
        for (const entry of parsed) {
          expect(entry.filename).toMatch(/\.md$/);
        }
      } finally {
        spy.mockRestore();
      }
    });

    it("prints human-readable output without --json", async () => {
      const { chunks, spy } = captureStdout();

      try {
        const code = await handleSkillsCommand(["list"], baseOptions({ json: false }));
        expect(code).toBe(0);

        const output = chunks.join("");
        expect(output).toContain("linearctl");
        expect(output).toContain("linearctl-raw-gql");
      } finally {
        spy.mockRestore();
      }
    });

    it("reports install paths and whether each known target is up to date", async () => {
      const tempHome = await mkdtemp(join(tmpdir(), "linearctl-skills-list-home-"));
      const tempProject = await mkdtemp(join(tmpdir(), "linearctl-skills-list-project-"));
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();
      process.env.HOME = tempHome;
      process.chdir(tempProject);

      const currentPath = join(tempHome, ".claude", "skills", "linearctl", "SKILL.md");
      const stalePath = join(process.cwd(), ".codex", "skills", "linearctl-raw-gql", "SKILL.md");
      const brokenPath = join(process.cwd(), ".claude", "skills", "linearctl", "SKILL.md");
      await mkdir(join(currentPath, ".."), { recursive: true });
      await mkdir(join(stalePath, ".."), { recursive: true });
      await mkdir(brokenPath, { recursive: true });
      await writeFile(currentPath, EMBEDDED_SKILLS.linearctl!.content, "utf8");
      await writeFile(stalePath, "stale skill content\n", "utf8");

      const { chunks, spy } = captureStdout();

      try {
        const code = await handleSkillsCommand(["list"], baseOptions());
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        const linearctl = parsed.find((entry: { name: string }) => entry.name === "linearctl");
        expect(linearctl.installs).toHaveLength(8);
        expect(linearctl.installs).toContainEqual({
          tool: "claude",
          scope: "user",
          path: currentPath,
          installed: true,
          upToDate: true
        });
        expect(linearctl.installs).toContainEqual({
          tool: "codex",
          scope: "user",
          path: join(tempHome, ".codex", "skills", "linearctl", "SKILL.md"),
          installed: false,
          upToDate: false
        });
        expect(linearctl.installs).toContainEqual({
          tool: "claude",
          scope: "project",
          path: brokenPath,
          installed: true,
          upToDate: false,
          error: expect.stringContaining("EISDIR")
        });

        expect(linearctl.installs).toContainEqual({
          tool: "pi",
          scope: "user",
          path: join(tempHome, ".pi", "agent", "skills", "linearctl", "SKILL.md"),
          installed: false,
          upToDate: false
        });
        expect(linearctl.installs).toContainEqual({
          tool: "pi",
          scope: "project",
          path: join(process.cwd(), ".pi", "skills", "linearctl", "SKILL.md"),
          installed: false,
          upToDate: false
        });
        expect(linearctl.installs).toContainEqual({
          tool: "antigravity",
          scope: "user",
          path: join(tempHome, ".gemini", "config", "skills", "linearctl", "SKILL.md"),
          installed: false,
          upToDate: false
        });
        expect(linearctl.installs).toContainEqual({
          tool: "antigravity",
          scope: "project",
          path: join(process.cwd(), ".agents", "skills", "linearctl", "SKILL.md"),
          installed: false,
          upToDate: false
        });
        // The original records keep their positions; pi and antigravity records are appended.
        expect(linearctl.installs.map((install: { tool: string; scope: string }) => `${install.tool}:${install.scope}`)).toEqual([
          "claude:user", "codex:user", "claude:project", "codex:project",
          "pi:user", "pi:project", "antigravity:user", "antigravity:project"
        ]);
        for (const install of linearctl.installs) {
          expect(Object.keys(install).sort()).toEqual(
            install.error === undefined
              ? ["installed", "path", "scope", "tool", "upToDate"]
              : ["error", "installed", "path", "scope", "tool", "upToDate"]
          );
        }

        const rawGql = parsed.find((entry: { name: string }) => entry.name === "linearctl-raw-gql");
        expect(rawGql.installs).toContainEqual({
          tool: "codex",
          scope: "project",
          path: stalePath,
          installed: true,
          upToDate: false
        });
      } finally {
        spy.mockRestore();
        process.chdir(originalCwd);
        process.env.HOME = originalHome;
      }
    });
  });

  describe("skills install", () => {
    it("installs to project level with --scope project", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linearctl-skills-"));
      const originalCwd = process.cwd();
      process.chdir(tempDir);

      const { chunks, spy: stdoutSpy } = captureStdout();
      const skillCount = Object.keys(EMBEDDED_SKILLS).length;

      try {
        const code = await handleSkillsCommand(["install"], baseOptions({ scope: "project" }));
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        // Project installs to .claude, .codex, .pi, and .agents
        expect(parsed.targets).toHaveLength(4);
        expect(parsed.installed).toHaveLength(skillCount * 4);

        // Verify directory structure: <name>/SKILL.md
        for (const entry of parsed.installed) {
          expect(entry.path).toContain("SKILL.md");
          const content = await readFile(entry.path, "utf8");
          expect(content).toBe(EMBEDDED_SKILLS[entry.name]!.content);
        }

        // Verify all agent dirs were created
        expect(existsSync(join(tempDir, ".claude", "skills"))).toBe(true);
        expect(existsSync(join(tempDir, ".codex", "skills"))).toBe(true);
        expect(existsSync(join(tempDir, ".pi", "skills", "linearctl", "SKILL.md"))).toBe(true);
        expect(existsSync(join(tempDir, ".agents", "skills", "linearctl", "SKILL.md"))).toBe(true);
        expect(parsed.installed).toContainEqual(expect.objectContaining({
          agent: "pi", scope: "project", displayName: "pi (project)"
        }));
        expect(parsed.installed).toContainEqual(expect.objectContaining({
          agent: "antigravity", scope: "project", displayName: "antigravity (project)"
        }));
      } finally {
        stdoutSpy.mockRestore();
        process.chdir(originalCwd);
      }
    });

    it("installs to user level with --scope user", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linearctl-skills-user-"));
      const originalHome = process.env.HOME;
      process.env.HOME = tempDir;

      const { chunks, spy: stdoutSpy } = captureStdout();
      const skillCount = Object.keys(EMBEDDED_SKILLS).length;

      try {
        const code = await handleSkillsCommand(["install"], baseOptions({ scope: "user" }));
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        // User level installs to .claude, .codex, pi, and antigravity when none is detected
        expect(parsed.targets).toHaveLength(4);
        expect(parsed.installed).toHaveLength(skillCount * 4);
        expect(parsed.targets).toContain(join(tempDir, ".pi", "agent", "skills"));
        expect(parsed.targets).toContain(join(tempDir, ".gemini", "config", "skills"));

        for (const entry of parsed.installed) {
          expect(entry.path).toContain(tempDir);
          expect(entry.path).toContain("SKILL.md");
          const content = await readFile(entry.path, "utf8");
          expect(content).toBe(EMBEDDED_SKILLS[entry.name]!.content);
        }
      } finally {
        stdoutSpy.mockRestore();
        process.env.HOME = originalHome;
      }
    });

    it("user level only installs to detected agents", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linearctl-skills-detect-"));
      await mkdir(join(tempDir, ".claude"), { recursive: true });
      // No .codex dir
      const originalHome = process.env.HOME;
      process.env.HOME = tempDir;

      const { chunks, spy: stdoutSpy } = captureStdout();
      const skillCount = Object.keys(EMBEDDED_SKILLS).length;

      try {
        const code = await handleSkillsCommand(["install"], baseOptions({ scope: "user" }));
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        // Only claude detected
        expect(parsed.targets).toHaveLength(1);
        expect(parsed.installed).toHaveLength(skillCount);
        expect(parsed.targets[0]).toContain(".claude");
      } finally {
        stdoutSpy.mockRestore();
        process.env.HOME = originalHome;
      }
    });

    it("user level installs to pi when ~/.pi/agent exists", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linearctl-skills-pi-"));
      await mkdir(join(tempDir, ".pi", "agent"), { recursive: true });
      const originalHome = process.env.HOME;
      process.env.HOME = tempDir;

      const { chunks, spy: stdoutSpy } = captureStdout();

      try {
        const code = await handleSkillsCommand(["install"], baseOptions({ scope: "user" }));
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        expect(parsed.targets).toEqual([join(tempDir, ".pi", "agent", "skills")]);
        for (const name of Object.keys(EMBEDDED_SKILLS)) {
          const path = join(tempDir, ".pi", "agent", "skills", name, "SKILL.md");
          expect(await readFile(path, "utf8")).toBe(EMBEDDED_SKILLS[name]!.content);
        }
      } finally {
        stdoutSpy.mockRestore();
        process.env.HOME = originalHome;
      }
    });

    it("follows PI_CODING_AGENT_DIR for pi's user directory in install and list", async () => {
      const tempHome = await mkdtemp(join(tmpdir(), "linearctl-skills-pi-env-"));
      const piDir = join(tempHome, "custom-pi");
      await mkdir(piDir, { recursive: true });
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;
      process.env.PI_CODING_AGENT_DIR = "~/custom-pi";

      const install = captureStdout();
      try {
        expect(await handleSkillsCommand(["install"], baseOptions({ scope: "user" }))).toBe(0);
      } finally {
        install.spy.mockRestore();
      }
      expect(JSON.parse(install.chunks.join("")).targets).toEqual([join(piDir, "skills")]);

      const list = captureStdout();
      try {
        expect(await handleSkillsCommand(["list"], baseOptions())).toBe(0);
      } finally {
        list.spy.mockRestore();
        process.env.HOME = originalHome;
      }
      const linearctl = JSON.parse(list.chunks.join("")).find((entry: { name: string }) => entry.name === "linearctl");
      expect(linearctl.installs).toContainEqual({
        tool: "pi",
        scope: "user",
        path: join(piDir, "skills", "linearctl", "SKILL.md"),
        installed: true,
        upToDate: true
      });
    });

    it.each([
      [".gemini", "config"],
      [".gemini", "antigravity"],
      [".gemini", "antigravity-cli"],
      [".gemini", "antigravity-ide"]
    ])("user level installs to antigravity when ~/%s/%s exists", async (...parts) => {
      const tempDir = await mkdtemp(join(tmpdir(), "linearctl-skills-antigravity-"));
      await mkdir(join(tempDir, ...parts), { recursive: true });
      const originalHome = process.env.HOME;
      process.env.HOME = tempDir;

      const install = captureStdout();
      try {
        const code = await handleSkillsCommand(["install"], baseOptions({ scope: "user" }));
        expect(code).toBe(0);
      } finally {
        install.spy.mockRestore();
      }

      const expectedSkillsDir = join(tempDir, ".gemini", "config", "skills");
      try {
        const parsed = JSON.parse(install.chunks.join(""));
        expect(parsed.targets).toEqual([expectedSkillsDir]);
        for (const name of Object.keys(EMBEDDED_SKILLS)) {
          const path = join(expectedSkillsDir, name, "SKILL.md");
          expect(await readFile(path, "utf8")).toBe(EMBEDDED_SKILLS[name]!.content);
          expect(parsed.installed).toContainEqual({
            name,
            filename: "SKILL.md",
            path,
            agent: "antigravity",
            scope: "user",
            displayName: "antigravity (user)"
          });
        }

        const list = captureStdout();
        try {
          expect(await handleSkillsCommand(["list"], baseOptions())).toBe(0);
        } finally {
          list.spy.mockRestore();
        }
        const linearctl = JSON.parse(list.chunks.join("")).find((entry: { name: string }) => entry.name === "linearctl");
        expect(linearctl.installs).toContainEqual({
          tool: "antigravity",
          scope: "user",
          path: join(expectedSkillsDir, "linearctl", "SKILL.md"),
          installed: true,
          upToDate: true
        });
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it("user level ignores bare ~/.gemini without antigravity directories", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linearctl-skills-bare-gemini-"));
      await mkdir(join(tempDir, ".claude"), { recursive: true });
      await mkdir(join(tempDir, ".gemini"), { recursive: true });
      const originalHome = process.env.HOME;
      process.env.HOME = tempDir;

      const { chunks, spy: stdoutSpy } = captureStdout();

      try {
        const code = await handleSkillsCommand(["install"], baseOptions({ scope: "user" }));
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        expect(parsed.targets).toEqual([join(tempDir, ".claude", "skills")]);
        expect(existsSync(join(tempDir, ".gemini", "config", "skills"))).toBe(false);
      } finally {
        stdoutSpy.mockRestore();
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it("json mode defaults to project scope without prompting", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linearctl-skills-json-"));
      const originalCwd = process.cwd();
      process.chdir(tempDir);

      const { chunks, spy: stdoutSpy } = captureStdout();

      try {
        const code = await handleSkillsCommand(["install"], baseOptions());
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        // Defaults to project scope
        expect(parsed.targets.some((t: string) => t.includes(".claude"))).toBe(true);
      } finally {
        stdoutSpy.mockRestore();
        process.chdir(originalCwd);
      }
    });
  });

  it("embeds SKILL.md frontmatter that pi and Google Antigravity's Agent Skills loaders accept", () => {
    for (const [dirName, skill] of Object.entries(EMBEDDED_SKILLS)) {
      const match = /^---\n([\s\S]*?)\n---\n/.exec(skill.content);
      expect(match, `${dirName} has no frontmatter block`).not.toBeNull();
      const fields: Record<string, string> = Object.fromEntries(
        match![1]!.split("\n").map((line) => {
          const index = line.indexOf(":");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        })
      );
      // Names: lowercase letters, digits and single hyphens, at most 64 chars, matching the directory.
      expect(fields.name ?? "").toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect((fields.name ?? "").length).toBeLessThanOrEqual(64);
      expect(fields.name).toBe(dirName);
      // Descriptions are required and at most 1024 chars.
      expect((fields.description ?? "").length).toBeGreaterThan(0);
      expect((fields.description ?? "").length).toBeLessThanOrEqual(1024);
    }
  });

  it("rejects unknown subcommand", async () => {
    const { spy: stdoutSpy } = captureStdout();
    const { chunks: stderrChunks, spy: stderrSpy } = captureStderr();

    try {
      const code = await handleSkillsCommand(["unknown"], baseOptions());
      expect(code).toBe(5);
      expect(stderrChunks.join("")).toContain("usage:");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("rejects no subcommand", async () => {
    const { spy: stdoutSpy } = captureStdout();
    const { chunks: stderrChunks, spy: stderrSpy } = captureStderr();

    try {
      const code = await handleSkillsCommand([], baseOptions());
      expect(code).toBe(5);
      expect(stderrChunks.join("")).toContain("usage:");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
