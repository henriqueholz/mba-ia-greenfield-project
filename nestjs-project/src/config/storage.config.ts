import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'minio',
  port: parseInt(process.env.STORAGE_PORT || '9000', 10),
  accessKey: process.env.STORAGE_ACCESS_KEY || 'streamtube',
  secretKey: process.env.STORAGE_SECRET_KEY || 'streamtube',
  bucket: process.env.STORAGE_BUCKET || 'streamtube',
  region: process.env.STORAGE_REGION || 'us-east-1',
  // MinIO (and any non-AWS S3-compatible endpoint) requires path-style addressing.
  forcePathStyle: true,
}));
