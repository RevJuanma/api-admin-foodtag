/** Crea un administrador de la plataforma:  npm run create-admin -- <email> <contraseña> [nombre] */
import { assertEnv } from "../src/config/env";
import { AppDataSource } from "../src/config/database";
import { createAdmin } from "../src/services/auth.service";

(async () => {
  const [email, password, name] = process.argv.slice(2);
  if (!email || !password) {
    console.error("Uso: npm run create-admin -- <email> <contraseña> [nombre]");
    process.exit(1);
  }
  assertEnv();
  await AppDataSource.initialize();
  const admin = await createAdmin(email, password, name);
  console.log(`Administrador creado: ${admin.email}`);
  await AppDataSource.destroy();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
