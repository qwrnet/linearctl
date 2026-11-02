/**
 * Optional nested data for `issue get`, `issue list` and `issue search`, selected with
 * `--with relations,children[,comments]`. Each value adds fields to the issue query itself,
 * so a list stays one GraphQL request per page however many issues it returns.
 */

export const ISSUE_INCLUDES = ["relations", "children", "comments"] as const;

export type IssueInclude = (typeof ISSUE_INCLUDES)[number];

/** `comments` is only for `issue get`: a page of issues with comments is too large to be cheap. */
export const LIST_ISSUE_INCLUDES: readonly IssueInclude[] = ["relations", "children"];

/** Nested page sizes. Larger connections are cut off and reported with `truncated: true`. */
export const RELATIONS_FIRST = 50;
export const CHILDREN_FIRST = 100;
export const COMMENTS_FIRST = 20;

/** Default page size for `--all`/`--max` when `--with` adds nested connections (250 otherwise). */
export const WITH_PAGE_SIZE = 100;

export function parseIssueIncludes(
  value: string | undefined,
  allowed: readonly IssueInclude[],
  command: string
): { includes: Set<IssueInclude> } | { error: string } {
  const includes = new Set<IssueInclude>();
  if (value === undefined) {
    return { includes };
  }
  const parts = value.split(",").map((part) => part.trim().toLowerCase()).filter((part) => part !== "");
  if (parts.length === 0) {
    return { error: `--with needs one or more of: ${allowed.join(", ")}.` };
  }
  for (const part of parts) {
    const include = allowed.find((candidate) => candidate === part);
    if (include === undefined) {
      return { error: `${command} --with accepts ${allowed.join(", ")}; got "${part}".` };
    }
    includes.add(include);
  }
  return { includes };
}

const STATE_SELECTION = "state { id name type }";
const CONNECTION_PAGE_INFO = "pageInfo { hasNextPage }";

/** GraphQL fields appended to the curated issue fragment for the requested includes. */
export function issueIncludeSelection(includes: ReadonlySet<IssueInclude>): string {
  const fields: string[] = [];
  if (includes.has("relations")) {
    fields.push(
      `relations(first: ${RELATIONS_FIRST}) { nodes { id type relatedIssue { id identifier title ${STATE_SELECTION} } } ${CONNECTION_PAGE_INFO} }`,
      `inverseRelations(first: ${RELATIONS_FIRST}) { nodes { id type issue { id identifier title ${STATE_SELECTION} } } ${CONNECTION_PAGE_INFO} }`
    );
  }
  if (includes.has("children")) {
    const child = `id identifier title sortOrder subIssueSortOrder ${STATE_SELECTION}`;
    fields.push(
      "subIssueSortOrder",
      `children(first: ${CHILDREN_FIRST}) { nodes { ${child} } ${CONNECTION_PAGE_INFO} }`,
      `parentChildren: parent { children(first: ${CHILDREN_FIRST}) { nodes { ${child} } ${CONNECTION_PAGE_INFO} } }`
    );
  }
  if (includes.has("comments")) {
    fields.push(
      `comments(first: ${COMMENTS_FIRST}, orderBy: createdAt) { nodes { id body createdAt user { id name email } } ${CONNECTION_PAGE_INFO} }`
    );
  }
  return fields.join("\n  ");
}

interface RawState {
  id: string;
  name: string;
  type: string;
}

interface RawLinkedIssue {
  id: string;
  identifier: string;
  title: string;
  state: RawState | null;
}

interface RawChildIssue extends RawLinkedIssue {
  sortOrder: number;
  subIssueSortOrder: number | null;
}

interface RawConnection<T> {
  nodes: T[];
  pageInfo?: { hasNextPage: boolean };
}

interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

