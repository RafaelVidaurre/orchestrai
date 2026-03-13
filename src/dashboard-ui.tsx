import type { ComponentType, ReactNode } from "react";

import { defineCatalog } from "@json-render/core";
import { type Spec, createRenderer } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import type {
  OperatorEvent,
  StatusProjectSummary,
  StatusRetryEntry,
  StatusRunningEntry,
  StatusSnapshot
} from "./domain";
import { z } from "zod";

type Fact = {
  label: string;
  value: string;
};

type ClassNameProps = {
  className?: string | null;
};

type PanelProps = ClassNameProps & {
  title: string;
};

type MetricCardProps = {
  label: string;
  value: string;
};

type ProjectCardProps = {
  title: string;
  url: string | null;
  slug: string;
  workflow: string;
  source: string;
  refreshed: string;
  linearFacts: Fact[];
  codexFacts: Fact[];
};

type AgentCardProps = {
  projectLabel: string;
  identifier: string;
  issueUrl: string | null;
  title: string;
  lastSeen: string;
  state: string;
  phase: string;
  turnCount: string;
  tokens: string;
  activity: string;
  lastEvent: string;
  sessionId: string;
};

type RetryCardProps = {
  projectLabel: string;
  identifier: string;
  title: string;
  attempt: string;
  due: string;
  error: string;
};

type EventCardProps = {
  level: string;
  timestamp: string;
  message: string;
  issueIdentifier: string;
};

type EmptyStateProps = {
  message: string;
};

type RendererProps<TProps> = {
  props: TProps;
  children?: ReactNode;
};

const factSchema = z.object({
  label: z.string(),
  value: z.string()
});

const dashboardCatalog = defineCatalog(schema as never, {
  components: {
    Stack: {
      props: z.object({
        className: z.string().nullable().optional()
      }),
      description: "A vertical container"
    },
    Grid: {
      props: z.object({
        className: z.string().nullable().optional()
      }),
      description: "A grid container"
    },
    Panel: {
      props: z.object({
        title: z.string(),
        className: z.string().nullable().optional()
      }),
      description: "A titled panel container"
    },
    MetricCard: {
      props: z.object({
        label: z.string(),
        value: z.string()
      }),
      description: "A metric summary card"
    },
    ProjectCard: {
      props: z.object({
        title: z.string(),
        url: z.string().nullable(),
        slug: z.string(),
        workflow: z.string(),
        source: z.string(),
        refreshed: z.string(),
        linearFacts: z.array(factSchema),
        codexFacts: z.array(factSchema)
      }),
      description: "A project summary card with rate limit facts"
    },
    AgentCard: {
      props: z.object({
        projectLabel: z.string(),
        identifier: z.string(),
        issueUrl: z.string().nullable(),
        title: z.string(),
        lastSeen: z.string(),
        state: z.string(),
        phase: z.string(),
        turnCount: z.string(),
        tokens: z.string(),
        activity: z.string(),
        lastEvent: z.string(),
        sessionId: z.string()
      }),
      description: "A card showing an active agent"
    },
    RetryCard: {
      props: z.object({
        projectLabel: z.string(),
        identifier: z.string(),
        title: z.string(),
        attempt: z.string(),
        due: z.string(),
        error: z.string()
      }),
      description: "A card showing a queued retry"
    },
    EventCard: {
      props: z.object({
        level: z.string(),
        timestamp: z.string(),
        message: z.string(),
        issueIdentifier: z.string()
      }),
      description: "A recent orchestration event"
    },
    EmptyState: {
      props: z.object({
        message: z.string()
      }),
      description: "An empty-state placeholder"
    }
  },
  actions: {}
} as never);

