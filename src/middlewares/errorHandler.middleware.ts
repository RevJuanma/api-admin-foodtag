import { Request, Response, NextFunction } from "express";

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ message: "Ruta no encontrada" });
}

/** Último recurso: nada que se escape de un controller muestra el stack ni el detalle del error. */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ message: "JSON inválido" });
    return;
  }
  console.error(err);
  res.status(500).json({ message: "Error interno" });
}
