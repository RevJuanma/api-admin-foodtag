import { assertEnv } from "@/config/env";
import { AppDataSource } from "@/config/database";
import app from "@/app";
import { startBackgroundJobs } from "@/services/monitor.service";

assertEnv();

const PORT = Number(process.env.PORT) || 4000;

AppDataSource.initialize()
  .then(() => {
    console.log("Database connected");
    startBackgroundJobs().catch((err) => console.error("No se pudieron iniciar los procesos de fondo:", err));
    app.listen(PORT, () => console.log(`Admin API running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("Database connection failed:", err);
    process.exit(1);
  });
