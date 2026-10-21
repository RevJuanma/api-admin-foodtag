import net from "net";
import { randomBytes } from "crypto";
import { AppDataSource } from "@/config/database";
import { provisioning } from "@/config/env";
import { Tenant } from "@/entities/Tenant";
import { decrypt, encrypt, generateToken } from "@/utils/crypto";
import { record, type Actor } from "@/services/audit.service";
import { checkContact, checkTimezone, clientFor, pushToInstance, viewOf } from "@/services/tenant.service";
import { resolveModules } from "@/config/modules";
import { assertProvisionableSlug, portOfUrl, publicUrlFor } from "@/services/provisioner/names";
import { createBackup } from "@/services/backup.service";
import { createTenantDatabase, dropTenantDatabase } from "@/services/provisioner/database";
import { namesFor } from "@/services/provisioner/names";
import {
  containerExists, logsOf, removeContainer, removeVolume, renameContainer, runInstance, startContainer, stopContainer, waitHealthy,
} from "@/services/provisioner/instance";
import { docker } from "@/services/provisioner/shell";

const tenants = () => AppDataSource.getRepository(Tenant);

/** Operaciones en curso: una por restaurante a la vez (el panel corre en un solo proceso). */
const inFlight = new Set<string>();

export interface OwnerInput {
  email: string;
  password: string;
  name?: string;
}

interface Secrets {
  dbPassword: string;
  jwtSecret: string;
}

export const newSecrets = (): Secrets => ({ dbPassword: randomBytes(24).toString("hex"), jwtSecret: randomBytes(32).toString("hex") });
const secretsOf = (t: Tenant): Secrets => JSON.parse(decrypt(t.secretsEnc!));

/** Contraseña temporal legible para el dueño inicial. */
export function temporaryPassword(length = 14): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(length), (b) => alphabet[b % alphabet.length]).join("");
}

export const isBusy = (tenantId: string): boolean => inFlight.has(tenantId);

function lock(tenantId: string): void {
  if (inFlight.has(tenantId)) throw new Error("Ya hay una operación en curso para este restaurante");
  inFlight.add(tenantId);
}

async function setState(tenantId: string, patch: Partial<Tenant>): Promise<void> {
  await tenants().update(tenantId, patch as never);
}

const setStep = (tenantId: string, step: string) => setState(tenantId, { provisionStep: step });

/** Corre `job` en segundo plano; si falla, deja el restaurante en FAILED con el motivo y lo registra en la auditoría. */
function background(
  tenantId: string,
  failedAction: string,
  actor: Actor,
  job: () => Promise<void>,
  opts: { onFail?: () => Promise<void>; failStatus?: "FAILED" | "READY" } = {}
): void {
  setImmediate(async () => {
    try {
      await job();
    } catch (err: any) {
      const t = await tenants().findOneBy({ id: tenantId });
      let message = String(err.message ?? err).slice(0, 400);
      if (t?.instanceRef) {
        const logs = (await logsOf(t.instanceRef.container, 8)).trim().split("\n").slice(-3).join(" | ").slice(0, 300);
        if (logs) message += ` · log: ${logs}`;
      }
      try {
        await opts.onFail?.();
      } catch { /* el motivo original es el que importa */ }
      // El alta que falla queda FAILED (se reintenta); una actualización o una baja fallidas dejan la instancia anterior andando (READY, con el aviso)
      await setState(tenantId, { provisionStatus: opts.failStatus ?? "FAILED", provisionError: message.slice(0, 700), provisionStep: null });
      await record(actor, failedAction, t ?? null, { step: t?.provisionStep, error: message });
    } finally {
      inFlight.delete(tenantId);
    }
  });
}

// ── Alta ──────────────────────────────────────────────────────────────────

export interface ManagedInput {
  name?: string;
  slug?: string;
  timezone?: string;
  modules?: string[];
  contactName?: string;
  contactEmail?: string;
  notes?: string;
  /** Email del dueño inicial; por defecto el de contacto. */
  ownerEmail?: string;
}

/**
 * Alta de un restaurante con instancia propia: lo registra y arranca el aprovisionamiento en segundo plano.
 * Devuelve enseguida el restaurante (en PROVISIONING) y el dueño con su contraseña temporal, que no se vuelve a mostrar.
 */
