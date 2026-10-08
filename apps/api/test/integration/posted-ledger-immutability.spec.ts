import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DatabaseService, type DbTransaction } from '../../src/database/database.service';
import { LedgerService } from '../../src/ledger/ledger.service';

const describeDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function outcome(promise: Promise<unknown>) {
  return promise.then(
    () => ({ status: 'fulfilled' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
}

describeDatabase('PostgreSQL posted ledger immutability (F02)', () => {
  let database: DatabaseService;
  let ledger: LedgerService;
  let merchantId: string;
  let cashId: string;
  let availableId: string;

  beforeAll(() => {
    database = new DatabaseService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://fintech:fintech@localhost:5432/fintech_lab' }));
    ledger = new LedgerService(database);
  });

  beforeEach(async () => {
    merchantId = randomUUID();
    await database.sql`insert into merchants (id,name) values (${merchantId},'F02 ledger test merchant')`;
    await database.sql`insert into ledger_accounts (merchant_id,code,account_type,currency,name) values
      (null,'PLATFORM_CASH','ASSET','USD','Cash'),
      (${merchantId},'MERCHANT_AVAILABLE','LIABILITY','USD','Available') on conflict do nothing`;
    const [cash] = await database.sql<{ id: string }[]>`select id from ledger_accounts where merchant_id is null and code='PLATFORM_CASH' and currency='USD'`;
    const [available] = await database.sql<{ id: string }[]>`select id from ledger_accounts where merchant_id=${merchantId} and code='MERCHANT_AVAILABLE' and currency='USD'`;
    cashId = cash.id;
    availableId = available.id;
  });

  afterAll(async () => { await database.onApplicationShutdown(); });

  async function draft(tx: DbTransaction, reversalOfId: string | null = null): Promise<string> {
    const [journal] = await tx<{ id: string }[]>`insert into ledger_transactions
      (merchant_id,business_type,business_id,currency,description,reversal_of_id)
      values (${merchantId},'F02_TEST',${randomUUID()},'USD','F02 regression',${reversalOfId}) returning id`;
    return journal.id;
  }

  async function pair(tx: DbTransaction, journalId: string, amount = 100): Promise<void> {
    await tx`insert into ledger_entries (transaction_id,account_id,currency,debit,credit) values
      (${journalId},${cashId},'USD',${amount},0),(${journalId},${availableId},'USD',0,${amount})`;
  }

  async function balancedDraft(): Promise<string> {
    return database.transaction(async (tx) => {
      const id = await draft(tx);
      await pair(tx, id);
      return id;
    });
  }

  async function post(tx: DbTransaction, id: string): Promise<void> {
    await tx`update ledger_transactions set status='POSTED',posted_at=now() where id=${id}`;
  }

  async function totals(id: string) {
    const [row] = await database.sql<{ status: string; entries: number; debit: string; credit: string }[]>`
      select t.status,count(e.id)::integer as entries,coalesce(sum(e.debit),0)::text as debit,coalesce(sum(e.credit),0)::text as credit
      from ledger_transactions t left join ledger_entries e on e.transaction_id=t.id where t.id=${id} group by t.id`;
    return row;
  }

  async function waitForBlockedOrFinished(pid: number, finished: () => boolean): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (finished()) return;
      const [row] = await database.sql<{ blocked: boolean }[]>`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`;
      if (row.blocked) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Concurrent ledger writer neither blocked nor finished');
  }

  it('rejects a balanced pair appended to a POSTED journal (audit case A)', async () => {
    const id = await balancedDraft();
    await database.transaction((tx) => post(tx, id));
    const append = await outcome(database.transaction((tx) => pair(tx, id, 50)));
    expect({ outcome: append.status, ...await totals(id) }).toEqual({ outcome: 'rejected', status: 'POSTED', entries: 2, debit: '100', credit: '100' });
    if (append.status === 'rejected') expect(String(append.error)).toMatch(/DRAFT/i);
  });

  it('serializes an append against posting after immediate balance checks (audit case B)', async () => {
    const id = await balancedDraft();
    const checked = gate();
    const releasePosting = gate();
    const writerStarted = gate();
    let writerPid = 0;
    let writerFinished = false;
    const posting = outcome(database.transaction(async (tx) => {
      await post(tx, id);
      await tx`set constraints all immediate`;
      checked.open();
      await releasePosting.promise;
    }));
    await checked.promise;
    const appending = outcome(database.transaction(async (tx) => {
      await tx`set local statement_timeout='5s'`;
      const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      writerPid = backend.pid;
      writerStarted.open();
      await tx`insert into ledger_entries (transaction_id,account_id,currency,debit,credit) values (${id},${cashId},'USD',100,0)`;
    })).finally(() => { writerFinished = true; });
    try {
      await writerStarted.promise;
      await waitForBlockedOrFinished(writerPid, () => writerFinished);
    } finally {
      releasePosting.open();
    }
    const results = await Promise.all([posting, appending]);
    expect({ outcomes: results.map((result) => result.status), ...await totals(id) }).toEqual({ outcomes: ['fulfilled', 'rejected'], status: 'POSTED', entries: 2, debit: '100', credit: '100' });
    if (results[1].status === 'rejected') expect(String(results[1].error)).toMatch(/DRAFT/i);
  });

  it('rejects posting at commit when an unbalanced draft append commits first', async () => {
    const id = await balancedDraft();
    await database.transaction(async (tx) => {
      await tx`insert into ledger_entries (transaction_id,account_id,currency,debit,credit) values (${id},${cashId},'USD',100,0)`;
    });
    let reachedCommit = false;
    await expect(database.transaction(async (tx) => {
      await post(tx, id);
      reachedCommit = true;
    })).rejects.toThrow(/not balanced/i);
    expect(reachedCommit).toBe(true);
    expect(await totals(id)).toEqual({ status: 'DRAFT', entries: 3, debit: '200', credit: '100' });
  });

  it('rejects a stale repeatable-read posting snapshot after another draft writer commits', async () => {
    const id = await balancedDraft();
    const snapshotTaken = gate();
    const releasePosting = gate();
    const posting = outcome(database.sql.begin('isolation level repeatable read', async (tx) => {
      await tx`select id from ledger_transactions where id=${id}`;
      snapshotTaken.open();
      await releasePosting.promise;
      await post(tx, id);
    }));
    try {
      await snapshotTaken.promise;
      await database.transaction(async (tx) => {
        await tx`insert into ledger_entries (transaction_id,account_id,currency,debit,credit) values (${id},${cashId},'USD',100,0)`;
      });
    } finally {
      releasePosting.open();
    }
    const result = await posting;
    expect({ outcome: result.status, ...await totals(id) }).toEqual({ outcome: 'rejected', status: 'DRAFT', entries: 3, debit: '200', credit: '100' });
    if (result.status === 'rejected') expect(result.error).toHaveProperty('code', '40001');
  });

  it.each(['update', 'delete'])('rejects entry %s after posting (audit case C)', async (operation) => {
    const id = await balancedDraft();
    await database.transaction((tx) => post(tx, id));
    await expect(database.transaction(async (tx) => {
      if (operation === 'update') await tx`update ledger_entries set debit=200 where transaction_id=${id} and account_id=${cashId}`;
      else await tx`delete from ledger_entries where transaction_id=${id}`;
    })).rejects.toThrow(/Ledger entries are immutable/i);
    expect(await totals(id)).toEqual({ status: 'POSTED', entries: 2, debit: '100', credit: '100' });
  });

  it.each(['description', 'status', 'delete'])('rejects POSTED header %s mutation', async (operation) => {
    const id = await balancedDraft();
    await database.transaction((tx) => post(tx, id));
    await expect(database.transaction(async (tx) => {
      if (operation === 'description') await tx`update ledger_transactions set description='Rewritten' where id=${id}`;
      else if (operation === 'status') await tx`update ledger_transactions set status='DRAFT' where id=${id}`;
      else await tx`delete from ledger_transactions where id=${id}`;
    })).rejects.toThrow(/Posted ledger transactions are immutable/i);
    expect(await totals(id)).toEqual({ status: 'POSTED', entries: 2, debit: '100', credit: '100' });
  });

  it.each(['entries', 'transactions'])('rejects TRUNCATE of ledger %s', async (table) => {
    const id = await balancedDraft();
    await database.transaction((tx) => post(tx, id));
    await expect(database.transaction(async (tx) => {
      if (table === 'entries') await tx`truncate table ledger_entries`;
      else await tx`truncate table ledger_transactions cascade`;
      // Roll back even on the old schema, keeping the shared test history intact.
      throw new Error('TRUNCATE was accepted');
    })).rejects.toThrow(/Cannot truncate ledger history/i);
    expect(await totals(id)).toEqual({ status: 'POSTED', entries: 2, debit: '100', credit: '100' });
  });

  it('permits atomic DRAFT construction, posting and commit (audit case D)', async () => {
    const id = await database.transaction(async (tx) => {
      const journalId = await draft(tx);
      await pair(tx, journalId);
      await post(tx, journalId);
      return journalId;
    });
    expect(await totals(id)).toEqual({ status: 'POSTED', entries: 2, debit: '100', credit: '100' });
  });

  it('preserves LedgerService posting and duplicate business-reference replay', async () => {
    const input = { merchantId, businessType: 'F02_SERVICE', businessId: randomUUID(), currency: 'USD', description: 'Normal posting', lines: [
      { accountCode: 'PLATFORM_CASH' as const, merchantId: null, debit: 100 },
      { accountCode: 'MERCHANT_AVAILABLE' as const, merchantId, credit: 100 },
    ] };
    const id = await database.transaction((tx) => ledger.post(tx, input));
    expect(await database.transaction((tx) => ledger.post(tx, input))).toBe(id);
    expect(await totals(id)).toEqual({ status: 'POSTED', entries: 2, debit: '100', credit: '100' });
  });

  it('still rejects mixed entry/journal currencies at commit', async () => {
    await expect(database.transaction(async (tx) => {
      const id = await draft(tx);
      await pair(tx, id);
      await tx`insert into ledger_entries (transaction_id,account_id,currency,debit,credit) values
        (${id},${cashId},'EUR',50,0),(${id},${availableId},'EUR',0,50)`;
      await post(tx, id);
    })).rejects.toThrow(/not balanced in one currency/i);
  });

  it.each([100, 99])('validates a credit of %i with public excluded from the session search path', async (credit) => {
    const posting = database.transaction(async (tx) => {
      await tx`set local search_path=pg_catalog`;
      const [journal] = await tx<{ id: string }[]>`insert into public.ledger_transactions
        (merchant_id,business_type,business_id,currency,description)
        values (${merchantId},'F02_FUNCTION_CONTEXT',${randomUUID()},'USD','Qualified posting') returning id`;
      await tx`insert into public.ledger_entries (transaction_id,account_id,currency,debit,credit) values
        (${journal.id},${cashId},'USD',100,0),(${journal.id},${availableId},'USD',0,${credit})`;
      await tx`update public.ledger_transactions set status='POSTED',posted_at=now() where id=${journal.id}`;
      const [context] = await tx<{ path: string }[]>`select current_setting('search_path') as path`;
      expect(context.path).toBe('pg_catalog');
      return journal.id;
    });
    if (credit === 100) {
      const id = await posting;
      expect(await totals(id)).toEqual({ status: 'POSTED', entries: 2, debit: '100', credit: '100' });
    } else {
      await expect(posting).rejects.toThrow(/not balanced in one currency/i);
    }
  });

  it('permits a new balanced correction journal referencing the immutable original', async () => {
    const original = await balancedDraft();
    await database.transaction((tx) => post(tx, original));
    const correction = await database.transaction(async (tx) => {
      const id = await draft(tx, original);
      await tx`insert into ledger_entries (transaction_id,account_id,currency,debit,credit) values
        (${id},${availableId},'USD',100,0),(${id},${cashId},'USD',0,100)`;
      await post(tx, id);
      return id;
    });
    const [row] = await database.sql<{ reversal_of_id: string }[]>`select reversal_of_id from ledger_transactions where id=${correction}`;
    expect(row.reversal_of_id).toBe(original);
    expect(await totals(original)).toEqual({ status: 'POSTED', entries: 2, debit: '100', credit: '100' });
    expect(await ledger.balances(merchantId)).toEqual([{ currency: 'USD', pending: '0', available: '0' }]);
  });
});
