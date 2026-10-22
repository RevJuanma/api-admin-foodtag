import { AppDataSource } from "@/config/database";
import { Tenant } from "@/entities/Tenant";
import { clientFor, byIdOrThrow } from "@/services/tenant.service";
import { record, type Actor } from "@/services/audit.service";

const tenants = () => AppDataSource.getRepository(Tenant);

/** Los restaurantes con pulseras que tienen instancia viva: los demás no tienen nada que reponer ni a quién preguntarle. */
const withNfc = (t: Tenant) => t.modules.includes("nfc") && !t.removedAt && t.provisionStatus !== "REMOVED";

/** Pulseras extraviadas o rotas de un restaurante, pendientes de reposición. */
export async function forTenant(id: string) {
  const t = await byIdOrThrow(id);
  if (!t.modules.includes("nfc")) throw new Error("Este restaurante no tiene contratado el módulo de pulseras");
  const report = await clientFor(t).nfcReplenishment(t.slug);
  if (!report) throw new Error("La instancia no tiene cargado el módulo de pulseras");
  return { tenantId: t.id, slug: t.slug, name: t.name, ...report };
}

/**
 * Todos los restaurantes con pulseras y cuántas tienen pendientes de reposición, de un vistazo. Una instancia que no
 * responde figura con su error en vez de frenar al resto.
 */
export async function overview() {
  const all = (await tenants().find({ order: { name: "ASC" } })).filter(withNfc);
  return Promise.all(all.map(async (t) => {
    const base = { tenantId: t.id, slug: t.slug, name: t.name };
    try {
      const report = await clientFor(t).nfcReplenishment(t.slug);
      if (!report) return { ...base, ok: false as const, error: "La instancia no tiene cargado el módulo de pulseras" };
      return { ...base, ok: true as const, ...report };
    } catch (err: any) {
      return { ...base, ok: false as const, error: String(err.message ?? err) };
    }
  }));
}

/** Se repusieron pulseras al restaurante (las indicadas o todas las pendientes): dejan de figurar como pendientes. */
export async function markReplaced(id: string, tagIds: unknown, actor: Actor) {
  if (tagIds !== undefined && (!Array.isArray(tagIds) || tagIds.some((n) => !Number.isInteger(n)))) throw new Error("tagIds debe ser una lista de números");
  const t = await byIdOrThrow(id);
  const result = await clientFor(t).nfcMarkReplaced(t.slug, tagIds as number[] | undefined);
  await record(actor, "tenant.nfc.replaced", t, { replaced: result.replaced, ...(tagIds ? { tagIds } : { all: true }) });
  return result;
}
