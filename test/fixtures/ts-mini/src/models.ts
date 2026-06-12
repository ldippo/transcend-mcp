/** Domain models. */

export interface User {
  name: string;
  email: string;
  active: boolean;
}

export interface Session {
  token: string;
  user: User;
  ttl: number;
}

export function displayName(user: User): string {
  return `${user.name} <${user.email}>`;
}

export function isExpired(session: Session): boolean {
  return session.ttl <= 0;
}