export const DashboardRenderer = createRenderer(dashboardCatalog as never, {
  Stack: ({ props, children }: RendererProps<ClassNameProps>) => <div className={props.className ?? undefined}>{children}</div>,
  Grid: ({ props, children }: RendererProps<ClassNameProps>) => <div className={props.className ?? undefined}>{children}</div>,
  Panel: ({ props, children }: RendererProps<PanelProps>) => (
    <section className={joinClassName("panel", props.className)}>
      <h2>{props.title}</h2>
      {children}
    </section>
  ),
  MetricCard: ({ props }: RendererProps<MetricCardProps>) => (
    <div className="metric">
      <span className="label">{props.label}</span>
      <span className="value">{props.value}</span>
    </div>
  ),
  ProjectCard: ({ props }: RendererProps<ProjectCardProps>) => (
    <article className="project-card">
      <div className="eyebrow">Project</div>
      {props.url ? (
        <a className="project-link" href={props.url} target="_blank" rel="noreferrer">
          {props.title}
        </a>
      ) : (
        <div className="project-link">{props.title}</div>
      )}
      <div className="project-meta">
        <div className="meta-row">
          <span>Slug</span>
          <strong>{props.slug}</strong>
        </div>
        <div className="meta-row">
          <span>Workflow</span>
          <strong>{props.workflow}</strong>
        </div>
        <div className="meta-row">
          <span>Source</span>
          <strong>{props.source}</strong>
        </div>
        <div className="meta-row">
          <span>Refreshed</span>
          <strong>{props.refreshed}</strong>
        </div>
      </div>
      <div className="rate-limit-columns">
        <div>
          <div className="eyebrow">Linear API</div>
          {renderFactList(props.linearFacts)}
        </div>
        <div>
          <div className="eyebrow">Codex</div>
          {renderFactList(props.codexFacts)}
        </div>
      </div>
    </article>
  ),
  AgentCard: ({ props }: RendererProps<AgentCardProps>) => (
    <article className="agent-card">
      <div className="agent-head">
        <div>
          <div className="ticket">
            {props.issueUrl ? (
              <a href={props.issueUrl} target="_blank" rel="noreferrer">
                {props.identifier}
              </a>
            ) : (
              props.identifier
            )}
          </div>
          <div className="title">{props.title}</div>
        </div>
        <div className="muted">last seen {props.lastSeen}</div>
      </div>
      <div className="pill-row">
        <span className="pill project">{props.projectLabel}</span>
        <span className="pill">{props.state}</span>
        <span className="pill">phase {props.phase}</span>
        <span className="pill">turns {props.turnCount}</span>
        <span className="pill">tokens {props.tokens}</span>
      </div>
      <div className="activity">
        <strong>{props.activity}</strong>
        <div className="muted">event: {props.lastEvent} | session: {props.sessionId}</div>
      </div>
    </article>
  ),
  RetryCard: ({ props }: RendererProps<RetryCardProps>) => (
    <article className="retry-card">
      <div className="retry-head">
        <div>
          <div className="ticket">{props.identifier}</div>
          <div className="title">{props.title}</div>
        </div>
        <div className="muted">attempt {props.attempt}</div>
      </div>
      <div className="pill-row">
        <span className="pill project">{props.projectLabel}</span>
        <span className="pill warn">due {props.due}</span>
      </div>
      <div className="title" style={{ marginTop: "10px" }}>
        {props.error}
      </div>
    </article>
  ),
  EventCard: ({ props }: RendererProps<EventCardProps>) => (
    <article className="event-item">
      <div className="event-meta">
        <span>{props.level}</span>
        <span>{props.timestamp}</span>
      </div>
      <div>
        <strong>{props.message}</strong>
      </div>
      {props.issueIdentifier ? <div className="muted">{props.issueIdentifier}</div> : null}
    </article>
  ),
  EmptyState: ({ props }: RendererProps<EmptyStateProps>) => <div className="empty">{props.message}</div>
} as never) as ComponentType<{ spec: Spec }>;

