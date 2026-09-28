import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

async function drain(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe('StorageService (integration)', () => {
  let moduleRef: TestingModule;
  let service: StorageService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();
    service = moduleRef.get(StorageService);
    await service.ensureBucket();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should be idempotent on ensureBucket', async () => {
    await expect(service.ensureBucket()).resolves.not.toThrow();
    await expect(service.ensureBucket()).resolves.not.toThrow();
  });

  it('should round-trip a presigned multipart upload and read it back', async () => {
    const key = `test/${randomUUID()}/original`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const [{ url, partNumber }] = await service.presignUploadParts(
      key,
      uploadId,
      [1],
    );
    const payload = Buffer.from('hello streamtube multipart video');

    const putRes = await fetch(url, { method: 'PUT', body: payload });
    expect(putRes.ok).toBe(true);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { PartNumber: partNumber, ETag: etag as string },
    ]);

    const obj = await service.getObject(key);
    expect((await drain(obj.body)).toString()).toBe(payload.toString());
    expect(obj.contentType).toBe('video/mp4');

    await service.deleteObjects([key]);
  });

  it('should return a byte range with a Content-Range header', async () => {
    const key = `test/${randomUUID()}/original`;
    await service.putObject(key, Buffer.from('0123456789'), 'text/plain');

    const obj = await service.getObject(key, 'bytes=0-4');
    expect((await drain(obj.body)).toString()).toBe('01234');
    expect(obj.contentRange).toContain('bytes 0-4/10');

    await service.deleteObjects([key]);
  });

  it('should abort a multipart upload without error', async () => {
    const key = `test/${randomUUID()}/original`;
    const uploadId = await service.createMultipartUpload(key);
    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.not.toThrow();
  });
});
