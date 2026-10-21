// Aprovisionamiento de punta a punta contra Docker real (admin API con PROVISIONER=docker ya levantada).
//   ADMIN=http://localhost:4999/api/v1 ADMIN_EMAIL=... ADMIN_PASSWORD=... node tests/e2e/provisioning.mjs
import { execFileSync } from "node:child_process";

const ADMIN = process.env.ADMIN ?? "http://localhost:4999/api/v1";
const lines = [];
let failed = false;
const check = (name, ok, extra = "") => { lines.push(`${ok ? "OK   " : "FALLA"} ${name} ${extra}`.trimEnd()); if (!ok) failed = true; };
const call = async (base, method, path, { token, body, headers } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
};
const admin = (method, path, token, body) => call(ADMIN, method, path, { token, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const instanceBase = (slug) => `http://127.0.0.1:${docker("port", `foodtag-${slug}`, "3000/tcp").split("\n")[0].split(":").pop()}`;

async function waitStatus(T, id, wanted, max = 240) {
  for (let i = 0; i < max; i++) {
    const { data } = await admin("GET", `/tenants/${id}`, T);
    const s = data?.provision?.status;
    if (wanted.includes(s)) return data;
    await sleep(1000);
  }
  return (await admin("GET", `/tenants/${id}`, T)).data;
}

let r = await admin("POST", "/auth/login", null, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
const T = r.data?.token;
check("login", !!T);
r = await admin("GET", "/system", T);
check("el aprovisionamiento está habilitado", r.status === 200 && r.data?.provisioning === true, JSON.stringify(r.data));

// ── validaciones previas
r = await admin("POST", "/tenants", T, { name: "Admin", slug: "admin", ownerEmail: "a@b.com" });
check("slug reservado", r.status === 400, r.data?.message);
r = await admin("POST", "/tenants", T, { name: "Sin dueño", slug: "sin-dueno" });
check("falta el email del dueño", r.status === 400, r.data?.message);

// ── alta
const slug = "prueba-prov";
r = await admin("POST", "/tenants", T, { name: "Prueba Prov", slug, modules: ["payments"], ownerEmail: "dueno@prueba.com", contactName: "Dueño" });
check("alta responde 202 PROVISIONING", r.status === 202 && r.data.tenant.provision.status === "PROVISIONING", `${r.status} ${r.data?.message ?? ""}`);
const id = r.data?.tenant?.id;
const tempPassword = r.data?.owner?.password;
check("contraseña temporal del dueño", typeof tempPassword === "string" && tempPassword.length >= 10);
check("la dirección pública es válida", /foodtag\.com|localhost:\d+/.test(r.data?.tenant?.instanceUrl ?? ""), r.data?.tenant?.instanceUrl);
r = await admin("POST", "/tenants", T, { name: "Otra", slug, ownerEmail: "x@y.com" });
check("slug repetido", r.status === 409, r.data?.message);

let t = await waitStatus(T, id, ["READY", "FAILED"]);
check("queda READY", t?.provision?.status === "READY", `${t?.provision?.status} ${t?.provision?.error ?? ""}`);
check("estado ACTIVE y sincronizado", t?.status === "ACTIVE", t?.status);
check("módulos con dependencias", t?.modules?.join() === "zones,products,accounts,payments", t?.modules?.join());

if (t?.provision?.status === "READY") {
  const base = instanceBase(slug);
  r = await call(base, "GET", "/health");
  check("la instancia responde /health", r.status === 200);
  if (new URL(t.instanceUrl).hostname === "localhost") {
    const page = await fetch(t.instanceUrl + "/");
    const html = await page.text();
    check("la dirección pública abre la web de la instancia", page.status === 200 && html.includes("/instance-config.js"), `${t.instanceUrl} ${page.status}`);
    check("la instancia informa su slug", (await (await fetch(t.instanceUrl + "/instance-config.js")).text()).includes(`"${slug}"`));
  }
  r = await call(base + "/api/v1", "POST", "/auth/login", { body: { email: "dueno@prueba.com", password: tempPassword } });
  check("el dueño entra con la contraseña temporal", r.status === 200 && !!r.data?.token, `${r.status}`);
  const ownerToken = r.data?.token;
  check("el dueño tiene los módulos contratados", (await call(base + "/api/v1", "GET", "/accounts", { token: ownerToken })).status === 200);
  check("el token ni la contraseña se filtran en la vista", !JSON.stringify(t).includes(tempPassword));
  check("el contenedor existe con su base propia", docker("ps", "--filter", `name=foodtag-${slug}`, "--format", "{{.Names}}") === `foodtag-${slug}`);

  // ── suspender se propaga a la instancia aprovisionada
  r = await admin("POST", `/tenants/${id}/suspend`, T, { reason: "Prueba" });
  check("suspender", r.status === 200);
  r = await call(base + "/api/v1", "POST", "/auth/login", { body: { email: "dueno@prueba.com", password: tempPassword } });
  check("el login queda bloqueado", r.status === 403);
  r = await admin("POST", `/tenants/${id}/resume`, T);
  check("reanudar", r.status === 200);

  // ── respaldos
  r = await admin("POST", `/tenants/${id}/backups`, T);
  check("respaldo manual", r.status === 201 && r.data?.sizeBytes > 0, `${r.status} ${r.data?.message ?? ""}`);
  const backupId = r.data?.id;
  r = await admin("GET", `/tenants/${id}/backups`, T);
  check("lista de respaldos", r.status === 200 && r.data.length >= 1);
  const dl = await fetch(`${ADMIN}/backups/${backupId}/download`, { headers: { authorization: `Bearer ${T}` } });
  const bytes = Buffer.from(await dl.arrayBuffer());
  check("descarga del respaldo (formato pg_dump)", dl.status === 200 && bytes.subarray(0, 5).toString() === "PGDMP", `${dl.status} ${bytes.length}B`);

  // ── actualización (misma imagen: se recrea el contenedor)
  r = await admin("POST", `/tenants/${id}/update`, T, {});
  check("actualizar responde 202", r.status === 202, r.data?.message);
  await sleep(1500);
  t = await waitStatus(T, id, ["READY", "FAILED"]);
  check("tras actualizar queda READY", t?.provision?.status === "READY", t?.provision?.error ?? "");
  r = await call(instanceBase(slug), "GET", "/health");
  check("la instancia sigue sana tras actualizar", r.status === 200);
  r = await call(instanceBase(slug) + "/api/v1", "POST", "/auth/login", { body: { email: "dueno@prueba.com", password: tempPassword } });
  check("los datos sobreviven (el dueño sigue entrando)", r.status === 200);

  // ── actualización a una imagen inexistente → vuelve la anterior
  r = await admin("POST", `/tenants/${id}/update`, T, { image: "foodtag-api:no-existe" });
  check("actualizar a imagen inexistente responde 202", r.status === 202, r.data?.message);
  await sleep(1500);
  t = await waitStatus(T, id, ["READY", "FAILED"], 120);
  check("rollback: sigue READY con el aviso", t?.provision?.status === "READY" && !!t?.provision?.error, `${t?.provision?.status} ${t?.provision?.error ?? ""}`);
  r = await call(instanceBase(slug), "GET", "/health");
  check("rollback: la instancia anterior sigue andando", r.status === 200);
}

// ── baja
r = await admin("DELETE", `/tenants/${id}`, T, { confirmSlug: "otro", deleteData: true });
check("baja sin confirmar el slug", r.status === 400, r.data?.message);
r = await admin("DELETE", `/tenants/${id}`, T, { confirmSlug: slug, deleteData: true });
check("baja responde 202", r.status === 202, r.data?.message);
await sleep(1500);
for (let i = 0; i < 90; i++) { const x = (await admin("GET", `/tenants?status=REMOVED`, T)).data; if (x?.some?.((q) => q.id === id)) break; await sleep(1000); }
r = await admin("GET", "/tenants", T);
check("el restaurante dado de baja deja de listarse", !r.data.some((q) => q.id === id));
let gone = false; try { docker("inspect", `foodtag-${slug}`); } catch { gone = true; }
check("el contenedor se borró", gone);
const dbs = docker("exec", process.env.PG_CONTAINER ?? "api-foodtag-db-1", "psql", "-U", "postgres", "-tAc", "SELECT datname FROM pg_database WHERE datname='foodtag_prueba_prov'");
check("la base del restaurante se borró", dbs === "");
r = await admin("GET", `/tenants/${id}/backups`, T);
check("queda el respaldo previo a la baja", r.status === 200 && r.data.some((b) => b.kind === "PRE_REMOVE"), JSON.stringify(r.data?.map?.((b) => b.kind)));

console.log(lines.join("\n"));
console.log(failed ? "\nHAY FALLAS" : "\nTODO OK");
process.exit(failed ? 1 : 0);
