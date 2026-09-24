import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  raw: Record<string, unknown>;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

/**
 * Thin wrapper around the ffprobe/ffmpeg system binaries (installed in the
 * worker image). Operates on local file paths — downloading from / uploading to
 * storage is the caller's responsibility.
 */
@Injectable()
export class MediaService {
  /** Extracts duration + dimensions + the raw ffprobe payload. */
  async probe(filePath: string): Promise<VideoMetadata> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
    const duration = Number(parsed.format?.duration ?? 0);

    return {
      durationSeconds: Number.isFinite(duration) ? duration : 0,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      raw: parsed as unknown as Record<string, unknown>,
    };
  }

  /** Extracts a single frame at `atSeconds` into `outPath` as a JPEG. */
  async generateThumbnail(
    filePath: string,
    outPath: string,
    atSeconds: number,
  ): Promise<void> {
    const seek = Math.max(0, atSeconds).toFixed(3);
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      seek,
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outPath,
    ]);
  }
}
