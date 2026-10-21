import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { AppDataSource } from "@/config/database";
import { AdminUser } from "@/entities/AdminUser";
import { record } from "@/services/audit.service";

const DUMMY_HASH = bcrypt.hashSync("foodtag-admin-dummy", 12);
const users = () => AppDataSource.getRepository(AdminUser);

export interface AdminPayload {
  id: number;
  email: string;
  role: "superadmin";
}

export async function login(email: string, password: string) {
  const user = await users().findOneBy({ email: email.trim().toLowerCase() });
  // Se compara siempre contra un hash para que el tiempo de respuesta no delate si el email existe
  const valid = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
  if (!user || !valid) throw Object.assign(new Error("Credenciales inválidas"), { status: 401 });

  const payload: AdminPayload = { id: user.id, email: user.email, role: "superadmin" };
  const expiresIn = (process.env.JWT_EXPIRES_IN || "8h") as jwt.SignOptions["expiresIn"];
  const token = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn, algorithm: "HS256" });
  await record(payload, "auth.login", null);
  return { token, user: { id: user.id, email: user.email, name: user.name, role: payload.role } };
}

export async function createAdmin(email: string, password: string, name?: string) {
  if (password.length < 10) throw new Error("La contraseña tiene que tener al menos 10 caracteres");
  const normalized = email.trim().toLowerCase();
  if (await users().findOneBy({ email: normalized })) throw new Error("Ya existe un administrador con ese email");
  const saved = await users().save(users().create({ email: normalized, name: name ?? null, password: await bcrypt.hash(password, 12) }));
  return { id: saved.id, email: saved.email };
}
