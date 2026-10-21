/** Status HTTP a partir del mensaje de error: "no encontrad-" → 404, "Ya existe" → 409, "permiso" → 403, resto → 400. */
export function statusFromError(err: any): number {
  const message: string = err?.message ?? "";
  if (err?.status) return err.status;
  if (message.includes("permiso")) return 403;
  if (/no encontrad[oa]/.test(message)) return 404;
  if (message.includes("Ya existe") || message.includes("ya está")) return 409;
  return 400;
}
