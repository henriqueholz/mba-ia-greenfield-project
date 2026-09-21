import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB

export class InitiateUploadDto {
  @ApiProperty({ example: 'my-clip.mp4' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  @ApiProperty({ example: 'video/mp4' })
  @IsString()
  @Matches(/^video\//, { message: 'contentType must be a video/* MIME type' })
  contentType: string;

  @ApiProperty({
    example: 1048576,
    description: 'Total size in bytes (must be <= 10 GiB)',
  })
  @IsInt()
  @Min(1)
  size: number;

  @ApiProperty({ required: false, example: 'My Clip' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
