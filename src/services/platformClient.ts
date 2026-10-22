import { insecureInstancesAllowed } from "@/config/env";

/** Qué informa una instancia en `GET /platform/status` para un restaurante. */
export interface InstanceStatus {
  version: string | null;
  modulesLoaded: string[];
  restaurant: { name: string; timezone: string; modules: string[]; users: number; modulesMissing: string[]; suspended: boolean } | null;
}

/** Pulseras extraviadas o rotas de un restaurante que la plataforma todavía tiene que reponer (lo informa la instancia). */
export interface NfcReplenishment {
  total: number;
  lost: number;
  broken: number;
  pending: { id: number; uid: string; condition: "LOST" | "BROKEN"; note: string | null; at: string | null }[];
}

/** Valida y normaliza la URL base de una instancia (sin barra final; https salvo que se permita http). */
export function normalizeInstanceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("La URL de la instancia no es válida");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && insecureInstancesAllowed())) {
    throw new Error("La URL de la instancia tiene que ser https");
  }
  if (url.username || url.password) throw new Error("La URL de la instancia no puede llevar usuario ni contraseña");
  return `${url.protocol}//${url.host}`;
}

/** Cliente del canal de la plataforma de UNA instancia (`/api/v1/platform`). */
export class PlatformClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/platform${path}`, {
        method,
        headers: { "content-type": "application/json", "x-platform-token": this.token },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err: any) {
      throw new Error(err?.name === "TimeoutError" ? "La instancia no respondió a tiempo" : "No se pudo conectar con la instancia");
    }
    const data = (await res.json().catch(() => null)) as { message?: string } | null;
    if (!res.ok) {
      if (res.status === 401) throw new Error("La instancia rechazó el token de la plataforma");
      if (res.status === 404 && data === null) throw new Error("La instancia no tiene habilitado el canal de la plataforma (falta PLATFORM_ADMIN_TOKEN)");
      throw new Error(data?.message ?? `La instancia respondió ${res.status}`);
    }
    return data as T;
  }

  upsertRestaurant(slug: string, input: { name: string; timezone: string; modules: string[] }) {
    return this.call<{ modules: string[] }>("PUT", `/restaurants/${encodeURIComponent(slug)}`, input);
  }

  suspend(slug: string, reason: string | null) {
    return this.call("POST", `/restaurants/${encodeURIComponent(slug)}/suspend`, { reason });
  }

  resume(slug: string) {
    return this.call("POST", `/restaurants/${encodeURIComponent(slug)}/resume`);
  }

  upsertOwner(slug: string, input: { email: string; password: string; name?: string }) {
    return this.call<{ id: number; email: string; name: string | null; created: boolean }>("PUT", `/restaurants/${encodeURIComponent(slug)}/owner`, input);
  }

  /** `null` si el restaurante no usa el módulo de pulseras en su instancia. */
  nfcReplenishment(slug: string) {
    return this.call<NfcReplenishment | null>("GET", `/restaurants/${encodeURIComponent(slug)}/nfc`);
  }

  nfcMarkReplaced(slug: string, tagIds?: number[]) {
    return this.call<{ replaced: number }>("POST", `/restaurants/${encodeURIComponent(slug)}/nfc/replaced`, tagIds ? { tagIds } : {});
  }

  async status(slug: string): Promise<InstanceStatus> {
    const s = await this.call<{ version: string | null; modulesLoaded: string[]; restaurants: Array<{ slug: string; name: string; timezone: string; modules: string[]; users: number; modulesMissing: string[]; suspended: boolean }> }>("GET", "/status");
    const r = s.restaurants.find((x) => x.slug === slug);
    return {
      version: s.version,
      modulesLoaded: s.modulesLoaded,
      restaurant: r ? { name: r.name, timezone: r.timezone, modules: r.modules, users: r.users, modulesMissing: r.modulesMissing, suspended: r.suspended } : null,
    };
  }
}
