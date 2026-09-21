import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { customAlphabet } from 'nanoid';
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
  UploadCompletionFailedException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotOwnedException,
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
