import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_ROOT / ".env")


def _env(name: str, fallback: str = "") -> str:
    return os.environ.get(f"RESOLVEIQ_{name}", fallback)


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path(_env("DATA_DIR", str(BACKEND_ROOT / "data")))
    ollama_url: str = _env("OLLAMA_URL", "http://127.0.0.1:11434")
    ollama_model: str = _env("OLLAMA_MODEL", "llama3.2:3b")
    embedding_model: str = _env("EMBEDDING_MODEL", "nomic-embed-text")
    jira_site_url: str = _env("JIRA_SITE_URL")
    jira_email: str = _env("JIRA_EMAIL")
    jira_api_token: str = _env("JIRA_API_TOKEN")
    jira_project_key: str = _env("JIRA_PROJECT_KEY")
    jira_issue_type: str = _env("JIRA_ISSUE_TYPE", "Task")
    jira_sync_jql: str = _env("JIRA_SYNC_JQL", "status != Done ORDER BY created DESC")
    gmail_client_id: str = _env("GMAIL_CLIENT_ID")
    gmail_client_secret: str = _env("GMAIL_CLIENT_SECRET")
    gmail_refresh_token: str = _env("GMAIL_REFRESH_TOKEN")
    auth_username: str = _env("AUTH_USERNAME", "support-admin")
    auth_password: str = _env("AUTH_PASSWORD", "resolveiq-local-demo")
    auth_session_hours: int = int(_env("AUTH_SESSION_HOURS", "8"))

    @property
    def database_path(self) -> Path:
        return self.data_dir / "resolveiq.db"
