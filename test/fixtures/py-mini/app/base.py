"""Abstract storage interface."""
from abc import ABC, abstractmethod
from typing import Optional

from .models import Session


class BaseStore(ABC):
    """Contract every session store implements."""

    @abstractmethod
    def get(self, token: str) -> Optional[Session]:
        ...

    @abstractmethod
    def put(self, session: Session) -> None:
        ...