export function buildDashboardSpec(snapshot: StatusSnapshot): Spec {
  const builder = createSpecBuilder();

  const metricsKey = builder.add(
    "Grid",
    { className: "metrics" },
    [
      builder.add("MetricCard", { label: "Projects", value: String(snapshot.project_count) }),
      builder.add("MetricCard", { label: "Active Agents", value: String(snapshot.running_count) }),
      builder.add("MetricCard", { label: "Retry Queue", value: String(snapshot.retry_count) }),
      builder.add("MetricCard", { label: "Completed", value: String(snapshot.completed_count) }),
      builder.add("MetricCard", { label: "Total Tokens", value: formatInteger(snapshot.codex_totals.totalTokens) })
    ]
  );

  const projectPanelKey = builder.add(
    "Panel",
    { title: "Projects", className: null },
    [
      snapshot.projects.length > 0
        ? builder.add(
            "Grid",
            { className: "project-list" },
            snapshot.projects.map((project) => builder.add("ProjectCard", buildProjectCardProps(project)))
          )
        : builder.add("EmptyState", { message: "No workflows are active yet." })
    ]
  );

  const agentPanelKey = builder.add(
    "Panel",
    { title: "Active Agents", className: null },
    [
      snapshot.running.length > 0
        ? builder.add(
            "Grid",
            { className: "agent-list" },
            snapshot.running.map((entry) => builder.add("AgentCard", buildAgentCardProps(entry)))
          )
        : builder.add("EmptyState", { message: "No active agents right now." })
    ]
  );

  const retryPanelKey = builder.add(
    "Panel",
    { title: "Queued Tasks", className: null },
    [
      snapshot.retries.length > 0
        ? builder.add(
            "Grid",
            { className: "retry-list" },
            snapshot.retries.map((entry) => builder.add("RetryCard", buildRetryCardProps(entry)))
          )
        : builder.add("EmptyState", { message: "No queued retries." })
    ]
  );

  const eventPanelKey = builder.add(
    "Panel",
    { title: "Recent Events", className: null },
    [
      snapshot.recent_events.length > 0
        ? builder.add(
            "Grid",
            { className: "event-list" },
            snapshot.recent_events.slice(0, 12).map((entry) => builder.add("EventCard", buildEventCardProps(entry)))
          )
        : builder.add("EmptyState", { message: "No recent events yet." })
    ]
  );

  const layoutKey = builder.add(
    "Grid",
    { className: "layout" },
    [agentPanelKey, builder.add("Stack", { className: "sidebar-panels" }, [retryPanelKey, eventPanelKey])]
  );

  const rootKey = builder.add("Stack", { className: "dashboard-body" }, [metricsKey, projectPanelKey, layoutKey]);
  return builder.build(rootKey);
}

function buildProjectCardProps(project: StatusProjectSummary) {
  return {
    title: project.linear_project.name ?? project.linear_project.slug,
    url: project.linear_project.url,
    slug: project.linear_project.slug,
    workflow: compactWorkflowPath(project.workflow_path),
    source: project.linear_project.url ? "linked from Linear API" : "using configured project slug",
    refreshed: project.linear_project.updated_at ? new Date(project.linear_project.updated_at).toLocaleTimeString() : "n/a",
    linearFacts: linearFacts(project),
    codexFacts: codexFacts(project.codex_rate_limits)
  };
}

function buildAgentCardProps(entry: StatusRunningEntry) {
  return {
    projectLabel: entry.project_name ?? entry.project_slug,
    identifier: entry.identifier,
    issueUrl: entry.issue_url,
    title: entry.title,
    lastSeen: formatTime(entry.last_timestamp_ms),
    state: entry.state,
    phase: entry.phase,
    turnCount: String(entry.turn_count),
    tokens: formatInteger(entry.codex_total_tokens),
    activity: entry.activity,
    lastEvent: entry.last_event ?? "n/a",
    sessionId: entry.session_id ?? "n/a"
  };
}

function buildRetryCardProps(entry: StatusRetryEntry) {
  return {
    projectLabel: entry.project_name ?? entry.project_slug,
    identifier: entry.identifier,
    title: entry.title,
    attempt: String(entry.attempt),
    due: formatTime(entry.due_at_ms),
    error: entry.error ?? "continuation retry"
  };
}

function buildEventCardProps(entry: OperatorEvent) {
  return {
    level: entry.level.toUpperCase(),
    timestamp: new Date(entry.timestamp).toLocaleTimeString(),
    message: entry.message,
    issueIdentifier: entry.issueIdentifier ?? ""
  };
}

