import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Backstop for uploads that were initiated (draft) but never completed: removes
 * the row and aborts/cleans up the associated storage objects once the draft is
 * older than the TTL (per phase-03-videos/TD-04).
 */
@Injectable()
export class DraftCleanupService {
  private readonly logger = new Logger(DraftCleanupService.name);

  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupStaleDrafts(): Promise<number> {
    const cutoff = new Date(Date.now() - DRAFT_TTL_MS);
    const stale = await this.videos.find({
      where: { status: VideoStatus.DRAFT, created_at: LessThan(cutoff) },
    });

    for (const video of stale) {
      if (video.upload_id) {
        await this.storage
          .abortMultipartUpload(video.storage_key, video.upload_id)
          .catch(() => undefined);
      }
      await this.storage
        .deleteObjects([video.storage_key])
        .catch(() => undefined);
      await this.videos.delete({ id: video.id });
    }

    if (stale.length > 0) {
      this.logger.log(`Cleaned up ${stale.length} stale draft(s)`);
    }
    return stale.length;
  }
}