/** Próximo puerto libre desde `INSTANCE_PORT_START`: no usado por otro restaurante ni ocupado en este equipo. */
async function freePort(): Promise<number> {
  const used = new Set((await tenants().find({ where: { managed: true }, select: { instanceUrl: true } })).map((t) => portOfUrl(t.instanceUrl)));
  for (let port = provisioning().portStart; port < 65535; port++) {
    if (used.has(port)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer().once("error", () => resolve(false)).once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error("No quedan puertos libres para la instancia");
}

export async function createManaged(input: ManagedInput, actor: Actor) {
  const p = provisioning();
  if (!p.enabled) throw new Error("El aprovisionamiento automático no está habilitado en el panel (PROVISIONER=docker)");
  const name = input.name?.trim();
  const slug = input.slug?.trim().toLowerCase();
  if (!name) throw new Error("El nombre es requerido");
  if (!slug) throw new Error("El slug es requerido");
  assertProvisionableSlug(slug);
  if (await tenants().existsBy({ slug })) throw new Error("Ya existe un restaurante con ese slug");
  const ownerEmail = (input.ownerEmail ?? input.contactEmail)?.trim().toLowerCase();
  if (!ownerEmail) throw new Error("Falta el email del dueño");
  checkContact(ownerEmail);
  checkContact(input.contactEmail);
  const timezone = input.timezone ?? "America/Argentina/Buenos_Aires";
  checkTimezone(timezone);

  const created = await tenants().save(
    tenants().create({
      slug,
      name,
      instanceUrl: publicUrlFor(slug, p.routing === "port" ? await freePort() : undefined),
      adminTokenEnc: encrypt(generateToken()),
      timezone,
      modules: resolveModules(input.modules ?? []),
      contactName: input.contactName?.trim() || null,
      contactEmail: input.contactEmail?.trim() || ownerEmail,
      notes: input.notes?.trim() || null,
      lastSyncOk: null,
      managed: true,
      provisionStatus: "PROVISIONING",
      provisionStep: "database",
      image: p.image,
    })
  );
  await record(actor, "tenant.create", created, { slug, modules: created.modules, managed: true, url: created.instanceUrl });

  const owner: OwnerInput = { email: ownerEmail, password: temporaryPassword(), name: input.contactName?.trim() || undefined };
  startProvision(created, owner, actor);
  return { tenant: viewOf(created), owner };
}

/** Levanta el contenedor de la instancia de un restaurante con la imagen indicada (alta y actualización). */
const startInstance = (tenant: Tenant, image: string, secrets: ReturnType<typeof secretsOf>) =>
  runInstance({ slug: tenant.slug, image, dbPassword: secrets.dbPassword, jwtSecret: secrets.jwtSecret, platformToken: decrypt(tenant.adminTokenEnc), port: portOfUrl(tenant.instanceUrl) });

/** Arranca el aprovisionamiento de un restaurante nuevo (o el reintento de uno que falló). Devuelve enseguida. */
export function startProvision(tenant: Tenant, owner: OwnerInput, actor: Actor): void {
  lock(tenant.id);
  background(tenant.id, "tenant.provision.failed", actor, async () => {
    const p = provisioning();
    const n = namesFor(tenant.slug);
    await setState(tenant.id, { provisionStatus: "PROVISIONING", provisionError: null, provisionStep: "database", image: tenant.image ?? p.image });

    // 1. Base de datos propia, con usuario propio
    const secrets = tenant.secretsEnc ? secretsOf(tenant) : newSecrets();
    if (!tenant.secretsEnc) await setState(tenant.id, { secretsEnc: encrypt(JSON.stringify(secrets)) });
    await createTenantDatabase({ database: n.database, dbUser: n.dbUser, password: secrets.dbPassword });
    await setState(tenant.id, { instanceRef: { container: n.container, database: n.database, dbUser: n.dbUser } });

    // 2. Contenedor de la API, con su dirección en el proxy
    await setStep(tenant.id, "container");
    await removeContainer(n.container);
    const image = tenant.image ?? p.image;
    const { controlUrl } = await startInstance(tenant, image, secrets);
    await setState(tenant.id, { controlUrl });

    // 3. Esperar a que arranque (crea el esquema de su base la primera vez)
    await setStep(tenant.id, "starting");
    await waitHealthy(controlUrl, provisioning().startTimeoutSeconds * 1000);

    // 4. Datos del restaurante, módulos contratados y suspensión
    await setStep(tenant.id, "configuring");
    const configured = await pushToInstance((await tenants().findOneByOrFail({ id: tenant.id })));
    if (!configured.lastSyncOk) throw new Error(configured.lastSyncError ?? "La instancia no aceptó la configuración");

    // 5. Dueño inicial
    await setStep(tenant.id, "owner");
    await clientFor(configured).upsertOwner(tenant.slug, owner);

    await setState(tenant.id, { provisionStatus: "READY", provisionStep: null, provisionError: null, provisionedAt: new Date() });
    await record(actor, "tenant.provisioned", configured, { url: tenant.instanceUrl, image, owner: owner.email });
  });
}

/** Reintenta un aprovisionamiento que falló (cada paso se puede repetir). Devuelve el dueño con una contraseña temporal nueva. */
export async function retryProvision(tenantId: string, actor: Actor, ownerOverride?: { email?: string; name?: string }) {
  const t = await tenants().findOneBy({ id: tenantId });
  if (!t) throw new Error("Restaurante no encontrado");
  if (!t.managed) throw new Error("Este restaurante no lo aprovisionó el panel");
  if (t.provisionStatus !== "FAILED") throw new Error("Solo se puede reintentar un aprovisionamiento que falló");
  const email = (ownerOverride?.email ?? t.contactEmail)?.trim();
  if (!email) throw new Error("Falta el email del dueño");
  const owner: OwnerInput = { email, password: temporaryPassword(), name: ownerOverride?.name ?? t.contactName ?? undefined };
  startProvision(t, owner, actor);
  await record(actor, "tenant.provision.retry", t);
  return owner;
}

// ── Actualización de versión ──────────────────────────────────────────────

/** Recrea el contenedor con otra imagen (las migraciones corren al arrancar). Si la nueva no levanta, vuelve a la anterior. */
export function startUpdate(tenant: Tenant, image: string, actor: Actor): void {
  lock(tenant.id);
  background(tenant.id, "tenant.update.failed", actor, async () => {
    const n = namesFor(tenant.slug);
    const previous = tenant.image;
    const oldName = `${n.container}-old`;
    await setState(tenant.id, { provisionStatus: "UPDATING", provisionStep: "pulling", provisionError: null });
    // Una imagen de un registro se descarga; una local ya está construida
    await docker(["pull", image], { timeoutMs: 300_000 }).catch(async () => {
      await docker(["image", "inspect", image]);
    });

    await setStep(tenant.id, "swapping");
    const secrets = secretsOf(tenant);
    await removeContainer(oldName);
    await stopContainer(n.container);
    await renameContainer(n.container, oldName);
    try {
      const { controlUrl } = await startInstance(tenant, image, secrets);
      await setStep(tenant.id, "starting");
      await waitHealthy(controlUrl, provisioning().startTimeoutSeconds * 1000);
      await setState(tenant.id, { controlUrl, image });
    } catch (err) {
      // Vuelve la versión anterior
      await removeContainer(n.container);
      await renameContainer(oldName, n.container);
      await startContainer(n.container);
      throw new Error(`No se pudo actualizar a ${image}; la instancia sigue con ${previous ?? "la versión anterior"}. ${(err as Error).message}`);
    }
    await removeContainer(oldName);

    await setStep(tenant.id, "configuring");
    const synced = await pushToInstance(await tenants().findOneByOrFail({ id: tenant.id }));
    await setState(tenant.id, { provisionStatus: "READY", provisionStep: null, provisionError: null });
    await record(actor, "tenant.updated", synced, { from: previous, to: image, sync: synced.lastSyncOk ? "ok" : synced.lastSyncError });
  }, {
    failStatus: "READY",
    // Si fallamos a mitad de camino, que la instancia anterior vuelva a estar andando
    onFail: async () => {
      const n = namesFor(tenant.slug);
      if (!(await containerExists(n.container)) && (await containerExists(`${n.container}-old`))) {
        await renameContainer(`${n.container}-old`, n.container);
        await startContainer(n.container);
      }
    },
  });
}

export async function updateTenantImage(tenantId: string, image: string | undefined, actor: Actor) {
  const t = await tenants().findOneBy({ id: tenantId });
  if (!t) throw new Error("Restaurante no encontrado");
  if (!t.managed || t.provisionStatus !== "READY") throw new Error("Solo se puede actualizar una instancia creada por el panel y lista");
  const target = image?.trim() || provisioning().image;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,200}$/.test(target)) throw new Error("El nombre de la imagen no es válido");
  startUpdate(t, target, actor);
  return { image: target };
}

