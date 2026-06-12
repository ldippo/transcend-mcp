import type { Session } from "./models";

/** Contract every session store implements. */
export interface BaseStore {
  get(token: string): Session | undefined;
  put(session: Session): void;
}

export abstract class AbstractStore implements BaseStore {
  abstract get(token: string): Session | undefined;
  abstract put(session: Session): void;

  has(token: string): boolean {
    return this.get(token) !== undefined;
  }
}
