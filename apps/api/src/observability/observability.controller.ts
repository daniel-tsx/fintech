import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { DatabaseService } from '../database/database.service';

@Controller()
export class ObservabilityController {
  constructor(private readonly database: DatabaseService) {}
  @Public() @Get('health') async health() { await this.database.sql`select 1`; return { status: 'ok', time: new Date().toISOString() }; }

  @Public() @Get('metrics') @Header('content-type', 'text/plain; version=0.0.4')
  async metrics(): Promise<string> {
    const [row] = await this.database.sql<Array<{ captured: string; failed: string; dead_webhooks: string; dead_outbox: string; reconciliation_open: string; payout_failed: string }>>`
      select
        (select count(*) from payments where status in ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED'))::text as captured,
        (select count(*) from payments where status='FAILED')::text as failed,
        (select count(*) from webhook_events where status='DEAD')::text as dead_webhooks,
        (select count(*) from outbox_events where status='DEAD')::text as dead_outbox,
        (select count(*) from reconciliation_issues where status='OPEN')::text as reconciliation_open,
        (select count(*) from payouts where status='FAILED')::text as payout_failed`;
    return [`fintech_payments_captured_total ${row.captured}`, `fintech_payments_failed_total ${row.failed}`, `fintech_webhooks_dead_total ${row.dead_webhooks}`, `fintech_outbox_dead_total ${row.dead_outbox}`, `fintech_reconciliation_open ${row.reconciliation_open}`, `fintech_payouts_failed_total ${row.payout_failed}`].join('\n') + '\n';
  }
}
