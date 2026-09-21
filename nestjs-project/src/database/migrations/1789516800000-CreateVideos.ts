import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1789516800000 implements MigrationInterface {
  name = 'CreateVideos1789516800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "public_id" character varying(16) NOT NULL,
        "channel_id" uuid NOT NULL,
        "title" character varying(255) NOT NULL,
        "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft',
        "storage_key" character varying(512) NOT NULL,
        "thumbnail_key" character varying(512),
        "upload_id" character varying(512),
        "original_filename" character varying(255),
        "content_type" character varying(128),
        "size_bytes" bigint,
        "duration_seconds" integer,
        "width" integer,
        "height" integer,
        "metadata" jsonb,
        "failure_reason" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_videos_public_id" UNIQUE ("public_id"),
        CONSTRAINT "PK_videos" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_id" ON "videos" ("channel_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_status" ON "videos" ("status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_videos_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_videos_channel_id"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_channel_id"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
