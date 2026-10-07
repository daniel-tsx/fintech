import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { OutboxRelayService } from './outbox-relay.service';

@Injectable()
export class OutboxRelayRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayRunner.name);
  private stopping = false;
  private runPromise?: Promise<void>;

  constructor(private readonly relay: OutboxRelayService) {}

  onApplicationBootstrap(): void {
    this.runPromise = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.runPromise;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const published = await this.relay.drain();
        if (published === 0) await this.wait(1_000);
      } catch (error) {
        this.logger.error({ error: error instanceof Error ? error.message : 'Unknown relay error' }, 'Outbox relay cycle failed');
        await this.wait(1_000);
      }
    }
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
