import { ILike } from "typeorm";
import { AppDataSource } from "@/config/database";
import { Tenant, type InstanceSnapshot } from "@/entities/Tenant";
import { resolveModules } from "@/config/modules";
import { decrypt, encrypt, generateToken } from "@/utils/crypto";
import { PlatformClient, normalizeInstanceUrl } from "@/services/platformClient";
import { record, type Actor } from "@/services/audit.service";

const tenants = () => AppDataSource.getRepository(Tenant);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type TenantStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "UNREACHABLE" | "PROVISIONING" | "UPDATING" | "REMOVING" | "REMOVED" | "FAILED";

/** Qué se muestra de un restaurante: nunca incluye el token de su instancia. */
export function viewOf(t: Tenant) {
  const busyStatus = ["PROVISIONING", "UPDATING", "REMOVING", "REMOVED", "FAILED"].includes(t.provisionStatus) ? (t.provisionStatus as TenantStatus) : null;
  const status: TenantStatus = busyStatus ?? (t.suspendedAt ? "SUSPENDED" : t.lastSyncOk === null ? "PENDING" : t.lastSyncOk ? "ACTIVE" : "UNREACHABLE");
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    instanceUrl: t.instanceUrl,
    timezone: t.timezone,
    modules: t.modules,
    status,
    suspendedAt: t.suspendedAt,
    suspendedReason: t.suspendedReason,
    contactName: t.contactName,
    contactEmail: t.contactEmail,
    notes: t.notes,
    /** La instancia tiene el último estado que se le pidió (si no, hay que sincronizar). */
    inSync: t.lastSyncOk === true,
    lastSyncAt: t.lastSyncAt,
    lastSyncError: t.lastSyncError,
    instance: t.instanceSnapshot,
    managed: t.managed,
    provision: t.managed ? { status: t.provisionStatus, step: t.provisionStep, error: t.provisionError, at: t.provisionedAt, image: t.image } : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** Con una instancia aprovisionada por el panel se le habla por su dirección de control; si no, por la pública. */
export const clientFor = (t: Tenant) => new PlatformClient(t.controlUrl ?? t.instanceUrl, decrypt(t.adminTokenEnc));

async function byId(id: string): Promise<Tenant> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Restaurante no encontrado");
  const t = await tenants().findOneBy({ id });
  if (!t) throw new Error("Restaurante no encontrado");
  return t;
}

export function checkTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error("Zona horaria inválida");
  }
}

export function checkContact(email?: string | null): void {
  if (email && !EMAIL.test(email)) throw new Error("El email de contacto no es válido");
}

export async function list(filters: { search?: string; status?: string }) {
  const where = filters.search ? [{ name: ILike(`%${filters.search}%`) }, { slug: ILike(`%${filters.search}%`) }] : {};
  const all = await tenants().find({ where, order: { name: "ASC" } });
  const views = all.map(viewOf);
  // Los restaurantes dados de baja solo aparecen si se pide ese estado
  return filters.status ? views.filter((v) => v.status === filters.status) : views.filter((v) => v.status !== "REMOVED");
}

export async function get(id: string) {
  return viewOf(await byId(id));
}

/**
 * Empuja a la instancia el estado deseado (datos, módulos, suspensión) y lee cómo quedó. Si la instancia no responde, el
 * cambio queda guardado en el panel y el restaurante pasa a "sin conexión" hasta la próxima sincronización.
 */
export async function byIdOrThrow(id: string): Promise<Tenant> {
  return byId(id);
}

export async function pushToInstance(t: Tenant): Promise<Tenant> {
  try {
    const client = clientFor(t);
    await client.upsertRestaurant(t.slug, { name: t.name, timezone: t.timezone, modules: t.modules });
    if (t.suspendedAt) await client.suspend(t.slug, t.suspendedReason);
    else await client.resume(t.slug);
    const status = await client.status(t.slug);
    const snapshot: InstanceSnapshot = {
      version: status.version,
      modulesLoaded: status.modulesLoaded,
      users: status.restaurant?.users ?? 0,
      modulesMissing: status.restaurant?.modulesMissing ?? [],
      suspended: status.restaurant?.suspended ?? false,
    };
    Object.assign(t, { lastSyncOk: true, lastSyncError: null, instanceSnapshot: snapshot });
  } catch (err: any) {
    Object.assign(t, { lastSyncOk: false, lastSyncError: String(err.message).slice(0, 300) });
  }
  t.lastSyncAt = new Date();
  return tenants().save(t);
}

export interface CreateInput {
  name?: string;
  slug?: string;
  instanceUrl?: string;
  /** Token de una instancia que ya existe. Vacío: se genera uno nuevo para cargar en la instancia. */
  adminToken?: string;
  timezone?: string;
  modules?: string[];
  contactName?: string;
  contactEmail?: string;
  notes?: string;
}

