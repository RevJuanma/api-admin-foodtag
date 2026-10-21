import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { AdminPayload } from "@/services/auth.service";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ message: "Token requerido" });
    return;
  }
  try {
    req.admin = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET!, { algorithms: ["HS256"] }) as AdminPayload;
    next();
  } catch {
    res.status(401).json({ message: "Sesión inválida o vencida" });
  }
}
