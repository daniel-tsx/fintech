import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreatePaymentDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount: number;
  @Matches(/^[A-Z]{3}$/) currency: string;
  @IsString() @MaxLength(255) paymentMethodToken: string;
  @IsIn(['MANUAL', 'AUTOMATIC']) captureMethod: 'MANUAL' | 'AUTOMATIC' = 'MANUAL';
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
  @IsOptional() @Type(() => Boolean) @IsBoolean() confirm = false;
}

export class CapturePaymentDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount?: number;
}
