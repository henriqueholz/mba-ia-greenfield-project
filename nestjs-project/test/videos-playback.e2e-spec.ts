import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, type Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

const PAYLOAD = '0123456789ABCDEFGHIJ'; // 20 bytes

// Buffer the raw response body so byte-level assertions work on binary streams.
function binaryParser(
  res: request.Response,
  cb: (err: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('Videos playback (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM videos');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function seedVideo(
    status: VideoStatus,
    withThumbnail = true,
  ): Promise<string> {
    const user = await users.save(
      users.create({ email: `play_${++counter}@example.com`, password: 'h' }),
    );
    const channel = await channels.save(
      channels.create({
        name: `c${counter}`,
        nickname: `play_${counter}`,
        user_id: user.id,
      }),
    );
    const publicId = `play${counter}xyz00`.slice(0, 11);
    const key = `videos/${publicId}/original`;
    await storage.putObject(key, Buffer.from(PAYLOAD), 'video/mp4');
    let thumbnailKey: string | null = null;
    if (withThumbnail) {
      thumbnailKey = `thumbnails/${publicId}.jpg`;
      await storage.putObject(thumbnailKey, Buffer.from('JPEGDATA'), 'image/jpeg');
    }
    await videos.save(
      videos.create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'Playable',
        status,
        storage_key: key,
        thumbnail_key: thumbnailKey,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: String(PAYLOAD.length),
      }),
    );
    return publicId;
  }

  it('returns metadata of a ready video anonymously', async () => {
    const id = await seedVideo(VideoStatus.READY);
    const res = await request(app.getHttpServer())
      .get(`/videos/${id}`)
      .expect(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.thumbnailUrl).toBe(`/videos/${id}/thumbnail`);
  });

  it('streams the full video with 200 and Accept-Ranges when no Range is sent', async () => {
    const id = await seedVideo(VideoStatus.READY);
    const res = await request(app.getHttpServer())
      .get(`/videos/${id}/stream`)
      .buffer()
      .parse(binaryParser)
      .expect(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(PAYLOAD.length));
    expect((res.body as Buffer).toString()).toBe(PAYLOAD);
  });

  it('streams a byte range with 206 and Content-Range', async () => {
    const id = await seedVideo(VideoStatus.READY);
    const res = await request(app.getHttpServer())
      .get(`/videos/${id}/stream`)
      .set('Range', 'bytes=0-4')
      .buffer()
      .parse(binaryParser)
      .expect(206);
    expect(res.headers['content-range']).toBe(`bytes 0-4/${PAYLOAD.length}`);
    expect(res.headers['content-length']).toBe('5');
    expect((res.body as Buffer).toString()).toBe('01234');
  });

  it('downloads with a Content-Disposition attachment header', async () => {
    const id = await seedVideo(VideoStatus.READY);
    const res = await request(app.getHttpServer())
      .get(`/videos/${id}/download`)
      .expect(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('clip.mp4');
  });

  it('serves the thumbnail as image/jpeg', async () => {
    const id = await seedVideo(VideoStatus.READY);
    const res = await request(app.getHttpServer())
      .get(`/videos/${id}/thumbnail`)
      .expect(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
  });

  it('returns 404 for an unknown video', async () => {
    await request(app.getHttpServer())
      .get('/videos/doesnotexist/stream')
      .expect(404);
  });

  it('returns 409 VIDEO_NOT_READY streaming a non-ready video anonymously', async () => {
    const id = await seedVideo(VideoStatus.PROCESSING, false);
    const res = await request(app.getHttpServer())
      .get(`/videos/${id}/stream`)
      .expect(409);
    expect(res.body.error).toBe('VIDEO_NOT_READY');
  });

  it('returns 416 for a malformed Range header', async () => {
    const id = await seedVideo(VideoStatus.READY);
    const res = await request(app.getHttpServer())
      .get(`/videos/${id}/stream`)
      .set('Range', 'bytes=abc')
      .expect(416);
    expect(res.body.error).toBe('INVALID_RANGE');
  });
});
