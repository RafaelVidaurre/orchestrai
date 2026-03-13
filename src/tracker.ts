import type {
  Issue,
  LinearProjectInfo,
  LinearRateLimitWindow,
  LinearRateLimits,
  ServiceConfig,
  TrackerConfig
} from "./domain";
import { ServiceError } from "./errors";
import { Logger } from "./logger";

const LINEAR_TIMEOUT_MS = 30000;
const PAGE_SIZE = 50;

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

type IssueNode = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  priority?: number | null;
  state?: { name?: string | null } | null;
  branchName?: string | null;
  url?: string | null;
  labels?: { nodes?: Array<{ name?: string | null } | null> | null } | null;
  inverseRelations?: {
    nodes?: Array<
      | {
          type?: string | null;
          issue?: { id?: string | null; identifier?: string | null; state?: { name?: string | null } | null } | null;
          relatedIssue?: { id?: string | null; identifier?: string | null; state?: { name?: string | null } | null } | null;
        }
      | null
    > | null;
  } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type ProjectNode = {
  name?: string | null;
  slugId?: string | null;
  url?: string | null;
};

type IssuesConnection = {
  issues?: {
    nodes?: IssueNode[];
    pageInfo?: {
      hasNextPage?: boolean | null;
      endCursor?: string | null;
    } | null;
  };
};

export interface IssueTrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
  fetchProjectMetadata(): Promise<LinearProjectInfo | null>;
}

interface TrackerObserver {
  onLinearRateLimits?: (limits: LinearRateLimits) => void;
}

