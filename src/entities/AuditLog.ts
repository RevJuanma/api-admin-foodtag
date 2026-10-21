import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/** Registro de lo que hace cada administrador: quién, cuándo, sobre qué restaurante y con qué datos. */
@Entity("audit_logs")
export class AuditLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int", nullable: true })
  adminId!: number | null;

  @Column({ type: "varchar", nullable: true })
  adminEmail!: string | null;

  @Index()
  @Column({ type: "uuid", nullable: true })
  tenantId!: string | null;

  /** Nombre del restaurante al momento de la acción (sobrevive a que se renombre). */
  @Column({ type: "varchar", nullable: true })
  tenantName!: string | null;

  @Column()
  action!: string;

  @Column({ type: "jsonb", nullable: true })
  detail!: Record<string, unknown> | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
