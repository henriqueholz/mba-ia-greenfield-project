import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { MAX_VIDEO_SIZE_BYTES } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoInvalidStateException,
  VideoNotOwnedException,
  VideoUploadTooLargeException,
} from './video.exceptions';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  let service: VideosService;
  const videosRepo = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  };
  const channels = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    presignUploadParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    deleteObjects: jest.fn(),
  };
  const queue = { add: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videosRepo },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  describe('initiate', () => {
    it('rejects a size above 10 GiB with VideoUploadTooLargeException', async () => {
      await expect(
        service.initiate('user-1', {
          filename: 'f.mp4',
          contentType: 'video/mp4',
          size: MAX_VIDEO_SIZE_BYTES + 1,
        }),
      ).rejects.toBeInstanceOf(VideoUploadTooLargeException);
    });

    it('creates a draft and presigns the parts', async () => {
      channels.findByUserId.mockResolvedValue({ id: 'chan-1' });
      videosRepo.findOne.mockResolvedValue(null);
      storage.createMultipartUpload.mockResolvedValue('upload-1');
      storage.presignUploadParts.mockResolvedValue([
        { partNumber: 1, url: 'http://minio/part1' },
      ]);
      videosRepo.create.mockImplementation((v: Partial<Video>) => v);
      videosRepo.save.mockResolvedValue(undefined);

      const res = await service.initiate('user-1', {
        filename: 'f.mp4',
        contentType: 'video/mp4',
        size: 1024,
      });

      expect(res.uploadId).toBe('upload-1');
      expect(res.parts).toHaveLength(1);
      expect(res.id).toHaveLength(11);
      expect(videosRepo.save).toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    const draft = {
      id: 'v1',
      public_id: 'pub',
      channel_id: 'chan-A',
      status: VideoStatus.DRAFT,
      storage_key: 'videos/pub/original',
      upload_id: 'u',
    };

    it('throws VideoNotOwnedException when the channel does not match', async () => {
      videosRepo.findOne.mockResolvedValue({ ...draft });
      channels.findByUserId.mockResolvedValue({ id: 'chan-B' });
      await expect(
        service.complete('user-1', 'pub', {
          uploadId: 'u',
          parts: [{ partNumber: 1, etag: 'e' }],
        }),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);
    });

    it('throws VideoInvalidStateException when the video is not a draft', async () => {
      videosRepo.findOne.mockResolvedValue({
        ...draft,
        status: VideoStatus.READY,
      });
      channels.findByUserId.mockResolvedValue({ id: 'chan-A' });
      await expect(
        service.complete('user-1', 'pub', {
          uploadId: 'u',
          parts: [{ partNumber: 1, etag: 'e' }],
        }),
      ).rejects.toBeInstanceOf(VideoInvalidStateException);
    });

    it('completes the upload, transitions to processing and enqueues the job', async () => {
      const video = { ...draft };
      videosRepo.findOne.mockResolvedValue(video);
      channels.findByUserId.mockResolvedValue({ id: 'chan-A' });
      storage.completeMultipartUpload.mockResolvedValue(undefined);
      videosRepo.save.mockResolvedValue(undefined);
      queue.add.mockResolvedValue({ id: 'v1' });

      const res = await service.complete('user-1', 'pub', {
        uploadId: 'u',
        parts: [{ partNumber: 1, etag: 'e' }],
      });

      expect(res.status).toBe(VideoStatus.PROCESSING);
      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/pub/original',
        'u',
        [{ PartNumber: 1, ETag: 'e' }],
      );
      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'v1' },
        expect.objectContaining({ jobId: 'v1', attempts: 3 }),
      );
    });
  });
});
