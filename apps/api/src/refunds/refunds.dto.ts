import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { ProviderScenario } from '../payment-provider/payment-provider.types';

export class CreateRefundDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsIn(['SUCCESS', 'TEMPORARY_500', 'REFUND_RETRY_THEN_SUCCESS', 'PROCESSED_RESPONSE_LOST', 'DELAYED_WEBHOOK', 'DUPLICATE_WEBHOOK'])
  scenario: ProviderScenario = 'SUCCESS';
}
