import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class UploadPartDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  partNumber: number;

  @ApiProperty({ example: '"9bb58f26192e4ba00f01e2e7b136bbd8"' })
  @IsString()
  @MinLength(1)
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({ example: 'multipart-upload-id' })
  @IsString()
  @MinLength(1)
  uploadId: string;

  @ApiProperty({ type: [UploadPartDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
