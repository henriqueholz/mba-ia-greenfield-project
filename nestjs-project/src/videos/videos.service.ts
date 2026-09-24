import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { customAlphabet } from 'nanoid';
import type { Readable } from 'stream';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import {
  InitiateUploadDto,
  MAX_VIDEO_SIZE_BYTES,
} from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  InvalidRangeException,
  UploadCompletionFailedException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
  VideoUploadTooLargeException,
} from './video.exceptions';

const PART_SIZE_BYTES = 100 * 1024 * 1024; // 100 MiB per part (max ~103 parts at 10 GiB)
const PUBLIC_ID_LENGTH = 11;
const PUBLIC_ID_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const generatePublicId = customAlphabet(PUBLIC_ID_ALPHABET, PUBLIC_ID_LENGTH);

export interface InitiateUploadResult {
  id: string;
  uploadId: string;
  key: string;
  partSize: number;
  parts: { partNumber: number; url: string }[];
}

export interface VideoMetadataResult {
  id: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  channelId: string;
  createdAt: Date;
}

export interface VideoStreamResult {
  stream: Readable;
  contentType: string;
  contentLength: number;
  contentRange?: string;
  status: 200 | 206;
  filename: string;
}

const RANGE_HEADER_PATTERN = /^bytes=\d*-\d*$/;

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly channels: ChannelsService,
    private readonly storage: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
  ) {}

  async initiate(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    if (dto.size > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoUploadTooLargeException();
    }
    const channel = await this.channels.findByUserId(userId);
    if (!channel) {
      // Every user gets a channel at registration; a missing one is unexpected.
      throw new VideoNotFoundException();
    }

    const publicId = await this.generateUniquePublicId();
    const key = `videos/${publicId}/original`;
    const uploadId = await this.storage.createMultipartUpload(
      key,
      dto.contentType,
    );

    const partCount = Math.max(1, Math.ceil(dto.size / PART_SIZE_BYTES));
    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const parts = await this.storage.presignUploadParts(
      key,
      uploadId,
      partNumbers,
    );

    await this.videos.save(
      this.videos.create({
        public_id: publicId,
        channel_id: channel.id,
        title: dto.title ?? dto.filename,
        status: VideoStatus.DRAFT,
        storage_key: key,
        upload_id: uploadId,
        original_filename: dto.filename,
        content_type: dto.contentType,
        size_bytes: String(dto.size),
      }),
    );

    return { id: publicId, uploadId, key, partSize: PART_SIZE_BYTES, parts };
  }

  async complete(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<{ id: string; status: VideoStatus }> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoInvalidStateException();
    }

    try {
      await this.storage.completeMultipartUpload(
        video.storage_key,
        dto.uploadId,
        dto.parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      );
    } catch {
      throw new UploadCompletionFailedException();
    }

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.videos.save(video);

    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id },
      {
        jobId: video.id,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
      },
    );

    return { id: video.public_id, status: video.status };
  }

  async remove(userId: string, publicId: string): Promise<void> {
    const video = await this.findOwnedVideo(userId, publicId);

    if (video.upload_id) {
      await this.storage
        .abortMultipartUpload(video.storage_key, video.upload_id)
        .catch(() => undefined);
    }
    const keys = [video.storage_key];
    if (video.thumbnail_key) {
      keys.push(video.thumbnail_key);
    }
    await this.storage.deleteObjects(keys).catch(() => undefined);
    await this.videos.delete({ id: video.id });
  }

  async getMetadata(
    publicId: string,
    userId?: string,
  ): Promise<VideoMetadataResult> {
    const video = await this.resolveViewable(
      publicId,
      userId,
      () => new VideoNotFoundException(),
    );
    return {
      id: video.public_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      thumbnailUrl: video.thumbnail_key
        ? `/videos/${video.public_id}/thumbnail`
        : null,
      channelId: video.channel_id,
      createdAt: video.created_at,
    };
  }

  async stream(
    publicId: string,
    userId: string | undefined,
    range: string | undefined,
  ): Promise<VideoStreamResult> {
    const video = await this.resolveViewable(
      publicId,
      userId,
      () => new VideoNotReadyException(),
    );
    if (range && !RANGE_HEADER_PATTERN.test(range)) {
      throw new InvalidRangeException();
    }
    try {
      const object = await this.storage.getObject(video.storage_key, range);
      return {
        stream: object.body,
        contentType: object.contentType,
        contentLength: object.contentLength,
        contentRange: object.contentRange,
        status: range ? 206 : 200,
        filename: video.original_filename ?? `${video.public_id}.mp4`,
      };
    } catch (err) {
      if (this.isRangeNotSatisfiable(err)) {
        throw new InvalidRangeException();
      }
      throw err;
    }
  }

  async getThumbnail(
    publicId: string,
    userId?: string,
  ): Promise<{ stream: Readable; contentType: string; contentLength: number }> {
    const video = await this.resolveViewable(
      publicId,
      userId,
      () => new VideoNotReadyException(),
    );
    if (!video.thumbnail_key) {
      throw new VideoNotFoundException();
    }
    const object = await this.storage.getObject(video.thumbnail_key);
    return {
      stream: object.body,
      contentType: object.contentType,
      contentLength: object.contentLength,
    };
  }

  /**
   * Resolves a video for viewing: ready videos are visible to everyone, while
   * non-ready videos are visible only to their owner. Otherwise `notVisible()`
   * is thrown (404 for metadata, 409 for media endpoints).
   */
  private async resolveViewable(
    publicId: string,
    userId: string | undefined,
    notVisible: () => Error,
  ): Promise<Video> {
    const video = await this.videos.findOne({ where: { public_id: publicId } });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status === VideoStatus.READY) {
      return video;
    }
    if (userId) {
      const channel = await this.channels.findByUserId(userId);
      if (channel && channel.id === video.channel_id) {
        return video;
      }
    }
    throw notVisible();
  }

  private isRangeNotSatisfiable(err: unknown): boolean {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e.name === 'InvalidRange' || e.$metadata?.httpStatusCode === 416;
  }

  private async findOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videos.findOne({ where: { public_id: publicId } });
    if (!video) {
      throw new VideoNotFoundException();
    }
    const channel = await this.channels.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new VideoNotOwnedException();
    }
    return video;
  }

  private async generateUniquePublicId(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generatePublicId();
      const existing = await this.videos.findOne({
        where: { public_id: candidate },
      });
      if (!existing) {
        return candidate;
      }
    }
    throw new Error('Could not generate a unique public_id after 5 attempts');
  }
}
