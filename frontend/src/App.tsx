import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  analyzeCase,
  acknowledgeCase,
  createCase,
  createGmailDraft,
  deleteCase,
  downloadReport,
  generateRunbook,
  getAppState,
  getAuditEvents,
  getCase,
  getCurrentUser,
  getHealth,
  getDashboard,
  getJiraPending,
  getMessageCounts,
  getMessages,
  getProblemGroups,
  getRelatedCases,
  getServiceTrends,
  indexCaseMemory,
  login,
  logout,
  resolveCase,
  savePreference,
  saveReview,
  searchCases,
  sendMessage,
  syncJiraTickets,
} from "./api";
import type {
  AuditEvent,
  AuthUser,
  CaseCreate,
  CaseMessage,
  Health,
  OperationsDashboard,
  ProblemGroup,
  RelatedCase,
  RunbookRecommendation,
  ServiceTrend,
  Severity,
  SupportAnalysis,
  SupportCase,
} from "./types";

const STATUS_LABELS = {
  new: "New",
  investigating: "Investigating",
  awaiting_approval: "Awaiting approval",
  approved: "Approved / active",
  resolved: "Resolved",
};

const EMPTY_CASE: CaseCreate = {
  title: "",
  customer: "",
  service: "",
  environment: "production",
  reported_issue: "",
  logs: "",
  severity: "medium",
};

type ConfirmAction = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

type DetailView =
  | "all"
  | "overview"
  | "sla"
  | "evidence"
  | "analysis"
  | "publish"
  | "report"
  | "similar"
  | "messages"
  | "runbook";

