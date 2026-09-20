import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import type { ProviderScenario } from '../../payment-provider/payment-provider.types';

const SCENARIOS: ProviderScenario[] = ['SUCCESS', 'DECLINE', 'TIMEOUT_BEFORE_PROCESSING', 'PROCESSED_RESPONSE_LOST', 'DELAYED_WEBHOOK', 'DUPLICATE_WEBHOOK', 'OUT_OF_ORDER_WEBHOOK', 'TEMPORARY_500', 'REFUND_RETRY_THEN_SUCCESS', 'AMOUNT_MISMATCH', 'UNEXPECTED_TRANSACTION'];

export class CreatePaymentDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount: number;
  @Matches(/^[A-Z]{3}$/) currency: string;
  @IsString() @MaxLength(255) paymentMethodToken: string;
  @IsIn(['MANUAL', 'AUTOMATIC']) captureMethod: 'MANUAL' | 'AUTOMATIC' = 'MANUAL';
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
  @IsOptional() @Type(() => Boolean) @IsBoolean() confirm = false;
  @IsOptional() @IsIn(SCENARIOS) scenario: ProviderScenario = 'SUCCESS';
}

export class ProviderCommandDto {
  @IsOptional() @IsIn(SCENARIOS) scenario: ProviderScenario = 'SUCCESS';
}

export class CapturePaymentDto extends ProviderCommandDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount?: number;
}
