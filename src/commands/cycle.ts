import { commandIO, type CommandOptions, type CommandIO } from "../core/runtime/options.js";
import { emitValidationError } from "../core/output/validation-error.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { paginateGraphQL, validatePaginationOptions, type PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { resolveTeamId, looksLikeId } from "../core/resolution/resolve.js";
import { normalizeRetryOptions } from "../core/transport/retry.js";
import { createCommandContext } from "../core/runtime/command-context.js";

export interface CycleCommandOptions extends CommandOptions {
  jsonl?: boolean;
  dryRun?: boolean;
  // cycle flags
  name?: string;
  description?: string;
  team?: string;
  allTeams?: boolean;
  startsAt?: string;
  endsAt?: string;
  count?: string;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
  quiet?: boolean;
}

const CURATED_CYCLE_BASE_FRAGMENT = `
fragment CuratedCycleBase on Cycle {
  id
  number
  name
  description
  startsAt
  endsAt
  progress
  issueCountHistory
  completedIssueCountHistory
  scopeHistory
  completedScopeHistory
  inProgressScopeHistory
  currentProgress
  team { id key name }
  completedAt
  createdAt
  updatedAt
}`;

const CURATED_CYCLE_DETAIL_FRAGMENT = `
fragment CuratedCycleDetail on Cycle {
  ...CuratedCycleBase
  uncompletedIssuesUponClose(first: 100) {
    nodes { id identifier title }
    pageInfo { hasNextPage endCursor }
  }
}
${CURATED_CYCLE_BASE_FRAGMENT}`;

const CYCLE_GET_QUERY = `
query CycleGet($id: String!) {
  cycle(id: $id) {
    ...CuratedCycleDetail
  }
}
${CURATED_CYCLE_DETAIL_FRAGMENT}`;

const CYCLE_LIST_QUERY = `
query CycleList($first: Int!, $after: String, $filter: CycleFilter) {
  cycles(first: $first, after: $after, filter: $filter) {
    nodes {
      ...CuratedCycleBase
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_CYCLE_BASE_FRAGMENT}`;

const CYCLE_CURRENT_QUERY = `
query CyclesCurrent($filter: CycleFilter!) {
  cycles(first: 1, filter: $filter) {
    nodes {
      ...CuratedCycleDetail
    }
  }
}
${CURATED_CYCLE_DETAIL_FRAGMENT}`;

const CYCLE_TEAM_SETTINGS_QUERY = `
query CycleTeamSettings($id: String!) {
  team(id: $id) {
    id
    key
    name
    cyclesEnabled
    upcomingCycleCount
  }
}`;

const CYCLE_TEAM_UPDATE_MUTATION = `
mutation CycleTeamUpdate($id: String!, $input: TeamUpdateInput!) {
  teamUpdate(id: $id, input: $input) {
    success
    team {
      id
      upcomingCycleCount
    }
  }
}`;

const CYCLE_UPCOMING_QUERY = `
query CyclesUpcoming($filter: CycleFilter!) {
  cycles(first: 50, filter: $filter) {
    nodes {
      ...CuratedCycleBase
    }
  }
}
${CURATED_CYCLE_BASE_FRAGMENT}`;

const CYCLE_UPDATE_MUTATION = `
mutation CycleUpdate($id: String!, $input: CycleUpdateInput!) {
  cycleUpdate(id: $id, input: $input) {
    success
    cycle {
      ...CuratedCycleBase
    }
  }
}
${CURATED_CYCLE_BASE_FRAGMENT}`;

const CYCLE_ARCHIVE_MUTATION = `
mutation CycleArchive($id: String!) {
  cycleArchive(id: $id) {
    success
  }
}`;

