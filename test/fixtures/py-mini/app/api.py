"""Tiny request-handling layer that exercises the store."""
from typing import Optional

from .models import Session, User
from .store import SessionStore

_store = SessionStore()


def login(name: str, email: str, token: str) -> Session:
    user = User(name=name, email=email)
    return _store.create(user, token)


def authenticate(token: str) -> Optional[User]:
    session = _store.refresh(token)
    if session is None:
        return None
    return session.user


def whoami(token: str) -> str:
    user = authenticate(token)
    if user is None:
        return "anonymous"
    return user.display_name()
