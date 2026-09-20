import { Type } from 'class-transformer';
import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreatePayoutDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount: number;
  @Matches(/^[A-Z]{3}$/) currency: string;
  @IsString() @MaxLength(255) destinationToken: string;
}
