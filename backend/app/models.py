from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


CaseStatus = Literal["new", "investigating", "awaiting_approval", "approved", "resolved"]
Severity = Literal["critical", "high", "medium", "low"]
ReviewStatus = Literal["not_ready", "pending_review", "approved"]
SlaState = Literal["on_track", "at_risk", "breached", "met"]


class CaseCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    customer: str = Field(min_length=1, max_length=120)
    service: str = Field(min_length=1, max_length=120)
    environment: Literal["production", "staging", "test"] = "production"
    reported_issue: str = Field(min_length=1)
    logs: str = ""
    severity: Severity = "medium"


class SupportAnalysis(BaseModel):
    incident_summary: str = ""
    customer_impact: str = ""
    likely_cause: str = ""
    suggested_severity: Severity = "medium"
    diagnostic_steps: list[str] = Field(default_factory=list)
    workaround: str = ""
    information_to_request: list[str] = Field(default_factory=list)
    customer_email_subject: str = ""
    customer_email_body: str = ""


class AnalysisReview(BaseModel):
    analysis: SupportAnalysis
    approve: bool = False


class ResolutionUpdate(BaseModel):
    resolution: str = Field(min_length=1)
    preventive_actions: list[str] = Field(default_factory=list)


class PostIncidentReport(BaseModel):
    summary: str = ""
    customer_impact: str = ""
    root_cause: str = ""
    resolution: str = ""
    preventive_actions: list[str] = Field(default_factory=list)


class RunbookRecommendation(BaseModel):
    title: str = ""
    symptoms: list[str] = Field(default_factory=list)
    verification_steps: list[str] = Field(default_factory=list)
    mitigation_steps: list[str] = Field(default_factory=list)
    escalation_guidance: str = ""
    evidence_case_ids: list[str] = Field(default_factory=list)


class TimelineEvent(BaseModel):
    at: datetime
    event: str


class CaseMessage(BaseModel):
    id: str
    case_id: str
    author: str
    content: str
    message_type: Literal["internal", "customer"] = "internal"
    created_at: datetime


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    message_type: Literal["internal", "customer"] = "internal"


class JiraSyncResult(BaseModel):
    imported: int
    skipped: int
    cases: list["SupportCase"]


class AcknowledgeUpdate(BaseModel):
    note: str = Field(default="Customer acknowledgement recorded.", max_length=300)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=200)


class AuthUser(BaseModel):
    username: str
    role: Literal["support_admin"] = "support_admin"


class LoginResponse(BaseModel):
    access_token: str
    expires_at: datetime
    user: AuthUser


class AuditEvent(BaseModel):
    id: str
    at: datetime
    actor: str
    action: str
    resource_type: str
    resource_id: str
    detail: str = ""


class SupportCase(BaseModel):
    id: str
    title: str
    customer: str
    service: str
    environment: str
    reported_issue: str
    logs: str
    status: CaseStatus
    severity: Severity
    created_at: datetime
    updated_at: datetime
    response_due_at: datetime
    resolution_due_at: datetime
    first_response_at: datetime | None = None
    sla_state: SlaState = "on_track"
    analysis: SupportAnalysis = Field(default_factory=SupportAnalysis)
    review_status: ReviewStatus = "not_ready"
    approved_at: datetime | None = None
    resolution: str = ""
    preventive_actions: list[str] = Field(default_factory=list)
    post_incident_report: PostIncidentReport = Field(default_factory=PostIncidentReport)
    jira_issue_key: str | None = None
    jira_issue_url: str | None = None
    jira_published_at: datetime | None = None
    gmail_draft_id: str | None = None
    gmail_draft_created_at: datetime | None = None
    jira_source_key: str | None = None
    memory_indexed: bool = False
    runbook: RunbookRecommendation | None = None
    timeline: list[TimelineEvent] = Field(default_factory=list)


class RelatedCase(BaseModel):
    case: SupportCase
    score: float
    match_type: Literal["semantic", "text"]


class MemoryStatus(BaseModel):
    resolved_cases: int
    indexed_cases: int
    embedding_model: str


class OperationsDashboard(BaseModel):
    total_cases: int
    open_cases: int
    urgent_open_cases: int
    awaiting_approval_cases: int
    breached_cases: int
    at_risk_cases: int
    resolved_cases: int
    average_resolution_hours: float | None = None


class ServiceTrend(BaseModel):
    service: str
    total_cases: int
    open_cases: int
    resolved_cases: int
    breached_cases: int
    average_resolution_hours: float | None = None


class ProblemGroup(BaseModel):
    service: str
    cause: str
    case_count: int
    cases: list[SupportCase] = Field(default_factory=list)
    known_resolutions: list[str] = Field(default_factory=list)


class PreferenceUpdate(BaseModel):
    key: str = Field(min_length=1, max_length=120)
    value: str | None = None


class HealthResponse(BaseModel):
    status: str
    ollama_installed: bool
    ollama_model: str
    embedding_model: str
    jira_configured: bool
    jira_site_url: str = ""
    gmail_configured: bool
    stored_cases: int


class AppState(BaseModel):
    health: HealthResponse
    cases: list[SupportCase]
    dashboard: OperationsDashboard
    trends: list[ServiceTrend]
    problems: list[ProblemGroup]
    audit: list[AuditEvent]
    preferences: dict[str, str]