interface RawCycle {
  id: string;
  number: number;
  name: string | null;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  progress: number;
  issueCountHistory: number[];
  completedIssueCountHistory: number[];
  scopeHistory: number[];
  completedScopeHistory: number[];
  inProgressScopeHistory: number[];
  currentProgress: unknown;
  uncompletedIssuesUponClose?: {
    nodes: Array<{ id: string; identifier: string; title: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
  team: { id: string; key: string; name: string };
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const CYCLE_DELETE_ALIAS_NOTE = "Linear does not support cycle deletion; cycle delete archives the cycle instead.";

async function handleCycleArchive(
  id: string,
  options: CycleCommandOptions,
  invokedAs: "archive" | "delete" = "archive"
): Promise<number> {
  const { stdout } = commandIO(options);
  if (options.dryRun === true) {
    const input = invokedAs === "delete"
      ? {
          id,
          requestedAction: "delete",
          performedAction: "archive",
          note: CYCLE_DELETE_ALIAS_NOTE
        }
      : { id };
    return emitDryRunResult(invokedAs, "cycle", input, options);
  }

  const ctx = createCommandContext(options);

  try {
    const response = await ctx.graphql<{ cycleArchive: { success: boolean } }>(
      CYCLE_ARCHIVE_MUTATION,
      { id }
    );

    if (ctx.hasErrors(response.body.errors) || response.body.data?.cycleArchive?.success !== true) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(errors.length > 0 ? errors : [{ category: "general", message: "Cycle archive failed" }]);
    }

    const result = invokedAs === "delete"
      ? {
          id,
          archived: true,
          requestedAction: "delete",
          performedAction: "archive",
          note: CYCLE_DELETE_ALIAS_NOTE
        }
      : { id, archived: true };
    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(
        invokedAs === "delete"
          ? `Linear does not support cycle deletion; archived cycle ${id} instead.\n`
          : `Archived cycle ${id}\n`
      );
    }
    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export interface NormalizedCycle {
  id: string;
  number: number;
  name: string | null;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  progress: number;
  scopeCount: number | null;
  issueCount: number | null;
  completedIssueCount: number | null;
  completedScopeCount: number | null;
  inProgressScopeCount: number | null;
  startedScopeCount: number | null;
  issueCountHistory: number[];
  completedIssueCountHistory: number[];
  scopeHistory: number[];
  completedScopeHistory: number[];
  inProgressScopeHistory: number[];
  currentProgress: unknown;
  uncompletedIssuesUponClose: {
    nodes: Array<{ id: string; identifier: string; title: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
  team: { id: string; key: string; name: string };
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function normalizeCycle(raw: RawCycle): NormalizedCycle {
  const scopeCount = lastNumber(raw.scopeHistory);
  const completedScopeCount = lastNumber(raw.completedScopeHistory);
  const inProgressScopeCount = lastNumber(raw.inProgressScopeHistory);

  return {
    id: raw.id,
    number: raw.number,
    name: raw.name,
    description: raw.description,
    startsAt: raw.startsAt,
    endsAt: raw.endsAt,
    progress: raw.progress,
    scopeCount,
    issueCount: lastNumber(raw.issueCountHistory),
    completedIssueCount: lastNumber(raw.completedIssueCountHistory),
    completedScopeCount,
    inProgressScopeCount,
    startedScopeCount:
      completedScopeCount === null && inProgressScopeCount === null
        ? null
        : (completedScopeCount ?? 0) + (inProgressScopeCount ?? 0),
    issueCountHistory: raw.issueCountHistory,
    completedIssueCountHistory: raw.completedIssueCountHistory,
    scopeHistory: raw.scopeHistory,
    completedScopeHistory: raw.completedScopeHistory,
    inProgressScopeHistory: raw.inProgressScopeHistory,
    currentProgress: raw.currentProgress,
    uncompletedIssuesUponClose: raw.uncompletedIssuesUponClose ?? {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null }
    },
    team: raw.team,
    completedAt: raw.completedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

function lastNumber(values: number[]): number | null {
  return values.length > 0 ? values[values.length - 1]! : null;
}

function printHumanCycle(cycle: NormalizedCycle, options: CommandIO): void {
  const { stdout } = commandIO(options);
  const label = cycle.name !== null ? `${cycle.name} (#${cycle.number})` : `Cycle #${cycle.number}`;
  stdout.write(`${label}\n`);
  stdout.write(`  Team:  ${cycle.team.name}\n`);
  if (cycle.startsAt !== null) {
    stdout.write(`  Start: ${cycle.startsAt}\n`);
  }
  if (cycle.endsAt !== null) {
    stdout.write(`  End:   ${cycle.endsAt}\n`);
  }
  if (cycle.completedAt !== null) {
    stdout.write(`  Done:  ${cycle.completedAt}\n`);
  }
}

async function handleCycleGet(
  id: string,
  options: CycleCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

  try {
    const response = await ctx.graphql<{ cycle: RawCycle | null }>(
      CYCLE_GET_QUERY,
      { id }
    );

    if (ctx.hasErrors(response.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
    }

    if (response.body.data?.cycle === null || response.body.data?.cycle === undefined) {
      return ctx.emitNotFound("Cycle not found");
    }

    const cycle = normalizeCycle(response.body.data.cycle);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(cycle);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      printHumanCycle(cycle, options);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCycleList(options: CycleCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  const paginationOptions: PaginationOptions = {
    stderr: commandIO(options).stderr,
    all: options.all,
    max: options.max,
    pageSize: options.pageSize,
    after: options.after,
    quiet: options.quiet
  };

  const validationError = validatePaginationOptions(paginationOptions);
  if (validationError !== undefined) {
    return emitValidationError(validationError, options);
  }

  const ctx = createCommandContext(options);

  try {
    const profile = await ctx.resolveProfile();

    let filter: Record<string, unknown> | undefined;
    const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
    if (effectiveTeam !== undefined) {
      const resolverOpts = await ctx.resolverOptions();
      const teamIdResolved = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
      filter = { team: { id: { eq: teamIdResolved } } };
    }

    const commonPaginateInput = {
      query: CYCLE_LIST_QUERY,
      ...(filter === undefined ? {} : { variables: { filter } }),
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      retry: normalizeRetryOptions(options),
      extractConnection: (data: unknown) => {
        const d = data as { cycles: { nodes: RawCycle[]; pageInfo: PageInfo } };
        return d.cycles;
      }
    };

    if (options.jsonl === true) {
      await streamPaginateGraphQL<RawCycle>({
        ...commonPaginateInput,
        options: { ...paginationOptions, all: paginationOptions.all ?? true },
        onItem: (raw) => {
          stdout.write(`${JSON.stringify(normalizeCycle(raw))}\n`);
        }
      });
    } else {
      const { items, pageInfo } = await paginateGraphQL<RawCycle>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const cycles = items.map(normalizeCycle);

      if (options.jsonEnvelope) {
        return ctx.emitSuccess(cycles, pageInfo);
      } else if (options.json) {
        stdout.write(`${JSON.stringify(cycles, null, 2)}\n`);
      } else {
        for (const cycle of cycles) {
          printHumanCycle(cycle, options);
          stdout.write("\n");
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCycleCurrent(options: CycleCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

  try {
    const profile = await ctx.resolveProfile();

    const effectiveTeam = options.team ?? profile.metadata.defaultTeam;
    if (effectiveTeam === undefined) {
      return emitValidationError("cycle current requires --team or a default team set via 'linearctl team get <key> --set-default'.", options);
    }

    const resolverOpts = await ctx.resolverOptions();
    const teamIdResolved = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
    const filter = { team: { id: { eq: teamIdResolved } }, isActive: { eq: true } };

    const response = await ctx.graphql<{ cycles: { nodes: RawCycle[] } }>(
      CYCLE_CURRENT_QUERY,
      { filter }
    );

    if (ctx.hasErrors(response.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
    }

    const nodes = response.body.data?.cycles?.nodes ?? [];
    if (nodes.length === 0) {
      return ctx.emitNotFound("No active cycle found for this team");
    }

    const cycle = normalizeCycle(nodes[0]!);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(cycle);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      printHumanCycle(cycle, options);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export const CYCLE_CREATE_UNSUPPORTED_MESSAGE =
  "cycle create is no longer supported: Linear removed the cycleCreate mutation. " +
  "Cycles are generated from the team's cycle settings. Run " +
  "'linearctl cycle ensure-upcoming --team <id> --count <n>' to have Linear generate more upcoming cycles, " +
  "then rename or re-date one with 'linearctl cycle update <id> --name <text> --starts-at <date> --ends-at <date>'.";

interface RawTeamCycleSettings {
  id: string;
  key: string;
  name: string;
  cyclesEnabled: boolean;
  upcomingCycleCount: number;
}

function parseUpcomingCount(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }
  const count = Number(value);
  return count >= 1 ? count : undefined;
}

async function handleCycleEnsureUpcoming(options: CycleCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  const count = parseUpcomingCount(options.count);
  if (count === undefined) {
    return emitValidationError("cycle ensure-upcoming requires --count <n> with a positive integer.", options);
  }

  const ctx = createCommandContext(options);

  try {
    const profile = options.team === undefined ? await ctx.resolveProfile() : undefined;
    const effectiveTeam = options.team ?? profile?.metadata.defaultTeam;
    if (effectiveTeam === undefined) {
      return emitValidationError("cycle ensure-upcoming requires --team or a default team set via 'linearctl team get <key> --set-default'.", options);
    }

    if (options.dryRun === true) {
      return emitDryRunResult("ensure-upcoming", "cycle", { teamId: effectiveTeam, upcomingCycleCount: count }, options);
    }

    const resolverOpts = await ctx.resolverOptions();
    const teamId = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);

    const teamResponse = await ctx.graphql<{ team: RawTeamCycleSettings | null }>(
      CYCLE_TEAM_SETTINGS_QUERY,
      { id: teamId }
    );

    if (ctx.hasErrors(teamResponse.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(teamResponse.body.errors));
    }

    const team = teamResponse.body.data?.team;
    if (team === null || team === undefined) {
      return ctx.emitNotFound("Team not found");
    }

    if (!team.cyclesEnabled) {
      return emitValidationError(`Cycles are disabled for team ${team.key}; enable cycles in the team's settings first.`, options);
    }

    const previousUpcomingCycleCount = team.upcomingCycleCount;
    let upcomingCycleCount = previousUpcomingCycleCount;
    const updated = previousUpcomingCycleCount < count;

    if (updated) {
      // upcomingCycleCount is a Float in the schema; passing the whole input object
      // avoids declaring it as Int!, which Linear rejects with HTTP 400.
      const updateResponse = await ctx.graphql<{
        teamUpdate: { success: boolean; team: { id: string; upcomingCycleCount: number } | null };
      }>(CYCLE_TEAM_UPDATE_MUTATION, { id: team.id, input: { upcomingCycleCount: count } });

      if (ctx.hasErrors(updateResponse.body.errors) || updateResponse.body.data?.teamUpdate?.success !== true) {
        const errors = ctx.mapGraphQLErrors(updateResponse.body.errors);
        return ctx.emitFailure(
          errors.length > 0 ? errors : [{ category: "general", message: "Updating the team's upcoming cycle count failed" }]
        );
      }

      upcomingCycleCount = updateResponse.body.data.teamUpdate.team?.upcomingCycleCount ?? count;
    }

    const cyclesResponse = await ctx.graphql<{ cycles: { nodes: RawCycle[] } }>(
      CYCLE_UPCOMING_QUERY,
      { filter: { team: { id: { eq: team.id } }, isFuture: { eq: true } } }
    );

    if (ctx.hasErrors(cyclesResponse.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(cyclesResponse.body.errors));
    }

    const upcomingCycles = (cyclesResponse.body.data?.cycles?.nodes ?? [])
      .map(normalizeCycle)
      .sort((a, b) => a.number - b.number);

    const result = {
      team: { id: team.id, key: team.key, name: team.name },
      previousUpcomingCycleCount,
      upcomingCycleCount,
      updated,
      upcomingCycles
    };

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(
        updated
          ? `Raised upcoming cycle count for ${team.key} from ${previousUpcomingCycleCount} to ${upcomingCycleCount}\n`
          : `Team ${team.key} already keeps ${previousUpcomingCycleCount} upcoming cycles\n`
      );
      for (const cycle of upcomingCycles) {
        stdout.write("\n");
        printHumanCycle(cycle, options);
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCycleUpdate(
  id: string,
  options: CycleCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  const input: Record<string, unknown> = {};

  if (options.name !== undefined) {
    input.name = options.name;
  }
  if (options.description !== undefined) {
    input.description = options.description;
  }
  if (options.startsAt !== undefined) {
    input.startsAt = options.startsAt;
  }
  if (options.endsAt !== undefined) {
    input.endsAt = options.endsAt;
  }

  if (Object.keys(input).length === 0) {
    return emitValidationError("cycle update requires at least one of --name, --description, --starts-at, --ends-at.", options);
  }

  if (options.dryRun === true) {
    return emitDryRunResult("update", "cycle", { id, ...input }, options);
  }

  const ctx = createCommandContext(options);

  try {
    const response = await ctx.graphql<{
      cycleUpdate: { success: boolean; cycle: RawCycle | null };
    }>(CYCLE_UPDATE_MUTATION, { id, input });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.cycleUpdate?.cycle === null ||
      response.body.data?.cycleUpdate?.cycle === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Cycle update failed" }]
      );
    }

    const cycle = normalizeCycle(response.body.data.cycleUpdate.cycle);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(cycle);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      const label = cycle.name !== null ? cycle.name : `Cycle #${cycle.number}`;
      stdout.write(`Updated cycle: ${label}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleCycleCommand(
  positionals: string[],
  options: CycleCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const id = rest[0];
    if (id === undefined || id === "") {
      return emitValidationError("usage: linearctl cycle get <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("cycle get accepts exactly one identifier.", options);
    }
    return handleCycleGet(id, options);
  }

  if (subcommand === "list") {
    if (rest.length > 0) {
      return emitValidationError("cycle list does not accept positional arguments.", options);
    }
    return handleCycleList(options);
  }

  if (subcommand === "current") {
    if (rest.length > 0) {
      return emitValidationError("cycle current does not accept positional arguments.", options);
    }
    return handleCycleCurrent(options);
  }

  if (subcommand === "create") {
    return emitValidationError(CYCLE_CREATE_UNSUPPORTED_MESSAGE, options);
  }

  if (subcommand === "ensure-upcoming") {
    if (rest.length > 0) {
      return emitValidationError("cycle ensure-upcoming does not accept positional arguments.", options);
    }
    return handleCycleEnsureUpcoming(options);
  }

  if (subcommand === "update") {
    const id = rest[0];
    if (id === undefined || id === "") {
      return emitValidationError("usage: linearctl cycle update <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("cycle update accepts exactly one identifier.", options);
    }
    return handleCycleUpdate(id, options);
  }

  if (subcommand === "archive" || subcommand === "delete") {
    const id = rest[0];
    if (id === undefined || id === "") {
      return emitValidationError(`usage: linearctl cycle ${subcommand} <id>`, options);
    }
    if (rest.length > 1) {
      return emitValidationError(`cycle ${subcommand} accepts exactly one identifier.`, options);
    }
    return handleCycleArchive(id, options, subcommand);
  }

  return emitValidationError("unsupported cycle command. Try linearctl cycle get, list, current, ensure-upcoming, update, archive, or delete.", options);
}
