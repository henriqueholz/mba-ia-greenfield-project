import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

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
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM videos');
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const authService = app.get(AuthService);
    const mailService = (
      authService as unknown as {
        mailService: {
          sendConfirmationEmail: (
            e: string,
            n: string,
            t: string,
          ) => Promise<void>;
        };
      }
    ).mailService;
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e, _n, t) => {
        token = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return res.body.access_token as string;
  }

  const validBody = {
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    size: 2048,
  };

  it('rejects an unauthenticated initiate with 401', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(validBody)
      .expect(401);
  });

  it('initiates an upload with 201 and a draft + presigned parts', async () => {
    const token = await registerConfirmAndLogin('uploader@example.com');
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
      .expect(201);

    expect(res.body.id).toHaveLength(11);
    expect(res.body.uploadId).toBeTruthy();
    expect(res.body.parts.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects a size above 10 GiB with 400 VIDEO_UPLOAD_TOO_LARGE', async () => {
    const token = await registerConfirmAndLogin('toobig@example.com');
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, size: MAX_VIDEO_SIZE_BYTES + 1 })
      .expect(400);
    expect(res.body.error).toBe('VIDEO_UPLOAD_TOO_LARGE');
  });

  it('rejects a missing filename with a 400 validation error', async () => {
    const token = await registerConfirmAndLogin('invalid@example.com');
    await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ contentType: 'video/mp4', size: 100 })
      .expect(400);
  });

  it('runs the full initiate -> upload -> complete flow to 200 processing', async () => {
    const token = await registerConfirmAndLogin('flow@example.com');
    const initiated = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, size: 32 })
      .expect(201);

    const part = initiated.body.parts[0];
    const put = await fetch(part.url, {
      method: 'PUT',
      body: Buffer.from('e2e upload payload'),
    });
    expect(put.ok).toBe(true);
    const etag = put.headers.get('etag') as string;

    const completed = await request(app.getHttpServer())
      .post(`/videos/${initiated.body.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        uploadId: initiated.body.uploadId,
        parts: [{ partNumber: part.partNumber, etag }],
      })
      .expect(200);

    expect(completed.body.status).toBe('processing');
  });

  it('rejects complete/delete by a non-owner with 403', async () => {
    const ownerToken = await registerConfirmAndLogin('owner@example.com');
    const initiated = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(validBody)
      .expect(201);

    const otherToken = await registerConfirmAndLogin('intruder@example.com');
    const res = await request(app.getHttpServer())
      .post(`/videos/${initiated.body.id}/complete`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({
        uploadId: initiated.body.uploadId,
        parts: [{ partNumber: 1, etag: 'x' }],
      })
      .expect(403);
    expect(res.body.error).toBe('VIDEO_NOT_OWNED');

    await request(app.getHttpServer())
      .delete(`/videos/${initiated.body.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);
  });

  it('deletes an owned draft with 204', async () => {
    const token = await registerConfirmAndLogin('deleter@example.com');
    const initiated = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/videos/${initiated.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  });
});
