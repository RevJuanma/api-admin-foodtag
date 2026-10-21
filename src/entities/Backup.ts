import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export type BackupKind = "MANUAL" | "AUTO" | "PRE_REMOVE";

/** Respaldo de la base de un restaurante (archivo `pg_dump -Fc` en BACKUP_DIR). */
@Entity("backups")
export class Backup {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column({ type: "uuid" })
  tenantId!: string;

  @Column({ type: "varchar" })
  kind!: BackupKind;

  /** Nombre del archivo dentro de BACKUP_DIR. */
  @Column()
  file!: string;

  @Column({ type: "bigint", transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  sizeBytes!: number;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