function linearFacts(project: StatusProjectSummary): Fact[] {
  const limits = project.linear_rate_limits;
  if (!limits) {
    return [];
  }

  const facts: Fact[] = [];
  if (limits.requests) {
    facts.push({ label: "Requests / hour", value: formatWindow(limits.requests) });
    if (limits.requests.reset_at_ms) {
      facts.push({ label: "Request reset", value: formatDateTime(limits.requests.reset_at_ms) });
    }
  }
  if (limits.complexity) {
    facts.push({ label: "Complexity / hour", value: formatWindow(limits.complexity) });
    if (limits.complexity.reset_at_ms) {
      facts.push({ label: "Complexity reset", value: formatDateTime(limits.complexity.reset_at_ms) });
    }
  }
  if (limits.endpoint_requests) {
    facts.push({
      label: limits.endpoint_requests.name ? `${limits.endpoint_requests.name} bucket` : "Endpoint bucket",
      value: formatWindow(limits.endpoint_requests)
    });
  }
  if (limits.last_query_complexity !== null) {
    facts.push({
      label: "Last query complexity",
      value: formatInteger(limits.last_query_complexity)
    });
  }
  if (limits.observed_at) {
    facts.push({
      label: "Observed",
      value: new Date(limits.observed_at).toLocaleTimeString()
    });
  }
  return facts;
}

function codexFacts(raw: unknown): Fact[] {
  return collectCodexFacts(raw);
}

function collectCodexFacts(value: unknown, path: string[] = [], facts: Fact[] = []): Fact[] {
  if (facts.length >= 8 || value === null || value === undefined) {
    return facts;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectCodexFacts(entry, path.concat([`Bucket ${index + 1}`]), facts);
    });
    return facts;
  }

  if (typeof value !== "object") {
    return facts;
  }

  Object.entries(value).forEach(([key, entry]) => {
    if (facts.length >= 8 || entry === null || entry === undefined) {
      return;
    }

    const nextPath = path.concat([key]);
    if (typeof entry === "object") {
      collectCodexFacts(entry, nextPath, facts);
      return;
    }

    if (!shouldShowCodexFact(key.toLowerCase())) {
      return;
    }

    facts.push({
      label: formatCodexFactLabel(nextPath),
      value: formatCodexFactValue(entry)
    });
  });

  return facts;
}

function createSpecBuilder() {
  let counter = 0;
  const elements: Spec["elements"] = {};

  return {
    add(type: string, props: Record<string, unknown>, children: string[] = []) {
      const key = `${type.toLowerCase()}-${++counter}`;
      elements[key] = {
        type,
        props,
        children
      };
      return key;
    },
    build(root: string): Spec {
      return {
        root,
        elements
      };
    }
  };
}

function renderFactList(facts: Fact[]) {
  if (facts.length === 0) {
    return <div className="empty">No concrete limit fields are available yet.</div>;
  }

  return (
    <div className="fact-list">
      {facts.map((fact) => (
        <div className="fact-row" key={`${fact.label}:${fact.value}`}>
          <span>{fact.label}</span>
          <strong>{fact.value}</strong>
        </div>
      ))}
    </div>
  );
}

function joinClassName(...parts: Array<string | null | undefined>): string | undefined {
  const value = parts.filter((part): part is string => Boolean(part && part.trim().length > 0)).join(" ");
  return value.length > 0 ? value : undefined;
}

function compactWorkflowPath(workflowPath: string): string {
  return workflowPath.split("/").slice(-2).join("/");
}

function formatWindow(value: { limit: number | null; remaining: number | null }): string {
  return `${formatNullableInteger(value.remaining)} / ${formatNullableInteger(value.limit)}`;
}

function formatTime(ms: number | null): string {
  return ms ? new Date(ms).toLocaleTimeString() : "n/a";
}

function formatDateTime(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : "n/a";
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatNullableInteger(value: number | null): string {
  return value === null ? "n/a" : formatInteger(value);
}

function shouldShowCodexFact(key: string): boolean {
  return /plan|tier|unlimited|remaining|limit|used|reset|window|available/.test(key);
}

function formatCodexFactLabel(path: string[]): string {
  return path
    .map((segment) => segment.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/[_-]+/g, " "))
    .join(" / ");
}

function formatCodexFactValue(value: string | number | boolean): string {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (typeof value === "number") {
    return formatInteger(value);
  }

  return value;
}
