import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { AppModule } from '../app.module';
import { Channel } from '../channels/entities/channel.entity';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { User } from '../users/entities/user.entity';
import { VideosController } from './videos.controller';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let queue: Queue;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await moduleRef.close();
  });

  let counter = 0;
  async function seedUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await users.save(
      users.create({
        email: `videos_int_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Chan ${counter}`,
        nickname: `chan_int_${counter}`,
        user_id: user.id,
      }),
    );
    return { userId: user.id, channelId: channel.id };
  }

  beforeEach(async () => {
    await dataSource.query('DELETE FROM videos');
    await dataSource.query('DELETE FROM channels');
    await dataSource.query('DELETE FROM users');
  });

  it('wires the module: VideosService and VideosController resolve', () => {
    expect(service).toBeInstanceOf(VideosService);
    expect(moduleRef.get(VideosController)).toBeInstanceOf(VideosController);
  });

  it('initiate creates a draft row and a multipart upload with presigned parts', async () => {
    const { userId, channelId } = await seedUserWithChannel();

    const res = await service.initiate(userId, {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      size: 2048,
    });

    expect(res.uploadId).toBeTruthy();
    expect(res.parts.length).toBeGreaterThanOrEqual(1);
    expect(res.parts[0].url).toContain('/videos/');

    const row = await videos.findOne({ where: { public_id: res.id } });
    expect(row?.status).toBe(VideoStatus.DRAFT);
    expect(row?.channel_id).toBe(channelId);
    expect(row?.upload_id).toBe(res.uploadId);
  });

  it('complete finalizes the upload, transitions to processing and enqueues the job', async () => {
    const { userId } = await seedUserWithChannel();

    const initiated = await service.initiate(userId, {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      size: 32,
    });

    // Upload the single part directly to storage via the presigned URL.
    const payload = Buffer.from('an integration test video payload');
    const put = await fetch(initiated.parts[0].url, {
      method: 'PUT',
      body: payload,
    });
    expect(put.ok).toBe(true);
    const etag = put.headers.get('etag') as string;

    const completed = await service.complete(userId, initiated.id, {
      uploadId: initiated.uploadId,
      parts: [{ partNumber: initiated.parts[0].partNumber, etag }],
    });

    expect(completed.status).toBe(VideoStatus.PROCESSING);

    const row = await videos.findOne({ where: { public_id: initiated.id } });
    expect(row?.status).toBe(VideoStatus.PROCESSING);
    expect(row?.upload_id).toBeNull();

    const job = await queue.getJob(row!.id);
    expect(job?.data).toEqual({ videoId: row!.id });

    await service.remove(userId, initiated.id);
  });
});
