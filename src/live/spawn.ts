/** Child-process plumbing for language servers: PATH probe, spawn, stderr
 * ring buffer (surfaced via map_status for debugging crash loops). */
import { spawn, type ChildProcess } from "node:child_process";
import which from "which";

export interface SpawnedServer {
  proc: ChildProcess;
  stderrTail: () => string[];
}

export function findBinary(command: string): string | null {
  return which.sync(command, { nothrow: true });
}

const RING_SIZE = 50;

export function spawnServer(command: string, args: string[], cwd: string): SpawnedServer {
  const proc = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const ring: string[] = [];
  proc.stderr!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      ring.push(line.slice(0, 400));
      if (ring.length > RING_SIZE) ring.shift();
    }
  });
  return { proc, stderrTail: () => [...ring] };
}
