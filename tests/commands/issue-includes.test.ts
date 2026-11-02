import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleIssueCommand } from "../../src/commands/issue.js";
import { writeCredentialsFile } from "../../src/core/auth/credentials.js";
import { writeLinearConfigFile } from "../../src/core/config/config-file.js";
import type { FetchLike } from "../../src/core/transport/graphql.js";

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  return {
    stdout,
    stderr,
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  };
}

async function baseOptions() {
  const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-includes-"));
  const configFile = join(directory, "config");
  const credentialsFile = join(directory, "credentials");
  await writeLinearConfigFile(configFile, { defaultProfile: "work", profiles: { work: {} } });
  await writeCredentialsFile(credentialsFile, {
    profiles: { work: { profileName: "work", type: "api_key", apiKey: "lin_api_work" } }
  });
  return { json: true, jsonEnvelope: false, configFile, credentialsFile, env: {} };
}

const started = { id: "state-started", name: "In Progress", type: "started" };
const done = { id: "state-done", name: "Done", type: "completed" };
const todo = { id: "state-todo", name: "Todo", type: "unstarted" };

function linked(identifier: string, state: typeof started) {
  return { id: `${identifier}-id`, identifier, title: `${identifier} title`, state };
}

function child(identifier: string, subIssueSortOrder: number | null, state: typeof started) {
  return { ...linked(identifier, state), sortOrder: -subIssueSortOrder!, subIssueSortOrder };
}

function makeRawIssue(overrides?: Record<string, unknown>) {
  return {
    id: "issue-uuid-1",
    identifier: "INF-2",
    title: "Fix login",
    description: null,
    priority: 2,
    estimate: null,
    dueDate: null,
    state: todo,
    team: { id: "team-1", key: "INF", name: "Infrastructure" },
    assignee: null,
    creator: null,
    cycle: null,
    project: null,
    projectMilestone: null,
    parent: { id: "parent-id", identifier: "INF-1", title: "Parent" },
    labels: { nodes: [] },
    url: "https://linear.app/team/issue/INF-2",
    trashed: false,
    archivedAt: null,
    createdAt: "2026-04-09T10:00:00Z",
    updatedAt: "2026-04-09T11:00:00Z",
    ...overrides
  };
}

function includeFields(hasMore = false) {
  return {
    relations: {
      nodes: [
        { id: "rel-blocks", type: "blocks", relatedIssue: linked("INF-9", todo) },
        { id: "rel-related", type: "related", relatedIssue: linked("INF-8", todo) }
      ],
      pageInfo: { hasNextPage: false }
    },
    inverseRelations: {
      nodes: [
        { id: "rel-blocked-by", type: "blocks", issue: linked("INF-5", started) },
        { id: "rel-duplicate", type: "duplicate", issue: linked("INF-6", done) }
      ],
      pageInfo: { hasNextPage: hasMore }
    },
    subIssueSortOrder: 20,
    children: {
      nodes: [child("INF-12", 200, todo), child("INF-11", 100, done), child("INF-13", null, todo)],
      pageInfo: { hasNextPage: false }
    },
    parentChildren: {
      children: {
        nodes: [child("INF-3", 30, todo), { ...child("INF-2", 20, todo), id: "issue-uuid-1" }, child("INF-4", 10, done)],
        pageInfo: { hasNextPage: false }
      }
    }
  };
}

const RELATION_FIELDS = ["relations", "inverseRelations"];
const CHILDREN_FIELDS = ["subIssueSortOrder", "children", "parentChildren"];

function onlyFields(fields: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => keys.includes(key)));
}

function fetchReturning(...bodies: unknown[]): FetchLike {
  const fn = vi.fn<FetchLike>();
  for (const body of bodies) {
    fn.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
  }
  return fn as FetchLike;
}

function requestBody(fetchImpl: FetchLike, call = 0): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[call]?.[1]?.body));
}

