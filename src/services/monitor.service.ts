import { AppDataSource } from "@/config/database";
import { provisioning } from "@/config/env";
import { Backup } from "@/entities/Backup";
import { Tenant } from "@/entities/Tenant";
import { record } from "@/services/audit.service";
import { runScheduledBackups, backupsAvailable } from "@/services/backup.service";
import { isBusy, recoverInterrupted } from "@/services/provisioning.service";
import { clientFor, pushToInstance } from "@/services/tenant.service";
import { isRunning, startContainer } from "@/services/provisioner/instance";

const tenants = () => AppDataSource.getRepository(Tenant);

/**
 * Mira una instancia: si su contenedor está caído lo arranca, lee su estado y, si lo que tiene no coincide con lo que el panel
 * pidió (por ejemplo un cambio hecho mientras estaba caída), se lo vuelve a empujar.
 */
export async function checkHealth(t: Tenant): Promise<void> {
  if (t.managed && t.instanceRef && !(await isRunning(t.instanceRef.container))) {
    await startContainer(t.instanceRef.container).catch(() => undefined);
  }
  try {
    const status = await clientFor(t).status(t.slug);
    const r = status.restaurant;
    const inSync = !!r && r.name === t.name && r.timezone === t.timezone && r.suspended === !!t.suspendedAt && [...r.modules].sort().join() === [...t.modules].sort().join();
    if (!inSync) {
      await pushToInstance(t);
      await record(null, "tenant.reconciled", t, { reason: r ? "la instancia tenía otra configuración" : "la instancia no tenía al restaurante" });
      return;
    }
    await tenants().update(t.id, {
      lastSyncOk: true,
      lastSyncError: null,
      lastSyncAt: new Date(),
      instanceSnapshot: { version: status.version, modulesLoaded: status.modulesLoaded, users: r!.users, modulesMissing: r!.modulesMissing, suspended: r!.suspended },
    });
  } catch (err: any) {
    await tenants().update(t.id, { lastSyncOk: false, lastSyncError: String(err.message).slice(0, 300), lastSyncAt: new Date() });
  }
}

let monitoring = false;

export async function monitorOnce(): Promise<void> {
  if (monitoring) return;
  monitoring = true;
  try {
    const all = await tenants().find({ where: [{ provisionStatus: "READY" }, { provisionStatus: "NONE" }] });
    for (const t of all) if (!isBusy(t.id)) await checkHealth(t);
  } finally {
    monitoring = false;
  }
}

async function backupsDueToday(): Promise<boolean> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const done = await AppDataSource.getRepository(Backup).createQueryBuilder("b").where("b.kind = 'AUTO' AND b.createdAt >= :start", { start }).getCount();
  return done === 0;
}

export async function backupTick(): Promise<void> {
  const { backupHour } = provisioning();
  if (backupHour < 0 || !backupsAvailable() || new Date().getHours() < backupHour) return;
  if (await backupsDueToday()) await runScheduledBackups();
}

/** Arranca los procesos de fondo del panel: recuperación tras un reinicio, monitoreo de salud y respaldo diario. */
export async function startBackgroundJobs(): Promise<void> {
  const interrupted = await recoverInterrupted();
  if (interrupted) console.warn(`${interrupted} operación(es) de instancias quedaron interrumpidas por un reinicio`);
  if (!provisioning().enabled && process.env.MONITOR_UNMANAGED !== "true") return;
  setInterval(() => monitorOnce().catch((e) => console.error("monitor:", e.message)), provisioning().monitorSeconds * 1000).unref();
  setInterval(() => backupTick().catch((e) => console.error("respaldo:", e.message)), 10 * 60 * 1000).unref();
}
