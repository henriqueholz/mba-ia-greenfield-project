import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideosService, type InitiateUploadResult } from './videos.service';
import type { VideoStatus } from './entities/video.entity';

@ApiTags('videos')
@ApiBearerAuth()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft and returns presigned multipart URLs so the client uploads directly to storage.',
  })
  @ApiResponse({ status: 201, description: 'Draft created with presigned parts' })
  initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiate(user.sub, dto);
  }

  @Post(':publicId/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload, transitions the video to processing and enqueues the processing job.',
  })
  @ApiResponse({ status: 200, description: 'Upload completed; video is processing' })
  complete(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; status: VideoStatus }> {
    return this.videosService.complete(user.sub, publicId, dto);
  }

  @Delete(':publicId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete or abort a video' })
  @ApiResponse({ status: 204, description: 'Video deleted' })
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    await this.videosService.remove(user.sub, publicId);
  }
}
