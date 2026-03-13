export const dashboardStyles = `
  :root {
    color-scheme: light;
    --background: #f8fafc;
    --foreground: #0f172a;
    --muted: #f1f5f9;
    --muted-foreground: #64748b;
    --card: rgba(255, 255, 255, 0.88);
    --card-foreground: #0f172a;
    --border: rgba(15, 23, 42, 0.08);
    --input: rgba(15, 23, 42, 0.14);
    --primary: #111827;
    --primary-foreground: #f8fafc;
    --secondary: #e2e8f0;
    --secondary-foreground: #0f172a;
    --accent: #2563eb;
    --accent-foreground: #eff6ff;
    --success: #16a34a;
    --warning: #d97706;
    --destructive: #dc2626;
    --shadow: 0 20px 40px rgba(15, 23, 42, 0.08);
    --sidebar-width: 312px;
    --radius: 18px;
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --background: #09090b;
      --foreground: #fafafa;
      --muted: #18181b;
      --muted-foreground: #a1a1aa;
      --card: rgba(17, 24, 39, 0.72);
      --card-foreground: #fafafa;
      --border: rgba(255, 255, 255, 0.08);
      --input: rgba(255, 255, 255, 0.12);
      --primary: #fafafa;
      --primary-foreground: #111827;
      --secondary: rgba(255, 255, 255, 0.06);
      --secondary-foreground: #fafafa;
      --accent: #60a5fa;
      --accent-foreground: #eff6ff;
      --success: #4ade80;
      --warning: #fbbf24;
      --destructive: #f87171;
      --shadow: 0 28px 60px rgba(0, 0, 0, 0.34);
    }
  }

  :root[data-theme="dark"] {
    color-scheme: dark;
    --background: #09090b;
    --foreground: #fafafa;
    --muted: #18181b;
    --muted-foreground: #a1a1aa;
    --card: rgba(17, 24, 39, 0.72);
    --card-foreground: #fafafa;
    --border: rgba(255, 255, 255, 0.08);
    --input: rgba(255, 255, 255, 0.12);
    --primary: #fafafa;
    --primary-foreground: #111827;
    --secondary: rgba(255, 255, 255, 0.06);
    --secondary-foreground: #fafafa;
    --accent: #60a5fa;
    --accent-foreground: #eff6ff;
    --success: #4ade80;
    --warning: #fbbf24;
    --destructive: #f87171;
    --shadow: 0 28px 60px rgba(0, 0, 0, 0.34);
  }

  * {
    box-sizing: border-box;
  }

  html,
  body,
  #app {
    min-height: 100%;
  }

  body {
    margin: 0;
    min-height: 100vh;
    color: var(--foreground);
    background:
      radial-gradient(circle at top left, rgba(37, 99, 235, 0.12), transparent 28%),
      radial-gradient(circle at top right, rgba(148, 163, 184, 0.12), transparent 22%),
      linear-gradient(180deg, color-mix(in srgb, var(--background) 94%, white 6%) 0%, var(--background) 100%);
    font-family: "Inter", "SF Pro Display", "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  button,
  input,
  select {
    font: inherit;
  }

  a {
    color: inherit;
    text-decoration: none;
  }

  .dashboard-shell {
    width: min(1560px, calc(100vw - 32px));
    margin: 0 auto;
    min-height: 100vh;
    display: grid;
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    gap: 28px;
    padding: 24px 0 28px;
  }

  .sidebar,
  .surface,
  .stat-card,
  .dialog-panel {
    backdrop-filter: blur(18px);
  }

  .sidebar {
    position: sticky;
    top: 24px;
    align-self: start;
    min-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 28px;
    background: color-mix(in srgb, var(--card) 92%, transparent 8%);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .sidebar-header,
  .sidebar-footer {
    padding: 20px;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--border);
  }

  .brand-lockup {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }

  .brand-mark {
    width: 40px;
    height: 40px;
    border-radius: 14px;
    display: grid;
    place-items: center;
    background: var(--foreground);
    color: var(--background);
    font-weight: 700;
    letter-spacing: -0.03em;
  }

  .brand-copy {
    min-width: 0;
  }

  .eyebrow {
    font-size: 0.73rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted-foreground);
  }

  .brand-title {
    margin-top: 2px;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -0.03em;
  }

  .sidebar-section {
    padding: 18px 14px 12px;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 10px;
    overflow: hidden;
  }

  .project-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow: auto;
    padding-right: 4px;
  }

  .project-row {
    appearance: none;
    width: 100%;
    border: 1px solid transparent;
    background: transparent;
    color: inherit;
    display: flex;
    align-items: center;
    gap: 12px;
    border-radius: 18px;
    padding: 12px;
    cursor: pointer;
    transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
    text-align: left;
  }

  .project-row:hover,
  .project-row.selected {
    background: color-mix(in srgb, var(--accent) 12%, transparent 88%);
    border-color: color-mix(in srgb, var(--accent) 24%, var(--border) 76%);
    transform: translateY(-1px);
  }

  .project-avatar {
    width: 38px;
    height: 38px;
    border-radius: 14px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    background: var(--secondary);
    color: var(--secondary-foreground);
    font-weight: 700;
  }

  .project-avatar.running {
    background: color-mix(in srgb, var(--success) 18%, transparent 82%);
    color: var(--success);
  }

  .project-avatar.stopped {
    background: color-mix(in srgb, var(--warning) 18%, transparent 82%);
    color: var(--warning);
  }

  .project-avatar.all {
    background: color-mix(in srgb, var(--accent) 16%, transparent 84%);
    color: var(--accent);
  }

  .project-copy {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .project-name,
  .row-title {
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .project-name,
  .row-subtitle,
  .activity-primary,
  .activity-secondary {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .project-name,
  .activity-primary {
    white-space: nowrap;
  }

  .project-meta,
  .row-subtitle,
  .detail-note,
  .surface-header p,
  .page-heading p,
  .timeline-time,
  .sidebar-meta-text,
  .dialog-description,
  .notice {
    color: var(--muted-foreground);
  }

  .project-meta,
  .row-subtitle,
  .detail-note,
  .activity-secondary,
  .timeline-time,
  .sidebar-meta-text {
    font-size: 0.9rem;
  }

  .project-chevron {
    color: var(--muted-foreground);
  }

  .status-pill {
    border-radius: 999px;
    padding: 4px 9px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }

  .status-pill.running {
    background: color-mix(in srgb, var(--success) 18%, transparent 82%);
    color: var(--success);
  }

  .status-pill.stopped {
    background: color-mix(in srgb, var(--warning) 18%, transparent 82%);
    color: var(--warning);
  }

  .sidebar-footer {
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .sidebar-action {
    justify-content: flex-start;
  }

  .sidebar-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 0.85rem;
  }

  .connection-line {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted-foreground);
  }

  .connection-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: currentColor;
    opacity: 0.9;
  }

  .connection-line.live {
    color: var(--success);
  }

  .connection-line.reconnecting,
  .connection-line.connecting {
    color: var(--warning);
  }

  .connection-line.failed {
    color: var(--destructive);
  }

  .theme-picker {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .theme-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 500;
  }

  .page-shell {
    min-width: 0;
    padding: 8px 0 0;
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 22px;
  }

  .page-heading h1 {
    margin: 8px 0 8px;
    font-size: clamp(2rem, 4.2vw, 3.6rem);
    line-height: 0.95;
    letter-spacing: -0.06em;
  }

  .page-heading p {
    margin: 0;
    max-width: 720px;
    font-size: 1rem;
    line-height: 1.55;
  }

  .header-links,
  .header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 16px;
  }

  .meta-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 999px;
    padding: 7px 11px;
    background: var(--muted);
    border: 1px solid var(--border);
    font-size: 0.85rem;
    color: var(--muted-foreground);
  }

  .meta-chip.interactive {
    color: var(--foreground);
  }

  .stat-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
    margin-bottom: 18px;
  }

  .stat-card,
  .surface {
    border: 1px solid var(--border);
    background: var(--card);
    box-shadow: var(--shadow);
  }

  .stat-card {
    padding: 16px 18px;
    border-radius: 22px;
  }

  .stat-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 14px;
  }

  .stat-label,
  .detail-label,
  .field-label {
    font-size: 0.84rem;
    font-weight: 600;
    color: var(--muted-foreground);
  }

  .stat-icon {
    color: var(--muted-foreground);
  }

  .stat-value,
  .detail-value {
    font-size: 1.7rem;
    font-weight: 700;
    letter-spacing: -0.05em;
  }

  .stat-note {
    margin-top: 6px;
    font-size: 0.88rem;
    color: var(--muted-foreground);
  }

  .layout-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.8fr) minmax(320px, 1fr);
    gap: 18px;
  }

  .surface {
    border-radius: 24px;
    overflow: hidden;
  }

  .span-two {
    grid-row: span 2;
  }

  .surface-header {
    padding: 18px 20px 12px;
    border-bottom: 1px solid var(--border);
  }

  .surface-header h2 {
    margin: 0;
    font-size: 1rem;
    letter-spacing: -0.03em;
  }

  .surface-header p {
    margin: 6px 0 0;
    font-size: 0.92rem;
    line-height: 1.45;
  }

  .surface-body {
    padding: 8px 20px 20px;
  }

  .table-shell {
    overflow: auto;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  .data-table th,
  .data-table td {
    padding: 14px 8px;
    vertical-align: top;
    border-bottom: 1px solid var(--border);
    text-align: left;
  }

  .data-table th {
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted-foreground);
  }

  .data-table tbody tr:last-child td {
    border-bottom: 0;
  }

  .agents-table th:nth-child(1) {
    width: 24%;
  }

  .agents-table th:nth-child(2) {
    width: 17%;
  }

  .agents-table th:nth-child(3) {
    width: 14%;
  }

  .agents-table th:nth-child(4) {
    width: 13%;
  }

  .activity-primary,
  .activity-secondary {
    display: block;
    max-width: 100%;
  }

  .activity-primary {
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .activity-secondary {
    margin-top: 5px;
    white-space: nowrap;
  }

  .phase-badge {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 5px 10px;
    background: color-mix(in srgb, var(--accent) 12%, transparent 88%);
    color: var(--accent);
    font-size: 0.8rem;
    font-weight: 600;
  }

  .timeline {
    display: flex;
    flex-direction: column;
  }

  .timeline-item {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 14px;
    padding: 14px 0;
    border-bottom: 1px solid var(--border);
  }

  .timeline-item:last-child {
    border-bottom: 0;
  }

  .timeline-meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .event-level {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    border-radius: 999px;
    padding: 4px 8px;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--muted);
  }

  .event-level.info {
    color: var(--accent);
  }

  .event-level.warn {
    color: var(--warning);
  }

  .event-level.error {
    color: var(--destructive);
  }

  .event-level.debug {
    color: var(--muted-foreground);
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .detail-item {
    border-radius: 16px;
    background: color-mix(in srgb, var(--muted) 72%, transparent 28%);
    padding: 14px;
    border: 1px solid var(--border);
  }

  .detail-value.good {
    color: var(--success);
  }

  .detail-value {
    font-size: 1.15rem;
    margin-top: 8px;
  }

  .detail-suffix {
    margin-top: 10px;
  }

  .detail-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--accent);
    font-weight: 600;
  }

  .empty-state {
    padding: 20px 0 6px;
  }

  .mono {
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" 1;
  }

  .button {
    appearance: none;
    border: 1px solid var(--border);
    border-radius: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 14px;
    background: transparent;
    color: var(--foreground);
    cursor: pointer;
    transition: transform 140ms ease, border-color 140ms ease, background 140ms ease, color 140ms ease;
  }

  .button:hover {
    transform: translateY(-1px);
  }

  .button.primary {
    background: var(--foreground);
    border-color: var(--foreground);
    color: var(--background);
  }

  .button.secondary,
  .button.ghost,
  .select,
  .input {
    background: color-mix(in srgb, var(--card) 60%, transparent 40%);
  }

  .button.danger {
    color: var(--destructive);
    border-color: color-mix(in srgb, var(--destructive) 28%, var(--border) 72%);
    background: color-mix(in srgb, var(--destructive) 10%, transparent 90%);
  }

  .button.icon-only {
    width: 40px;
    height: 40px;
    padding: 0;
  }

  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 23, 0.48);
  }

  .dialog-panel {
    position: fixed;
    top: 50%;
    left: 50%;
    width: min(760px, calc(100vw - 28px));
    max-height: min(90vh, 920px);
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    gap: 18px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 26px;
    background: color-mix(in srgb, var(--card) 96%, transparent 4%);
    box-shadow: var(--shadow);
    padding: 22px;
  }

  .dialog-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .dialog-title {
    margin: 0;
    font-size: 1.35rem;
    letter-spacing: -0.04em;
  }

  .dialog-description {
    margin: 6px 0 0;
    line-height: 1.5;
  }

  .form-stack {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .field-grid {
    display: grid;
    gap: 14px;
  }

  .field-grid.two-up {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .field.full {
    grid-column: 1 / -1;
  }

  .field-label {
    letter-spacing: -0.01em;
  }

  .input,
  .select {
    width: 100%;
    border: 1px solid var(--input);
    border-radius: 12px;
    padding: 11px 13px;
    color: inherit;
  }

  .input:disabled {
    opacity: 0.65;
  }

  .toggle-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 14px;
    background: var(--muted);
    border: 1px solid var(--border);
  }

  .toggle-input {
    width: 18px;
    height: 18px;
  }

  .dialog-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-top: 6px;
  }

  .notice {
    flex: 1;
    min-width: 0;
    line-height: 1.45;
  }

  .notice.success {
    color: var(--success);
  }

  .notice.error {
    color: var(--destructive);
  }

  .notice.saving {
    color: var(--accent);
  }

  .dialog-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  @media (max-width: 1180px) {
    .dashboard-shell {
      grid-template-columns: 1fr;
    }

    .sidebar {
      position: static;
      min-height: 0;
    }

    .layout-grid {
      grid-template-columns: 1fr;
    }

    .span-two {
      grid-row: auto;
    }
  }

  @media (max-width: 900px) {
    .stat-grid,
    .detail-grid,
    .field-grid.two-up {
      grid-template-columns: 1fr;
    }

    .page-header,
    .dialog-footer,
    .sidebar-meta {
      flex-direction: column;
      align-items: stretch;
    }

    .header-actions {
      margin-top: 0;
    }

    .timeline-item {
      grid-template-columns: 1fr;
      gap: 8px;
    }
  }

  @media (max-width: 720px) {
    .dashboard-shell {
      width: min(100vw, calc(100vw - 16px));
      padding: 8px 0 16px;
      gap: 14px;
    }

    .sidebar,
    .surface,
    .stat-card {
      border-radius: 20px;
    }

    .page-heading h1 {
      font-size: 2rem;
    }

    .surface-body,
    .surface-header,
    .sidebar-header,
    .sidebar-footer {
      padding-left: 16px;
      padding-right: 16px;
    }

    .agents-table th:nth-child(4),
    .agents-table td:nth-child(4) {
      display: none;
    }
  }
`;
