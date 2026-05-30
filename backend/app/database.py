import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from .models import (
    AuditEvent,
    CaseCreate,
    CaseMessage,
    MessageCreate,
    OperationsDashboard,
    ProblemGroup,
    PostIncidentReport,
    ResolutionUpdate,
    RunbookRecommendation,
    SupportAnalysis,
    SupportCase,
    ServiceTrend,
    TimelineEvent,
)


class CaseDatabase:
    def __init__(self, path: Path) -> None:
        self.path = path

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS support_cases (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    customer TEXT NOT NULL,
                    service TEXT NOT NULL,
                    environment TEXT NOT NULL,
                    reported_issue TEXT NOT NULL,
                    logs TEXT NOT NULL,
                    status TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    response_due_at TEXT,
                    resolution_due_at TEXT,
                    first_response_at TEXT,
                    analysis TEXT NOT NULL,
                    review_status TEXT NOT NULL,
                    approved_at TEXT,
                    resolution TEXT NOT NULL,
                    preventive_actions TEXT NOT NULL,
                    post_incident_report TEXT NOT NULL DEFAULT '{}',
                    jira_issue_key TEXT,
                    jira_issue_url TEXT,
                    jira_published_at TEXT,
                    gmail_draft_id TEXT,
                    gmail_draft_created_at TEXT,
                    runbook TEXT,
                    timeline TEXT NOT NULL
                )
                """
            )
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(support_cases)").fetchall()
            }
            additions = {
                "post_incident_report": "TEXT NOT NULL DEFAULT '{}'",
                "jira_issue_key": "TEXT",
                "jira_issue_url": "TEXT",
                "jira_published_at": "TEXT",
                "gmail_draft_id": "TEXT",
                "gmail_draft_created_at": "TEXT",
                "jira_source_key": "TEXT",
                "runbook": "TEXT",
                "response_due_at": "TEXT",
                "resolution_due_at": "TEXT",
                "first_response_at": "TEXT",
            }
            for name, sql_type in additions.items():
                if name not in columns:
                    connection.execute(f"ALTER TABLE support_cases ADD COLUMN {name} {sql_type}")
            connection.execute(
                """
                UPDATE support_cases
                SET status = 'approved'
                WHERE status = 'awaiting_approval' AND review_status = 'approved'
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS case_memory (
                    case_id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    vector TEXT NOT NULL,
                    embedded_at TEXT NOT NULL,
                    FOREIGN KEY(case_id) REFERENCES support_cases(id)
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_events (
                    id TEXT PRIMARY KEY,
                    at TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    action TEXT NOT NULL,
                    resource_type TEXT NOT NULL,
                    resource_id TEXT NOT NULL,
                    detail TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS case_messages (
                    id TEXT PRIMARY KEY,
                    case_id TEXT NOT NULL,
                    author TEXT NOT NULL,
                    content TEXT NOT NULL,
                    message_type TEXT NOT NULL DEFAULT 'internal',
                    created_at TEXT NOT NULL,
                    jira_comment_id TEXT,
                    FOREIGN KEY(case_id) REFERENCES support_cases(id)
                )
                """
            )
            msg_columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(case_messages)").fetchall()
            }
            if "jira_comment_id" not in msg_columns:
                connection.execute("ALTER TABLE case_messages ADD COLUMN jira_comment_id TEXT")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS user_preferences (
                    username TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    PRIMARY KEY (username, key)
                )
                """
            )

    def record_audit(
        self, actor: str, action: str, resource_type: str, resource_id: str, detail: str = ""
    ) -> AuditEvent:
        event = AuditEvent(
            id=str(uuid4()),
            at=datetime.now(UTC),
            actor=actor,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            detail=detail,
        )
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO audit_events (id, at, actor, action, resource_type, resource_id, detail)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event.id,
                    event.at.isoformat(),
                    event.actor,
                    event.action,
                    event.resource_type,
                    event.resource_id,
                    event.detail,
                ),
            )
        return event

    def list_audit_events(self, limit: int = 100) -> list[AuditEvent]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM audit_events ORDER BY at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [
            AuditEvent(
                id=row["id"],
                at=row["at"],
                actor=row["actor"],
                action=row["action"],
                resource_type=row["resource_type"],
                resource_id=row["resource_id"],
                detail=row["detail"],
            )
            for row in rows
        ]

    def list_cases(self) -> list[SupportCase]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT support_cases.*,
                       EXISTS(SELECT 1 FROM case_memory WHERE case_memory.case_id = support_cases.id) AS memory_indexed
                FROM support_cases
                ORDER BY updated_at DESC
                """
            ).fetchall()
        return [self._to_case(row) for row in rows]

    def search_cases(self, query: str = "", status: str = "") -> list[SupportCase]:
        clauses: list[str] = []
        values: list[str] = []
        if query.strip():
            clauses.append(
                "(title LIKE ? OR customer LIKE ? OR service LIKE ? OR reported_issue LIKE ? OR logs LIKE ?)"
            )
            value = f"%{query.strip()}%"
            values.extend([value] * 5)
        if status:
            clauses.append("status = ?")
            values.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT support_cases.*,
                       EXISTS(SELECT 1 FROM case_memory WHERE case_memory.case_id = support_cases.id) AS memory_indexed
                FROM support_cases
                {where}
                ORDER BY updated_at DESC
                """,
                values,
            ).fetchall()
        return [self._to_case(row) for row in rows]

    def get_case(self, case_id: str) -> SupportCase | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT support_cases.*,
                       EXISTS(SELECT 1 FROM case_memory WHERE case_memory.case_id = support_cases.id) AS memory_indexed
                FROM support_cases
                WHERE id = ?
                """,
                (case_id,),
            ).fetchone()
        return self._to_case(row) if row else None

    def delete_case(self, case_id: str) -> None:
        self._required(case_id)
        with self._connect() as connection:
            connection.execute("DELETE FROM case_memory WHERE case_id = ?", (case_id,))
            connection.execute("DELETE FROM case_messages WHERE case_id = ?", (case_id,))
            connection.execute("DELETE FROM support_cases WHERE id = ?", (case_id,))

    def create_case(self, payload: CaseCreate) -> SupportCase:
        now = datetime.now(UTC)
        severity = payload.severity
        case = SupportCase(
            id=str(uuid4()),
            **payload.model_dump(),
            status="new",
            created_at=now,
            updated_at=now,
            response_due_at=now + self._sla_targets(severity)[0],
            resolution_due_at=now + self._sla_targets(severity)[1],
            timeline=[TimelineEvent(at=now, event="Customer case created.")],
        )
        self._write_case(case)
        return case

    def mark_investigating(self, case_id: str) -> SupportCase:
        case = self._required(case_id)
        return self._save_event(
            case.model_copy(update={"status": "investigating"}),
            "AI log analysis started.",
        )

    def save_analysis(self, case_id: str, analysis: SupportAnalysis) -> SupportCase:
        case = self._required(case_id)
        response_window, resolution_window = self._sla_targets(analysis.suggested_severity)
        return self._save_event(
            case.model_copy(
                update={
                    "analysis": analysis,
                    "severity": analysis.suggested_severity,
                    "status": "awaiting_approval",
                    "review_status": "pending_review",
                    "response_due_at": case.created_at + response_window,
                    "resolution_due_at": case.created_at + resolution_window,
                }
            ),
            "Analysis and customer draft prepared for review.",
        )

    def save_review(self, case_id: str, analysis: SupportAnalysis, approve: bool) -> SupportCase:
        case = self._required(case_id)
        now = datetime.now(UTC)
        response_window, resolution_window = self._sla_targets(analysis.suggested_severity)
        return self._save_event(
            case.model_copy(
                update={
                    "analysis": analysis,
                    "severity": analysis.suggested_severity,
                    "status": "resolved" if case.status == "resolved" else (
                        "approved" if approve else "awaiting_approval"
                    ),
                    "review_status": "approved" if approve else "pending_review",
                    "approved_at": now if approve else None,
                    "response_due_at": case.created_at + response_window,
                    "resolution_due_at": case.created_at + resolution_window,
                }
            ),
            "Analysis approved by support engineer." if approve else "Analysis draft updated.",
        )

    def resolve_case(self, case_id: str, payload: ResolutionUpdate) -> SupportCase:
        case = self._required(case_id)
        report = PostIncidentReport(
            summary=case.analysis.incident_summary,
            customer_impact=case.analysis.customer_impact,
            root_cause=case.analysis.likely_cause,
            resolution=payload.resolution,
            preventive_actions=payload.preventive_actions,
        )
        return self._save_event(
            case.model_copy(
                update={
                    "resolution": payload.resolution,
                    "preventive_actions": payload.preventive_actions,
                    "post_incident_report": report,
                    "status": "resolved",
                }
            ),
            "Case marked resolved.",
        )

    def acknowledge_case(self, case_id: str, note: str) -> SupportCase:
        case = self._required(case_id)
        if case.first_response_at is not None:
            return case
        return self._save_event(
            case.model_copy(update={"first_response_at": datetime.now(UTC)}),
            note.strip() or "Customer acknowledgement recorded.",
        )

    def save_jira_issue(self, case_id: str, issue_key: str, issue_url: str) -> SupportCase:
        case = self._required(case_id)
        return self._save_event(
            case.model_copy(
                update={
                    "jira_issue_key": issue_key,
                    "jira_issue_url": issue_url,
                    "jira_published_at": datetime.now(UTC),
                }
            ),
            f"Jira escalation created: {issue_key}.",
        )

    def save_gmail_draft(self, case_id: str, draft_id: str) -> SupportCase:
        case = self._required(case_id)
        return self._save_event(
            case.model_copy(
                update={"gmail_draft_id": draft_id, "gmail_draft_created_at": datetime.now(UTC)}
            ),
            "Customer update saved as a Gmail draft.",
        )

    def save_runbook(self, case_id: str, runbook: RunbookRecommendation) -> SupportCase:
        case = self._required(case_id)
        return self._save_event(
            case.model_copy(update={"runbook": runbook}),
            "Runbook recommendation generated.",
        )

    def memory_content(self, case: SupportCase) -> str:
        return "\n".join(
            [
                case.title,
                case.service,
                case.reported_issue,
                case.analysis.incident_summary,
                case.analysis.likely_cause,
                case.resolution,
                " ".join(case.preventive_actions),
            ]
        ).strip()

    def save_memory(self, case_id: str, vector: list[float]) -> None:
        case = self._required(case_id)
        if case.status != "resolved":
            raise ValueError("Only resolved cases can be indexed as incident memory.")
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO case_memory (case_id, content, vector, embedded_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    case_id,
                    self.memory_content(case),
                    json.dumps(vector),
                    datetime.now(UTC).isoformat(),
                ),
            )

    def get_memory(self, exclude_case_id: str | None = None) -> list[tuple[SupportCase, str, list[float]]]:
        where = "WHERE m.case_id != ?" if exclude_case_id else ""
        values = (exclude_case_id,) if exclude_case_id else ()
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT c.*,
                       1 AS memory_indexed,
                       m.content AS memory_content, m.vector AS memory_vector
                FROM case_memory m JOIN support_cases c ON c.id = m.case_id
                {where}
                """,
                values,
            ).fetchall()
        return [
            (self._to_case(row), row["memory_content"], json.loads(row["memory_vector"]))
            for row in rows
        ]

    def memory_counts(self) -> tuple[int, int]:
        with self._connect() as connection:
            resolved = connection.execute(
                "SELECT COUNT(*) FROM support_cases WHERE status = 'resolved'"
            ).fetchone()[0]
            indexed = connection.execute("SELECT COUNT(*) FROM case_memory").fetchone()[0]
        return int(resolved), int(indexed)

    def count_cases(self) -> int:
        with self._connect() as connection:
            return int(connection.execute("SELECT COUNT(*) FROM support_cases").fetchone()[0])

    def dashboard(self) -> OperationsDashboard:
        cases = self.list_cases()
        resolved = [case for case in cases if case.status == "resolved"]
        resolution_hours = [
            (case.updated_at - case.created_at).total_seconds() / 3600 for case in resolved
        ]
        return OperationsDashboard(
            total_cases=len(cases),
            open_cases=sum(case.status != "resolved" for case in cases),
            urgent_open_cases=sum(
                case.status != "resolved" and case.severity in ("critical", "high")
                for case in cases
            ),
            awaiting_approval_cases=sum(
                case.status == "awaiting_approval" and case.review_status != "approved"
                for case in cases
            ),
            breached_cases=sum(case.sla_state == "breached" for case in cases),
            at_risk_cases=sum(case.sla_state == "at_risk" for case in cases),
            resolved_cases=len(resolved),
            average_resolution_hours=(
                round(sum(resolution_hours) / len(resolution_hours), 2)
                if resolution_hours
                else None
            ),
        )

    def service_trends(self) -> list[ServiceTrend]:
        grouped: dict[str, list[SupportCase]] = {}
        for case in self.list_cases():
            grouped.setdefault(case.service.strip() or "Unspecified", []).append(case)
        trends = []
        for service, cases in grouped.items():
            resolved = [case for case in cases if case.status == "resolved"]
            hours = [(case.updated_at - case.created_at).total_seconds() / 3600 for case in resolved]
            trends.append(
                ServiceTrend(
                    service=service,
                    total_cases=len(cases),
                    open_cases=sum(case.status != "resolved" for case in cases),
                    resolved_cases=len(resolved),
                    breached_cases=sum(case.sla_state == "breached" for case in cases),
                    average_resolution_hours=round(sum(hours) / len(hours), 2) if hours else None,
                )
            )
        return sorted(trends, key=lambda trend: (-trend.total_cases, trend.service.lower()))

    def problem_groups(self) -> list[ProblemGroup]:
        grouped: dict[tuple[str, str], list[SupportCase]] = {}
        for case in self.list_cases():
            if case.status != "resolved":
                continue
            cause = case.analysis.likely_cause.strip() or "Cause not recorded"
            key = (case.service.strip() or "Unspecified", cause.casefold())
            grouped.setdefault(key, []).append(case)
        problems = []
        for (service, _), cases in grouped.items():
            first_cause = cases[0].analysis.likely_cause.strip() or "Cause not recorded"
            resolutions = list(dict.fromkeys(case.resolution for case in cases if case.resolution.strip()))
            problems.append(
                ProblemGroup(
                    service=service,
                    cause=first_cause,
                    case_count=len(cases),
                    cases=cases,
                    known_resolutions=resolutions,
                )
            )
        return sorted(problems, key=lambda group: (-group.case_count, group.service.lower()))

    def get_preferences(self, username: str) -> dict[str, str]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT key, value FROM user_preferences WHERE username = ?", (username,)
            ).fetchall()
        return {row["key"]: row["value"] for row in rows}

    def set_preference(self, username: str, key: str, value: str | None) -> None:
        with self._connect() as connection:
            if value is None:
                connection.execute(
                    "DELETE FROM user_preferences WHERE username = ? AND key = ?",
                    (username, key),
                )
            else:
                connection.execute(
                    "INSERT OR REPLACE INTO user_preferences (username, key, value) VALUES (?, ?, ?)",
                    (username, key, value),
                )

    def list_messages(self, case_id: str) -> list[CaseMessage]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM case_messages WHERE case_id = ? ORDER BY created_at ASC",
                (case_id,),
            ).fetchall()
        return [
            CaseMessage(
                id=row["id"],
                case_id=row["case_id"],
                author=row["author"],
                content=row["content"],
                message_type=row["message_type"],
                created_at=row["created_at"],
            )
            for row in rows
        ]

    def create_message(self, case_id: str, author: str, payload: MessageCreate) -> CaseMessage:
        now = datetime.now(UTC)
        message = CaseMessage(
            id=str(uuid4()),
            case_id=case_id,
            author=author,
            content=payload.content,
            message_type=payload.message_type,
            created_at=now,
        )
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO case_messages (id, case_id, author, content, message_type, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (message.id, message.case_id, message.author, message.content,
                 message.message_type, message.created_at.isoformat()),
            )
        return message

    def sync_jira_comments(self, case_id: str, comments: list[dict[str, str]], jira_email: str) -> int:
        with self._connect() as connection:
            existing_jira_ids = {
                row["jira_comment_id"]
                for row in connection.execute(
                    "SELECT jira_comment_id FROM case_messages WHERE case_id = ? AND jira_comment_id IS NOT NULL",
                    (case_id,),
                ).fetchall()
            }
            local_contents = {
                row["content"]
                for row in connection.execute(
                    "SELECT content FROM case_messages WHERE case_id = ? AND jira_comment_id IS NULL",
                    (case_id,),
                ).fetchall()
            }
        imported = 0
        for comment in comments:
            if comment["id"] in existing_jira_ids:
                continue
            body = comment["body"]
            if any(body.endswith(lc) or lc in body for lc in local_contents if lc.strip()):
                continue
            message = CaseMessage(
                id=str(uuid4()),
                case_id=case_id,
                author=comment["author"] or "Jira",
                content=comment["body"],
                message_type="customer",
                created_at=comment["created"] or datetime.now(UTC).isoformat(),
            )
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO case_messages (id, case_id, author, content, message_type, created_at, jira_comment_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (message.id, message.case_id, message.author, message.content,
                     message.message_type, message.created_at if isinstance(message.created_at, str) else message.created_at.isoformat(),
                     comment["id"]),
                )
            imported += 1
        return imported

    def message_counts(self) -> dict[str, int]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT case_id, COUNT(*) AS cnt FROM case_messages GROUP BY case_id"
            ).fetchall()
        return {row["case_id"]: row["cnt"] for row in rows}

    def delete_messages(self, case_id: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM case_messages WHERE case_id = ?", (case_id,))

    def update_jira_source(self, case_id: str, jira_key: str) -> SupportCase:
        case = self._required(case_id)
        return self._save_event(
            case.model_copy(update={"jira_source_key": jira_key}),
            f"Imported from Jira ticket {jira_key}.",
        )

    def get_pushed_jira_keys(self) -> set[str]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT jira_issue_key FROM support_cases WHERE jira_issue_key IS NOT NULL"
            ).fetchall()
        return {row["jira_issue_key"] for row in rows}

    def get_imported_jira_keys(self) -> set[str]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT jira_source_key FROM support_cases WHERE jira_source_key IS NOT NULL"
            ).fetchall()
        return {row["jira_source_key"] for row in rows}

    def _save_event(self, case: SupportCase, event: str) -> SupportCase:
        now = datetime.now(UTC)
        updated = case.model_copy(
            update={"updated_at": now, "timeline": [*case.timeline, TimelineEvent(at=now, event=event)]}
        )
        self._write_case(updated)
        return self._required(updated.id)

    def _write_case(self, case: SupportCase) -> None:
        values = (
            case.id,
            case.title,
            case.customer,
            case.service,
            case.environment,
            case.reported_issue,
            case.logs,
            case.status,
            case.severity,
            case.created_at.isoformat(),
            case.updated_at.isoformat(),
            case.response_due_at.isoformat(),
            case.resolution_due_at.isoformat(),
            case.first_response_at.isoformat() if case.first_response_at else None,
            case.analysis.model_dump_json(),
            case.review_status,
            case.approved_at.isoformat() if case.approved_at else None,
            case.resolution,
            json.dumps(case.preventive_actions),
            case.post_incident_report.model_dump_json(),
            case.jira_issue_key,
            case.jira_issue_url,
            case.jira_published_at.isoformat() if case.jira_published_at else None,
            case.gmail_draft_id,
            case.gmail_draft_created_at.isoformat() if case.gmail_draft_created_at else None,
            case.jira_source_key,
            case.runbook.model_dump_json() if case.runbook else None,
            json.dumps([event.model_dump(mode="json") for event in case.timeline]),
        )
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO support_cases (
                    id, title, customer, service, environment, reported_issue, logs, status,
                    severity, created_at, updated_at, response_due_at, resolution_due_at,
                    first_response_at, analysis, review_status, approved_at,
                    resolution, preventive_actions, post_incident_report, jira_issue_key,
                    jira_issue_url, jira_published_at, gmail_draft_id, gmail_draft_created_at,
                    jira_source_key, runbook, timeline
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                values,
            )

    def _required(self, case_id: str) -> SupportCase:
        case = self.get_case(case_id)
        if case is None:
            raise KeyError(case_id)
        return case

    def _to_case(self, row: sqlite3.Row) -> SupportCase:
        created_at = datetime.fromisoformat(row["created_at"])
        updated_at = datetime.fromisoformat(row["updated_at"])
        resp_window, res_window = self._sla_targets(row["severity"])
        response_due = datetime.fromisoformat(row["response_due_at"]) if row["response_due_at"] else created_at + resp_window
        resolution_due = datetime.fromisoformat(row["resolution_due_at"]) if row["resolution_due_at"] else created_at + res_window
        first_response = datetime.fromisoformat(row["first_response_at"]) if row["first_response_at"] else None
        status = "approved" if row["status"] == "awaiting_approval" and row["review_status"] == "approved" else row["status"]
        return SupportCase(
            id=row["id"],
            title=row["title"],
            customer=row["customer"],
            service=row["service"],
            environment=row["environment"],
            reported_issue=row["reported_issue"],
            logs=row["logs"],
            status=status,
            severity=row["severity"],
            created_at=created_at,
            updated_at=updated_at,
            response_due_at=response_due,
            resolution_due_at=resolution_due,
            first_response_at=first_response,
            sla_state=self._sla_state(status, created_at, updated_at, response_due, resolution_due, first_response),
            analysis=SupportAnalysis.model_validate_json(row["analysis"]),
            review_status=row["review_status"],
            approved_at=row["approved_at"],
            resolution=row["resolution"],
            preventive_actions=json.loads(row["preventive_actions"]),
            post_incident_report=PostIncidentReport.model_validate_json(
                row["post_incident_report"] or "{}"
            ),
            jira_issue_key=row["jira_issue_key"],
            jira_issue_url=row["jira_issue_url"],
            jira_published_at=row["jira_published_at"],
            gmail_draft_id=row["gmail_draft_id"],
            gmail_draft_created_at=row["gmail_draft_created_at"],
            jira_source_key=row["jira_source_key"],
            memory_indexed=bool(row["memory_indexed"]),
            runbook=RunbookRecommendation.model_validate_json(row["runbook"]) if row["runbook"] else None,
            timeline=[TimelineEvent.model_validate(event) for event in json.loads(row["timeline"])],
        )

    @staticmethod
    def _sla_targets(severity: str) -> tuple[timedelta, timedelta]:
        return {
            "critical": (timedelta(minutes=15), timedelta(hours=4)),
            "high": (timedelta(hours=1), timedelta(hours=8)),
            "medium": (timedelta(hours=4), timedelta(hours=24)),
            "low": (timedelta(hours=8), timedelta(hours=72)),
        }.get(severity, (timedelta(hours=4), timedelta(hours=24)))

    @staticmethod
    def _sla_state(
        status: str,
        created_at: datetime,
        updated_at: datetime,
        response_due_at: datetime,
        resolution_due_at: datetime,
        first_response_at: datetime | None,
    ) -> str:
        now = datetime.now(UTC)
        response_failed = (
            first_response_at is None and now > response_due_at
        ) or (first_response_at is not None and first_response_at > response_due_at)
        resolution_failed = (
            status != "resolved" and now > resolution_due_at
        ) or (status == "resolved" and updated_at > resolution_due_at)
        if response_failed or resolution_failed:
            return "breached"
        if status == "resolved":
            return "met"
        deadlines = [resolution_due_at]
        if first_response_at is None:
            deadlines.append(response_due_at)
        next_deadline = min(deadlines)
        window = max((next_deadline - created_at).total_seconds(), 1)
        remaining = (next_deadline - now).total_seconds()
        return "at_risk" if remaining <= window * 0.25 else "on_track"

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()
