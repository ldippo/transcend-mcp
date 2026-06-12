"""Domain models."""
from dataclasses import dataclass, field


@dataclass
class User:
    """A user account."""

    name: str
    email: str
    active: bool = True

    def display_name(self) -> str:
        """Human-readable label."""
        return f"{self.name} <{self.email}>"


@dataclass
class Session:
    """An auth session belonging to a user."""

    token: str
    user: User
    ttl: int = 3600

    def is_expired(self) -> bool:
        return self.ttl <= 0
