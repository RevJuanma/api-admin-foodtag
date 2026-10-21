import "reflect-metadata";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import routes from "@/routes";
import { corsOrigins } from "@/config/env";
import { errorHandler, notFoundHandler } from "@/middlewares/errorHandler.middleware";

const app = express();

app.use(helmet());
app.use(cors({ origin: corsOrigins() ?? true }));
app.use(express.json({ limit: "100kb" }));

app.use("/api/v1", routes);
app.get("/health", (_req, res) => void res.json({ status: "ok" }));

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
