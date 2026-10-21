import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1791400000000 implements MigrationInterface {
    name = 'Init1791400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE TABLE "admin_users" ("id" SERIAL NOT NULL, "email" character varying NOT NULL, "name" character varying, "password" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_admin_users_email" UNIQUE ("email"), CONSTRAINT "PK_admin_users" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "tenants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "slug" character varying NOT NULL, "name" character varying NOT NULL, "instanceUrl" character varying NOT NULL, "adminTokenEnc" text NOT NULL, "timezone" character varying NOT NULL DEFAULT 'America/Argentina/Buenos_Aires', "modules" text array NOT NULL DEFAULT '{}', "suspendedAt" TIMESTAMP WITH TIME ZONE, "suspendedReason" character varying, "contactName" character varying, "contactEmail" character varying, "notes" text, "lastSyncAt" TIMESTAMP WITH TIME ZONE, "lastSyncOk" boolean, "lastSyncError" character varying, "instanceSnapshot" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_tenants_slug" UNIQUE ("slug"), CONSTRAINT "PK_tenants" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "audit_logs" ("id" SERIAL NOT NULL, "adminId" integer, "adminEmail" character varying, "tenantId" uuid, "tenantName" character varying, "action" character varying NOT NULL, "detail" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_audit_logs_tenant" ON "audit_logs" ("tenantId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_audit_logs_tenant"`);
        await queryRunner.query(`DROP TABLE "audit_logs"`);
        await queryRunner.query(`DROP TABLE "tenants"`);
        await queryRunner.query(`DROP TABLE "admin_users"`);
    }
}
