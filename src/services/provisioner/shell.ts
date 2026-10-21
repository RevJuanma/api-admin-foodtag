import { execFile } from "child_process";

/** Ejecuta `docker <args>` sin shell (los argumentos no se interpretan). Devuelve stdout. */
export function docker(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().trim().split("\n").slice(-3).join(" ").slice(0, 400)));
      resolve(stdout.toString());
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