describe("issue get --with", () => {
  it("keeps the default payload and query unchanged without --with", async () => {
    const fetchImpl = fetchReturning({ data: { issue: makeRawIssue() } });
    const output = captureOutput();
    try {
      expect(await handleIssueCommand(["get", "INF-2"], { ...(await baseOptions()), fetchImpl })).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      for (const key of ["relations", "children", "siblings", "subIssueSortOrder", "comments"]) {
        expect(parsed).not.toHaveProperty(key);
      }
      const { query } = requestBody(fetchImpl);
      expect(query).not.toContain("inverseRelations");
      expect(query).not.toContain("children");
      expect(query).not.toContain("comments");
    } finally {
      output.restore();
    }
  });

  it("returns blocking relations in both directions, ordered children and siblings, and recent comments", async () => {
    const fetchImpl = fetchReturning({
      data: {
        issue: makeRawIssue({
          ...includeFields(),
          comments: {
            nodes: [{ id: "c-2", body: "newest", createdAt: "2026-04-10T00:00:00Z", user: null }],
            pageInfo: { hasNextPage: true }
          }
        })
      }
    });
    const output = captureOutput();
    try {
      const exitCode = await handleIssueCommand(["get", "INF-2"], {
        ...(await baseOptions()),
        with: "relations, children,comments",
        fetchImpl
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.relations).toEqual({
        blocks: [{ relationId: "rel-blocks", issue: linked("INF-9", todo) }],
        blockedBy: [{ relationId: "rel-blocked-by", issue: linked("INF-5", started) }],
        truncated: false
      });
      expect(parsed.subIssueSortOrder).toBe(20);
      expect(parsed.children.nodes.map((node: { identifier: string }) => node.identifier)).toEqual(["INF-11", "INF-12", "INF-13"]);
      expect(parsed.children.nodes[0]).toEqual(child("INF-11", 100, done));
      expect(parsed.children.truncated).toBe(false);
      expect(parsed.siblings.nodes.map((node: { identifier: string }) => node.identifier)).toEqual(["INF-4", "INF-3"]);
      expect(parsed.comments).toEqual({
        nodes: [{ id: "c-2", body: "newest", createdAt: "2026-04-10T00:00:00Z", user: null }],
        truncated: true
      });
      expect(parsed).not.toHaveProperty("inverseRelations");
      expect(parsed).not.toHaveProperty("parentChildren");

      const { query } = requestBody(fetchImpl);
      expect(query).toContain("relations(first: 50)");
      expect(query).toContain("inverseRelations(first: 50)");
      expect(query).toContain("children(first: 100)");
      expect(query).toContain("parentChildren: parent");
      expect(query).toContain("comments(first: 20, orderBy: createdAt)");
    } finally {
      output.restore();
    }
  });

  it("reports siblings as null for an issue without a parent and truncation of relations", async () => {
    const fetchImpl = fetchReturning({
      data: { issue: makeRawIssue({ ...includeFields(true), parent: null, parentChildren: null }) }
    });
    const output = captureOutput();
    try {
      const exitCode = await handleIssueCommand(["get", "INF-2"], {
        ...(await baseOptions()),
        with: "children,relations",
        fetchImpl
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.siblings).toBeNull();
      expect(parsed.relations.truncated).toBe(true);
      expect(parsed).not.toHaveProperty("comments");
    } finally {
      output.restore();
    }
  });

  it("prints blockers, blocked issues, children and comment count in human output", async () => {
    const fetchImpl = fetchReturning({
      data: { issue: makeRawIssue({ ...includeFields(), comments: { nodes: [], pageInfo: { hasNextPage: false } } }) }
    });
    const output = captureOutput();
    try {
      const options = { ...(await baseOptions()), json: false, with: "relations,children,comments", fetchImpl };
      expect(await handleIssueCommand(["get", "INF-2"], options)).toBe(0);
      const text = output.stdout.join("");
      expect(text).toContain("Blocked by: INF-5 (started)");
      expect(text).toContain("Blocks:   INF-9 (unstarted)");
      expect(text).toContain("Children: INF-11 (completed), INF-12 (unstarted), INF-13 (unstarted)");
      expect(text).toContain("Comments: 0");
    } finally {
      output.restore();
    }
  });

  it.each(["", "bogus", "relations,bogus"])("rejects --with %j without calling the API", async (value) => {
    const fetchImpl = fetchReturning();
    const output = captureOutput();
    try {
      const exitCode = await handleIssueCommand(["get", "INF-2"], { ...(await baseOptions()), with: value, fetchImpl });
      expect(exitCode).toBe(5);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });
});

describe("issue list --with", () => {
  it("adds relations and children with one request per page and smaller pages for --all", async () => {
    const page = (nodes: unknown[], hasNextPage: boolean) => ({
      data: { issues: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor-1" : null } } }
    });
    const fetchImpl = fetchReturning(
      page([makeRawIssue(includeFields())], true),
      page([makeRawIssue({ ...includeFields(), id: "issue-uuid-2", identifier: "INF-7" })], false)
    );
    const output = captureOutput();
    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...(await baseOptions()),
        all: true,
        with: "relations,children",
        fetchImpl
      });
      expect(exitCode).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.map((issue: { identifier: string }) => issue.identifier)).toEqual(["INF-2", "INF-7"]);
      expect(parsed[0].relations.blockedBy[0].issue.identifier).toBe("INF-5");
      expect(parsed[1].siblings.nodes.map((node: { identifier: string }) => node.identifier)).toEqual(["INF-4", "INF-2", "INF-3"]);

      const first = requestBody(fetchImpl, 0);
      expect(first.variables.first).toBe(100);
      expect(first.query).toContain("inverseRelations(first: 50)");
      expect(first.query).toContain("children(first: 100)");
      expect(first.query).not.toContain("comments");
      expect(requestBody(fetchImpl, 1).variables.after).toBe("cursor-1");
    } finally {
      output.restore();
    }
  });

  it("keeps an explicit --page-size and the default page size without --all", async () => {
    const page = { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    const fetchImpl = fetchReturning(page, page, page);
    const output = captureOutput();
    try {
      const options = await baseOptions();
      expect(await handleIssueCommand(["list"], { ...options, all: true, pageSize: 250, with: "relations", fetchImpl })).toBe(0);
      expect(await handleIssueCommand(["list"], { ...options, with: "relations", fetchImpl })).toBe(0);
      expect(await handleIssueCommand(["list"], { ...options, all: true, fetchImpl })).toBe(0);
      expect(requestBody(fetchImpl, 0).variables.first).toBe(250);
      expect(requestBody(fetchImpl, 1).variables.first).toBe(50);
      expect(requestBody(fetchImpl, 2).variables.first).toBe(250);
      expect(requestBody(fetchImpl, 2).query).not.toContain("inverseRelations");
    } finally {
      output.restore();
    }
  });

  it("streams includes with --jsonl", async () => {
    const fetchImpl = fetchReturning({
      data: {
        issues: {
          nodes: [makeRawIssue(onlyFields(includeFields(), RELATION_FIELDS))],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();
    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...(await baseOptions()),
        json: false,
        jsonl: true,
        with: "relations",
        fetchImpl
      });
      expect(exitCode).toBe(0);
      const line = JSON.parse(output.stdout.join("").trim());
      expect(line.relations.blocks[0].issue.identifier).toBe("INF-9");
      expect(line).not.toHaveProperty("children");
    } finally {
      output.restore();
    }
  });

  it("rejects --with comments for list and search", async () => {
    const fetchImpl = fetchReturning();
    const output = captureOutput();
    try {
      const options = await baseOptions();
      expect(await handleIssueCommand(["list"], { ...options, with: "comments", fetchImpl })).toBe(5);
      expect(await handleIssueCommand(["search", "login"], { ...options, with: "relations,comments", fetchImpl })).toBe(5);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(output.stderr.join("")).toContain("accepts relations, children");
    } finally {
      output.restore();
    }
  });

  it("adds includes to issue search", async () => {
    const fetchImpl = fetchReturning({
      data: {
        searchIssues: {
          nodes: [makeRawIssue(onlyFields(includeFields(), CHILDREN_FIELDS))],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();
    try {
      const exitCode = await handleIssueCommand(["search", "login"], {
        ...(await baseOptions()),
        with: "children",
        fetchImpl
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed[0].children.nodes).toHaveLength(3);
      expect(parsed[0]).not.toHaveProperty("relations");
      expect(requestBody(fetchImpl).query).toContain("fragment CuratedIssueSearchResult on IssueSearchResult");
      expect(requestBody(fetchImpl).query).toContain("parentChildren: parent");
    } finally {
      output.restore();
    }
  });
});
