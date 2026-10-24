import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import Stripe from 'stripe';
import request from 'supertest';
import { DomainExceptionFilter } from '../../src/common/domain-exception.filter';
import { DatabaseService, type DbTransaction } from '../../src/database/database.service';
import { RestrictedReceiptDatabase, type ReceiptTransactions } from '../../src/webhooks/trusted-receipt-database';
import { TrustedReceiptCorrelationService } from '../../src/webhooks/trusted-receipt-correlation.service';
import { TrustedSignedReceiptService, type SignedReceiptResult } from '../../src/webhooks/trusted-signed-receipt.service';

export interface ReceiptHttpBody extends Partial<SignedReceiptResult> { error?: { code: string } }

@Controller('isolated-receipts')
class TestReceiptController {
  constructor(private readonly receiver: TrustedSignedReceiptService) {}
  @Post('stripe') @HttpCode(202)
  receive(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature = '') {
    return this.receiver.receive(req.rawBody, signature, req.headers);
  }
}

export async function trustedReceiptHarness(migrationsFolder = resolve(__dirname, '../../drizzle')) {
  const value = process.env.MIGRATION_ADMIN_URL;
  if (!value) throw new Error('Disposable MIGRATION_ADMIN_URL required');
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local test cluster required');
  const suffix = randomUUID().replaceAll('-', ''), name = `fintech_r1_signed_${suffix}`, admin = postgres(value, { max: 1 });
  try { await admin.unsafe(`create database "${name}"`); } finally { await admin.end(); }
  url.pathname = '/' + name;
  const setup = postgres(url.toString(), { max: 1 });
  try { await migrate(drizzle(setup), { migrationsFolder }); } finally { await setup.end(); }
  const db = new DatabaseService(new ConfigService({ DATABASE_URL: url.toString() }));
  const roles = { publisher: `r1_pub_${suffix}`, correlator: `r1_cor_${suffix}`, worker: `r1_worker_${suffix}` };
  const clients: Sql[] = [], apps: INestApplication[] = [];
  function login(role: string, password: string, label: string) {
    const connection = new URL(url); connection.username = role; connection.password = password;
    const sql = postgres(connection.toString(), { max: 1, connection: { application_name: label, statement_timeout: 10000 } }); clients.push(sql); return sql;
  }
  const passwords: Record<string, string> = {};
  for (const role of Object.values(roles)) {
    passwords[role] = randomBytes(32).toString('hex');
    await db.sql.unsafe(`create role "${role}" login password '${passwords[role]}' noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await db.sql.unsafe(`grant connect on database "${name}" to "${role}"`);
    await db.sql.unsafe(`grant usage on schema public to "${role}"`);
  }
  const pub = roles.publisher, cor = roles.correlator;
  await db.sql.unsafe(`grant insert(provider,provider_event_id,event_type,signature,payload,headers),select(id,provider,provider_event_id) on public.webhook_events to "${pub}"`);
  await db.sql.unsafe(`grant select(inbox_id) on public.provider_financial_receipts,public.receipt_admissions to "${pub}"`);
  await db.sql.unsafe(`grant execute on function public.publish_admitted_receipt(uuid,text,bytea,text),public.publish_verified_receipt_delivery(uuid,text,bytea,text,jsonb,jsonb,text) to "${pub}"`);
  await db.sql.unsafe(`grant select(id,attempts) on public.webhook_events to "${cor}"`);
  await db.sql.unsafe(`grant select(inbox_id,provider,provider_account,operation) on public.receipt_admissions to "${cor}"`);
  await db.sql.unsafe(`grant select(inbox_id,normalized_payload) on public.provider_financial_receipts to "${cor}"`);
  await db.sql.unsafe(`grant select(id,provider,provider_account,source_kind,object_kind,provider_object_id) on public.provider_financial_observations to "${cor}"`);
  await db.sql.unsafe(`grant insert(inbox_id,review_key,reason,observations),select(inbox_id,review_key) on public.financial_evidence_reviews to "${cor}"`);
  await db.sql.unsafe(`grant execute on function public.seal_financial_correlation(uuid,integer,uuid),public.bind_receipt_obligation(uuid,integer) to "${cor}"`);
  await db.sql.unsafe(`grant execute on function public.inspect_receipt_admission(text,text,uuid,text,bigint,bigint) to "${roles.worker}"`);
  const publisher = login(pub, passwords[pub], `r1_publisher_${suffix}`), peer = login(pub, passwords[pub], `r1_peer_${suffix}`);
  const correlator = login(cor, passwords[cor], `r1_correlator_${suffix}`), correlationPeer = login(cor, passwords[cor], `r1_correlation_peer_${suffix}`);
  const worker = login(roles.worker, passwords[roles.worker], `r1_worker_${suffix}`);
  const stripe = new Stripe('sk_test_r1_isolated_receipt_fixture'), secret = 'whsec_isolated_evidence_fixture';
  const publication = new RestrictedReceiptDatabase(publisher, 'PUBLISHER'), peerPublication = new RestrictedReceiptDatabase(peer, 'PUBLISHER');
  const correlation = new RestrictedReceiptDatabase(correlator, 'CORRELATOR');
  const peerCorrelation = new RestrictedReceiptDatabase(correlationPeer, 'CORRELATOR');
  const receiver = (account: string, database: ReceiptTransactions = publication) => new TrustedSignedReceiptService(database, { account, webhookSecret: secret }, stripe);
  const correlate = (account: string, database: ReceiptTransactions = correlation) => new TrustedReceiptCorrelationService(database, { account, webhookSecret: secret });
  const sign = (raw: Buffer, timestamp = Math.floor(Date.now() / 1000), signingSecret = secret) => ({ raw,
    signature: stripe.webhooks.generateTestHeaderString({ payload: raw.toString('utf8'), secret: signingSecret, timestamp }) });
  async function http(service: TrustedSignedReceiptService, rawBody = true) {
    const module = await Test.createTestingModule({ controllers: [TestReceiptController], providers: [{ provide: TrustedSignedReceiptService, useValue: service }] }).compile();
    const app = module.createNestApplication({ rawBody, logger: false }); app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1'); apps.push(app);
    const server = app.getHttpServer() as Server;
    return (signed: { raw: Buffer; signature: string }, headers: Record<string, string> = {}) => ({
      async expect(status: number): Promise<{ body: ReceiptHttpBody }> {
        const response = await request(server).post('/isolated-receipts/stripe').set('Content-Type', 'application/json')
          .set('stripe-signature', signed.signature).set(headers).send(signed.raw.toString('utf8')).expect(status);
        return { body: response.body as ReceiptHttpBody };
      },
    });
  }
  const inspect = (tx: DbTransaction, f: { account: string; merchantId: string }, scope: string | null = null, intake: string | null = null) =>
    tx`select * from public.inspect_receipt_admission('STRIPE',${f.account},${f.merchantId},'USD',${scope},${intake})`;
  const read = (f: { account: string; merchantId: string }, scope: string | null = null, intake: string | null = null) => worker.begin(tx => inspect(tx, f, scope, intake));
  mkdirSync(resolve(__dirname, '../../../../.tmp'), { recursive: true });
  writeFileSync(resolve(__dirname, '../../../../.tmp/r1-signed-integration-db.txt'), name + '\n');
  return { db, roles, publisher, peer, correlator, correlationPeer, worker, publication, peerPublication, correlation, peerCorrelation, stripe, secret, receiver, correlate, sign, http, inspect, read,
    async close(expectedMigrations = 13) {
      try {
        expect((await db.sql`select count(*)::int n from capture_accounting_scopes where status='ACTIVE'`)[0].n).toBe(0);
        expect((await db.sql`select count(*)::int n from financial_evidence_accounts where runtime_enforcement<>'UNINSTALLED'`)[0].n).toBe(0);
        expect((await db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(expectedMigrations);
      } finally { for (const app of apps) await app.close(); for (const sql of clients) await sql.end(); await db.onApplicationShutdown(); }
    } };
}
