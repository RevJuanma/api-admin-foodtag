import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

/** Persona que administra la plataforma. */
@Entity("admin_users")
export class AdminUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  email!: string;

  @Column({ type: "varchar", nullable: true })
  name!: string | null;

  @Column()
  password!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
