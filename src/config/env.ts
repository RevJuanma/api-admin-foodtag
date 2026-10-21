import dotenv from "dotenv";

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";

/** Falla al arrancar si faltan los secretos; en producción exige que sean largos. */
export function assertEnv(): void {
  for (const key of ["JWT_SECRET", "ADMIN_SECRET_KEY"]) {
    const value = process.env[key];
    if (!value) throw new Error(`Falta ${key} en el entorno`);
    if (value.length < 32) {
      if (isProduction) throw new Error(`${key} tiene que tener al menos 32 caracteres`);
      console.warn(`${key} tiene menos de 32 caracteres: usar uno más largo en producción`);
    }
  }
  if (isProduction && !process.env.CORS_ORIGINS) console.warn("CORS_ORIGINS no está definido: la API acepta pedidos desde cualquier origen");
}

export const corsOrigins = (): string[] | undefined => {
  const list = process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
  return list?.length ? list : undefined;
};

/** Las instancias deben estar en https, salvo que se permita http a propósito (desarrollo o red privada). */
export const insecureInstancesAllowed = (): boolean => process.env.ALLOW_INSECURE_INSTANCES === "true";

/**
 * Configuración del aprovisionamiento de instancias (ver README). Con `PROVISIONER=docker` el panel crea y administra la
 * instancia de cada restaurante; sin eso solo se pueden registrar instancias que ya existen.
 */
export function provisioning() {
  const env = process.env;
  const scheme = env.INSTANCE_SCHEME === "http" ? "http" : "https";
  return {
    enabled: env.PROVISIONER === "docker",
    /** `host`: cada restaurante en su subdominio (detrás de un proxy); `port`: cada uno en su propio puerto de este equipo (desarrollo, sin DNS ni proxy). */
    routing: env.INSTANCE_ROUTING === "port" ? ("port" as const) : ("host" as const),
    /** Primer puerto que se asigna con `INSTANCE_ROUTING=port`. */
    portStart: Number(env.INSTANCE_PORT_START) || 4100,
    baseDomain: env.INSTANCE_BASE_DOMAIN || "foodtag.com",
    scheme,
    /** Puerto público del proxy, si no es el estándar (ej. 8088 en desarrollo). */
    publicPort: env.INSTANCE_PUBLIC_PORT || "",
    image: env.INSTANCE_IMAGE || "foodtag-api:local",
    network: env.INSTANCE_NETWORK || "foodtag",
    entrypoint: env.INSTANCE_ENTRYPOINT || (scheme === "https" ? "websecure" : "web"),
    certResolver: env.INSTANCE_CERT_RESOLVER || "",
    /** Carpeta del servidor con el build de la web de gestión (`npm run build:instance` en app-foodtag): se monta en cada instancia. */
    webDir: env.INSTANCE_WEB_DIR || "",
    /** `port`: el panel habla con la instancia por un puerto publicado en 127.0.0.1; `network`: por el nombre del contenedor en la red de Docker. */
    controlMode: env.INSTANCE_CONTROL_MODE === "network" ? "network" : "port",
    db: {
      host: env.TENANT_DB_HOST || "localhost",
      port: Number(env.TENANT_DB_PORT) || 5432,
      user: env.TENANT_DB_USER || "postgres",
      password: env.TENANT_DB_PASS || "",
      /** Cómo llegan las instancias (dentro de la red de Docker) al Postgres. */
      internalHost: env.TENANT_DB_INTERNAL_HOST || "db",
      internalPort: Number(env.TENANT_DB_INTERNAL_PORT) || 5432,
      /** Contenedor del Postgres: de ahí se hacen los respaldos (`docker exec … pg_dump`). */
      container: env.TENANT_DB_CONTAINER || "",
    },
    backupDir: env.BACKUP_DIR || "./backups",
    backupRetentionDays: Number(env.BACKUP_RETENTION_DAYS) || 14,
    /** Hora local (0-23) del respaldo diario automático; -1 lo apaga. */
    backupHour: env.BACKUP_HOUR === undefined ? 3 : Number(env.BACKUP_HOUR),
    monitorSeconds: Number(env.MONITOR_INTERVAL_SECONDS) || 120,
    /** Cuánto se espera a que una instancia nueva responda /health (la primera vez crea el esquema de su base). */
    startTimeoutSeconds: Number(env.INSTANCE_START_TIMEOUT_SECONDS) || 120,
  };
}
