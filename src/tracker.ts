import type { Issue, ServiceConfig, TrackerConfig } from "./domain";
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
}

export class LinearIssueTrackerClient implements IssueTrackerClient {
  constructor(private readonly tracker: TrackerConfig, private readonly logger: Logger) {}

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

export function createTrackerClient(config: ServiceConfig, logger: Logger): IssueTrackerClient {
  return new LinearIssueTrackerClient(config.tracker, logger.child({ component: "tracker", tracker_kind: "linear" }));
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
