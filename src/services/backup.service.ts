import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { mkdir, rm, stat } from "fs/promises";
import path from "path";
import { AppDataSource } from "@/config/database";
import { provisioning } from "@/config/env";
import { Backup, type BackupKind } from "@/entities/Backup";
import { Tenant } from "@/entities/Tenant";
import { record, type Actor } from "@/services/audit.service";
import { byIdOrThrow } from "@/services/tenant.service";

const backups = () => AppDataSource.getRepository(Backup);
const dir = () => path.resolve(provisioning().backupDir);

/** Los respaldos se hacen con `pg_dump` dentro del contenedor de Postgres: hay que decirle cuál es. */
export const backupsAvailable = (): boolean => !!provisioning().db.container;

const view = (b: Backup) => ({ id: b.id, kind: b.kind, file: b.file, sizeBytes: b.sizeBytes, createdAt: b.createdAt });

/** Respaldo de la base del restaurante (`pg_dump -Fc`, formato comprimido que se restaura con `pg_restore`). */
export async function createBackup(tenant: Tenant, kind: BackupKind): Promise<Backup> {
  const p = provisioning();
  if (!tenant.managed || !tenant.instanceRef) throw new Error("Solo se pueden respaldar las instancias creadas por el panel");
  if (!p.db.container) throw new Error("Falta TENANT_DB_CONTAINER: el panel no sabe de qué contenedor hacer el respaldo");

  await mkdir(dir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const file = `${tenant.slug}-${stamp}-${kind.toLowerCase()}.dump`;
  const target = path.join(dir(), file);

  await new Promise<void>((resolve, reject) => {
    // El Postgres de la imagen oficial confía en el socket local para el usuario postgres: no hace falta contraseña
    const child = spawn("docker", ["exec", p.db.container, "pg_dump", "-U", p.db.user, "-Fc", tenant.instanceRef!.database]);
    const out = createWriteStream(target, { mode: 0o600 });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.pipe(out);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? out.end(resolve) : reject(new Error(stderr.trim().slice(-300) || `pg_dump terminó con código ${code}`))));
  }).catch(async (err) => {
    await rm(target, { force: true });
    throw err;
  });

  const { size } = await stat(target);
  if (size === 0) {
    await rm(target, { force: true });
    throw new Error("El respaldo quedó vacío");
  }
  return backups().save(backups().create({ tenantId: tenant.id, kind, file, sizeBytes: size }));
}

export async function listBackups(tenantId: string) {
  return (await backups().find({ where: { tenantId }, order: { id: "DESC" } })).map(view);
}

export async function manualBackup(tenantId: string, actor: Actor) {
  const tenant = await byIdOrThrow(tenantId);
  const backup = await createBackup(tenant, "MANUAL");
  await record(actor, "tenant.backup", tenant, { file: backup.file, sizeBytes: backup.sizeBytes });
  return view(backup);
}

export async function backupFile(id: number): Promise<{ path: string; name: string }> {
  const b = await backups().findOneBy({ id });
  if (!b) throw new Error("Respaldo no encontrado");
  return { path: path.join(dir(), b.file), name: b.file };
}

export async function deleteBackup(id: number, actor: Actor) {
  const b = await backups().findOneBy({ id });
  if (!b) throw new Error("Respaldo no encontrado");
  await rm(path.join(dir(), b.file), { force: true });
  await backups().delete(id);
  const tenant = await AppDataSource.getRepository(Tenant).findOneBy({ id: b.tenantId });
  await record(actor, "tenant.backup.delete", tenant, { file: b.file });
  return { ok: true };
}

/** Respaldo diario de todas las instancias que administra el panel, y limpieza de los más viejos que la retención. */
export async function runScheduledBackups(): Promise<{ done: number; failed: number }> {
  const all = await AppDataSource.getRepository(Tenant).find({ where: { managed: true, provisionStatus: "READY" } });
  let done = 0;
  let failed = 0;
  for (const t of all) {
    try {
      await createBackup(t, "AUTO");
      done++;
    } catch (err: any) {
      failed++;
      await record(null, "tenant.backup.failed", t, { error: err.message });
    }
  }
  const cutoff = new Date(Date.now() - provisioning().backupRetentionDays * 86_400_000);
  const old = await backups().createQueryBuilder("b").where("b.kind = 'AUTO' AND b.createdAt < :cutoff", { cutoff }).getMany();
  for (const b of old) {
    await rm(path.join(dir(), b.file), { force: true });
    await backups().delete(b.id);
  }
  return { done, failed };
}
