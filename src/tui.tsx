#!/usr/bin/env node

import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";

import { AppController, type AppControlState } from "./app-controller";
import { openUrlInBrowser } from "./browser";
import type { LinearRateLimits, StatusRetryEntry, StatusRunningEntry, StatusSnapshot } from "./domain";
import { Logger } from "./logger";
import { buildAgentTableLines, buildEventLines, buildRetryLines, formatElapsedShort } from "./tui-layout";
import { resolveWorkflowContext } from "./workflow";

const REFRESH_INTERVAL_MS = 1000;

function OrchestraiTuiApp(props: { controller: AppController }) {
  const { controller } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const stdoutColumns = Math.max(stdout.columns ?? 120, 88);
  const [snapshot, setSnapshot] = useState<StatusSnapshot>(() => controller.snapshot());
  const [controlState, setControlState] = useState<AppControlState>(() => controller.state());
  const [notice, setNotice] = useState("Space opens the dashboard in your browser.");
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [fatalError, setFatalError] = useState<string | null>(null);
  const startedAtMs = useRef(Date.now());
  const closing = useRef(false);
  const contentWidth = Math.max(64, stdoutColumns - 20);
  const runningEntries = useMemo(() => sortRunningEntries(snapshot.running), [snapshot.running]);
  const retryEntries = useMemo(() => sortRetryEntries(snapshot.retries), [snapshot.retries]);
  const capacity = useMemo(
    () => snapshot.projects.reduce((sum, project) => sum + project.max_concurrent_agents, 0),
    [snapshot.projects]
  );
  const projectLine = useMemo(() => resolveProjectLine(snapshot), [snapshot]);
  const rateLimitLine = useMemo(() => resolveRateLimitLine(snapshot), [snapshot]);
  const agentTableLines = useMemo(
    () => buildAgentTableLines(runningEntries, Math.max(72, contentWidth), nowMs),
    [contentWidth, nowMs, runningEntries]
  );
  const eventLines = useMemo(
    () => buildEventLines(snapshot.recent_events, contentWidth),
    [contentWidth, snapshot.recent_events]
  );
  const retryLines = useMemo(
    () => buildRetryLines(retryEntries, contentWidth, nowMs),
    [contentWidth, nowMs, retryEntries]
  );

  useEffect(() => {
    let cancelled = false;
    const unsubscribeSnapshot = controller.subscribe((nextSnapshot) => {
      if (!cancelled) {
        setSnapshot(nextSnapshot);
      }
    });
    const unsubscribeState = controller.subscribeState((nextState) => {
      if (!cancelled) {
        setControlState(nextState);
      }
    });

    void controller
      .start({ runtime: true, dashboard: true })
      .then(() => {
        if (cancelled) {
          return;
        }
        setNotice(
          controller.state().dashboardUrl
            ? `Dashboard running at ${controller.state().dashboardUrl}`
            : "Dashboard is not running."
        );
      })
      .catch((error) => {
        if (!cancelled) {
          setFatalError(error instanceof Error ? error.message : "Failed to start OrchestrAI.");
        }
      });

    return () => {
      cancelled = true;
      unsubscribeSnapshot();
      unsubscribeState();
      void controller.stop().catch(() => undefined);
    };
  }, [controller]);

  useEffect(() => {
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(interval);
    };
  }, []);

  useInput((input, key) => {
    if (closing.current || busy) {
      return;
    }

    if (key.ctrl && input === "c") {
      void stopAndExit(controller, closing, setBusy, setNotice, exit, 0);
      return;
    }

    if (input === "q") {
      void stopAndExit(controller, closing, setBusy, setNotice, exit, 0);
      return;
    }

    if (input === "r") {
      void toggleRuntime(controller, controlState, setBusy, setNotice);
      return;
    }

    if (input === "d") {
      void toggleDashboard(controller, controlState, setBusy, setNotice);
      return;
    }

    if (input === " ") {
      void openDashboard(controller, setBusy, setNotice);
    }
  });

  return (
    <Box padding={1}>
      <Box borderStyle="round" borderColor="gray" paddingX={1} paddingY={0} flexDirection="column" width={stdoutColumns}>
        <PanelTitle title="ORCHESTRAI CONTROL" />
        <KeyValueLine label="Agents" value={`${snapshot.running_count}/${capacity || snapshot.running_count || 0}`} valueColor="yellowBright" />
        <KeyValueLine label="Projects" value={String(snapshot.project_count)} valueColor="cyanBright" />
        <KeyValueLine label="Session" value={formatElapsedShort(nowMs - startedAtMs.current)} valueColor="magentaBright" />
        <KeyValueLine
          label="Tokens"
          value={`in ${formatInteger(snapshot.codex_totals.inputTokens)} | out ${formatInteger(snapshot.codex_totals.outputTokens)} | total ${formatInteger(snapshot.codex_totals.totalTokens)}`}
          valueColor="yellow"
        />
        <KeyValueLine label="Dashboard" value={controlState.dashboardUrl ?? "stopped"} valueColor="cyan" />
        {projectLine ? <KeyValueLine label="Project" value={projectLine} valueColor="cyanBright" /> : null}
        {rateLimitLine ? <KeyValueLine label="Rate Limits" value={rateLimitLine} valueColor="yellow" /> : null}
        <KeyValueLine label="Updated" value={new Date(snapshot.updated_at).toLocaleTimeString()} valueColor="gray" />

        <SectionTitle title="Running" />
        <TableBlock lines={agentTableLines} />

        <SectionTitle title="Recent Activity" />
        <TableBlock lines={eventLines} mutedEmpty />

        <SectionTitle title="Backoff Queue" />
        <TableBlock lines={retryLines} mutedEmpty />

        <SectionTitle title="Controls" />
        <Text color={fatalError ? "redBright" : "gray"}>
          {fatalError ?? notice}
        </Text>
        <Text color="gray">[r] runtime  [d] dashboard  [space] open dashboard  [q] quit</Text>
      </Box>
    </Box>
  );
}

