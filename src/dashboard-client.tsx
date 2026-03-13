import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { StatusSnapshot } from "./domain";
import { DashboardRenderer, buildDashboardSpec } from "./dashboard-ui";

type ThemePreference = "system" | "light" | "dark";
type ConnectionState = "connecting" | "live" | "reconnecting" | "failed";

const themeStorageKey = "symphony-dashboard-theme";

declare global {
  interface Window {
    __SYMPHONY_INITIAL_SNAPSHOT__?: StatusSnapshot;
  }
}

function DashboardApp() {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(() => window.__SYMPHONY_INITIAL_SNAPSHOT__ ?? null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());

  useEffect(() => {
    applyThemePreference(themePreference);
  }, [themePreference]);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    async function bootstrap() {
      if (!snapshot) {
        try {
          const response = await fetch("/api/snapshot");
          if (!response.ok) {
            throw new Error(`snapshot request failed: ${response.status}`);
          }
          const nextSnapshot = (await response.json()) as StatusSnapshot;
          if (!cancelled) {
            setSnapshot(nextSnapshot);
            setConnectionState("connecting");
          }
        } catch {
          if (!cancelled) {
            setConnectionState("failed");
          }
        }
      }

      source = new EventSource("/api/events");
      source.onopen = () => {
        if (!cancelled) {
          setConnectionState("live");
        }
      };
      source.addEventListener("snapshot", (event) => {
        if (cancelled) {
          return;
        }

        setSnapshot(JSON.parse(event.data) as StatusSnapshot);
        setConnectionState("live");
      });
      source.onerror = () => {
        if (!cancelled) {
          setConnectionState("reconnecting");
        }
      };
    }

    void bootstrap();

    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);

  const effectiveSnapshot = snapshot ?? emptySnapshot();

  return (
    <main>
      <section className="hero">
        <div>
          <h1>Symphony Live Ops</h1>
          <p>Realtime view of active agents, ticket execution, retry backlog, and orchestration events.</p>
        </div>
        <div className="hero-controls">
          <label className="theme-field">
            <span>Theme</span>
            <select
              aria-label="Theme preference"
              className="theme-select"
              value={themePreference}
              onChange={(event) => {
                const nextPreference = event.target.value as ThemePreference;
                writeThemePreference(nextPreference);
                setThemePreference(nextPreference);
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <div className="badge">
            <span className="dot"></span>
            <span>{statusMessage(connectionState, snapshot)}</span>
          </div>
        </div>
      </section>
      <DashboardRenderer spec={buildDashboardSpec(effectiveSnapshot)} />
    </main>
  );
}

function emptySnapshot(): StatusSnapshot {
  return {
    updated_at: new Date(0).toISOString(),
    project_count: 0,
    running_count: 0,
    retry_count: 0,
    completed_count: 0,
    claimed_count: 0,
    projects: [],
    running: [],
    retries: [],
    codex_totals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0
    },
    recent_events: []
  };
}

function statusMessage(connectionState: ConnectionState, snapshot: StatusSnapshot | null): string {
  if (connectionState === "failed" && !snapshot) {
    return "Failed to load snapshot";
  }

  if (connectionState === "reconnecting") {
    return snapshot ? `Reconnecting... last update ${formatSnapshotTime(snapshot)}` : "Reconnecting...";
  }

  if (connectionState === "live") {
    return snapshot ? `Live at ${formatSnapshotTime(snapshot)}` : "Live";
  }

  return snapshot ? `Connecting... last update ${formatSnapshotTime(snapshot)}` : "Connecting...";
}

function formatSnapshotTime(snapshot: StatusSnapshot): string {
  return new Date(snapshot.updated_at).toLocaleTimeString();
}

function readThemePreference(): ThemePreference {
  const saved = window.localStorage.getItem(themeStorageKey);
  return saved === "light" || saved === "dark" ? saved : "system";
}

function writeThemePreference(preference: ThemePreference): void {
  if (preference === "system") {
    window.localStorage.removeItem(themeStorageKey);
    return;
  }

  window.localStorage.setItem(themeStorageKey, preference);
}

function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
    return;
  }

  root.setAttribute("data-theme", preference);
}

const container = document.getElementById("app");
if (!container) {
  throw new Error("Dashboard root element was not found");
}

createRoot(container).render(<DashboardApp />);
