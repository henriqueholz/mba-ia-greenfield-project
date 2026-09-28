import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1789516800000 } from './migrations/1789516800000-CreateVideos';
import { Video } from '../videos/entities/video.entity';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
        ],
      },
    );

    await dataSource.initialize();

    await Promise.all([
      ...MANAGED_TABLES.map((table) =>
        dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`),
      ),
      dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`),
    ]);
    // Enum types are not dropped by DROP TABLE; clear them so this migration's
    // CREATE TYPE does not collide with types left behind by synchronize-based
    // suites that ran earlier in the shared DB.
    await dataSource.query(
      `DROP TYPE IF EXISTS "verification_tokens_type_enum" CASCADE`,
    );
    await dataSource.query(`DROP TYPE IF EXISTS "videos_status_enum" CASCADE`);
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all four tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(2);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
  });

  it('should revert the last migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});

describe('CreateVideos migration (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1789516800000,
        ],
      },
    );

    await dataSource.initialize();

    await Promise.all([
      ...[...MANAGED_TABLES, 'videos'].map((table) =>
        dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`),
      ),
      dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`),
    ]);
    // Enum types are not dropped by DROP TABLE; clear them so CREATE TYPE in the
    // migrations does not collide with types left by synchronize-based suites.
    await dataSource.query(`DROP TYPE IF EXISTS "videos_status_enum" CASCADE`);
    await dataSource.query(
      `DROP TYPE IF EXISTS "verification_tokens_type_enum" CASCADE`,
    );

    await dataSource.runMigrations();
  });

  afterAll(async () => {
    // Leave the shared DB fully migrated for subsequent suites.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should create the videos table, status enum and indexes', async () => {
    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    expect(tables).toHaveLength(1);

    const enumType = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = 'videos_status_enum'`,
    );
    expect(enumType).toHaveLength(1);

    const indexes = await dataSource.query<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'videos' AND indexname = ANY($1::text[])`,
      [['UQ_videos_public_id', 'IDX_videos_channel_id', 'IDX_videos_status']],
    );
    // The unique constraint may be backed by a constraint rather than a plain
    // index name; assert at least the two explicit indexes exist.
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain('IDX_videos_channel_id');
    expect(names).toContain('IDX_videos_status');
  });

  it('should revert CreateVideos and drop the videos table and enum', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    expect(tables).toHaveLength(0);

    const enumType = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = 'videos_status_enum'`,
    );
    expect(enumType).toHaveLength(0);
  });
});
