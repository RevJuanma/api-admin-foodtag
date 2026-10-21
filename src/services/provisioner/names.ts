import { provisioning } from "@/config/env";

/** Subdominios que no pueden ser de un restaurante (los usa la plataforma). */
const RESERVED = new Set(["www", "api", "app", "admin", "panel", "mail", "traefik", "status", "docs", "static", "assets", "cdn", "db", "localhost"]);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function assertProvisionableSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new Error("El slug solo admite minúsculas, números y guiones");
  if (slug.length < 3 || slug.length > 40) throw new Error("El slug tiene que tener entre 3 y 40 caracteres");
  if (RESERVED.has(slug)) throw new Error(`El slug "${slug}" está reservado por la plataforma`);
}

/** Nombres de infraestructura de un restaurante, todos derivados del slug (ya validado). */
export function namesFor(slug: string) {
  const key = slug.replace(/-/g, "_");
  return {
    container: `foodtag-${slug}`,
    uploadsVolume: `foodtag-${slug}-uploads`,
    database: `foodtag_${key}`,
    dbUser: `ft_${key}`,
  };
}

/** Dirección pública de la instancia: `https://slug.foodtag.com` (con puerto si el proxy no usa el estándar). */
export function publicUrlFor(slug: string, port?: number): string {
  const p = provisioning();
  if (p.routing === "port") return `${p.scheme}://${p.baseDomain}:${port}`;
  return `${p.scheme}://${slug}.${p.baseDomain}${p.publicPort ? `:${p.publicPort}` : ""}`;
}

/** Puerto asignado a una instancia con `INSTANCE_ROUTING=port` (está en su dirección pública). */
export const portOfUrl = (url: string): number | undefined => Number(new URL(url).port) || undefined;
