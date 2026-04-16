import {
  IsOptional,
  IsString,
  IsBoolean,
  IsEmail,
  IsUrl,
  IsArray,
  IsIn,
  IsNumber,
  Min,
  Max,
  MaxLength,
  ValidateIf,
  Matches,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Fields a store owner is allowed to patch via the settings endpoint.
 *
 * SECURITY: Whitelisting is critical here — without a DTO the raw body is
 * spread into a Prisma update, so a malicious caller could overwrite
 * `webhookSecret`, `webhookDisabledAt`, `webhookFailureCount`, etc. Only
 * the fields below are accepted; everything else is stripped by the global
 * ValidationPipe (whitelist: true).
 */
export class UpdateStoreSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  storeName?: string;

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

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  webhookEvents?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  webhookEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  defaultMarkup?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyOrders?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyEscrow?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyShipping?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyDisputes?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyProducts?: boolean;

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

  /**
   * Payout address (lives on the Store model, not StoreSettings). The
   * service extracts this field before writing the settings upsert.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'Must be a valid Stellar public key' })
  stellarAddress?: string | null;
}