export class LinearIssueTrackerClient implements IssueTrackerClient {
  constructor(
    private readonly tracker: TrackerConfig,
    private readonly logger: Logger,
    private readonly observer: TrackerObserver = {}
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesByStates(this.tracker.activeStates);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    if (states.length === 0) {
      return [];
    }

    const nodes = await this.paginateIssues(states);
    return nodes.map(normalizeIssue);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const data = await this.request<{
      issues?: {
        nodes?: IssueNode[];
      };
    }>(
      `
        query SymphonyFetchIssueStates($ids: [ID!]) {
          issues(filter: { id: { in: $ids } }) {
            nodes {
              id
              identifier
              title
              description
              priority
              branchName
              url
              createdAt
              updatedAt
              state {
                name
              }
              labels {
                nodes {
                  name
                }
              }
              inverseRelations(first: 50) {
                nodes {
                  type
                  issue {
                    id
                    identifier
                    state {
                      name
                    }
                  }
                  relatedIssue {
                    id
                    identifier
                    state {
                      name
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { ids: issueIds }
    );

    return (data.issues?.nodes ?? []).map(normalizeIssue);
  }

  async fetchProjectMetadata(): Promise<LinearProjectInfo | null> {
    try {
      const data = await this.request<{
        projects?: {
          nodes?: ProjectNode[];
        };
      }>(
        `
          query SymphonyFetchProject($projectSlug: String!) {
            projects(filter: { slugId: { eq: $projectSlug } }, first: 1) {
              nodes {
                name
                slugId
                url
              }
            }
          }
        `,
        {
          projectSlug: this.tracker.projectSlug
        }
      );

      return normalizeProject(data.projects?.nodes?.[0] ?? null, this.tracker.projectSlug);
    } catch (error) {
      this.logger.debug("project metadata query with url failed; retrying without url", {
        project_slug: this.tracker.projectSlug,
        error_message: error instanceof Error ? error.message : String(error)
      });
    }

    const fallback = await this.request<{
      projects?: {
        nodes?: ProjectNode[];
      };
    }>(
      `
        query SymphonyFetchProjectFallback($projectSlug: String!) {
          projects(filter: { slugId: { eq: $projectSlug } }, first: 1) {
            nodes {
              name
              slugId
            }
          }
        }
      `,
      {
        projectSlug: this.tracker.projectSlug
      }
    );

    return normalizeProject(fallback.projects?.nodes?.[0] ?? null, this.tracker.projectSlug);
  }

  private async paginateIssues(states: string[]): Promise<IssueNode[]> {
    const nodes: IssueNode[] = [];
    let after: string | null = null;

    while (true) {
      const data: IssuesConnection = await this.request<IssuesConnection>(
        `
          query SymphonyFetchIssues($projectSlug: String!, $states: [String!], $after: String, $first: Int) {
            issues(
              filter: {
                project: { slugId: { eq: $projectSlug } }
                state: { name: { in: $states } }
              }
              first: $first
              after: $after
            ) {
              nodes {
                id
                identifier
                title
                description
                priority
                branchName
                url
                createdAt
                updatedAt
                state {
                  name
                }
                labels {
                  nodes {
                    name
                  }
                }
                inverseRelations(first: 50) {
                  nodes {
                    type
                    issue {
                      id
                      identifier
                      state {
                        name
                      }
                    }
                    relatedIssue {
                      id
                      identifier
                      state {
                        name
                      }
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        {
          projectSlug: this.tracker.projectSlug,
          states,
          after,
          first: PAGE_SIZE
        }
      );

      const connection: IssuesConnection["issues"] = data.issues;
      nodes.push(...(connection?.nodes ?? []));
      if (!connection?.pageInfo?.hasNextPage) {
        break;
      }
      if (!connection.pageInfo.endCursor) {
        throw new ServiceError("linear_missing_end_cursor", "Linear pagination returned hasNextPage without an endCursor");
      }
      after = connection.pageInfo.endCursor;
    }

    return nodes;
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const signal = AbortSignal.timeout(LINEAR_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(this.tracker.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.tracker.apiKey
        },
        body: JSON.stringify({
          query,
          variables
        }),
        signal
      });
    } catch (error) {
      throw new ServiceError("linear_api_request", "Failed to reach Linear GraphQL API", undefined, {
        cause: error instanceof Error ? error : undefined
      });
    }

    if (!response.ok) {
      throw new ServiceError("linear_api_status", `Linear GraphQL API responded with ${response.status}`, {
        status: response.status
      });
    }

    const rateLimits = parseLinearRateLimits(response.headers);
    if (rateLimits) {
      this.observer.onLinearRateLimits?.(rateLimits);
    }

    const payload = (await response.json()) as GraphqlResponse<T>;
    if (payload.errors && payload.errors.length > 0) {
      this.logger.error("linear graphql errors", {
        errors: payload.errors.map((entry) => entry.message ?? "Unknown GraphQL error")
      });
      throw new ServiceError("linear_graphql_errors", "Linear GraphQL returned errors", {
        errors: payload.errors
      });
    }

    if (!payload.data) {
      throw new ServiceError("linear_unknown_payload", "Linear GraphQL returned no data");
    }

    return payload.data;
  }
}

export function createTrackerClient(
  config: ServiceConfig,
  logger: Logger,
  observer?: TrackerObserver
): IssueTrackerClient {
  return new LinearIssueTrackerClient(config.tracker, logger.child({ component: "tracker", tracker_kind: "linear" }), observer);
}

export function parseLinearRateLimits(headers: Headers, observedAtMs = Date.now()): LinearRateLimits | null {
  const requests = readWindow(headers, "x-ratelimit-requests");
  const complexity = readWindow(headers, "x-ratelimit-complexity");
  const endpointRequests = readWindow(headers, "x-ratelimit-endpoint-requests");
  const endpointName = asOptionalString(headers.get("x-ratelimit-endpoint-name"));
  const lastQueryComplexity = parseIntegerHeader(headers.get("x-complexity"));

  if (!requests && !complexity && !endpointRequests && !endpointName && lastQueryComplexity === null) {
    return null;
  }

  return {
    auth_mode: "api_key",
    observed_at: new Date(observedAtMs).toISOString(),
    requests,
    complexity,
    endpoint_requests: endpointRequests || endpointName
      ? {
          ...(endpointRequests ?? {
            limit: null,
            remaining: null,
            reset_at_ms: null
          }),
          name: endpointName
        }
      : null,
    last_query_complexity: lastQueryComplexity
  };
}

function normalizeIssue(node: IssueNode): Issue {
  const issueId = node.id ?? "";
  const blockers =
    node.inverseRelations?.nodes
      ?.filter((relation): relation is NonNullable<typeof relation> => Boolean(relation))
      .filter((relation) => (relation.type ?? "").toLowerCase() === "blocks")
      .map((relation) => {
        const candidates = [relation.issue, relation.relatedIssue].filter(
          (entry): entry is NonNullable<typeof entry> => Boolean(entry)
        );
        const blocker = candidates.find((entry) => entry.id && entry.id !== issueId) ?? relation.issue ?? relation.relatedIssue;
        return {
          id: blocker?.id ?? null,
          identifier: blocker?.identifier ?? null,
          state: blocker?.state?.name ?? null
        };
      }) ?? [];

  return {
    id: issueId,
    identifier: node.identifier ?? "",
    title: node.title ?? "",
    description: node.description ?? null,
    priority: Number.isInteger(node.priority) ? (node.priority as number) : null,
    state: node.state?.name ?? "",
    branch_name: node.branchName ?? null,
    url: node.url ?? null,
    labels:
      node.labels?.nodes
        ?.map((label) => label?.name?.toLowerCase().trim())
        .filter((label): label is string => Boolean(label)) ?? [],
    blocked_by: blockers,
    created_at: normalizeTimestamp(node.createdAt),
    updated_at: normalizeTimestamp(node.updatedAt)
  };
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return Number.isNaN(Date.parse(value)) ? null : value;
}

function normalizeProject(node: ProjectNode | null, fallbackSlug: string): LinearProjectInfo | null {
  if (!node) {
    return null;
  }

  const slug = node.slugId?.trim() || fallbackSlug;
  if (!slug) {
    return null;
  }

  return {
    slug,
    name: node.name?.trim() || null,
    url: node.url?.trim() || null,
    updated_at: new Date().toISOString()
  };
}

function readWindow(headers: Headers, prefix: string): LinearRateLimitWindow | null {
  const limit = parseIntegerHeader(headers.get(`${prefix}-limit`));
  const remaining = parseIntegerHeader(headers.get(`${prefix}-remaining`));
  const resetAtMs = parseResetHeader(headers.get(`${prefix}-reset`));

  if (limit === null && remaining === null && resetAtMs === null) {
    return null;
  }

  return {
    limit,
    remaining,
    reset_at_ms: resetAtMs
  };
}

function parseIntegerHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseResetHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }

  if (/^\d+$/.test(value)) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric)) {
      return null;
    }

    if (numeric >= 1_000_000_000_000) {
      return numeric;
    }

    if (numeric >= 1_000_000_000) {
      return numeric * 1000;
    }

    return Date.now() + numeric * 1000;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function asOptionalString(value: string | null): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}