function PanelTitle(props: { title: string }) {
  return (
    <Box marginBottom={1}>
      <Text color="whiteBright">{props.title}</Text>
    </Box>
  );
}

function SectionTitle(props: { title: string }) {
  return (
    <Box marginTop={1}>
      <Text color="whiteBright">- {props.title}</Text>
    </Box>
  );
}

function KeyValueLine(props: {
  label: string;
  value: string;
  valueColor:
    | "white"
    | "whiteBright"
    | "gray"
    | "cyan"
    | "cyanBright"
    | "yellow"
    | "yellowBright"
    | "magentaBright";
}) {
  return (
    <Text>
      <Text color="whiteBright">{props.label}:</Text>{" "}
      <Text color={props.valueColor}>{props.value}</Text>
    </Text>
  );
}

function TableBlock(props: { lines: string[]; mutedEmpty?: boolean }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {props.lines.map((line, index) => (
        <Text key={`${index}:${line}`} color={props.mutedEmpty && index > 0 ? "gray" : index === 0 ? "gray" : "white"}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

async function toggleRuntime(
  controller: AppController,
  controlState: AppControlState,
  setBusy: Dispatch<SetStateAction<boolean>>,
  setNotice: Dispatch<SetStateAction<string>>
): Promise<void> {
  setBusy(true);
  try {
    if (controlState.runtimeRunning) {
      await controller.stopRuntime();
      setNotice("Runtime stopped.");
    } else {
      await controller.startRuntime();
      setNotice("Runtime started.");
    }
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "Failed to toggle runtime.");
  } finally {
    setBusy(false);
  }
}

async function toggleDashboard(
  controller: AppController,
  controlState: AppControlState,
  setBusy: Dispatch<SetStateAction<boolean>>,
  setNotice: Dispatch<SetStateAction<string>>
): Promise<void> {
  setBusy(true);
  try {
    if (controlState.dashboardRunning) {
      await controller.stopDashboard();
      setNotice("Dashboard stopped.");
    } else {
      const url = await controller.startDashboard();
      setNotice(`Dashboard started at ${url}`);
    }
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "Failed to toggle dashboard.");
  } finally {
    setBusy(false);
  }
}

async function openDashboard(
  controller: AppController,
  setBusy: Dispatch<SetStateAction<boolean>>,
  setNotice: Dispatch<SetStateAction<string>>
): Promise<void> {
  setBusy(true);
  try {
    const url = controller.state().dashboardUrl ?? (await controller.startDashboard());
    await openUrlInBrowser(url);
    setNotice(`Opened dashboard: ${url}`);
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "Failed to open dashboard.");
  } finally {
    setBusy(false);
  }
}

async function stopAndExit(
  controller: AppController,
  closing: MutableRefObject<boolean>,
  setBusy: Dispatch<SetStateAction<boolean>>,
  setNotice: Dispatch<SetStateAction<string>>,
  exit: () => void,
  exitCode: number
): Promise<void> {
  if (closing.current) {
    return;
  }

  closing.current = true;
  setBusy(true);
  setNotice("Stopping OrchestrAI...");
  try {
    await controller.stop();
  } finally {
    process.exitCode = exitCode;
    exit();
  }
}

function sortRunningEntries(entries: StatusRunningEntry[]): StatusRunningEntry[] {
  return [...entries].sort((left, right) => left.started_at_ms - right.started_at_ms || left.identifier.localeCompare(right.identifier));
}

function sortRetryEntries(entries: StatusRetryEntry[]): StatusRetryEntry[] {
  return [...entries].sort((left, right) => left.due_at_ms - right.due_at_ms || left.identifier.localeCompare(right.identifier));
}

function resolveProjectLine(snapshot: StatusSnapshot): string | null {
  const urls = [...new Set(snapshot.projects.map((project) => project.linear_project.url).filter(isNonEmptyString))];
  if (urls.length === 1) {
    return urls[0];
  }

  if (snapshot.projects.length === 1) {
    return snapshot.projects[0].linear_project.name ?? snapshot.projects[0].linear_project.slug;
  }

  return null;
}

function resolveRateLimitLine(snapshot: StatusSnapshot): string | null {
  const first = snapshot.projects.find((project) => project.linear_rate_limits)?.linear_rate_limits ?? null;
  if (!first) {
    return "linear n/a";
  }

  return `linear ${renderWindow("requests", first.requests)} | ${renderWindow("complexity", first.complexity)}`;
}

function renderWindow(label: string, window: LinearRateLimits["requests"]): string {
  if (!window) {
    return `${label} n/a`;
  }

  const remaining = window.remaining ?? "n/a";
  const limit = window.limit ?? "n/a";
  return `${label} ${remaining}/${limit}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function isNonEmptyString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The OrchestrAI TUI requires an interactive terminal.");
  }

  const workflowContext = await resolveWorkflowContext(process.argv[2], { allowEmpty: true });
  const logger = new Logger({}, { writeToStreams: false });
  const controller = new AppController(workflowContext, logger);
  const app = render(<OrchestraiTuiApp controller={controller} />);
  await app.waitUntilExit();
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
