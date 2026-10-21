import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const key = () => createHash("sha256").update(process.env.ADMIN_SECRET_KEY ?? "").digest();

/** Cifra un texto con AES-256-GCM. Devuelve `iv.tag.datos` en base64. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Token aleatorio para el canal de la plataforma de una instancia (48 hex = 192 bits). */
export const generateToken = (): string => randomBytes(24).toString("hex");
