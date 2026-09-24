import { Test, type TestingModule } from '@nestjs/testing';
import { MediaService } from './media.service';
import { VideoProcessor } from './video.processor';
import { WorkerModule } from './worker.module';

// Booting the real WorkerModule starts a live BullMQ worker (Redis) and a DB
// connection, so this is an integration test, not a unit spec.
describe('WorkerModule (integration)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    // The BullMQ worker holds a blocking Redis connection; close it explicitly
    // so Jest exits cleanly without --forceExit.
    await moduleRef.get(VideoProcessor).worker.close();
    await moduleRef.close();
  });

  it('wires the processor and media service against real infrastructure', () => {
    expect(moduleRef.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(moduleRef.get(MediaService)).toBeInstanceOf(MediaService);
  });
});