export async function create(input: CreateInput, actor: Actor) {
  const name = input.name?.trim();
  const slug = input.slug?.trim().toLowerCase();
  if (!name) throw new Error("El nombre es requerido");
  if (!slug || !SLUG.test(slug)) throw new Error("El slug solo admite minúsculas, números y guiones");
  if (!input.instanceUrl) throw new Error("La URL de la instancia es requerida");
  if (await tenants().existsBy({ slug })) throw new Error("Ya existe un restaurante con ese slug");
  const timezone = input.timezone ?? "America/Argentina/Buenos_Aires";
  checkTimezone(timezone);
  checkContact(input.contactEmail);
  if (input.adminToken !== undefined && input.adminToken.length < 32) throw new Error("El token de la instancia tiene que tener al menos 32 caracteres");

  const generatedToken = input.adminToken ? null : generateToken();
  const token = input.adminToken ?? generatedToken!;
  const created = await tenants().save(
    tenants().create({
      slug,
      name,
      instanceUrl: normalizeInstanceUrl(input.instanceUrl),
      adminTokenEnc: encrypt(token),
      timezone,
      modules: resolveModules(input.modules ?? []),
      contactName: input.contactName?.trim() || null,
      contactEmail: input.contactEmail?.trim() || null,
      notes: input.notes?.trim() || null,
      lastSyncOk: null,
    })
  );
  await record(actor, "tenant.create", created, { slug, modules: created.modules, instanceUrl: created.instanceUrl });

  const synced = await pushToInstance(created);
  await record(actor, "tenant.sync", synced, { ok: synced.lastSyncOk, error: synced.lastSyncError });
  return { tenant: viewOf(synced), ...(generatedToken && { adminToken: generatedToken }), env: envFor(synced, token) };
}

export interface UpdateInput {
  name?: string;
  instanceUrl?: string;
  timezone?: string;
  modules?: string[];
  contactName?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  adminToken?: string;
}

export async function update(id: string, input: UpdateInput, actor: Actor) {
  const t = await byId(id);
  const before = { modules: [...t.modules], name: t.name, timezone: t.timezone, instanceUrl: t.instanceUrl };
  // La dirección y el token de una instancia aprovisionada los maneja el panel: cambiarlos la dejaría inalcanzable
  if (t.managed && ((input.instanceUrl !== undefined && normalizeInstanceUrl(input.instanceUrl) !== t.instanceUrl) || input.adminToken !== undefined)) {
    throw new Error("La dirección y el token de una instancia creada por el panel no se pueden cambiar");
  }

  if (input.name !== undefined) {
    if (!input.name.trim()) throw new Error("El nombre es requerido");
    t.name = input.name.trim();
  }
  if (input.instanceUrl !== undefined) t.instanceUrl = normalizeInstanceUrl(input.instanceUrl);
  if (input.timezone !== undefined) {
    checkTimezone(input.timezone);
    t.timezone = input.timezone;
  }
  if (input.modules !== undefined) t.modules = resolveModules(input.modules);
  if (input.contactName !== undefined) t.contactName = input.contactName?.trim() || null;
  if (input.contactEmail !== undefined) {
    checkContact(input.contactEmail);
    t.contactEmail = input.contactEmail?.trim() || null;
  }
  if (input.notes !== undefined) t.notes = input.notes?.trim() || null;
  if (input.adminToken !== undefined) {
    if (input.adminToken.length < 32) throw new Error("El token de la instancia tiene que tener al menos 32 caracteres");
    t.adminTokenEnc = encrypt(input.adminToken);
  }

  const synced = await pushToInstance(t);
  const changes: Record<string, unknown> = {};
  if (before.modules.join() !== synced.modules.join()) changes.modules = { from: before.modules, to: synced.modules };
  if (before.name !== synced.name) changes.name = { from: before.name, to: synced.name };
  if (before.timezone !== synced.timezone) changes.timezone = { from: before.timezone, to: synced.timezone };
  if (before.instanceUrl !== synced.instanceUrl) changes.instanceUrl = { from: before.instanceUrl, to: synced.instanceUrl };
  if (input.adminToken !== undefined) changes.adminToken = "reemplazado";
  await record(actor, changes.modules ? "tenant.modules" : "tenant.update", synced, { ...changes, sync: synced.lastSyncOk ? "ok" : synced.lastSyncError });
  return viewOf(synced);
}

export async function setSuspended(id: string, suspended: boolean, reason: string | undefined, actor: Actor) {
  const t = await byId(id);
  t.suspendedAt = suspended ? t.suspendedAt ?? new Date() : null;
  t.suspendedReason = suspended ? reason?.trim() || null : null;
  const synced = await pushToInstance(t);
  await record(actor, suspended ? "tenant.suspend" : "tenant.resume", synced, { reason: synced.suspendedReason, sync: synced.lastSyncOk ? "ok" : synced.lastSyncError });
  return viewOf(synced);
}

export async function sync(id: string, actor: Actor) {
  const synced = await pushToInstance(await byId(id));
  await record(actor, "tenant.sync", synced, { ok: synced.lastSyncOk, error: synced.lastSyncError });
  return viewOf(synced);
}

/** Alta del dueño del restaurante (o cambio de su contraseña) directamente en la instancia. La contraseña no se guarda acá. */
export async function upsertOwner(id: string, input: { email?: string; password?: string; name?: string }, actor: Actor) {
  const t = await byId(id);
  if (!input.email || !EMAIL.test(input.email)) throw new Error("El email del dueño no es válido");
  if (!input.password) throw new Error("La contraseña es requerida");
  const owner = await clientFor(t).upsertOwner(t.slug, { email: input.email, password: input.password, name: input.name });
  await record(actor, owner.created ? "tenant.owner.create" : "tenant.owner.reset", t, { email: owner.email });
  return owner;
}

function envFor(t: Tenant, token: string) {
  return [
    `# Variables de la instancia de ${t.name} (${t.slug})`,
    `PLATFORM_ADMIN_TOKEN=${token}`,
    `ENABLED_MODULES=${t.modules.join(",")}`,
    `# Compilar solo esos módulos: docker compose build --build-arg MODULES=${t.modules.join(",")} api`,
  ].join("\n");
}

/** Configuración para cargar en la instancia (incluye el token): cada consulta queda en la auditoría. */
export async function instanceEnv(id: string, actor: Actor) {
  const t = await byId(id);
  await record(actor, "tenant.env.view", t);
  return { env: envFor(t, decrypt(t.adminTokenEnc)) };
}
