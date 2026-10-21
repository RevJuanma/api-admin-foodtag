import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";

/** Lo que la instancia del restaurante informó en la última sincronización. */
export interface InstanceSnapshot {
  version: string | null;
  modulesLoaded: string[];
  users: number;
  /** Módulos contratados que la instancia no tiene cargados (hay que redesplegarla con ellos). */
  modulesMissing: string[];
  suspended: boolean;
}

/**
 * Un restaurante cliente. Cada uno corre en su propia instancia de la API; acá se guarda cómo hablarle y el estado
 * deseado (módulos contratados, suspensión), que el panel empuja a la instancia en cada cambio y al sincronizar.
 */
@Entity("tenants")
export class Tenant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ unique: true })
  slug!: string;

  @Column()
  name!: string;

  /** URL base de la API de la instancia, sin barra final (ej. https://rincon.foodtag.app). */
  @Column()
  instanceUrl!: string;

  /** Token del canal de la plataforma (PLATFORM_ADMIN_TOKEN de la instancia), cifrado. Nunca se devuelve. */
  @Column({ type: "text" })
  adminTokenEnc!: string;

  @Column({ default: "America/Argentina/Buenos_Aires" })
  timezone!: string;

  /** Módulos contratados, ya completados con sus dependencias. */
  @Column({ type: "text", array: true, default: "{}" })
  modules!: string[];

  @Column({ type: "timestamptz", nullable: true })
  suspendedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  suspendedReason!: string | null;

  @Column({ type: "varchar", nullable: true })
  contactName!: string | null;

  @Column({ type: "varchar", nullable: true })
  contactEmail!: string | null;

  @Column({ type: "text", nullable: true })
  notes!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  lastSyncAt!: Date | null;

  /** null = nunca se sincronizó. */
  @Column({ type: "boolean", nullable: true })
  lastSyncOk!: boolean | null;

  @Column({ type: "varchar", nullable: true })
  lastSyncError!: string | null;

  @Column({ type: "jsonb", nullable: true })
  instanceSnapshot!: InstanceSnapshot | null;

  // ── Aprovisionamiento (instancias que crea y administra el panel) ──
  /** true si el panel creó la instancia (y puede actualizarla, respaldarla y darla de baja); false si solo se registró una existente. */
  @Column({ default: false })
  managed!: boolean;

  /** NONE (registrada a mano) | PROVISIONING | READY | FAILED | UPDATING | REMOVING | REMOVED */
  @Column({ default: "NONE" })
  provisionStatus!: string;

  /** Paso actual (o en el que falló) del aprovisionamiento. */
  @Column({ type: "varchar", nullable: true })
  provisionStep!: string | null;

  @Column({ type: "varchar", nullable: true })
  provisionError!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  provisionedAt!: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  removedAt!: Date | null;

  /** Dirección con la que el panel le habla a la instancia, si no es la pública (ej. http://127.0.0.1:49153). */
  @Column({ type: "varchar", nullable: true })
  controlUrl!: string | null;

  /** Imagen que corre la instancia. */
  @Column({ type: "varchar", nullable: true })
  image!: string | null;

  /** Datos de infraestructura de la instancia: contenedor, base y usuario de base. */
  @Column({ type: "jsonb", nullable: true })
  instanceRef!: { container: string; database: string; dbUser: string } | null;

  /** Secretos de la instancia (contraseña de la base y secreto de sesión), cifrados: hacen falta para recrear el contenedor. */
  @Column({ type: "text", nullable: true })
  secretsEnc!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
