import "reflect-metadata";
import { DataSource } from "typeorm";
import dotenv from "dotenv";
import { AdminUser } from "@/entities/AdminUser";
import { Tenant } from "@/entities/Tenant";
import { AuditLog } from "@/entities/AuditLog";
import { Backup } from "@/entities/Backup";

dotenv.config();

export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USER || "postgres",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "foodtag_admin",
  synchronize: process.env.NODE_ENV === "development",
  logging: false,
  entities: [AdminUser, Tenant, AuditLog, Backup],
  migrations: [__filename.endsWith(".ts") ? "src/migrations/**/*.ts" : "dist/migrations/**/*.js"],
});