function App() {
  const [page, setPage] = useState<"dashboard" | "insights" | "about">("dashboard");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [cases, setCases] = useState<SupportCase[]>([]);
  const [selected, setSelected] = useState<SupportCase | null>(null);
  const [related, setRelated] = useState<RelatedCase[]>([]);
  const [dashboard, setDashboard] = useState<OperationsDashboard | null>(null);
  const [trends, setTrends] = useState<ServiceTrend[]>([]);
  const [problems, setProblems] = useState<ProblemGroup[]>([]);
  const [runbook, setRunbook] = useState<RunbookRecommendation | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [messages, setMessages] = useState<CaseMessage[]>([]);
  const [jiraPending, setJiraPending] = useState(0);
  const [msgCounts, setMsgCounts] = useState<Record<string, number>>({});
  const [readCounts, setReadCounts] = useState<Record<string, number>>({});
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [activeTasks, setActiveTasks] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SupportCase | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [showNewCase, setShowNewCase] = useState(false);

  function selectCase(caseItem: SupportCase | null) {
    setSelected(caseItem);
    void savePreference("selected_case_id", caseItem?.id ?? null);
  }

  function startTask(key: string) { setActiveTasks(prev => new Set([...prev, key])); }
  function endTask(key: string) { setActiveTasks(prev => { const next = new Set(prev); next.delete(key); return next; }); }
  function isActive(key: string) { return activeTasks.has(key); }

  function updateCaseInPlace(updated: SupportCase) {
    setCases(current => current.map(c => c.id === updated.id ? updated : c));
    setSelected(current => current?.id === updated.id ? updated : current);
  }

  useEffect(() => {
    void getCurrentUser()
      .then(setUser)
      .catch(() => {})
      .finally(() => setAuthReady(true));
  }, []);

  useEffect(() => {
    function handleUnauthorized() {
      setUser(null);
      setCases([]);
      setSelected(null);
      setAudit([]);
      setError("Your session has expired. Sign in again.");
    }
    window.addEventListener("resolveiq:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("resolveiq:unauthorized", handleUnauthorized);
  }, []);

  useEffect(() => {
    if (!user) return;
    void getAppState()
      .then((state) => {
        setHealth(state.health);
        setDashboard(state.dashboard);
        setTrends(state.trends);
        setProblems(state.problems);
        setAudit(state.audit);
        setCases(state.cases);
        const selectedId = state.preferences.selected_case_id;
        selectCase(state.cases.find((caseItem) => caseItem.id === selectedId) ?? state.cases[0] ?? null);
        if (state.health.jira_configured) void getJiraPending().then((r) => setJiraPending(r.count)).catch(() => {});
        void getMessageCounts().then(setMsgCounts).catch(() => {});
      })
      .catch((caught: unknown) => setError(readError(caught)));
  }, [user?.username]);

  useEffect(() => {
    if (!user || !health?.jira_configured) return;
    const interval = setInterval(() => {
      void getJiraPending().then((r) => setJiraPending(r.count)).catch(() => {});
      void getMessageCounts().then(setMsgCounts).catch(() => {});
    }, 180000);
    return () => clearInterval(interval);
  }, [user?.username, health?.jira_configured]);

  useEffect(() => {
    if (!selected) {
      setRunbook(null);
      setRelated([]);
      setMessages([]);
      return;
    }
    setRunbook(selected.runbook ?? null);
    void getRelatedCases(selected.id).then(setRelated).catch(() => setRelated([]));
    void getMessages(selected.id).then((msgs) => {
      setMessages(msgs);
      setReadCounts((prev) => ({ ...prev, [selected.id]: msgs.length }));
    }).catch(() => setMessages([]));
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/cases/${selected.id}/ws`);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as CaseMessage;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        const next = [...prev, msg];
        setReadCounts((rc) => ({ ...rc, [selected.id]: next.length }));
        return next;
      });
      setMsgCounts((prev) => ({ ...prev, [msg.case_id]: (prev[msg.case_id] ?? 0) + 1 }));
    };
    return () => ws.close();
  }, [selected?.id]);

  function replaceCase(nextCase: SupportCase) {
    selectCase(nextCase);
    setCases((current) => [nextCase, ...current.filter((entry) => entry.id !== nextCase.id)]);
  }

  async function refreshDashboardData() {
    const state = await getAppState();
    setHealth(state.health);
    setDashboard(state.dashboard);
    setTrends(state.trends);
    setProblems(state.problems);
    setAudit(state.audit);
    setCases(state.cases);
    selectCase(state.cases[0] ?? null);
  }

  async function runInline(taskKey: string, action: () => Promise<SupportCase>, success?: string) {
    startTask(taskKey);
    setError("");
    try {
      const updated = await action();
      replaceCase(updated);
      if (success) setNotice(success);
      const [nextHealth, nextDashboard, nextTrends, nextProblems, nextRelated, nextAudit] = await Promise.all([
        getHealth(), getDashboard(), getServiceTrends(), getProblemGroups(), getRelatedCases(updated.id), getAuditEvents(),
      ]);
      setHealth(nextHealth);
      setDashboard(nextDashboard);
      setTrends(nextTrends);
      setProblems(nextProblems);
      setRelated(nextRelated);
      setAudit(nextAudit);
    } catch (caught: unknown) {
      setError(readError(caught));
    } finally {
      endTask(taskKey);
    }
  }

  function runBackground(taskKey: string, action: () => Promise<SupportCase>, success: string) {
    startTask(taskKey);
    action()
      .then(async (updated) => {
        updateCaseInPlace(updated);
        if (updated.runbook) setRunbook(prev => updated.runbook ?? prev);
        setHighlightId(updated.id);
        setTimeout(() => setHighlightId(null), 2000);
        setNotice(success);
        const [d, a] = await Promise.all([getDashboard(), getAuditEvents()]);
        setDashboard(d);
        setAudit(a);
      })
      .catch((caught: unknown) => setError(readError(caught)))
      .finally(() => endTask(taskKey));
  }

  function awaitAnalysis(caseIds: string[]) {
    const pending = new Set(caseIds);
    const poll = setInterval(async () => {
      for (const id of [...pending]) {
        try {
          const updated = await getCase(id);
          if (updated.status !== "new" && updated.status !== "investigating") {
            pending.delete(id);
            updateCaseInPlace(updated);
            setHighlightId(updated.id);
            setTimeout(() => setHighlightId(null), 2000);
          }
        } catch { pending.delete(id); }
      }
      if (pending.size === 0) {
        clearInterval(poll);
        const [h, d, a] = await Promise.all([getHealth(), getDashboard(), getAuditEvents()]);
        setHealth(h); setDashboard(d); setAudit(a);
        setNotice("AI analysis complete — ready for review.");
      }
    }, 2000);
    setTimeout(() => clearInterval(poll), 60000);
  }

  async function signIn(username: string, password: string) {
    startTask("login");
    setError("");
    try {
      const session = await login(username, password);
      setUser(session.user);
      setNotice("");
    } catch (caught: unknown) {
      setError(readError(caught));
    } finally {
      endTask("login");
    }
  }

  async function signOut() {
    startTask("logout");
    setConfirmLogout(false);
    try {
      await logout();
      setNotice("");
      setError("");
    } catch (caught: unknown) {
      setError(readError(caught));
    } finally {
      setUser(null);
      setPage("dashboard");
      setCases([]);
      setSelected(null);
      setAudit([]);
      endTask("logout");
    }
  }

  function requestSignOut() {
    setError("");
    setNotice("");
    setConfirmLogout(true);
  }

  async function confirmDeleteCase() {
    if (!deleteTarget) return;
    startTask("delete");
    setError("");
    try {
      await deleteCase(deleteTarget.id);
      const state = await getAppState();
      setCases(state.cases);
      selectCase(selected?.id === deleteTarget.id ? state.cases[0] ?? null : selected);
      setHealth(state.health);
      setDashboard(state.dashboard);
      setTrends(state.trends);
      setProblems(state.problems);
      setAudit(state.audit);
      setRelated([]);
      setRunbook(null);
      setNotice("Support case deleted.");
      setDeleteTarget(null);
    } catch (caught: unknown) {
      setError(readError(caught));
    } finally {
      endTask("delete");
    }
  }

  if (!authReady) return <div className="splash">Checking local session...</div>;
  if (page === "about") {
    return (
      <>
        <AboutPage user={user} busy={isActive("logout")} onBack={() => setPage("dashboard")} onInsights={() => setPage("insights")} onSignOut={requestSignOut} />
        {error ? <StatusModal kind="error" message={error} onClose={() => setError("")} /> : null}
        {confirmLogout ? <LogoutModal busy={isActive("logout")} onCancel={() => setConfirmLogout(false)} onConfirm={signOut} /> : null}
      </>
    );
  }
  if (!user) return <LoginScreen busy={isActive("login")} error={error} onAbout={() => setPage("about")} onDismissError={() => setError("")} onLogin={signIn} />;

  return (
    <div className="app">
      <header className="header-bar">
        <div className="header-brand">
          <h1 className="header-title">ResolveIQ</h1>
          <span className="header-kicker">AI Support Copilot</span>
        </div>
        <nav className="header-nav" aria-label="Account and navigation">
          <button aria-current={page === "dashboard" ? "page" : undefined} className={page === "dashboard" ? "control-button active" : "control-button"} onClick={() => setPage("dashboard")} type="button"><ActionIcon kind="dashboard" />Dashboard</button>
          <button aria-current={page === "insights" ? "page" : undefined} className={page === "insights" ? "control-button active" : "control-button"} onClick={() => setPage("insights")} type="button"><ActionIcon kind="insights" />Insights</button>
          <button className="control-button" onClick={() => setPage("about")} type="button"><ActionIcon kind="about" />About</button>
          <button className="control-button" disabled={isActive("logout")} onClick={requestSignOut} type="button"><ActionIcon kind="logout" />Sign out</button>
        </nav>
        <div className="profile-badge"><ActionIcon kind="user" />{user.username}</div>
      </header>
      {error ? <StatusModal kind="error" message={error} onClose={() => setError("")} /> : notice ? <StatusModal kind="success" message={notice} onClose={() => setNotice("")} /> : null}
      {confirmLogout ? <LogoutModal busy={isActive("logout")} onCancel={() => setConfirmLogout(false)} onConfirm={signOut} /> : null}
      {deleteTarget ? <DeleteCaseModal caseItem={deleteTarget} busy={isActive("delete")} onCancel={() => setDeleteTarget(null)} onConfirm={confirmDeleteCase} /> : null}
      {confirmAction ? <ConfirmActionModal action={confirmAction} onCancel={() => setConfirmAction(null)} onConfirm={() => { const action = confirmAction; setConfirmAction(null); action.onConfirm(); }} /> : null}
      {page === "dashboard" ? (
        <>
          <OperationsOverview dashboard={dashboard} cases={cases} />
          <div className="toolbar">
            <button className="primary compact" disabled={isActive("create")} onClick={() => setShowNewCase(true)} type="button"><ActionIcon kind="save" />New case</button>
            {health?.jira_configured ? (
              <button className={jiraPending > 0 ? "jira-sync-pending compact" : "secondary compact"} disabled={isActive("jira-sync")} onClick={() => {
                startTask("jira-sync");
                setError("");
                syncJiraTickets()
                  .then(async (result) => {
                    setJiraPending(0);
                    if (result.imported > 0) {
                      await refreshDashboardData();
                      setNotice(`Synced ${result.imported} ticket(s) from Jira. AI analysis running...`);
                      awaitAnalysis(result.cases.map((c) => c.id));
                    } else {
                      setNotice(`No new Jira tickets to import (${result.skipped} already synced).`);
                    }
                  })
                  .catch((caught: unknown) => setError(readError(caught)))
                  .finally(() => endTask("jira-sync"));
              }} type="button"><ActionIcon kind="automation" />{isActive("jira-sync") ? "Syncing..." : jiraPending > 0 ? `Sync Jira (${jiraPending})` : "Sync Jira"}</button>
            ) : null}
            <CaseSearch
              disabled={isActive("search")}
              onReset={async () => {
                startTask("search");
                setError("");
                setNotice("");
                try {
                  await refreshDashboardData();
                } catch (caught: unknown) {
                  setError(readError(caught));
                } finally {
                  endTask("search");
                }
              }}
              onSearch={async (query, status) => {
                startTask("search");
                setError("");
                try {
                  const results = await searchCases(query, status);
                  setCases(results);
                  selectCase(results[0] ?? null);
                } catch (caught: unknown) {
                  setError(readError(caught));
                } finally {
                  endTask("search");
                }
              }}
            />
          </div>
          {showNewCase ? (
            <NewCaseModal
              disabled={isActive("create")}
              onClose={() => setShowNewCase(false)}
              onCreate={(payload) => {
                setShowNewCase(false);
                startTask("create");
                setError("");
                createCase(payload)
                  .then(async (created) => {
                    replaceCase(created);
                    setNotice("Case created. AI analysis running...");
                    const [h, d, a] = await Promise.all([getHealth(), getDashboard(), getAuditEvents()]);
                    setHealth(h); setDashboard(d); setAudit(a);
                    awaitAnalysis([created.id]);
                  })
                  .catch((caught: unknown) => setError(readError(caught)))
                  .finally(() => endTask("create"));
              }}
            />
          ) : null}
        </>
      ) : null}
      {page === "insights" ? (
        <main className="insights-page">
          <section className="card page-intro">
            <p className="kicker">INSIGHTS</p>
            <h2>Patterns across resolved and active incidents</h2>
          </section>
          <OperationsInsights trends={trends} problems={problems} />
          <section className="insights-operations">
            <AuditHistory events={audit} />
            {selected ? (
              <TimelineCard caseItem={selected} busy={isActive("download:" + selected.id)} onDownloadReport={async () => {
                startTask("download:" + selected.id);
                setError("");
                try {
                  await downloadReport(selected.id, `${selected.title}-incident-report.md`);
                  setAudit(await getAuditEvents());
                  setNotice("Incident report downloaded.");
                } catch (caught: unknown) {
                  setError(readError(caught));
                } finally {
                  endTask("download:" + selected.id);
                }
              }} />
            ) : (
              <section className="card timeline">
                <h3>Timeline</h3>
                <p className="muted">Select a case to review its timeline.</p>
              </section>
            )}
          </section>
        </main>
      ) : (
      <main className="workspace">
        <aside>
          <CaseHistory cases={cases} selected={selected} highlightId={highlightId} jiraSiteUrl={health?.jira_site_url ?? ""} msgCounts={msgCounts} readCounts={readCounts} onDelete={setDeleteTarget} onSelect={selectCase} />
        </aside>
        <section className="detail">
          {selected ? (
            <CaseDetail
              caseItem={selected}
              health={health}
              related={related}
              messages={messages}
              runbook={runbook}
              activeTasks={activeTasks}
              onAnalyze={() => {
                const doAnalyze = () => runBackground("analyze:" + selected.id, () => analyzeCase(selected.id), "Analysis generated for review.");
                if (selected.review_status !== "not_ready") {
                  setConfirmAction({
                    title: "Re-analyze incident",
                    message: "This case already has an analysis. Re-analyzing will overwrite it and require a new review.",
                    confirmLabel: "Re-analyze",
                    onConfirm: doAnalyze,
                  });
                } else {
                  doAnalyze();
                }
              }}
              onReview={(analysis, approve) =>
                runInline("review:" + selected.id, () => saveReview(selected.id, analysis, approve), approve ? "Analysis approved." : "Analysis edits saved.")
              }
              onResolve={(resolution, actions) =>
                runInline("resolve:" + selected.id, () => resolveCase(selected.id, resolution, actions), "Case resolved.")
              }
              onAcknowledge={() =>
                runInline("ack:" + selected.id, () => acknowledgeCase(selected.id), "Customer acknowledgement recorded.")
              }
              onIndex={() => {
                const doIndex = () => {
                  const key = "index:" + selected.id;
                  startTask(key);
                  indexCaseMemory(selected.id)
                    .then(async () => {
                      updateCaseInPlace({ ...selected, memory_indexed: true });
                      const [nextRelated, nextAudit] = await Promise.all([getRelatedCases(selected.id), getAuditEvents()]);
                      setRelated(nextRelated);
                      setAudit(nextAudit);
                      setNotice("Resolved incident indexed for similar-case lookup.");
                    })
                    .catch((caught: unknown) => setError(readError(caught)))
                    .finally(() => endTask(key));
                };
                if (selected.memory_indexed) {
                  setConfirmAction({
                    title: "Re-index resolution",
                    message: "This resolution is already indexed. Re-indexing will update the stored embedding.",
                    confirmLabel: "Re-index",
                    onConfirm: doIndex,
                  });
                } else {
                  doIndex();
                }
              }}
              onGmail={() => runInline("gmail:" + selected.id, () => createGmailDraft(selected.id), "Gmail customer draft created.")}
              onSendMessage={async (content, messageType) => {
                const key = "message:" + selected.id;
                startTask(key);
                setError("");
                try {
                  const msg = await sendMessage(selected.id, content, messageType);
                  setMessages((prev) => {
                    const next = [...prev, msg];
                    setReadCounts((rc) => ({ ...rc, [selected.id]: next.length }));
                    setMsgCounts((mc) => ({ ...mc, [selected.id]: next.length }));
                    return next;
                  });
                  setAudit(await getAuditEvents());
                } catch (caught: unknown) {
                  setError(readError(caught));
                } finally {
                  endTask(key);
                }
              }}
              onRunbook={() => {
                const doRunbook = () => {
                  const key = "runbook:" + selected.id;
                  startTask(key);
                  generateRunbook(selected.id)
                    .then(async (nextRunbook) => {
                      updateCaseInPlace({ ...selected, runbook: nextRunbook });
                      setRunbook(nextRunbook);
                      setAudit(await getAuditEvents());
                      setNotice("Runbook recommendation generated from resolved incident evidence.");
                    })
                    .catch((caught: unknown) => setError(readError(caught)))
                    .finally(() => endTask(key));
                };
                if (runbook) {
                  setConfirmAction({
                    title: "Regenerate runbook",
                    message: "A runbook already exists for this case. Regenerating will replace the current runbook.",
                    confirmLabel: "Regenerate",
                    onConfirm: doRunbook,
                  });
                } else {
                  doRunbook();
                }
              }}
            />
          ) : (
            <section className="empty">
              <h2>Create your first production incident</h2>
              <p>Add a customer issue and logs to generate a support-ready investigation.</p>
            </section>
          )}
        </section>
      </main>
      )}
    </div>
  );
}

function LoginScreen({ busy, error, onAbout, onDismissError, onLogin }: { busy: boolean; error: string; onAbout: () => void; onDismissError: () => void; onLogin: (username: string, password: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return (
    <main className="login-page">
      <form className="card login" onSubmit={(event) => { event.preventDefault(); onLogin(username, password); }}>
        <p className="kicker">AI PRODUCTION SUPPORT COPILOT</p>
        <h1>ResolveIQ</h1>
        {error ? <StatusModal kind="error" message={error} onClose={onDismissError} /> : null}
        <label><span>Username</span><input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label><span>Password</span><input autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button className="primary" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
        <button className="text-action centered" onClick={onAbout} type="button">About ResolveIQ</button>
      </form>
    </main>
  );
}

function AboutPage({ user, busy, onBack, onInsights, onSignOut }: { user: AuthUser | null; busy: boolean; onBack: () => void; onInsights: () => void; onSignOut: () => void }) {
  const capabilities = [
    ["Incident intake", "Capture customer issues with priority, environment, service impact, and logs. Cases auto-sync to Jira."],
    ["Jira integration", "Bidirectional sync with Jira Cloud. Import tickets automatically, push local cases, and link directly to Jira issues."],
    ["Local AI analysis", "Prepare a diagnosis, troubleshooting steps, workaround, severity, and response draft using local AI."],
    ["Human approval", "Review and edit generated guidance before any escalation or customer communication."],
    ["Support operations", "Track response and resolution SLAs with breach alerts, hotspots, and recurring problem detection."],
    ["Knowledge base", "Auto-index resolved cases, surface similar incidents with resolutions, and generate grounded runbooks."],
    ["Real-time messaging", "Collaborate on cases with internal notes and customer-facing messages delivered in real time."],
    ["Controlled publishing", "Create approved Jira escalations and Gmail drafts with duplicate protection."],
    ["Accountability", "Actor-tagged audit trail, downloadable Markdown incident reports, and full case timeline."],
  ];
  return (
    <div className="app about-page">
      <header className="header-bar">
        <div className="header-brand">
          <button className="brand" onClick={onBack} type="button">ResolveIQ</button>
          <span className="header-kicker">About</span>
        </div>
        <nav className="header-nav" aria-label="Account and navigation">
          <button className="control-button" onClick={onBack} type="button"><ActionIcon kind={user ? "dashboard" : "user"} />{user ? "Dashboard" : "Sign in"}</button>
          {user ? <button className="control-button" onClick={onInsights} type="button"><ActionIcon kind="insights" />Insights</button> : null}
          <button aria-current="page" className="control-button active" type="button"><ActionIcon kind="about" />About</button>
          {user ? <button className="control-button" disabled={busy} onClick={onSignOut} type="button"><ActionIcon kind="logout" />Sign out</button> : null}
        </nav>
        {user ? <div className="profile-badge"><ActionIcon kind="user" />{user.username}</div> : null}
      </header>
      <main className="about-content">
        <p className="kicker">ABOUT</p>
        <h1>AI support work, kept accountable.</h1>
        <p className="about-lead">
          Turn customer incidents and application logs into reviewed diagnoses, response drafts, and resolution records.
        </p>
        <section className="capability-grid" aria-label="ResolveIQ capabilities">
          {capabilities.map(([title, detail]) => (
            <article key={title}>
              <h2>{title}</h2>
              <p>{detail}</p>
            </article>
          ))}
        </section>
        <p className="about-footnote">Local-first processing through Ollama and SQLite. External publishing happens only after explicit approval.</p>
      </main>
    </div>
  );
}

function StatusModal({ kind, message, onClose }: { kind: "success" | "error"; message: string; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        aria-label={kind === "success" ? "Success" : "Error"}
        aria-modal="true"
        className={`status-modal ${kind}`}
        role="alertdialog"
        onClick={(event) => event.stopPropagation()}
      >
        <button aria-label="Close message" className="modal-close" onClick={onClose} type="button">×</button>
        <p className="modal-label"><ActionIcon kind={kind} />{kind === "success" ? "Success" : "Unable to complete action"}</p>
        <p>{message}</p>
      </section>
    </div>
  );
}

function LogoutModal({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        aria-label="Confirm sign out"
        aria-modal="true"
        className="status-modal confirm"
        role="alertdialog"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="modal-label">Confirm</p>
        <p>Sign out of ResolveIQ?</p>
        <div className="actions">
          <button className="secondary" disabled={busy} onClick={onCancel}>Stay signed in</button>
          <button className="primary" disabled={busy} onClick={onConfirm}>{busy ? "Signing out..." : "Sign out"}</button>
        </div>
      </section>
    </div>
  );
}

function DeleteCaseModal({ caseItem, busy, onCancel, onConfirm }: { caseItem: SupportCase; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        aria-label="Confirm case delete"
        aria-modal="true"
        className="status-modal delete"
        role="alertdialog"
        onClick={(event) => event.stopPropagation()}
      >
        <button aria-label="Close delete confirmation" className="modal-close" disabled={busy} onClick={onCancel} type="button">×</button>
        <p className="modal-label">Delete case</p>
        <p>Delete "{caseItem.title}" from ResolveIQ?</p>
        <div className="actions">
          <button className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="danger" disabled={busy} onClick={onConfirm}>{busy ? "Deleting..." : "Delete case"}</button>
        </div>
      </section>
    </div>
  );
}

function ConfirmActionModal({ action, onCancel, onConfirm }: { action: ConfirmAction; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        aria-label={action.title}
        aria-modal="true"
        className="status-modal confirm"
        role="alertdialog"
        onClick={(event) => event.stopPropagation()}
      >
        <button aria-label="Close" className="modal-close" onClick={onCancel} type="button">×</button>
        <p className="modal-label">{action.title}</p>
        <p>{action.message}</p>
        <div className="actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onConfirm}>{action.confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

function ActionIcon({ kind }: { kind: "success" | "error" | "save" | "logout" | "download" | "reset" | "search" | "automation" | "dashboard" | "insights" | "about" | "user" | "trash" }) {
  if (kind === "success") {
    return <svg aria-hidden="true" className={`action-icon ${kind}`} viewBox="0 0 16 16"><path d="M3 8.2 6.3 11.5 13 4.5" /></svg>;
  }
  if (kind === "save") {
    return <svg aria-hidden="true" className="action-icon save" viewBox="0 0 16 16"><path d="M3 3.5h8.5L13 5v7.5H3zM5 3.5V7h6M5.5 12.5v-3h5v3" /></svg>;
  }
  if (kind === "error") {
    return <svg aria-hidden="true" className="action-icon error" viewBox="0 0 16 16"><path d="M8 3v6M8 12.3v.2" /></svg>;
  }
  if (kind === "logout") {
    return <svg aria-hidden="true" className="action-icon neutral" viewBox="0 0 16 16"><path d="M6 3H3.5v10H6M8 8h5M10.5 5.5 13 8l-2.5 2.5" /></svg>;
  }
  if (kind === "download") {
    return <svg aria-hidden="true" className="action-icon neutral" viewBox="0 0 16 16"><path d="M8 2.5v7M5.5 7 8 9.5 10.5 7M3 12.5h10" /></svg>;
  }
  if (kind === "search") {
    return <svg aria-hidden="true" className="action-icon neutral" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="4" /><path d="m9.5 9.5 3.5 3.5" /></svg>;
  }
  if (kind === "reset") {
    return <svg aria-hidden="true" className="action-icon neutral" viewBox="0 0 16 16"><path d="M12.5 6.5A4.5 4.5 0 1 0 11 11M12.5 3.5v3h-3" /></svg>;
  }
  if (kind === "dashboard") {
    return <svg aria-hidden="true" className="action-icon neutral" viewBox="0 0 16 16"><path d="M3 4h4v4H3zM9 4h4v3H9zM3 10h4v2H3zM9 9h4v3H9z" /></svg>;
  }
  if (kind === "insights") {
    return <svg aria-hidden="true" className="action-icon neutral" viewBox="0 0 16 16"><path d="M3 12.5V8M8 12.5V3.5M13 12.5V6M2.5 12.5h11" /></svg>;
  }
  if (kind === "about") {
    return <svg aria-hidden="true" className="action-icon neutral" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" /><path d="M8 7.5v3M8 5.5v.1" /></svg>;
  }
  if (kind === "user") {
    return <svg aria-hidden="true" className="action-icon neutral" viewBox="0 0 16 16"><circle cx="8" cy="5.5" r="2.5" /><path d="M3.5 13c.8-2.3 2.3-3.4 4.5-3.4s3.7 1.1 4.5 3.4" /></svg>;
  }
  if (kind === "trash") {
    return <svg aria-hidden="true" className="action-icon error" viewBox="0 0 16 16"><path d="M3.5 4.5h9M6.5 4.5v-1h3v1M5 6v6.5h6V6M7 7.5v3M9 7.5v3" /></svg>;
  }
  return <svg aria-hidden="true" className="action-icon neutral" viewBox="0 0 16 16"><path d="M8 2.5v11M2.5 8h11" /></svg>;
}

function AuditHistory({ events }: { events: AuditEvent[] }) {
  return (
    <section className="card insight-card audit">
      <div className="section-heading">
        <h2>Audit history</h2>
        <small className="muted">{events.length} recent event{events.length === 1 ? "" : "s"}</small>
      </div>
      {events.length === 0 ? <p className="muted">Actions taken after sign-in appear here.</p> : (
        <div className="audit-grid audit-scroll">
          {events.slice(0, 12).map((event) => (
            <article key={event.id}>
              <time>{new Date(event.at).toLocaleString()}</time>
              <strong>{formatAction(event.action)}</strong>
              <span className="meta-pair"><span>{event.actor}</span><span>{event.detail || event.resource_type}</span></span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function OperationsInsights({ trends, problems }: { trends: ServiceTrend[]; problems: ProblemGroup[] }) {
  return (
    <section className="insights">
      <section className="card insight-card">
        <h2>Service hotspots</h2>
        {trends.length === 0 ? <p className="muted">No incident trends recorded yet.</p> : (
          <div className="insight-scroll" aria-label="Scrollable service hotspots">
            {trends.map((trend) => (
              <article className="trend-row" key={trend.service}>
                <strong>{trend.service}</strong>
                <span className="metric-strip">
                  <span><strong>{trend.total_cases}</strong> cases</span>
                  <span><strong>{trend.open_cases}</strong> open</span>
                  <span><strong>{trend.breached_cases}</strong> breached</span>
                </span>
                <small>{trend.average_resolution_hours === null ? "No completed resolutions" : `${trend.average_resolution_hours}h average resolution`}</small>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="card insight-card">
        <h2>Problem management</h2>
        {problems.length === 0 ? <p className="muted">Resolve repeated incidents to identify recurring problems.</p> : (
          <div className="insight-scroll" aria-label="Scrollable recurring problems">
            {problems.map((problem) => (
              <article className="problem-row" key={`${problem.service}-${problem.cause}`}>
                <strong className="problem-heading"><span>{problem.service}</span><span>{problem.case_count} occurrence{problem.case_count === 1 ? "" : "s"}</span></strong>
                <span>{problem.cause}</span>
                <small>{problem.known_resolutions[0] ?? "No recorded resolution."}</small>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function OperationsOverview({ dashboard, cases }: { dashboard: OperationsDashboard | null; cases: SupportCase[] }) {
  const openBreached = cases.filter((c) => c.status !== "resolved" && c.sla_state === "breached").length;
  const openAtRisk = cases.filter((c) => c.status !== "resolved" && c.sla_state === "at_risk").length;
  const metrics = [
    ["Open incidents", dashboard?.open_cases ?? 0],
    ["Urgent open", dashboard?.urgent_open_cases ?? 0],
    ["Awaiting approval", dashboard?.awaiting_approval_cases ?? 0],
    ["SLA at risk", dashboard?.at_risk_cases ?? 0],
    ["SLA breached", dashboard?.breached_cases ?? 0],
    ["Resolved", dashboard?.resolved_cases ?? 0],
  ];
  return (
    <>
      {openBreached > 0 ? (
        <div className="sla-alert breached" role="alert">
          <ActionIcon kind="error" /><strong>{openBreached} open case{openBreached > 1 ? "s" : ""} breached SLA</strong> — immediate attention required
        </div>
      ) : openAtRisk > 0 ? (
        <div className="sla-alert at-risk" role="alert">
          <ActionIcon kind="error" /><strong>{openAtRisk} open case{openAtRisk > 1 ? "s" : ""} approaching SLA deadline</strong> — action recommended
        </div>
      ) : null}
      <section className="overview" aria-label="Support operations overview">
        {metrics.map(([label, value]) => (
          <article key={label}><span>{label}</span><strong>{value}</strong></article>
        ))}
      </section>
    </>
  );
}

function NewCaseModal({ disabled, onClose, onCreate }: { disabled: boolean; onClose: () => void; onCreate: (payload: CaseCreate) => void }) {
  const [form, setForm] = useState(EMPTY_CASE);
  function submit(event: FormEvent) {
    event.preventDefault();
    onCreate(form);
    setForm(EMPTY_CASE);
  }
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="new-case-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <button aria-label="Close" className="modal-close" onClick={onClose} type="button">×</button>
        <h2>New customer case</h2>
        <input required placeholder="Case title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <div className="paired">
          <input required placeholder="Customer" value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} />
          <input required placeholder="Affected service" value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} />
        </div>
        <div className="paired">
          <select value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="test">Test</option>
          </select>
          <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as Severity })}>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <textarea required rows={3} placeholder="Customer-reported issue" value={form.reported_issue} onChange={(e) => setForm({ ...form, reported_issue: e.target.value })} />
        <textarea rows={3} className="logs" placeholder="Paste logs, error messages, request IDs..." value={form.logs} onChange={(e) => setForm({ ...form, logs: e.target.value })} />
        <div className="actions">
          <button className="secondary" onClick={onClose} type="button">Cancel</button>
          <button disabled={disabled} className="primary action-save"><ActionIcon kind="save" />Create case</button>
        </div>
      </form>
    </div>
  );
}

function CaseSearch({ disabled, onReset, onSearch }: { disabled: boolean; onReset: () => void; onSearch: (query: string, status: string) => void }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  function resetSearch() {
    setQuery("");
    setStatus("");
    onReset();
  }
  return (
    <form className="card search-bar" onSubmit={(event) => { event.preventDefault(); onSearch(query, status); }}>
      <input placeholder="Search by customer, service, or symptoms..." value={query} onChange={(e) => setQuery(e.target.value)} />
      <select value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">All statuses</option>
        <option value="new">New</option>
        <option value="investigating">Investigating</option>
        <option value="awaiting_approval">Awaiting approval</option>
        <option value="approved">Approved / active</option>
        <option value="resolved">Resolved</option>
      </select>
      <button disabled={disabled} className="secondary"><ActionIcon kind="search" />Search</button>
      <button disabled={disabled} className="secondary action-reset" onClick={resetSearch} type="button"><ActionIcon kind="reset" />Reset</button>
    </form>
  );
}

function CaseHistory({ cases, selected, highlightId, jiraSiteUrl, msgCounts, readCounts, onDelete, onSelect }: { cases: SupportCase[]; selected: SupportCase | null; highlightId: string | null; jiraSiteUrl: string; msgCounts: Record<string, number>; readCounts: Record<string, number>; onDelete: (value: SupportCase) => void; onSelect: (value: SupportCase) => void }) {
  return (
    <nav className="history case-tabs">
      <h2>Case queue{cases.length > 1 ? ` (${cases.length})` : ""}</h2>
      {cases.map((item) => (
        <article key={item.id} className={`case-row${selected?.id === item.id ? " active" : ""}${highlightId === item.id ? " pulse" : ""}`}>
          <button className="case-tab" onClick={() => onSelect(item)} type="button">
            <strong>{item.title}</strong>
            {!item.jira_source_key ? <span className="meta-pair"><span>{item.service}</span></span> : null}
            <span className="case-badges">
              <small className={`severity ${item.severity}`}>{item.severity}</small>
              <small className={`status-badge ${item.status}`}>{STATUS_LABELS[item.status]}</small>
              {item.jira_source_key ? <a href={`${jiraSiteUrl}/browse/${item.jira_source_key}`} target="_blank" rel="noreferrer" className="source-badge jira" onClick={(e) => e.stopPropagation()}>Jira {item.jira_source_key}</a> : item.jira_issue_key && jiraSiteUrl ? <a href={`${jiraSiteUrl}/browse/${item.jira_issue_key}`} target="_blank" rel="noreferrer" className="source-badge jira" onClick={(e) => e.stopPropagation()}>Jira {item.jira_issue_key}</a> : null}
              {(msgCounts[item.id] ?? 0) > (readCounts[item.id] ?? 0) ? <small className="unread-badge">{(msgCounts[item.id] ?? 0) - (readCounts[item.id] ?? 0)} new</small> : null}
            </span>
          </button>
          <button aria-label={`Delete ${item.title}`} className="case-delete" onClick={() => onDelete(item)} title="Delete case" type="button"><ActionIcon kind="trash" /></button>
        </article>
      ))}
    </nav>
  );
}

function CaseDetail({ caseItem, health, related, messages, runbook, activeTasks, onAnalyze, onReview, onResolve, onAcknowledge, onIndex, onGmail, onSendMessage, onRunbook }: {
  caseItem: SupportCase;
  health: Health | null;
  related: RelatedCase[];
  messages: CaseMessage[];
  runbook: RunbookRecommendation | null;
  activeTasks: Set<string>;
  onAnalyze: () => void;
  onReview: (analysis: SupportAnalysis, approve: boolean) => void;
  onResolve: (resolution: string, preventiveActions: string[]) => void;
  onAcknowledge: () => void;
  onIndex: () => void;
  onGmail: () => void;
  onSendMessage: (content: string, messageType: "internal" | "customer") => void;
  onRunbook: () => void;
}) {
  const [draft, setDraft] = useState(caseItem.analysis);
  const [resolution, setResolution] = useState(caseItem.resolution);
  const [actions, setActions] = useState(caseItem.preventive_actions.join("\n"));
  const [detailView, setDetailView] = useState<DetailView>("all");
  const busy = (action: string) => activeTasks.has(action + ":" + caseItem.id);
  const mutating = busy("review") || busy("resolve") || busy("ack") || busy("jira") || busy("gmail");
  useEffect(() => {
    setDraft(caseItem.analysis);
    setResolution(caseItem.resolution);
    setActions(caseItem.preventive_actions.join("\n"));
    setDetailView("all");
  }, [caseItem]);
  const ready = caseItem.review_status !== "not_ready";
  const canPublish = caseItem.review_status === "approved" && caseItem.status !== "resolved";
  const hasReport = caseItem.status === "resolved";
  const hasRunbook = !!runbook;
  const availableViews: DetailView[] = [
    "all",
    "overview",
    "sla",
    "evidence",
    ...(ready ? ["analysis" as DetailView] : []),
    ...(canPublish ? ["publish" as DetailView] : []),
    ...(hasReport ? ["report" as DetailView] : []),
    "similar",
    "messages",
    ...(hasRunbook ? ["runbook" as DetailView] : []),
  ];
  const tabLabels: Record<DetailView, string> = {
    all: "All",
    overview: "Overview",
    sla: "SLA",
    evidence: "Evidence",
    analysis: "Analysis",
    publish: "Publish",
    report: "Report",
    similar: "Similar",
    messages: `Messages (${messages.length})`,
    runbook: "Runbook",
  };
  const isVisible = (view: DetailView) => detailView === "all" || detailView === view;
  return (
    <>
      <nav className="detail-tabbar" aria-label="Incident detail sections">
        {availableViews.map((view) => (
          <button
            aria-current={detailView === view ? "page" : undefined}
            className={detailView === view ? "detail-tab active" : "detail-tab"}
            key={view}
            onClick={() => setDetailView(view)}
            type="button"
          >
            {tabLabels[view]}
          </button>
        ))}
      </nav>
      {isVisible("overview") ? <section className="case-header card">
        <div>
          <p className="kicker">{caseItem.environment.toUpperCase()} INCIDENT</p>
          <h2>{caseItem.title}</h2>
          <p className="meta-pair"><span>{caseItem.customer}</span><span>{caseItem.service}</span></p>
          {caseItem.jira_source_key && health?.jira_site_url ? (
            <a className="jira-link" href={`${health.jira_site_url}/browse/${caseItem.jira_source_key}`} target="_blank" rel="noreferrer">View in Jira ({caseItem.jira_source_key})</a>
          ) : caseItem.jira_issue_url ? (
            <a className="jira-link" href={caseItem.jira_issue_url} target="_blank" rel="noreferrer">View in Jira ({caseItem.jira_issue_key})</a>
          ) : null}
        </div>
        <div className="case-flags">
          <div className={`severity-pill ${caseItem.severity}`}>{caseItem.severity}</div>
          <div className={`sla-pill ${caseItem.sla_state}`}>SLA {caseItem.sla_state.replace("_", " ")}</div>
        </div>
      </section> : null}
      {isVisible("sla") ? <section className="card sla-panel">
        <div>
          <span>Initial response target</span>
          <strong>{formatDeadline(caseItem.response_due_at)}</strong>
          <small>{caseItem.first_response_at ? `Acknowledged ${formatDeadline(caseItem.first_response_at)}` : "Response not recorded"}</small>
        </div>
        <div>
          <span>Resolution target</span>
          <strong>{formatDeadline(caseItem.resolution_due_at)}</strong>
          <small>{caseItem.status === "resolved" ? "Resolution recorded" : "Incident remains open"}</small>
        </div>
        {caseItem.first_response_at ? (
          <span className="state-badge success"><ActionIcon kind="success" />Customer acknowledged</span>
        ) : (
          <button className="secondary action-save" disabled={mutating || caseItem.status === "resolved"} onClick={onAcknowledge}>
            <ActionIcon kind="save" />
            Record acknowledgement
          </button>
        )}
      </section> : null}
      {isVisible("evidence") ? <section className="card evidence">
        <div className="section-heading"><h3>Customer report and evidence</h3><button className="primary" disabled={busy("analyze")} onClick={onAnalyze}>{busy("analyze") ? "Analyzing..." : ready ? "Re-analyze" : "Analyze with local AI"}</button></div>
        <p>{caseItem.reported_issue}</p>
        <pre>{caseItem.logs || "No logs supplied."}</pre>
      </section> : null}
      {ready && isVisible("analysis") ? (
        <section className="card analysis">
          <div className="section-heading">
            <h3>Support analysis</h3>
            <select value={draft.suggested_severity} onChange={(e) => setDraft({ ...draft, suggested_severity: e.target.value as Severity })}>
              <option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select>
          </div>
          <div className="analysis-grid">
            <Editable label="Incident summary" value={draft.incident_summary} onChange={(value) => setDraft({ ...draft, incident_summary: value })} />
            <Editable label="Customer impact" value={draft.customer_impact} onChange={(value) => setDraft({ ...draft, customer_impact: value })} />
            <Editable label="Likely cause" value={draft.likely_cause} onChange={(value) => setDraft({ ...draft, likely_cause: value })} />
            <Editable label="Workaround" value={draft.workaround} onChange={(value) => setDraft({ ...draft, workaround: value })} />
            <ListEditor label="Diagnostic steps" values={draft.diagnostic_steps} onChange={(values) => setDraft({ ...draft, diagnostic_steps: values })} />
            <ListEditor label="Information to request" values={draft.information_to_request} onChange={(values) => setDraft({ ...draft, information_to_request: values })} />
            <Editable label="Customer email subject" value={draft.customer_email_subject} onChange={(value) => setDraft({ ...draft, customer_email_subject: value })} />
            <Editable label="Customer update draft" value={draft.customer_email_body} rows={5} onChange={(value) => setDraft({ ...draft, customer_email_body: value })} />
          </div>
          <div className="actions">
            <button className="secondary action-save" disabled={mutating} onClick={() => onReview(draft, false)}><ActionIcon kind="save" />Save edits</button>
            <button className="primary action-save" disabled={mutating} onClick={() => onReview(draft, true)}>Approve analysis</button>
          </div>
        </section>
      ) : null}
      {canPublish && isVisible("publish") ? (
        <>
          <section className="card publishing">
            <h3>Actions</h3>
            <div className="actions left">
              {(() => {
                const jiraKey = caseItem.jira_source_key || caseItem.jira_issue_key;
                const jiraUrl = caseItem.jira_source_key ? `${health?.jira_site_url}/browse/${caseItem.jira_source_key}` : caseItem.jira_issue_url;
                return jiraKey && jiraUrl ? (
                  <a className="secondary jira-link-btn" href={jiraUrl} target="_blank" rel="noreferrer">Open Jira ({jiraKey})</a>
                ) : null;
              })()}
              <button className="secondary" disabled={mutating || !health?.gmail_configured || !!caseItem.gmail_draft_id} onClick={onGmail}>
                {caseItem.gmail_draft_id ? "Gmail draft created" : "Create Gmail draft"}
              </button>
            </div>
            {!health?.gmail_configured ? <small className="muted">Configure Gmail credentials in backend/.env to enable drafts.</small> : null}
          </section>
          <section className="card closure">
            <h3>Resolution record</h3>
            <textarea rows={4} placeholder="Resolution applied and verification performed" value={resolution} onChange={(e) => setResolution(e.target.value)} />
            <textarea rows={3} placeholder="Preventive actions, one per line" value={actions} onChange={(e) => setActions(e.target.value)} />
            <button className="primary action-save" disabled={mutating || !resolution.trim()} onClick={() => onResolve(resolution, lines(actions))}><ActionIcon kind="save" />Mark resolved</button>
          </section>
        </>
      ) : null}
      {hasReport && isVisible("report") ? (
        <section className="card report">
          <div className="section-heading">
            <h3>Post-incident report</h3>
            <div className="section-heading-actions">
              {caseItem.memory_indexed ? (
                <>
                  <span className="state-badge success"><ActionIcon kind="success" />Indexed</span>
                  <button className="secondary action-save" disabled={busy("index")} onClick={onIndex}><ActionIcon kind="save" />Re-index</button>
                </>
              ) : null}
            </div>
          </div>
          <p><strong>Summary:</strong> {caseItem.post_incident_report.summary}</p>
          <p><strong>Impact:</strong> {caseItem.post_incident_report.customer_impact}</p>
          <p><strong>Root cause:</strong> {caseItem.post_incident_report.root_cause}</p>
          <p><strong>Resolution:</strong> {caseItem.post_incident_report.resolution}</p>
          <p><strong>Prevention:</strong> {caseItem.post_incident_report.preventive_actions.join("; ") || "None recorded."}</p>
        </section>
      ) : null}
      {isVisible("similar") ? <section className="card related">
        <div className="section-heading related-heading">
          <h3>Similar resolved incidents</h3>
          <button className="secondary" disabled={busy("runbook") || related.length === 0} onClick={onRunbook}>{busy("runbook") ? "Generating..." : "Generate runbook"}</button>
        </div>
        {related.length === 0 ? <p className="muted">No indexed resolution matches yet.</p> : related.map((item) => (
          <article key={item.case.id}>
            <strong>{item.case.title}</strong>
            <span className="meta-pair"><span>{Math.round(item.score * 100)}% {item.match_type} match</span><span>{item.case.service}</span></span>
            {item.case.resolution ? <p className="kb-resolution"><strong>Resolution:</strong> {item.case.resolution}</p> : null}
            {item.case.preventive_actions.length > 0 ? <p className="kb-resolution"><strong>Prevention:</strong> {item.case.preventive_actions.join("; ")}</p> : null}
          </article>
        ))}
      </section> : null}
      {isVisible("messages") ? <MessageThread caseId={caseItem.id} messages={messages} busy={busy("message")} onSend={onSendMessage} /> : null}
      {hasRunbook && isVisible("runbook") ? (
        <section className="card runbook">
          <h3>{runbook.title}</h3>
          <ListBlock label="Symptoms to verify" values={runbook.symptoms} />
          <ListBlock label="Verification steps" values={runbook.verification_steps} />
          <ListBlock label="Mitigation steps" values={runbook.mitigation_steps} />
          <p><strong>Escalation guidance:</strong> {runbook.escalation_guidance}</p>
          <small className="muted">Grounded in {runbook.evidence_case_ids.length} resolved incident(s).</small>
        </section>
      ) : null}
    </>
  );
}

function MessageThread({ caseId, messages, busy, onSend }: { caseId: string; messages: CaseMessage[]; busy: boolean; onSend: (content: string, messageType: "internal" | "customer") => void }) {
  const [draft, setDraft] = useState("");
  const [messageType, setMessageType] = useState<"internal" | "customer">("internal");
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [messages.length]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    onSend(draft.trim(), messageType);
    setDraft("");
  }
  return (
    <section className="card messages">
      <h3>Messages</h3>
      <div className="message-scroll" ref={scrollRef}>
        {messages.length === 0 ? <p className="muted">No messages yet. Start a conversation to collaborate on this case.</p> : messages.map((msg) => (
          <article key={msg.id} className={`message-bubble ${msg.message_type}`}>
            <span className="message-meta">
              <strong>{msg.author}</strong>
              <small className={`message-type-badge ${msg.message_type}`}>{msg.message_type}</small>
              <time>{new Date(msg.created_at).toLocaleString()}</time>
            </span>
            <p>{msg.content}</p>
          </article>
        ))}
      </div>
      <form className="message-compose" onSubmit={submit}>
        <select value={messageType} onChange={(e) => setMessageType(e.target.value as "internal" | "customer")}>
          <option value="internal">Internal note</option>
          <option value="customer">Customer message</option>
        </select>
        <input placeholder="Type a message..." value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="primary" disabled={busy || !draft.trim()} type="submit">Send</button>
      </form>
    </section>
  );
}

function TimelineCard({ caseItem, busy, onDownloadReport }: { caseItem: SupportCase; busy: boolean; onDownloadReport: () => void }) {
  return (
    <section className="card insight-card timeline">
      <div className="section-heading">
        <h3>Timeline</h3>
        <button className="export-link" disabled={busy} onClick={onDownloadReport}><ActionIcon kind="download" />Download report</button>
      </div>
      <div className="timeline-scroll">
        {caseItem.timeline.map((entry) => <p key={entry.at + entry.event}><time>{new Date(entry.at).toLocaleString()}</time>{entry.event}</p>)}
      </div>
    </section>
  );
}

function Editable({ label, value, onChange, rows = 3, className = "" }: { label: string; value: string; onChange: (value: string) => void; rows?: number; className?: string }) {
  return <label className={className}><span>{label}</span><textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}

function ListEditor({ label, values, onChange, className = "" }: { label: string; values: string[]; onChange: (values: string[]) => void; className?: string }) {
  return <Editable className={className} label={label} value={values.join("\n")} onChange={(value) => onChange(lines(value))} />;
}

function ListBlock({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <strong>{label}</strong>
      <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>
    </div>
  );
}

function lines(value: string) {
  return value.split("\n").map((entry) => entry.trim()).filter(Boolean);
}

function readError(caught: unknown) {
  return caught instanceof Error ? caught.message : "Request failed.";
}

function formatDeadline(value: string) {
  return new Date(value).toLocaleString();
}

function formatAction(action: string) {
  return action.split(".").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

export default App;
