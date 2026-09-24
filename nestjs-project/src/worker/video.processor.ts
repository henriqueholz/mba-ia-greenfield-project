import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { Repository } from 'typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { MediaService } from './media.service';

export interface ProcessVideoJobData {
  videoId: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly media: MediaService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videos.findOne({
      where: { id: job.data.videoId },
    });
    if (!video) {
      this.logger.warn(`Video ${job.data.videoId} not found; skipping job`);
      return;
    }
    if (video.status === VideoStatus.READY) {
      return; // idempotent: already processed
    }

    const tmpVideo = join(tmpdir(), randomUUID());
    const tmpThumb = join(tmpdir(), `${randomUUID()}.jpg`);
    try {
      const object = await this.storage.getObject(video.storage_key);
      await pipeline(object.body, createWriteStream(tmpVideo));

      const meta = await this.media.probe(tmpVideo);
      const at = Math.min(1, Math.max(0, meta.durationSeconds / 2));
      await this.media.generateThumbnail(tmpVideo, tmpThumb, at);

      const thumbnailKey = `thumbnails/${video.public_id}.jpg`;
      await this.storage.putObject(
        thumbnailKey,
        await readFile(tmpThumb),
        'image/jpeg',
      );

      video.status = VideoStatus.READY;
      video.duration_seconds = Math.round(meta.durationSeconds);
      video.width = meta.width;
      video.height = meta.height;
      video.metadata = meta.raw;
      video.thumbnail_key = thumbnailKey;
      video.failure_reason = null;
      await this.videos.save(video);
      this.logger.log(`Video ${video.public_id} processed → ready`);
    } finally {
      await rm(tmpVideo, { force: true }).catch(() => undefined);
      await rm(tmpThumb, { force: true }).catch(() => undefined);
    }
  }

  /** Marks the video failed only once BullMQ has exhausted all retries. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>): Promise<void> {
    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return; // retries still pending
    }
    const video = await this.videos.findOne({
      where: { id: job.data.videoId },
    });
    if (video && video.status !== VideoStatus.READY) {
      video.status = VideoStatus.FAILED;
      video.failure_reason = job.failedReason ?? 'Video processing failed';
      await this.videos.save(video);
      this.logger.error(
        `Video ${video.public_id} → failed: ${video.failure_reason}`,
      );
    }
  }
}
