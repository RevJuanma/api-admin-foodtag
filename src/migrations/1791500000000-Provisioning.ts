import { MigrationInterface, QueryRunner } from "typeorm";

/** Aprovisionamiento de instancias: columnas de Tenant y la tabla de respaldos. */
export class Provisioning1791500000000 implements MigrationInterface {
    name = 'Provisioning1791500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tenants" ADD "managed" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "tenants" ADD "provisionStatus" character varying NOT NULL DEFAULT 'NONE'`);
        await queryRunner.query(`ALTER TABLE "tenants" ADD "provisionStep" character varying`);
        await queryRunner.query(`ALTER TABLE "tenants" ADD "provisionError" character varying`);
        await queryRunner.query(`ALTER TABLE "tenants" ADD "provisionedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "tenants" ADD "removedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "tenants" ADD "controlUrl" character varying`);
        await queryRunner.query(`ALTER TABLE "tenants" ADD "image" character varying`);
        await queryRunner.query(`ALTER TABLE "tenants" ADD "instanceRef" jsonb`);
        await queryRunner.query(`ALTER TABLE "tenants" ADD "secretsEnc" text`);
        await queryRunner.query(`CREATE TABLE "backups" ("id" SERIAL NOT NULL, "tenantId" uuid NOT NULL, "kind" character varying NOT NULL, "file" character varying NOT NULL, "sizeBytes" bigint NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_backups" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_backups_tenant" ON "backups" ("tenantId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_backups_tenant"`);
        await queryRunner.query(`DROP TABLE "backups"`);
        for (const c of ["secretsEnc", "instanceRef", "image", "controlUrl", "removedAt", "provisionedAt", "provisionError", "provisionStep", "provisionStatus", "managed"]) {
            await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "${c}"`);
        }
    }
}
