import {
  IsOptional,
  IsBoolean,
  IsEmail,
  IsUrl,
  IsIn,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Whitelist of fields a provider can patch. Same rationale as
 * UpdateStoreSettingsDto — prevents direct writes to webhookSecret,
 * webhookDisabledAt, webhookFailureCount via the update endpoint.
 */
export class UpdateProviderSettingsDto {
  @ApiPropertyOptional({ enum: ['en', 'vi'] })
  @IsOptional()
  @IsIn(['en', 'vi'])
  locale?: 'en' | 'vi';

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { message: 'webhookUrl must be an http(s) URL' },
  )
  @MaxLength(2048)
  webhookUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  webhookEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyNewOrders?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyOrderCancelled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyEscrowReleased?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyDisputes?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifySystem?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsEmail()
  @MaxLength(254)
  notificationEmail?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  inAppEnabled?: boolean;
}
