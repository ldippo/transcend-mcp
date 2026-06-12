import { displayName, User } from "./models";
import { SessionStore } from "./store";

const store = new SessionStore();

export function login(name: string, email: string, token: string) {
  const user: User = { name, email, active: true };
  return store.create(user, token);
}

export function authenticate(token: string): User | undefined {
  const session = store.refresh(token);
  return session?.user;
}

export function whoami(token: string): string {
  const user = authenticate(token);
  return user ? displayName(user) : "anonymous";
}
