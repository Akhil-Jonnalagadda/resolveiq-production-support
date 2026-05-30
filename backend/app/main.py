import shutil
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from .config import Settings
from .database import CaseDatabase
from .models import (
    AnalysisReview,
    AcknowledgeUpdate,
    AppState,
    AuditEvent,
    AuthUser,
    CaseCreate,
    CaseMessage,
    HealthResponse,
    JiraSyncResult,
    LoginRequest,
    LoginResponse,
    MemoryStatus,
    MessageCreate,
    OperationsDashboard,
    PreferenceUpdate,
    ProblemGroup,
    RelatedCase,
    ResolutionUpdate,
    RunbookRecommendation,
    ServiceTrend,
    SupportCase,
)
from .services.auth import LocalAuthenticator
from .services.analysis import AnalysisUnavailable, OllamaSupportAnalyst
from .services.gmail import GmailDraftError, GmailDraftPublisher
from .services.jira import JiraEscalationPublisher, JiraPublishError
from .services.memory import EmbeddingUnavailable, LocalEmbedder, cosine_similarity, text_similarity


settings = Settings()
database = CaseDatabase(settings.database_path)
analyst = OllamaSupportAnalyst(settings.ollama_url, settings.ollama_model)
embedder = LocalEmbedder(settings.ollama_url, settings.embedding_model)
jira_publisher = JiraEscalationPublisher(
    settings.jira_site_url,
    settings.jira_email,
    settings.jira_api_token,
    settings.jira_project_key,
    settings.jira_issue_type,
)
gmail_publisher = GmailDraftPublisher(
    settings.gmail_client_id, settings.gmail_client_secret, settings.gmail_refresh_token
)
authenticator = LocalAuthenticator(
    settings.auth_username, settings.auth_password, settings.auth_session_hours
)


