/**
 * Catálogo de módulos que se pueden contratar y sus dependencias. ESPEJO de `api-foodtag/src/core/config/modules.ts`
 * (`MODULE_REQUIRES`): `npm run check:modules` verifica que coincidan. Al contratar un módulo se suman los que necesita.
 */
export const MODULES = {
  zones:           { label: "Zonas y mesas",     description: "Plano del salón con zonas y mesas.",                      requires: [] },
  products:        { label: "Productos",         description: "Carta con categorías, variantes de precio e imágenes.",   requires: [] },
  dashboard:       { label: "Dashboard",         description: "Resumen del salón en vivo.",                              requires: ["zones"] },
  accounts:        { label: "Cuentas",           description: "Abrir cuentas por mesa y cargar el pedido.",              requires: ["zones", "products"] },
  nfc:             { label: "Pulseras NFC",      description: "Pulseras para identificar al cliente.",                   requires: ["accounts"] },
  promotions:      { label: "Promociones",       description: "Descuentos por horario, zona y medio de pago.",           requires: ["products", "zones", "accounts"] },
  comandas:        { label: "Comandas",          description: "Pedidos a cocina y barra con seguimiento.",               requires: ["accounts"] },
  payments:        { label: "Cobros",            description: "Cobro, propinas, cierre de cuenta y resumen del día.",    requires: ["accounts"] },
  "customer-menu": { label: "Menú del cliente",  description: "Menú público para el cliente final.",                     requires: ["products", "nfc"] },
  branches:        { label: "Sucursales",        description: "Varias sucursales con su propio personal, salón y cierre.", requires: [] },
} as const satisfies Record<string, { label: string; description: string; requires: readonly string[] }>;

export type ModuleId = keyof typeof MODULES;
export const ALL_MODULES = Object.keys(MODULES) as ModuleId[];

/** Los módulos pedidos más todo lo que necesitan, con cada uno después de sus dependencias. */
export function resolveModules(requested: readonly string[]): ModuleId[] {
  const unknown = requested.filter((m) => !(m in MODULES));
  if (unknown.length) throw new Error(`Módulo desconocido: ${unknown.join(", ")}`);

  const ordered: ModuleId[] = [];
  const visit = (id: ModuleId) => {
    if (ordered.includes(id)) return;
    for (const dep of MODULES[id].requires) visit(dep as ModuleId);
    ordered.push(id);
  };
  (requested as ModuleId[]).forEach(visit);
  return ordered;
}