export interface RawIssueIncludes {
  relations?: RawConnection<{ id: string; type: string; relatedIssue: RawLinkedIssue | null }>;
  inverseRelations?: RawConnection<{ id: string; type: string; issue: RawLinkedIssue | null }>;
  subIssueSortOrder?: number | null;
  children?: RawConnection<RawChildIssue>;
  parentChildren?: { children: RawConnection<RawChildIssue> } | null;
  comments?: RawConnection<RawComment>;
}

export interface IssueRelationLink {
  relationId: string;
  issue: RawLinkedIssue;
}

export interface IssueChild {
  id: string;
  identifier: string;
  title: string;
  sortOrder: number;
  subIssueSortOrder: number | null;
  state: RawState | null;
}

export interface NormalizedIssueIncludes {
  relations?: { blocks: IssueRelationLink[]; blockedBy: IssueRelationLink[]; truncated: boolean };
  subIssueSortOrder?: number | null;
  children?: { nodes: IssueChild[]; truncated: boolean };
  siblings?: { nodes: IssueChild[]; truncated: boolean } | null;
  comments?: { nodes: RawComment[]; truncated: boolean };
}

function truncated(connection: RawConnection<unknown> | undefined): boolean {
  return connection?.pageInfo?.hasNextPage === true;
}

/** Sub-issue order as Linear shows it under the parent: ascending subIssueSortOrder, unset last. */
function bySubIssueOrder(a: IssueChild, b: IssueChild): number {
  if (a.subIssueSortOrder === null || b.subIssueSortOrder === null) {
    return a.subIssueSortOrder === b.subIssueSortOrder ? 0 : a.subIssueSortOrder === null ? 1 : -1;
  }
  return a.subIssueSortOrder - b.subIssueSortOrder;
}

function normalizeChild(raw: RawChildIssue): IssueChild {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    sortOrder: raw.sortOrder,
    subIssueSortOrder: raw.subIssueSortOrder,
    state: raw.state
  };
}

/**
 * Turns the raw include fields into the documented output. A key appears only when its
 * include was requested (its raw field is present), so the default issue shape is unchanged.
 *
 * Linear stores "A blocks B" as one relation `{ type: "blocks", issue: A, relatedIssue: B }`:
 * an issue's own `relations` of type blocks are the issues it blocks, and its
 * `inverseRelations` of type blocks are the issues that block it.
 */
export function normalizeIssueIncludes(raw: RawIssueIncludes, issueId: string): NormalizedIssueIncludes {
  const result: NormalizedIssueIncludes = {};
  if (raw.relations !== undefined || raw.inverseRelations !== undefined) {
    const blocks: IssueRelationLink[] = [];
    const blockedBy: IssueRelationLink[] = [];
    for (const relation of raw.relations?.nodes ?? []) {
      if (relation.type === "blocks" && relation.relatedIssue !== null) {
        blocks.push({ relationId: relation.id, issue: relation.relatedIssue });
      }
    }
    for (const relation of raw.inverseRelations?.nodes ?? []) {
      if (relation.type === "blocks" && relation.issue !== null) {
        blockedBy.push({ relationId: relation.id, issue: relation.issue });
      }
    }
    result.relations = {
      blocks,
      blockedBy,
      truncated: truncated(raw.relations) || truncated(raw.inverseRelations)
    };
  }
  if (raw.children !== undefined) {
    result.subIssueSortOrder = raw.subIssueSortOrder ?? null;
    result.children = {
      nodes: raw.children.nodes.map(normalizeChild).sort(bySubIssueOrder),
      truncated: truncated(raw.children)
    };
    const siblings = raw.parentChildren?.children;
    result.siblings =
      siblings === undefined
        ? null
        : {
            nodes: siblings.nodes.filter((node) => node.id !== issueId).map(normalizeChild).sort(bySubIssueOrder),
            truncated: truncated(siblings)
          };
  }
  if (raw.comments !== undefined) {
    result.comments = {
      nodes: raw.comments.nodes.map((comment) => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        user: comment.user
      })),
      truncated: truncated(raw.comments)
    };
  }
  return result;
}
