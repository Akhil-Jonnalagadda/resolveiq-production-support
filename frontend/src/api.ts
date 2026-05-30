import type {
  AppState,
  AuditEvent,
  AuthUser,
  CaseCreate,
  CaseMessage,
  Health,
  JiraSyncResult,
  LoginResponse,
  MemoryStatus,
  OperationsDashboard,
  ProblemGroup,
  RelatedCase,
  RunbookRecommendation,
  ServiceTrend,
  SupportAnalysis,
  SupportCase,
} from "./types";

let authenticated = false;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const response = await fetch(url, { ...options, headers, credentials: "include" });
  if (response.status === 401 && authenticated && url !== "/api/auth/login") {
    authenticated = false;
    window.dispatchEvent(new Event("resolveiq:unauthorized"));
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const result = await request<LoginResponse>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  authenticated = true;
  return result;
}

export async function getCurrentUser(): Promise<AuthUser> {
  const user = await request<AuthUser>("/api/auth/me");
  authenticated = true;
  return user;
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  authenticated = false;
  if (!response.ok) throw new Error("Unable to sign out.");
}

export function getAppState(): Promise<AppState> {
  return request<AppState>("/api/state");
}

export function getAuditEvents(): Promise<AuditEvent[]> {
  return request<AuditEvent[]>("/api/audit");
}

export function getHealth(): Promise<Health> {
  return request<Health>("/api/health");
}

export function listCases(): Promise<SupportCase[]> {
  return request<SupportCase[]>("/api/cases");
}

export function getDashboard(): Promise<OperationsDashboard> {
  return request<OperationsDashboard>("/api/dashboard");
}

export function getServiceTrends(): Promise<ServiceTrend[]> {
  return request<ServiceTrend[]>("/api/trends/services");
}

export function getProblemGroups(): Promise<ProblemGroup[]> {
  return request<ProblemGroup[]>("/api/problems");
}

export function searchCases(query: string, status: string): Promise<SupportCase[]> {
  const parameters = new URLSearchParams();
  if (query.trim()) parameters.set("q", query.trim());
  if (status) parameters.set("status", status);
  return request<SupportCase[]>(`/api/cases/search?${parameters.toString()}`);
}

export function createCase(payload: CaseCreate): Promise<SupportCase> {
  return request<SupportCase>("/api/cases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteCase(caseId: string): Promise<void> {
  const response = await fetch(`/api/cases/${caseId}`, { method: "DELETE", credentials: "include" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail ?? "Unable to delete support case.");
  }
}

export function analyzeCase(caseId: string): Promise<SupportCase> {
  return request<SupportCase>(`/api/cases/${caseId}/analyze`, { method: "POST" });
}

export function saveReview(
  caseId: string,
  analysis: SupportAnalysis,
  approve: boolean,
): Promise<SupportCase> {
  return request<SupportCase>(`/api/cases/${caseId}/review`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ analysis, approve }),
  });
}

export function resolveCase(
  caseId: string,
  resolution: string,
  preventiveActions: string[],
): Promise<SupportCase> {
  return request<SupportCase>(`/api/cases/${caseId}/resolve`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolution, preventive_actions: preventiveActions }),
  });
}

export function acknowledgeCase(caseId: string): Promise<SupportCase> {
  return request<SupportCase>(`/api/cases/${caseId}/acknowledge`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: "Initial response acknowledged with customer." }),
  });
}

export function getMemoryStatus(): Promise<MemoryStatus> {
  return request<MemoryStatus>("/api/memory/status");
}

export function indexCaseMemory(caseId: string): Promise<MemoryStatus> {
  return request<MemoryStatus>(`/api/cases/${caseId}/memory/index`, { method: "POST" });
}

export function getRelatedCases(caseId: string): Promise<RelatedCase[]> {
  return request<RelatedCase[]>(`/api/cases/${caseId}/related`);
}

export function generateRunbook(caseId: string): Promise<RunbookRecommendation> {
  return request<RunbookRecommendation>(`/api/cases/${caseId}/runbook`, { method: "POST" });
}

export async function downloadReport(caseId: string, filename: string): Promise<void> {
  const response = await fetch(`/api/cases/${caseId}/report.md`, { credentials: "include" });
  if (!response.ok) throw new Error("Unable to download incident report.");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function createJiraEscalation(caseId: string): Promise<SupportCase> {
  return request<SupportCase>(`/api/cases/${caseId}/jira`, { method: "POST" });
}

export function createGmailDraft(caseId: string): Promise<SupportCase> {
  return request<SupportCase>(`/api/cases/${caseId}/gmail-draft`, { method: "POST" });
}

export function getJiraPending(): Promise<{ count: number }> {
  return request<{ count: number }>("/api/jira/pending");
}

export function getCase(caseId: string): Promise<SupportCase> {
  return request<SupportCase>(`/api/cases/${caseId}`);
}

export function syncJiraTickets(): Promise<JiraSyncResult> {
  return request<JiraSyncResult>("/api/jira/sync", { method: "POST" });
}

export function getKBSuggestions(caseId: string): Promise<RelatedCase[]> {
  return request<RelatedCase[]>(`/api/cases/${caseId}/suggestions`);
}

export function getMessageCounts(): Promise<Record<string, number>> {
  return request<Record<string, number>>("/api/messages/counts");
}

export function getMessages(caseId: string): Promise<CaseMessage[]> {
  return request<CaseMessage[]>(`/api/cases/${caseId}/messages`);
}

export function sendMessage(
  caseId: string,
  content: string,
  messageType: "internal" | "customer" = "internal",
): Promise<CaseMessage> {
  return request<CaseMessage>(`/api/cases/${caseId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, message_type: messageType }),
  });
}

export function savePreference(key: string, value: string | null): Promise<Record<string, string>> {
  return request<Record<string, string>>("/api/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}
