import { execFile } from 'child_process';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { MediaService } from './media.service';

const execFileAsync = promisify(execFile);

describe('MediaService (integration, real ffmpeg)', () => {
  const media = new MediaService();
  let dir: string;
  let sample: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-test-'));
    sample = join(dir, 'sample.mp4');
    // Generate a deterministic 1s 64x64 test video with the bundled ffmpeg.
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=64x64:rate=10',
      '-pix_fmt',
      'yuv420p',
      sample,
    ]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('probes duration and dimensions from a real file', async () => {
    const meta = await media.probe(sample);
    expect(meta.durationSeconds).toBeGreaterThan(0);
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
  });

  it('generates a non-empty JPEG thumbnail', async () => {
    const out = join(dir, 'thumb.jpg');
    await media.generateThumbnail(sample, out, 0);
    const info = await stat(out);
    expect(info.size).toBeGreaterThan(0);
  });
});
