import { AppDataSource } from "@/config/database";
import { AuditLog } from "@/entities/AuditLog";

export interface Actor {
  id: number;
  email: string;
}

export async function record(actor: Actor | null, action: string, tenant: { id: string; name: string } | null, detail?: Record<string, unknown>): Promise<void> {
  const repo = AppDataSource.getRepository(AuditLog);
  await repo.save(repo.create({ adminId: actor?.id ?? null, adminEmail: actor?.email ?? null, tenantId: tenant?.id ?? null, tenantName: tenant?.name ?? null, action, detail: detail ?? null }));
}

export async function list(filters: { tenantId?: string; limit?: number }) {
  return AppDataSource.getRepository(AuditLog).find({
    where: filters.tenantId ? { tenantId: filters.tenantId } : {},
    order: { id: "DESC" },
    take: Math.min(filters.limit ?? 100, 500),
  });
}
