import { Client } from "pg";
import { provisioning } from "@/config/env";

const IDENT = /^[a-z0-9_]{1,63}$/;
const assertIdent = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`Identificador de base inválido: ${name}`);
  return `"${name}"`;
};

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const { db } = provisioning();
  const client = new Client({ host: db.host, port: db.port, user: db.user, password: db.password, database: "postgres" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Crea el usuario y la base del restaurante (cada uno con su usuario, que solo es dueño de su base). Idempotente. */
export async function createTenantDatabase(opts: { database: string; dbUser: string; password: string }): Promise<void> {
  const db = assertIdent(opts.database);
  const user = assertIdent(opts.dbUser);
  await withAdmin(async (c) => {
    const role = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [opts.dbUser]);
    // CREATE/ALTER ROLE no admite parámetros: la contraseña se escapa como literal
    const literal = `'${opts.password.replace(/'/g, "''")}'`;
    await c.query(role.rowCount ? `ALTER ROLE ${user} WITH LOGIN PASSWORD ${literal}` : `CREATE ROLE ${user} LOGIN PASSWORD ${literal}`);
    const exists = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [opts.database]);
    if (!exists.rowCount) await c.query(`CREATE DATABASE ${db} OWNER ${user}`);
    await c.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  });
}

/** Borra la base y el usuario del restaurante. */
export async function dropTenantDatabase(opts: { database: string; dbUser: string }): Promise<void> {
  const db = assertIdent(opts.database);
  const user = assertIdent(opts.dbUser);
  await withAdmin(async (c) => {
    await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [opts.database]);
    await c.query(`DROP DATABASE IF EXISTS ${db}`);
    await c.query(`DROP ROLE IF EXISTS ${user}`);
  });
}
