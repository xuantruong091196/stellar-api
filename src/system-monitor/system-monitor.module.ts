import { Module } from '@nestjs/common';
import { SystemBalanceMonitor } from './system-balance.monitor';
import { StellarModule } from '../stellar/stellar.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [StellarModule, NotificationsModule],
  providers: [SystemBalanceMonitor],
  exports: [SystemBalanceMonitor],
})
export class SystemMonitorModule {}
