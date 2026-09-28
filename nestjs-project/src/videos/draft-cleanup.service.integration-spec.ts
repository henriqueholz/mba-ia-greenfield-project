import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { DRAFT_TTL_MS, DraftCleanupService } from './draft-cleanup.service';
import { Video, VideoStatus } from './entities/video.entity';

describe('DraftCleanupService (integration)', () => {
  let moduleRef: TestingModule;
  let service: DraftCleanupService;
  let storage: StorageService;
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig],
        }),
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [databaseConfig.KEY],
          useFactory: (db: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres' as const,
            host: db.host,
            port: db.port,
            username: db.username,
            password: db.password,
            database: db.name,
            autoLoadEntities: true,
            synchronize: false,
          }),
        }),
        TypeOrmModule.forFeature([Video, Channel, User]),
        StorageModule,
      ],
      providers: [DraftCleanupService],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(DraftCleanupService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  let counter = 0;
  async function seedVideo(
    status: VideoStatus,
    ageMs: number,
  ): Promise<Video> {
    const user = await users.save(
      users.create({ email: `clean_${++counter}@example.com`, password: 'h' }),
    );
    const channel = await channels.save(
      channels.create({
        name: `c${counter}`,
        nickname: `clean_${counter}`,
        user_id: user.id,
      }),
    );
    const publicId = `clean${counter}xy0`.slice(0, 11);
    const key = `videos/${publicId}/original`;
    await storage.putObject(key, Buffer.from('x'), 'video/mp4');
    const video = await videos.save(
      videos.create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'C',
        status,
        storage_key: key,
      }),
    );
    // Backdate created_at to simulate age.
    await dataSource.query('UPDATE videos SET created_at = $1 WHERE id = $2', [
      new Date(Date.now() - ageMs),
      video.id,
    ]);
    return video;
  }

  beforeEach(async () => {
    await dataSource.query('DELETE FROM videos');
    await dataSource.query('DELETE FROM channels');
    await dataSource.query('DELETE FROM users');
  });

  it('removes a stale draft past the TTL', async () => {
    const stale = await seedVideo(VideoStatus.DRAFT, DRAFT_TTL_MS + 60_000);

    const removed = await service.cleanupStaleDrafts();

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await videos.findOne({ where: { id: stale.id } })).toBeNull();
  });

  it('keeps recent drafts and non-draft videos', async () => {
    const freshDraft = await seedVideo(VideoStatus.DRAFT, 60_000);
    const readyOld = await seedVideo(VideoStatus.READY, DRAFT_TTL_MS + 60_000);

    await service.cleanupStaleDrafts();

    expect(await videos.findOne({ where: { id: freshDraft.id } })).not.toBeNull();
    expect(await videos.findOne({ where: { id: readyOld.id } })).not.toBeNull();
  });
});