class _WSManager:
    def __init__(self) -> None:
        self._connections: dict[str, list[WebSocket]] = {}

    async def connect(self, case_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.setdefault(case_id, []).append(websocket)

    def disconnect(self, case_id: str, websocket: WebSocket) -> None:
        conns = self._connections.get(case_id, [])
        self._connections[case_id] = [ws for ws in conns if ws is not websocket]

    async def broadcast(self, case_id: str, data: dict) -> None:
        for ws in list(self._connections.get(case_id, [])):
            try:
                await ws.send_json(data)
            except Exception:
                self.disconnect(case_id, ws)


ws_manager = _WSManager()


@asynccontextmanager
async def lifespan(_: FastAPI):
    database.initialize()
    yield


app = FastAPI(title="ResolveIQ API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_authenticated_session(request: Request, call_next):
    public_paths = {"/api/auth/login"}
    if (
        request.method != "OPTIONS"
        and request.url.path.startswith("/api/")
        and request.url.path not in public_paths
    ):
        authorization = request.headers.get("Authorization")
        if not authorization:
            cookie_token = request.cookies.get("resolveiq_session")
            if cookie_token:
                authorization = f"Bearer {cookie_token}"
        user = authenticator.authenticate(authorization)
        if user is None:
            return JSONResponse(status_code=401, content={"detail": "Authentication required."})
        request.state.user = user
    return await call_next(request)


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ready",
        ollama_installed=shutil.which("ollama") is not None,
        ollama_model=settings.ollama_model,
        embedding_model=settings.embedding_model,
        jira_configured=jira_publisher.configured,
        jira_site_url=settings.jira_site_url.rstrip("/") if jira_publisher.configured else "",
        gmail_configured=gmail_publisher.configured,
        stored_cases=database.count_cases(),
    )


@app.post("/api/auth/login")
def login(payload: LoginRequest):
    session = authenticator.login(payload.username, payload.password)
    if session is None:
        raise HTTPException(status_code=401, detail="Bad credentials.")
    database.record_audit(session.user.username, "auth.login", "session", session.user.username)
    response = JSONResponse(content=session.model_dump(mode="json"))
    response.set_cookie(
        key="resolveiq_session",
        value=session.access_token,
        httponly=True,
        samesite="lax",
        max_age=settings.auth_session_hours * 3600,
        path="/api",
    )
    return response


@app.get("/api/auth/me", response_model=AuthUser)
def current_user(request: Request) -> AuthUser:
    return request.state.user


@app.post("/api/auth/logout")
def logout(request: Request, authorization: str | None = Header(default=None)):
    user = request.state.user
    auth = authorization
    if not auth:
        cookie_token = request.cookies.get("resolveiq_session")
        if cookie_token:
            auth = f"Bearer {cookie_token}"
    authenticator.logout(auth)
    database.record_audit(user.username, "auth.logout", "session", user.username)
    response = Response(status_code=204)
    response.delete_cookie("resolveiq_session", path="/api")
    return response


@app.get("/api/audit", response_model=list[AuditEvent])
def audit_history(limit: int = Query(default=100, ge=1, le=250)) -> list[AuditEvent]:
    return database.list_audit_events(limit)


@app.get("/api/preferences")
def get_preferences(request: Request) -> dict[str, str]:
    return database.get_preferences(request.state.user.username)


@app.put("/api/preferences")
def update_preference(payload: PreferenceUpdate, request: Request) -> dict[str, str]:
    database.set_preference(request.state.user.username, payload.key, payload.value)
    return database.get_preferences(request.state.user.username)


@app.get("/api/state", response_model=AppState)
def app_state(request: Request) -> AppState:
    return AppState(
        health=health(),
        cases=database.list_cases(),
        dashboard=database.dashboard(),
        trends=database.service_trends(),
        problems=database.problem_groups(),
        audit=database.list_audit_events(),
        preferences=database.get_preferences(request.state.user.username),
    )


@app.get("/api/cases", response_model=list[SupportCase])
def list_cases() -> list[SupportCase]:
    return database.list_cases()


@app.get("/api/dashboard", response_model=OperationsDashboard)
def dashboard() -> OperationsDashboard:
    return database.dashboard()


@app.get("/api/trends/services", response_model=list[ServiceTrend])
def service_trends() -> list[ServiceTrend]:
    return database.service_trends()


@app.get("/api/problems", response_model=list[ProblemGroup])
def problem_groups() -> list[ProblemGroup]:
    return database.problem_groups()


@app.get("/api/cases/search", response_model=list[SupportCase])
def search_cases(q: str = Query(default=""), status: str = Query(default="")) -> list[SupportCase]:
    return database.search_cases(q, status)


@app.get("/api/cases/{case_id}", response_model=SupportCase)
def get_case(case_id: str) -> SupportCase:
    return _find_case(case_id)


@app.delete("/api/cases/{case_id}", status_code=204)
def delete_case(case_id: str, request: Request) -> None:
    case = _find_case(case_id)
    _audit(request, "case.deleted", case, f"Deleted case: {case.title}.")
    database.delete_case(case_id)


@app.post("/api/cases", response_model=SupportCase)
def create_case(payload: CaseCreate, request: Request, background_tasks: BackgroundTasks) -> SupportCase:
    case = database.create_case(payload)
    _audit(request, "case.created", case, f"Created case for {case.customer}.")
    if jira_publisher.configured:
        try:
            key, url = jira_publisher.create_tracking_issue(
                case.title, case.customer, case.service, case.environment,
                case.reported_issue, case.severity,
            )
            case = database.save_jira_issue(case.id, key, url)
            _audit(request, "jira.auto_created", case, f"Jira ticket {key} created automatically.")
        except JiraPublishError:
            pass
    background_tasks.add_task(_auto_analyze, case.id, request.state.user.username)
    return case


@app.post("/api/cases/{case_id}/analyze", response_model=SupportCase)
def analyze_case(case_id: str, request: Request) -> SupportCase:
    case = _find_case(case_id)
    database.mark_investigating(case_id)
    _audit(request, "analysis.started", case, "Local AI incident analysis started.")
    try:
        analysis = analyst.analyze(case)
    except AnalysisUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    updated = database.save_analysis(case_id, analysis)
    _audit(request, "analysis.generated", updated, "Analysis prepared for human review.")
    return updated


@app.put("/api/cases/{case_id}/review", response_model=SupportCase)
def review_case(case_id: str, payload: AnalysisReview, request: Request) -> SupportCase:
    _find_case(case_id)
    case = database.save_review(case_id, payload.analysis, payload.approve)
    action = "analysis.approved" if payload.approve else "analysis.edited"
    _audit(request, action, case, "Human review decision saved.")
    return case


@app.put("/api/cases/{case_id}/resolve", response_model=SupportCase)
def resolve_case(case_id: str, payload: ResolutionUpdate, request: Request, background_tasks: BackgroundTasks) -> SupportCase:
    _find_case(case_id)
    case = database.resolve_case(case_id, payload)
    _audit(request, "case.resolved", case, "Resolution and preventive actions recorded.")
    try:
        database.save_memory(case_id, embedder.embed(database.memory_content(case)))
        case = database.get_case(case_id) or case
        _audit(request, "memory.indexed", case, "Resolution auto-indexed into knowledge base.")
    except EmbeddingUnavailable:
        pass
    jira_key = case.jira_source_key or case.jira_issue_key
    if jira_key and jira_publisher.configured:
        try:
            jira_publisher.transition_to_done(jira_key)
            _audit(request, "jira.transitioned", case, f"Jira {jira_key} transitioned to Done.")
        except JiraPublishError:
            pass
    background_tasks.add_task(_auto_runbook, case_id, request.state.user.username)
    return case


@app.put("/api/cases/{case_id}/acknowledge", response_model=SupportCase)
def acknowledge_case(case_id: str, payload: AcknowledgeUpdate, request: Request) -> SupportCase:
    _find_case(case_id)
    case = database.acknowledge_case(case_id, payload.note)
    _audit(request, "customer.acknowledged", case, payload.note)
    return case


@app.get("/api/memory/status", response_model=MemoryStatus)
def memory_status() -> MemoryStatus:
    resolved, indexed = database.memory_counts()
    return MemoryStatus(
        resolved_cases=resolved, indexed_cases=indexed, embedding_model=settings.embedding_model
    )


@app.post("/api/cases/{case_id}/memory/index", response_model=MemoryStatus)
def index_case_memory(case_id: str, request: Request) -> MemoryStatus:
    case = _find_case(case_id)
    if case.status != "resolved":
        raise HTTPException(status_code=400, detail="Only resolved cases can be indexed.")
    try:
        database.save_memory(case_id, embedder.embed(database.memory_content(case)))
    except EmbeddingUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    _audit(request, "memory.indexed", case, "Resolved case indexed in local semantic memory.")
    return memory_status()


@app.get("/api/cases/{case_id}/related", response_model=list[RelatedCase])
def related_cases(case_id: str) -> list[RelatedCase]:
    case = _find_case(case_id)
    content = database.memory_content(case)
    records = database.get_memory(exclude_case_id=case_id)
    if not records:
        return []
    try:
        vec = embedder.embed(content)
        matches = [
            RelatedCase(case=r, score=round(cosine_similarity(vec, v), 4), match_type="semantic")
            for r, _, v in records
        ]
    except EmbeddingUnavailable:
        matches = [
            RelatedCase(case=r, score=round(text_similarity(content, c), 4), match_type="text")
            for r, c, _ in records
        ]
    return sorted((m for m in matches if m.score > 0), key=lambda m: m.score, reverse=True)[:5]


@app.post("/api/cases/{case_id}/runbook", response_model=RunbookRecommendation)
def recommend_runbook(case_id: str, request: Request) -> RunbookRecommendation:
    case = _find_case(case_id)
    related = related_cases(case_id)
    evidence = [item.case for item in related if item.case.status == "resolved"]
    if not evidence:
        evidence = [
            item
            for item in database.list_cases()
            if item.id != case_id and item.status == "resolved" and item.service == case.service
        ][:5]
    if not evidence:
        raise HTTPException(status_code=400, detail="Need at least one resolved similar case.")
    try:
        runbook = analyst.recommend_runbook(case, evidence)
    except AnalysisUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    database.save_runbook(case_id, runbook)
    _audit(request, "runbook.generated", case, f"Grounded in {len(evidence)} resolved case(s).")
    return runbook


@app.get("/api/cases/{case_id}/report.md", response_class=PlainTextResponse)
def export_case_report(case_id: str, request: Request) -> str:
    case = _find_case(case_id)
    _audit(request, "report.exported", case, "Markdown incident report downloaded.")
    timeline = "\n".join(f"- {entry.at.isoformat()}: {entry.event}" for entry in case.timeline)
    actions = "\n".join(f"- {item}" for item in case.preventive_actions) or "- None recorded"
    return f"""# ResolveIQ Incident Report: {case.title}

## Case Details

- Customer: {case.customer}
- Service: {case.service}
- Environment: {case.environment}
- Severity: {case.severity}
- Status: {case.status}
- SLA status: {case.sla_state}
- Created: {case.created_at.isoformat()}
- Initial response target: {case.response_due_at.isoformat()}
- Resolution target: {case.resolution_due_at.isoformat()}

## Customer Report

{case.reported_issue}

## Analysis

**Summary:** {case.analysis.incident_summary}

**Customer impact:** {case.analysis.customer_impact}

**Likely cause:** {case.analysis.likely_cause}

**Workaround:** {case.analysis.workaround}

## Resolution

{case.resolution or "Not yet resolved."}

## Preventive Actions

{actions}

## Timeline

{timeline}
"""


@app.post("/api/cases/{case_id}/jira", response_model=SupportCase)
def publish_jira_escalation(case_id: str, request: Request) -> SupportCase:
    case = _approved_case(case_id)
    if case.jira_issue_key:
        raise HTTPException(status_code=409, detail="Already escalated to Jira.")
    try:
        issue_key, issue_url = jira_publisher.create_issue(case)
    except JiraPublishError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    case = database.save_jira_issue(case_id, issue_key, issue_url)
    _audit(request, "jira.created", case, f"Jira issue {issue_key} created.")
    return case


@app.post("/api/cases/{case_id}/gmail-draft", response_model=SupportCase)
def publish_gmail_draft(case_id: str, request: Request) -> SupportCase:
    case = _approved_case(case_id)
    if case.gmail_draft_id:
        raise HTTPException(status_code=409, detail="Draft already exists.")
    try:
        draft_id = gmail_publisher.create_draft(
            case.analysis.customer_email_subject, case.analysis.customer_email_body
        )
    except GmailDraftError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    case = database.save_gmail_draft(case_id, draft_id)
    _audit(request, "gmail.draft_created", case, "Customer update draft created.")
    return case


@app.get("/api/jira/pending")
def jira_pending() -> dict[str, int]:
    if not jira_publisher.configured:
        return {"count": 0}
    try:
        tickets = jira_publisher.search_issues(settings.jira_sync_jql)
    except JiraPublishError:
        return {"count": 0}
    existing_keys = database.get_imported_jira_keys() | database.get_pushed_jira_keys()
    return {"count": sum(1 for t in tickets if t["key"] not in existing_keys)}


@app.post("/api/jira/sync", response_model=JiraSyncResult)
def sync_jira_tickets(request: Request, background_tasks: BackgroundTasks) -> JiraSyncResult:
    if not jira_publisher.configured:
        raise HTTPException(status_code=400, detail="Jira not configured.")
    try:
        tickets = jira_publisher.search_issues(settings.jira_sync_jql)
    except JiraPublishError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    existing_keys = database.get_imported_jira_keys() | database.get_pushed_jira_keys()
    imported: list[SupportCase] = []
    skipped = 0
    for ticket in tickets:
        if ticket["key"] in existing_keys:
            skipped += 1
            continue
        payload = CaseCreate(
            title=ticket["summary"] or ticket["key"],
            customer=ticket["reporter"] or "Jira",
            service=settings.jira_project_key,
            environment="production",
            reported_issue=ticket["description"] or ticket["summary"] or "Imported from Jira.",
            logs=f"Jira: {ticket['key']}  Status: {ticket['status']}  Priority: {ticket['priority']}",
            severity=jira_publisher.map_severity(ticket["priority"]),
        )
        case = database.create_case(payload)
        case = database.update_jira_source(case.id, ticket["key"])
        _audit(request, "jira.imported", case, f"Imported from Jira ticket {ticket['key']}.")
        imported.append(case)
    if imported:
        _audit(request, "jira.sync", imported[0], f"Synced {len(imported)} ticket(s) from Jira.")
        for case in imported:
            background_tasks.add_task(_auto_analyze, case.id, request.state.user.username)
    return JiraSyncResult(imported=len(imported), skipped=skipped, cases=imported)


@app.get("/api/cases/{case_id}/suggestions", response_model=list[RelatedCase])
def kb_suggestions(case_id: str) -> list[RelatedCase]:
    case = _find_case(case_id)
    content = database.memory_content(case)
    records = database.get_memory(exclude_case_id=case_id)
    if not records:
        return []
    try:
        vec = embedder.embed(content)
        matches = [
            RelatedCase(case=r, score=round(cosine_similarity(vec, v), 4), match_type="semantic")
            for r, _, v in records
        ]
    except EmbeddingUnavailable:
        matches = [
            RelatedCase(case=r, score=round(text_similarity(content, c), 4), match_type="text")
            for r, c, _ in records
        ]
    return sorted((m for m in matches if m.score > 0.15), key=lambda m: m.score, reverse=True)[:5]


@app.get("/api/cases/{case_id}/messages", response_model=list[CaseMessage])
def list_messages(case_id: str) -> list[CaseMessage]:
    case = _find_case(case_id)
    jira_key = case.jira_source_key or case.jira_issue_key
    if jira_key and jira_publisher.configured:
        try:
            comments = jira_publisher.get_comments(jira_key)
            database.sync_jira_comments(case_id, comments, "")
        except JiraPublishError:
            pass
    return database.list_messages(case_id)


@app.get("/api/messages/counts")
def message_counts() -> dict[str, int]:
    return database.message_counts()


@app.post("/api/cases/{case_id}/messages", response_model=CaseMessage)
def create_message(
    case_id: str, payload: MessageCreate, request: Request, background_tasks: BackgroundTasks,
) -> CaseMessage:
    case = _find_case(case_id)
    message = database.create_message(case_id, request.state.user.username, payload)
    _audit(request, "message.sent", case, f"{payload.message_type} message.")
    background_tasks.add_task(ws_manager.broadcast, case_id, message.model_dump(mode="json"))
    jira_key = case.jira_source_key or case.jira_issue_key
    if jira_key and jira_publisher.configured:
        background_tasks.add_task(
            _sync_jira_comment, jira_key, request.state.user.username, payload.content,
        )
    return message


@app.websocket("/api/cases/{case_id}/ws")
async def case_websocket(websocket: WebSocket, case_id: str) -> None:
    cookie_token = websocket.cookies.get("resolveiq_session")
    if not cookie_token or authenticator.authenticate(f"Bearer {cookie_token}") is None:
        await websocket.close(code=1008)
        return
    await ws_manager.connect(case_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(case_id, websocket)


def _find_case(case_id: str) -> SupportCase:
    case = database.get_case(case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found.")
    return case


def _approved_case(case_id: str) -> SupportCase:
    case = _find_case(case_id)
    if case.review_status != "approved":
        raise HTTPException(status_code=400, detail="Analysis must be approved first.")
    return case


def _audit(request: Request, action: str, case: SupportCase, detail: str = "") -> None:
    database.record_audit(request.state.user.username, action, "case", case.id, detail)


def _auto_runbook(case_id: str, actor: str) -> None:
    case = database.get_case(case_id)
    if case is None or case.runbook is not None:
        return
    records = database.get_memory(exclude_case_id=case_id)
    if not records:
        return
    try:
        vec = embedder.embed(database.memory_content(case))
    except EmbeddingUnavailable:
        return
    evidence = [
        r for r, _, v in records
        if r.status == "resolved" and cosine_similarity(vec, v) > 0.15
    ]
    if not evidence:
        return
    try:
        runbook = analyst.recommend_runbook(case, evidence[:5])
    except AnalysisUnavailable:
        return
    database.save_runbook(case_id, runbook)
    database.record_audit(actor, "runbook.auto_generated", "case", case_id, f"Grounded in {len(evidence[:5])} resolved case(s).")


def _auto_analyze(case_id: str, actor: str) -> None:
    case = database.get_case(case_id)
    if case is None or case.status != "new":
        return
    database.mark_investigating(case_id)
    database.record_audit(actor, "analysis.started", "case", case_id, "Auto-analysis triggered on Jira import.")
    try:
        analysis = analyst.analyze(case)
    except AnalysisUnavailable:
        return
    database.save_analysis(case_id, analysis)
    database.record_audit(actor, "analysis.generated", "case", case_id, "AI analysis ready for review.")


def _sync_jira_comment(jira_key: str, author: str, content: str) -> None:
    try:
        jira_publisher.add_comment(jira_key, author, content)
    except JiraPublishError:
        pass
