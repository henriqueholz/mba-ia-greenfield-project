import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import {
  VideosService,
  type InitiateUploadResult,
  type VideoMetadataResult,
  type VideoStreamResult,
} from './videos.service';
import type { VideoStatus } from './entities/video.entity';
import { OptionalJwtGuard } from './guards/optional-jwt.guard';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(201)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft and returns presigned multipart URLs so the client uploads directly to storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created with presigned parts',
  })
  initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiate(user.sub, dto);
  }

  @Post(':publicId/complete')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload, transitions the video to processing and enqueues the processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; video is processing',
  })
  complete(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; status: VideoStatus }> {
    return this.videosService.complete(user.sub, publicId, dto);
  }

  @Delete(':publicId')
  @HttpCode(204)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Delete or abort a video' })
  @ApiResponse({ status: 204, description: 'Video deleted' })
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    await this.videosService.remove(user.sub, publicId);
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @Get(':publicId')
  @ApiOperation({ summary: 'Get video metadata' })
  getMetadata(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
  ): Promise<VideoMetadataResult> {
    return this.videosService.getMetadata(publicId, user?.sub);
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Stream the video (HTTP Range / 206 Partial Content)',
  })
  async stream(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.videosService.stream(
      publicId,
      user?.sub,
      req.headers.range,
    );
    this.applyStreamHeaders(res, result);
    result.stream.pipe(res);
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @Get(':publicId/download')
  @ApiOperation({ summary: 'Download the video file' })
  async download(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.videosService.stream(
      publicId,
      user?.sub,
      req.headers.range,
    );
    this.applyStreamHeaders(res, result);
    res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
    result.stream.pipe(res);
  }

  @Public()
  @UseGuards(OptionalJwtGuard)
  @Get(':publicId/thumbnail')
  @ApiOperation({ summary: 'Get the generated thumbnail' })
  async thumbnail(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.videosService.getThumbnail(publicId, user?.sub);
    res.status(200);
    res.set({
      'Content-Type': result.contentType,
      'Content-Length': String(result.contentLength),
    });
    result.stream.pipe(res);
  }

  private applyStreamHeaders(res: Response, result: VideoStreamResult): void {
    res.status(result.status);
    res.set({
      'Accept-Ranges': 'bytes',
      'Content-Type': result.contentType,
      'Content-Length': String(result.contentLength),
    });
    if (result.contentRange) {
      res.set('Content-Range', result.contentRange);
    }
  }
}
