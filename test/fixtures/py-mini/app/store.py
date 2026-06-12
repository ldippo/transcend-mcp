"""In-memory session store."""
from typing import Dict, Optional

from .base import BaseStore
from .models import Session, User


class SessionStore(BaseStore):
    """Keeps sessions in a dict; refresh extends their TTL."""

    def __init__(self) -> None:
        self._sessions: Dict[str, Session] = {}

    def get(self, token: str) -> Optional[Session]:
        return self._sessions.get(token)

    def put(self, session: Session) -> None:
        self._sessions[session.token] = session

    def refresh(self, token: str, extra_ttl: int = 3600) -> Optional[Session]:
        """Extend a session's lifetime; drops expired sessions."""
        session = self.get(token)
        if session is None:
            return None
        if session.is_expired():
            self._sessions.pop(token, None)
            return None
        session.ttl += extra_ttl
        self.put(session)
        return session

    def create(self, user: User, token: str) -> Session:
        session = Session(token=token, user=user)
        self.put(session)
        return session
