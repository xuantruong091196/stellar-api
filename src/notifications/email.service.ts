import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import Redis from 'ioredis';
import { EmailPriority, EVENT_PRIORITY_MAP, NotificationType } from './notifications.types';
import { EmailTemplatesService } from './email-templates.service';

/**
 * Wraps Resend SDK with rate limiting and locale support.
 * Resend free tier: 100 emails/day, 3000/month.
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;
  private redis: Redis | null = null;
  private fromEmail: string;
  private replyTo: string;
  private dailyLimit: number;
  private hardLimit: number;

  constructor(
    private readonly config: ConfigService,
    private readonly templates: EmailTemplatesService,
  ) {
    this.fromEmail = this.config.get<string>('resend.fromEmail') || 'notifications@stelo.life';
    this.replyTo = this.config.get<string>('resend.replyTo') || 'noreply@stelo.life';
    this.dailyLimit = this.config.get<number>('notifications.emailDailyLimit') ?? 90;
    this.hardLimit = this.config.get<number>('notifications.emailHardLimit') ?? 100;
  }

  async onModuleInit() {
    const apiKey = this.config.get<string>('resend.apiKey');
    if (apiKey && apiKey !== 'placeholder') {
      this.resend = new Resend(apiKey);
      this.logger.log('Resend client initialized');
    } else {
      this.logger.warn('RESEND_API_KEY not configured — emails will be logged only');
    }

    try {
      const redisHost = this.config.get<string>('redis.host') || 'localhost';
      const redisPort = this.config.get<number>('redis.port') || 6379;
      const redisPassword = this.config.get<string>('redis.password');
      this.redis = new Redis({
        host: redisHost,
        port: redisPort,
        password: redisPassword || undefined,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      await this.redis.connect();
    } catch (err) {
      this.logger.warn(`Redis connection failed for email rate limiting: ${(err as Error).message}`);
      this.redis = null;
    }
  }

  /**
   * Send a notification email with rate limiting and priority handling.
   */
  async send(input: {
    to: string;
    type: NotificationType;
    locale: 'en' | 'vi';
    title: string;
    payload: Record<string, unknown>;
  }): Promise<{ sent: boolean; reason?: string }> {
    const priority = EVENT_PRIORITY_MAP[input.type];

    // Rate limit check
    const dailyKey = `email:count:${new Date().toISOString().slice(0, 10)}`;
    const todayCount = this.redis ? parseInt((await this.redis.get(dailyKey)) || '0', 10) : 0;

    if (todayCount >= this.hardLimit) {
      this.logger.error(`Email hard limit reached (${this.hardLimit}), dropping email to ${input.to}`);
      return { sent: false, reason: 'hard_limit_reached' };
    }

    if (todayCount >= this.dailyLimit && priority !== 'critical') {
      this.logger.warn(`Email soft limit reached (${this.dailyLimit}), skipping ${priority} email`);
      return { sent: false, reason: 'soft_limit_reached' };
    }

    if (!this.resend) {
      this.logger.log(`[DRY RUN] Email to ${input.to}: ${input.title}`);
      return { sent: false, reason: 'resend_not_configured' };
    }

    try {
      const rendered = await this.templates.render(input.type, input.locale, input.payload);

      await this.resend.emails.send({
        from: this.fromEmail,
        to: input.to,
        replyTo: this.replyTo,
        subject: rendered.subject,
        html: rendered.html,
      });

      // Increment counter
      if (this.redis) {
        await this.redis.incr(dailyKey);
        await this.redis.expire(dailyKey, 86400 * 2); // expire after 2 days
      }

      this.logger.log(`Email sent to ${input.to}: ${input.type}`);
      return { sent: true };
    } catch (err) {
      this.logger.error(`Failed to send email to ${input.to}: ${(err as Error).message}`);
      throw err;
    }
  }
}
