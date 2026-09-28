import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { MediaService } from './media.service';
import type { ProcessVideoJobData } from './video.processor';
import { VideoProcessor } from './video.processor';

const execFileAsync = promisify(execFile);

function fakeJob(
  videoId: string,
  extra: Partial<Job> = {},
): Job<ProcessVideoJobData> {
  return {
    data: { videoId },
    opts: { attempts: 3 },
    attemptsMade: 0,
    ...extra,
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessor (integration, real DB+MinIO+ffmpeg)', () => {
  let moduleRef: TestingModule;
  let processor: VideoProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let dir: string;
  let sample: Buffer;

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
      providers: [VideoProcessor, MediaService],
    }).compile();
    await moduleRef.init();

    processor = moduleRef.get(VideoProcessor);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);

    dir = await mkdtemp(join(tmpdir(), 'proc-test-'));
    const samplePath = join(dir, 'sample.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=128x72:rate=10',
      '-pix_fmt',
      'yuv420p',
      samplePath,
    ]);
    sample = await readFile(samplePath);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await moduleRef.close();
  });

  let counter = 0;
  async function seedVideo(status: VideoStatus, body: Buffer): Promise<Video> {
    const user = await users.save(
      users.create({
        email: `proc_${++counter}@example.com`,
        password: 'h',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: `c${counter}`,
        nickname: `proc_${counter}`,
        user_id: user.id,
      }),
    );
    const publicId = `proc${counter}pub`.slice(0, 11);
    const key = `videos/${publicId}/original`;
    await storage.putObject(key, body, 'video/mp4');
    return videos.save(
      videos.create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'Proc',
        status,
        storage_key: key,
      }),
    );
  }

  beforeEach(async () => {
    await dataSource.query('DELETE FROM videos');
    await cleanAllTables(dataSource);
  });

  it('processes a valid video → ready with duration, dimensions and thumbnail', async () => {
    const video = await seedVideo(VideoStatus.PROCESSING, sample);

    await processor.process(fakeJob(video.id));

    const row = await videos.findOne({ where: { id: video.id } });
    expect(row?.status).toBe(VideoStatus.READY);
    expect(row?.duration_seconds).toBeGreaterThan(0);
    expect(row?.width).toBe(128);
    expect(row?.height).toBe(72);
    expect(row?.thumbnail_key).toBe(`thumbnails/${video.public_id}.jpg`);

    // Thumbnail object was actually written to storage.
    const thumb = await storage.getObject(row!.thumbnail_key as string);
    expect(thumb.contentLength).toBeGreaterThan(0);
  });

  it('throws when the stored object is not a valid video', async () => {
    const video = await seedVideo(
      VideoStatus.PROCESSING,
      Buffer.from('this is not a video'),
    );
    await expect(processor.process(fakeJob(video.id))).rejects.toBeDefined();
  });

  it('marks the video failed once retries are exhausted', async () => {
    const video = await seedVideo(
      VideoStatus.PROCESSING,
      Buffer.from('not a video'),
    );

    await processor.onFailed(
      fakeJob(video.id, {
        attemptsMade: 3,
        failedReason: 'ffprobe failed',
      } as Partial<Job>),
    );

    const row = await videos.findOne({ where: { id: video.id } });
    expect(row?.status).toBe(VideoStatus.FAILED);
    expect(row?.failure_reason).toBe('ffprobe failed');
  });
});
