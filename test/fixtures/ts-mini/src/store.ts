import { AbstractStore } from "./base";
import { isExpired, Session, User } from "./models";

/** Keeps sessions in a Map; refresh extends their TTL. */
export class SessionStore extends AbstractStore {
  private sessions = new Map<string, Session>();

  get(token: string): Session | undefined {
    return this.sessions.get(token);
  }

  put(session: Session): void {
    this.sessions.set(session.token, session);
  }

  /** Extend a session's lifetime; drops expired sessions. */
  refresh(token: string, extraTtl = 3600): Session | undefined {
    const session = this.get(token);
    if (!session) return undefined;
    if (isExpired(session)) {
      this.sessions.delete(token);
      return undefined;
    }
    session.ttl += extraTtl;
    this.put(session);
    return session;
  }

  create(user: User, token: string): Session {
    const session: Session = { token, user, ttl: 3600 };
    this.put(session);
    return session;
  }
}
