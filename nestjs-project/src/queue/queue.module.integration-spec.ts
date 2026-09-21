import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './queue.constants';

// BullMQ opens a real Redis connection on module init, so this is an
// integration test (per nestjs-project test-type rules), not a unit spec.
describe('QueueModule (integration)', () => {
  let moduleRef: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    await moduleRef.init();
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await moduleRef.close();
  });

  it('should register the video-processing queue and enqueue a job on Redis', async () => {
    const job = await queue.add(PROCESS_VIDEO_JOB, { videoId: 'test-video-id' });
    expect(job.id).toBeDefined();

    const fetched = await queue.getJob(job.id as string);
    expect(fetched?.name).toBe(PROCESS_VIDEO_JOB);
    expect(fetched?.data).toEqual({ videoId: 'test-video-id' });
  });
});
