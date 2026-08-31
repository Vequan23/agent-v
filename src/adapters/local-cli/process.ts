import { execFile } from "node:child_process";

export interface RuntimeProcessResult {
  stdout: string;
  stderr: string;
}

export interface RuntimeProcessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Per-run environment additions. Never mutate the parent process environment. */
  environment?: Readonly<Record<string, string | undefined>>;
}

export type RuntimeProcessRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  options?: RuntimeProcessOptions,
) => Promise<RuntimeProcessResult>;

export const runRuntimeProcess: RuntimeProcessRunner = (command, args, cwd, options = {}) => new Promise((resolve, reject) => {
  const child = execFile(command, [...args], {
    cwd,
    env: options.environment ? { ...process.env, ...options.environment } : process.env,
    signal: options.signal,
    timeout: options.timeoutMs ?? 75_000,
    maxBuffer: options.maxOutputBytes ?? 8 * 1024 * 1024,
    encoding: "utf8",
  }, (error, stdout, stderr) => {
    if (error) {
      reject(Object.assign(error, { stdout: String(stdout || ""), stderr: String(stderr || "") }));
      return;
    }
    resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
  });
  // Interactive CLIs treat an open pipe as more prompt input and wait for EOF.
  child.stdin?.end();
});
