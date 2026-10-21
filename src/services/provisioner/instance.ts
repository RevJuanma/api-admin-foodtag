import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { provisioning } from "@/config/env";
import { docker, sleep } from "@/services/provisioner/shell";
import { namesFor, publicUrlFor } from "@/services/provisioner/names";

export interface InstanceSpec {
  slug: string;
  image: string;
  dbPassword: string;
  jwtSecret: string;
  platformToken: string;
  /** Puerto en el que se publica con `INSTANCE_ROUTING=port`. */
  port?: number;
}

function labelsFor(slug: string): string[] {
  const p = provisioning();
  const router = `ft-${slug}`;
  const labels = [
    "traefik.enable=true",
    `traefik.docker.network=${p.network}`,
    `traefik.http.routers.${router}.rule=Host(\`${slug}.${p.baseDomain}\`)`,
    `traefik.http.routers.${router}.entrypoints=${p.entrypoint}`,
    `traefik.http.services.${router}.loadbalancer.server.port=3000`,
    "foodtag.managed=true",
    `foodtag.tenant=${slug}`,
  ];
  if (p.scheme === "https") {
    labels.push(`traefik.http.routers.${router}.tls=true`);
    if (p.certResolver) labels.push(`traefik.http.routers.${router}.tls.certresolver=${p.certResolver}`);
  }
  return labels;
}

/** Variables de la instancia. Se pasan por archivo (no por argumentos) para que no aparezcan en la lista de procesos. */
function envFor(spec: InstanceSpec): string {
  const p = provisioning();
  const n = namesFor(spec.slug);
  const vars: Record<string, string> = {
    NODE_ENV: "production",
    PORT: "3000",
    DB_HOST: p.db.internalHost,
    DB_PORT: String(p.db.internalPort),
    DB_USER: n.dbUser,
    DB_PASS: spec.dbPassword,
    DB_NAME: n.database,
    JWT_SECRET: spec.jwtSecret,
    PLATFORM_ADMIN_TOKEN: spec.platformToken,
    CORS_ORIGINS: publicUrlFor(spec.slug, spec.port),
    RESTAURANT_SLUG: spec.slug,
    BOOTSTRAP_SCHEMA: "true",
    RUN_MIGRATIONS: "true",
    ...(p.webDir && { WEB_DIST_DIR: "/app/web" }),
  };
  for (const [k, v] of Object.entries(vars)) if (/[\r\n]/.test(v)) throw new Error(`Valor inválido en ${k}`);
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

export const containerExists = async (name: string): Promise<boolean> =>
  (await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"])).trim() === name;

export async function removeContainer(name: string): Promise<void> {
  if (await containerExists(name)) await docker(["rm", "-f", name]);
}

/** Crea y arranca el contenedor de la instancia. Devuelve la dirección con la que el panel le habla. */
export async function runInstance(spec: InstanceSpec, containerName = namesFor(spec.slug).container): Promise<{ controlUrl: string }> {
  const p = provisioning();
  const n = namesFor(spec.slug);
  const dir = await mkdtemp(path.join(tmpdir(), "foodtag-env-"));
  const envFile = path.join(dir, "instance.env");
  try {
    await writeFile(envFile, envFor(spec), { mode: 0o600 });
    await chmod(envFile, 0o600);
    const args = [
      "run", "-d", "--name", containerName, "--restart", "unless-stopped", "--network", p.network,
      "--env-file", envFile,
      "-v", `${n.uploadsVolume}:/app/uploads`,
      ...(p.webDir ? ["-v", `${p.webDir}:/app/web:ro`] : []),
      ...(spec.port ? ["-p", `127.0.0.1:${spec.port}:3000`] : p.controlMode === "port" ? ["-p", "127.0.0.1::3000"] : []),
      ...(p.routing === "host" ? labelsFor(spec.slug).flatMap((l) => ["--label", l]) : []),
      spec.image,
    ];
    await docker(args, { timeoutMs: 120_000 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { controlUrl: await controlUrlOf(containerName) };
}

/** Cómo le habla el panel a la instancia: por el puerto publicado en 127.0.0.1, o por el nombre del contenedor en la red. */
export async function controlUrlOf(containerName: string): Promise<string> {
  if (provisioning().controlMode === "network") return `http://${containerName}:3000`;
  const out = (await docker(["port", containerName, "3000/tcp"])).trim().split("\n")[0];
  const port = out.split(":").pop();
  if (!port) throw new Error("No se pudo obtener el puerto de la instancia");
  return `http://127.0.0.1:${port}`;
}

/** Espera a que la instancia responda `/health`. */
export async function waitHealthy(baseUrl: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "sin respuesta";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
      last = `respondió ${res.status}`;
    } catch (err: any) {
      last = err?.cause?.code ?? err?.message ?? last;
    }
    await sleep(1500);
  }
  throw new Error(`La instancia no quedó lista a tiempo (${last})`);
}

export const isRunning = async (name: string): Promise<boolean> => {
  try {
    return (await docker(["inspect", "-f", "{{.State.Running}}", name])).trim() === "true";
  } catch {
    return false;
  }
};

export const logsOf = async (name: string, lines = 60): Promise<string> => docker(["logs", "--tail", String(lines), name]).catch((e) => String(e.message));

export async function removeVolume(name: string): Promise<void> {
  await docker(["volume", "rm", "-f", name]).catch(() => undefined);
}

export const renameContainer = (from: string, to: string) => docker(["rename", from, to]);
export const stopContainer = (name: string) => docker(["stop", "-t", "20", name], { timeoutMs: 60_000 });
export const startContainer = (name: string) => docker(["start", name]);
