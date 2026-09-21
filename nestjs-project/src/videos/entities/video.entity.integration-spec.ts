import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM videos');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, publicId: string): Video {
    return videoRepository.create({
      public_id: publicId,
      channel_id: channelId,
      title: 'My Video',
      storage_key: `videos/${publicId}/original`,
    });
  }

  it('should default status to draft', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(buildVideo(channel.id, 'abc123'));

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should default nullable metadata fields to null', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(buildVideo(channel.id, 'nulls1'));

    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.failure_reason).toBeNull();
    expect(video.created_at).toBeInstanceOf(Date);
  });

  it('should enforce unique public_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, 'dup123'));

    await expect(
      videoRepository.save(buildVideo(channel.id, 'dup123')),
    ).rejects.toThrow();
  });

  it('should persist all four status enum values', async () => {
    const channel = await createChannel();
    for (const status of [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.READY,
      VideoStatus.FAILED,
    ]) {
      const video = buildVideo(channel.id, `st_${status}`);
      video.status = status;
      const saved = await videoRepository.save(video);
      expect(saved.status).toBe(status);
    }
  });

  it('should cascade-delete videos when the owning channel is removed', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, 'casc01'));

    await channelRepository.delete({ id: channel.id });

    const remaining = await videoRepository.count({
      where: { channel_id: channel.id },
    });
    expect(remaining).toBe(0);
  });

  it('should load the owning channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, 'rel001'));

    const found = await videoRepository.findOne({
      where: { public_id: 'rel001' },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
