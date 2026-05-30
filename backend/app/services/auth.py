import hmac
import secrets
from datetime import UTC, datetime, timedelta

from ..models import AuthUser, LoginResponse


class LocalAuthenticator:
    def __init__(self, username: str, password: str, session_hours: int = 8) -> None:
        self.username = username
        self.password = password
        self.session_hours = session_hours
        self._sessions: dict[str, datetime] = {}

    def login(self, username: str, password: str) -> LoginResponse | None:
        if not (
            hmac.compare_digest(username, self.username)
            and hmac.compare_digest(password, self.password)
        ):
            return None
        expires_at = datetime.now(UTC) + timedelta(hours=self.session_hours)
        token = secrets.token_urlsafe(32)
        self._sessions[token] = expires_at
        return LoginResponse(
            access_token=token,
            expires_at=expires_at,
            user=AuthUser(username=self.username),
        )

    def authenticate(self, header: str | None) -> AuthUser | None:
        if not header or not header.startswith("Bearer "):
            return None
        token = header.removeprefix("Bearer ").strip()
        expiry = self._sessions.get(token)
        if expiry is None or expiry <= datetime.now(UTC):
            self._sessions.pop(token, None)
            return None
        return AuthUser(username=self.username)

    def logout(self, header: str | None) -> None:
        if header and header.startswith("Bearer "):
            self._sessions.pop(header.removeprefix("Bearer ").strip(), None)