/** Actualiza una por una todas las instancias listas (no a la vez, para no dejar a todos sin servicio juntos). */
export async function updateAll(image: string | undefined, actor: Actor) {
  const all = await tenants().find({ where: { managed: true, provisionStatus: "READY" }, order: { name: "ASC" } });
  const target = image?.trim() || provisioning().image;
  const queued = all.filter((t) => t.image !== target).map((t) => ({ id: t.id, name: t.name }));
  setImmediate(async () => {
    for (const q of queued) {
      try {
        await updateTenantImage(q.id, target, actor);
        // Esperar a que termine antes de seguir con la próxima
        while (inFlight.has(q.id)) await new Promise((r) => setTimeout(r, 1000));
      } catch { /* queda registrado en la auditoría de ese restaurante */ }
    }
  });
  return { image: target, queued };
}

// ── Baja ──────────────────────────────────────────────────────────────────

/**
 * Da de baja la instancia: baja el contenedor y, si `deleteData`, hace antes un respaldo y borra la base y los archivos.
 * El restaurante queda registrado como REMOVED (la auditoría y los respaldos se conservan).
 */
export async function removeTenant(tenantId: string, opts: { confirmSlug?: string; deleteData: boolean }, actor: Actor) {
  const t = await tenants().findOneBy({ id: tenantId });
  if (!t) throw new Error("Restaurante no encontrado");
  if (!t.managed) throw new Error("Este restaurante no lo aprovisionó el panel: se da de baja desde su propia infraestructura");
  if (t.provisionStatus === "REMOVED") throw new Error("El restaurante ya está dado de baja");
  if (opts.confirmSlug !== t.slug) throw new Error("Para confirmar la baja escribí el slug del restaurante");
  lock(t.id);
  try {
    await setState(t.id, { provisionStatus: "REMOVING", provisionStep: opts.deleteData ? "backup" : "stopping", provisionError: null });
  } catch (err) {
    inFlight.delete(t.id);
    throw err;
  }
  const previousStatus = t.provisionStatus;
  background(t.id, "tenant.remove.failed", actor, async () => {
    const n = namesFor(t.slug);
    if (opts.deleteData) {
      await createBackup(t, "PRE_REMOVE"); // sin respaldo no se borra nada
      await setStep(t.id, "deleting");
    }
    await setStep(t.id, "stopping");
    await removeContainer(n.container);
    if (opts.deleteData) {
      await dropTenantDatabase({ database: n.database, dbUser: n.dbUser });
      await removeVolume(n.uploadsVolume);
    }
    const removedAt = new Date();
    // Con los datos borrados el slug queda libre para un restaurante nuevo; si se conservaron, sigue reservado (su base todavía existe)
    await setState(t.id, { provisionStatus: "REMOVED", provisionStep: null, removedAt, controlUrl: null, lastSyncOk: null, ...(opts.deleteData && { slug: `${t.slug}~${removedAt.getTime()}` }) });
    await record(actor, "tenant.removed", t, { deleteData: opts.deleteData, backup: opts.deleteData ? "PRE_REMOVE" : null });
  }, { failStatus: previousStatus === "READY" ? "READY" : "FAILED" });
  return { removing: true };
}

/** Si el panel se reinició a mitad de una operación, esos restaurantes quedan marcados como fallidos (se pueden reintentar). */
export async function recoverInterrupted(): Promise<number> {
  const stuck = await tenants().find({ where: [{ provisionStatus: "PROVISIONING" }, { provisionStatus: "UPDATING" }, { provisionStatus: "REMOVING" }] });
  for (const t of stuck) {
    await setState(t.id, { provisionStatus: t.provisionStatus === "PROVISIONING" ? "FAILED" : "READY", provisionError: "Se interrumpió porque el panel se reinició", provisionStep: null });
  }
  return stuck.length;
}

export { generateToken };
