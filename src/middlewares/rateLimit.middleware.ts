import { rateLimit } from "express-rate-limit";

/** Frena la fuerza bruta sobre el login: 10 intentos cada 15 minutos por IP. */
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Demasiados intentos. Probá de nuevo en unos minutos" },
});
