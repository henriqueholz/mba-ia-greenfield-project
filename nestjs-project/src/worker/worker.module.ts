import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { MediaService } from './media.service';
import { VideoProcessor } from './video.processor';

/**
 * Self-contained root module for the video-worker process. It wires only the
 * infrastructure the worker needs (config, DB, storage, queue) plus the
 * processor — the API's HTTP surface is intentionally absent.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (db: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: db.host,
        port: db.port,
        username: db.username,
        password: db.password,
        database: db.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // Video → Channel → User relations require all three entity metadatas to be
    // registered, even though the worker only queries the Video repository.
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    QueueModule,
  ],
  providers: [VideoProcessor, MediaService],
})
export class WorkerModule {}
