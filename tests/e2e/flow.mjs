// Recorrido del panel contra una API de administración y una instancia de restaurante levantadas.
//   ADMIN=http://localhost:4999/api/v1 INSTANCE=http://localhost:3995 INSTANCE_TOKEN=<PLATFORM_ADMIN_TOKEN> \
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... node tests/e2e/flow.mjs
const ADMIN = process.env.ADMIN ?? "http://localhost:4999/api/v1";
const INSTANCE = process.env.INSTANCE ?? "http://localhost:3995";
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN;
const lines = [];
let failed = false;

const call = async (base, method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const admin = (method, path, token, body) => call(ADMIN, method, path, { token, body });
const inst = (method, path, token, body) => call(INSTANCE + "/api/v1", method, path, { token, body });
const check = (name, ok, extra = "") => { lines.push(`${ok ? "OK   " : "FALLA"} ${name} ${extra}`.trimEnd()); if (!ok) failed = true; };

// ── sesión
let r = await admin("POST", "/auth/login", null, { email: process.env.ADMIN_EMAIL, password: "incorrecta" });
check("login con contraseña incorrecta", r.status === 401);
r = await admin("POST", "/auth/login", null, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
check("login", r.status === 200 && !!r.data?.token);
const T = r.data?.token;
check("sin sesión no entra", (await admin("GET", "/tenants")).status === 401);
r = await admin("GET", "/modules", T);
check("catálogo de módulos", r.status === 200 && r.data.length === 10, `n=${r.data?.length}`);

// ── alta
const body = { name: "El Rincón", slug: "el-rincon", instanceUrl: INSTANCE + "/", adminToken: INSTANCE_TOKEN, modules: ["payments"], contactEmail: "dueno@rincon.com" };
r = await admin("POST", "/tenants", T, body);
check("alta del restaurante", r.status === 201 && r.data.tenant.status === "ACTIVE", `status=${r.data?.tenant?.status} err=${r.data?.tenant?.lastSyncError ?? ""}`);
const tenant = r.data?.tenant;
check("módulos con sus dependencias", tenant?.modules.join() === "zones,products,accounts,payments", tenant?.modules.join());
check("la instancia informa su estado", tenant?.instance?.modulesLoaded?.length === 10 && tenant.instance.suspended === false);
check("la URL se normaliza (sin barra final)", tenant?.instanceUrl === INSTANCE);
check("el token nunca se devuelve", !JSON.stringify(r.data.tenant).includes(INSTANCE_TOKEN));
r = await admin("POST", "/tenants", T, body); check("slug repetido", r.status === 409, r.data?.message);
r = await admin("POST", "/tenants", T, { ...body, slug: "Mal Slug" }); check("slug inválido", r.status === 400);
r = await admin("POST", "/tenants", T, { ...body, slug: "otro", instanceUrl: "no es una url" }); check("URL inválida", r.status === 400);
r = await admin("POST", "/tenants", T, { ...body, slug: "otro", modules: ["inventado"] }); check("módulo desconocido", r.status === 400, r.data?.message);

// ── token generado + instancia que rechaza el token
r = await admin("POST", "/tenants", T, { name: "Token Malo", slug: "token-malo", instanceUrl: INSTANCE, modules: ["zones"] });
check("sin token: se genera uno para cargar en la instancia", r.status === 201 && r.data.adminToken?.length === 48 && r.data.env.includes("PLATFORM_ADMIN_TOKEN="));
check("la instancia rechaza el token generado", r.data?.tenant?.status === "UNREACHABLE", r.data?.tenant?.lastSyncError);

// ── dueño + login real en la instancia
r = await admin("PUT", `/tenants/${tenant.id}/owner`, T, { email: "dueno@rincon.com", password: "contraseña-larga-1", name: "Dueño" });
check("alta del dueño en la instancia", r.status === 200 && r.data.created === true);
r = await inst("POST", "/auth/login", null, { email: "dueno@rincon.com", password: "contraseña-larga-1" });
check("el dueño entra a su instancia", r.status === 200);
const ownerToken = r.data?.token;
check("sesión con los módulos contratados", (await inst("GET", "/accounts", ownerToken)).status === 200);

// ── suspender / reanudar
r = await admin("POST", `/tenants/${tenant.id}/suspend`, T, { reason: "Falta de pago" });
check("suspender", r.status === 200 && r.data.status === "SUSPENDED" && r.data.suspendedReason === "Falta de pago" && r.data.inSync === true);
check("la sesión abierta del dueño se corta", (await inst("GET", "/accounts", ownerToken)).status === 403);
r = await inst("POST", "/auth/login", null, { email: "dueno@rincon.com", password: "contraseña-larga-1" });
check("no puede iniciar sesión suspendido", r.status === 403, r.data?.message);
r = await admin("POST", `/tenants/${tenant.id}/resume`, T);
check("reanudar", r.status === 200 && r.data.status === "ACTIVE");
check("la sesión vuelve a funcionar", (await inst("GET", "/accounts", ownerToken)).status === 200);

// ── cambiar lo contratado
r = await admin("PATCH", `/tenants/${tenant.id}`, T, { modules: ["comandas", "payments"], name: "El Rincón Bar" });
check("cambia módulos y nombre", r.status === 200 && r.data.modules.includes("comandas") && r.data.name === "El Rincón Bar" && r.data.inSync);
r = await inst("GET", "/accounts", ownerToken); check("la sesión anterior pide volver a entrar", r.status === 401 && r.data?.code === "SESSION_OUTDATED");
r = await inst("POST", "/auth/login", null, { email: "dueno@rincon.com", password: "contraseña-larga-1" });
check("con la sesión nueva ya usa comandas", (await inst("GET", "/comandas/board", r.data?.token)).status === 200);

// ── instancia caída: el cambio queda guardado y se reintenta
const down = (await admin("POST", "/tenants", T, { name: "Caído", slug: "caido", instanceUrl: "http://localhost:1", adminToken: "x".repeat(40), modules: ["zones"] })).data?.tenant;
check("instancia caída", down?.status === "UNREACHABLE" && !down?.inSync, down?.lastSyncError);
r = await admin("PATCH", `/tenants/${down.id}`, T, { notes: "pendiente de configurar" });
check("el cambio se guarda aunque la instancia no responda", r.status === 200 && r.data.notes === "pendiente de configurar" && r.data.status === "UNREACHABLE");

// ── listado, configuración y auditoría
r = await admin("GET", "/tenants?search=rinc", T); check("búsqueda", r.status === 200 && r.data.length === 1 && r.data[0].slug === "el-rincon");
r = await admin("GET", "/tenants?status=UNREACHABLE", T); check("filtro por estado", r.data.length === 2, `n=${r.data.length}`);
r = await admin("GET", `/tenants/${tenant.id}/instance-env`, T); check("configuración de la instancia", r.status === 200 && r.data.env.includes(INSTANCE_TOKEN) && r.data.env.includes("ENABLED_MODULES=zones,products,accounts,comandas,payments"));
r = await admin("GET", `/audit?tenantId=${tenant.id}`, T);
const actions = new Set(r.data?.map((a) => a.action));
check("auditoría", ["tenant.create", "tenant.sync", "tenant.suspend", "tenant.resume", "tenant.modules", "tenant.env.view", "tenant.owner.create"].every((a) => actions.has(a)), [...actions].join(","));
check("la auditoría no guarda contraseñas ni tokens", !JSON.stringify(r.data).includes("contraseña-larga") && !JSON.stringify(r.data).includes(INSTANCE_TOKEN));

console.log(lines.join("\n"));
process.exit(failed ? 1 : 0);
