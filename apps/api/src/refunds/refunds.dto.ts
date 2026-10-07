import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateRefundDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
