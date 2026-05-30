export type CaseStatus = "new" | "investigating" | "awaiting_approval" | "approved" | "resolved";
export type Severity = "critical" | "high" | "medium" | "low";
export type ReviewStatus = "not_ready" | "pending_review" | "approved";
export type SlaState = "on_track" | "at_risk" | "breached" | "met";

export interface AuthUser {
  username: string;
  role: "support_admin";
}

export interface LoginResponse {
  access_token: string;
  expires_at: string;
  user: AuthUser;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string;
  detail: string;
}

export interface SupportAnalysis {
  incident_summary: string;
  customer_impact: string;
  likely_cause: string;
  suggested_severity: Severity;
  diagnostic_steps: string[];
  workaround: string;
  information_to_request: string[];
  customer_email_subject: string;
  customer_email_body: string;
}

export interface TimelineEvent {
  at: string;
  event: string;
}

export interface PostIncidentReport {
  summary: string;
  customer_impact: string;
  root_cause: string;
  resolution: string;
  preventive_actions: string[];
}

export interface SupportCase {
  id: string;
  title: string;
  customer: string;
  service: string;
  environment: string;
  reported_issue: string;
  logs: string;
  status: CaseStatus;
  severity: Severity;
  created_at: string;
  updated_at: string;
  response_due_at: string;
  resolution_due_at: string;
  first_response_at: string | null;
  sla_state: SlaState;
  analysis: SupportAnalysis;
  review_status: ReviewStatus;
  approved_at: string | null;
  resolution: string;
  preventive_actions: string[];
  post_incident_report: PostIncidentReport;
  jira_issue_key: string | null;
  jira_issue_url: string | null;
  jira_published_at: string | null;
  gmail_draft_id: string | null;
  gmail_draft_created_at: string | null;
  jira_source_key: string | null;
  memory_indexed: boolean;
  runbook: RunbookRecommendation | null;
  timeline: TimelineEvent[];
}

export interface CaseCreate {
  title: string;
  customer: string;
  service: string;
  environment: string;
  reported_issue: string;
  logs: string;
  severity: Severity;
}

export interface Health {
  status: string;
  ollama_installed: boolean;
  ollama_model: string;
  embedding_model: string;
  jira_configured: boolean;
  jira_site_url: string;
  gmail_configured: boolean;
  stored_cases: number;
}

export interface MemoryStatus {
  resolved_cases: number;
  indexed_cases: number;
  embedding_model: string;
}

export interface RelatedCase {
  case: SupportCase;
  score: number;
  match_type: "semantic" | "text";
}

export interface OperationsDashboard {
  total_cases: number;
  open_cases: number;
  urgent_open_cases: number;
  awaiting_approval_cases: number;
  breached_cases: number;
  at_risk_cases: number;
  resolved_cases: number;
  average_resolution_hours: number | null;
}

export interface ServiceTrend {
  service: string;
  total_cases: number;
  open_cases: number;
  resolved_cases: number;
  breached_cases: number;
  average_resolution_hours: number | null;
}

export interface ProblemGroup {
  service: string;
  cause: string;
  case_count: number;
  cases: SupportCase[];
  known_resolutions: string[];
}

export interface RunbookRecommendation {
  title: string;
  symptoms: string[];
  verification_steps: string[];
  mitigation_steps: string[];
  escalation_guidance: string;
  evidence_case_ids: string[];
}

export interface CaseMessage {
  id: string;
  case_id: string;
  author: string;
  content: string;
  message_type: "internal" | "customer";
  created_at: string;
}

export interface JiraSyncResult {
  imported: number;
  skipped: number;
  cases: SupportCase[];
}

export interface AppState {
  health: Health;
  cases: SupportCase[];
  dashboard: OperationsDashboard;
  trends: ServiceTrend[];
  problems: ProblemGroup[];
  audit: AuditEvent[];
  preferences: Record<string, string>;
}
