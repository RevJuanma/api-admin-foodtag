import { Router, Request, Response } from "express";
import { authMiddleware } from "@/middlewares/auth.middleware";
import { loginRateLimit } from "@/middlewares/rateLimit.middleware";
import { statusFromError } from "@/utils/errorStatus";
import { MODULES } from "@/config/modules";
import * as auth from "@/services/auth.service";
import * as tenants from "@/services/tenant.service";
import * as audit from "@/services/audit.service";
import * as provisioning from "@/services/provisioning.service";
import * as backups from "@/services/backup.service";
import { provisioning as provisioningConfig } from "@/config/env";
import { publicUrlFor } from "@/services/provisioner/names";

const router = Router();

/** Envuelve un handler: responde con el resultado o con el status que corresponde al error. */
const run = (fn: (req: Request) => Promise<unknown>, okStatus = 200) => async (req: Request, res: Response) => {
  try {
    res.status(okStatus).json(await fn(req));
  } catch (err: any) {
    res.status(statusFromError(err)).json({ message: err.message });
  }
};
const id = (req: Request) => String(req.params.id);
const actor = (req: Request) => req.admin!;

// ── Sesión
router.post("/auth/login", loginRateLimit, run((req) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    throw Object.assign(new Error("Email y contraseña son requeridos"), { status: 400 });
  }
  return auth.login(email, password);
}));
router.get("/auth/me", authMiddleware, run(async (req) => ({ admin: req.admin })));

// ── Todo lo demás requiere sesión
router.use(authMiddleware);

router.get("/modules", run(async () =>
  Object.entries(MODULES).map(([moduleId, m]) => ({ id: moduleId, label: m.label, description: m.description, requires: m.requires }))
));

router.get("/tenants", run((req) => tenants.list({ search: typeof req.query.search === "string" ? req.query.search : undefined, status: typeof req.query.status === "string" ? req.query.status : undefined })));
// Con el aprovisionamiento habilitado, crear un restaurante levanta su instancia (en segundo plano); `mode: "existing"` registra una instancia que ya existe
router.post("/tenants", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    if (provisioningConfig().enabled && body.mode !== "existing") res.status(202).json(await provisioning.createManaged(body, actor(req)));
    else res.status(201).json(await tenants.create(body, actor(req)));
  } catch (err: any) {
    res.status(statusFromError(err)).json({ message: err.message });
  }
});
router.get("/system", run(async () => {
  const p = provisioningConfig();
  return {
    provisioning: p.enabled,
    baseDomain: p.baseDomain,
    exampleUrl: publicUrlFor("mi-restaurante"),
    image: p.image,
    backups: { available: backups.backupsAvailable(), hour: p.backupHour, retentionDays: p.backupRetentionDays },
  };
}));
router.get("/tenants/:id", run((req) => tenants.get(id(req))));
router.patch("/tenants/:id", run((req) => tenants.update(id(req), req.body ?? {}, actor(req))));
router.post("/tenants/:id/suspend", run((req) => tenants.setSuspended(id(req), true, req.body?.reason, actor(req))));
router.post("/tenants/:id/resume", run((req) => tenants.setSuspended(id(req), false, undefined, actor(req))));
router.post("/tenants/:id/sync", run((req) => tenants.sync(id(req), actor(req))));

// ── Operación de las instancias que crea el panel
router.post("/tenants/:id/provision/retry", run(async (req) => ({ owner: await provisioning.retryProvision(id(req), actor(req), req.body ?? {}) }), 202));
router.post("/tenants/:id/update", run((req) => provisioning.updateTenantImage(id(req), req.body?.image, actor(req)), 202));
router.post("/instances/update-all", run((req) => provisioning.updateAll(req.body?.image, actor(req)), 202));
router.delete("/tenants/:id", run((req) => provisioning.removeTenant(id(req), { confirmSlug: req.body?.confirmSlug, deleteData: req.body?.deleteData === true }, actor(req)), 202));
router.get("/tenants/:id/backups", run((req) => backups.listBackups(id(req))));
router.post("/tenants/:id/backups", run((req) => backups.manualBackup(id(req), actor(req)), 201));
router.get("/backups/:backupId/download", async (req: Request, res: Response) => {
  try {
    const file = await backups.backupFile(Number(req.params.backupId));
    res.download(file.path, file.name);
  } catch (err: any) {
    res.status(statusFromError(err)).json({ message: err.message });
  }
});
router.delete("/backups/:backupId", run((req) => backups.deleteBackup(Number(req.params.backupId), actor(req))));
router.put("/tenants/:id/owner", run((req) => tenants.upsertOwner(id(req), req.body ?? {}, actor(req))));
router.get("/tenants/:id/instance-env", run((req) => tenants.instanceEnv(id(req), actor(req))));

router.get("/audit", run((req) => audit.list({ tenantId: typeof req.query.tenantId === "string" ? req.query.tenantId : undefined, limit: Number(req.query.limit) || undefined })));

export default router;
