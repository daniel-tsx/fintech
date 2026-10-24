import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { specArtifacts, verifyIntegration } from './test-integration-docker.mjs';

async function scenario({ fail, unsafe, passed = 4, tmpRoot, specFiles = [] } = {}) {
  const calls = [];
  const messages = [];
  const env = { npm_execpath: '/fixture/pnpm.cjs', DATABASE_URL: 'existing-database', MIGRATION_ADMIN_URL: 'existing-admin',
    REDIS_URL: 'existing-redis', RABBITMQ_URL: 'existing-broker', STRIPE_SECRET_KEY: 'existing-provider',
    DOTENV_CONFIG_OVERRIDE: 'true', DOTENV_CONFIG_PATH: '/fixture/existing.env', DOTENV_KEY: 'existing-vault-key' };
  const run = async (file, args, options = {}) => {
    const step = args.includes('info') ? 'availability' : args.includes('config') ? 'config'
      : args.includes('up') ? 'startup' : args.includes('db:migrate') ? 'migration'
        : args.includes('test:integration') ? 'tests' : args.includes('down') ? 'cleanup' : 'other';
    calls.push({ file, args, options, step });
    if (step === fail) throw new Error(`fixture ${step} failure`);
    if (step === 'config') {
      const project = args[args.indexOf('-p') + 1];
      return JSON.stringify({ name: project, services: { postgres: {
        ports: [{ host_ip: '127.0.0.1', target: 5432 }],
        environment: { POSTGRES_USER: 'fintech', POSTGRES_PASSWORD: 'fintech', POSTGRES_DB: 'fintech_lab' },
        volumes: [{ type: unsafe === 'bind' ? 'bind' : 'volume', source: 'database' }],
      } }, volumes: { database: { name: `${project}_database`, external: unsafe === 'external' } },
      networks: { default: { name: `${project}_default` } } });
    }
    if (args.includes('port')) return '127.0.0.1:55439';
    if (step === 'tests') {
      await writeFile(args[args.indexOf('--outputFile') + 1], JSON.stringify({
        success: true, numPassedTests: passed, numFailedTests: 0, numPendingTests: 2,
      }));
      for (const name of specFiles) await writeFile(join(tmpRoot, name), 'fixture\n');
    }
    return '';
  };
  // Never touch the repository's real .tmp/ from unit tests.
  tmpRoot ??= await mkdtemp(join(tmpdir(), 'verify-tmp-'));
  const status = await verifyIntegration({ run, env, log: (message) => messages.push(message), tmpRoot });
  return { status, calls, messages, env };
}

test('uses existing scripts with isolated URLs, dynamic ports and one owned cleanup', async () => {
  const result = await scenario();
  assert.equal(result.status, 0);
  const composeCalls = result.calls.filter(({ args }) => args[0] === 'compose' && args.includes('-p'));
  const projects = new Set(composeCalls.map(({ args }) => args[args.indexOf('-p') + 1]));
  assert.equal(projects.size, 1);
  assert.match([...projects][0], /^fintech-verify-[0-9a-f-]{36}$/);
  const migration = result.calls.find(({step}) => step === 'migration');
  assert.equal(migration.options.env.DATABASE_URL, 'postgres://fintech:fintech@127.0.0.1:55439/fintech_lab');
  assert.equal(migration.options.env.MIGRATION_ADMIN_URL, 'postgres://fintech:fintech@127.0.0.1:55439/postgres');
  assert.equal(migration.options.env.RUN_DB_TESTS, '1');
  assert.equal(migration.options.env.RUN_MIGRATION_TESTS, '1');
  assert.equal(migration.options.env.STRIPE_SECRET_KEY, 'sk_test_placeholder');
  assert.equal(result.env.DATABASE_URL, 'existing-database');
  assert.equal(result.calls.filter(({step}) => step === 'cleanup').length, 1);
  assert.equal(result.calls.at(-1).step, 'cleanup');
  assert(result.messages.some((line) => line.includes('4 passed, 2 skipped')));
});

test('unavailable Docker is NOT RUN and starts or removes no resources', async () => {
  const result = await scenario({ fail: 'availability' });
  assert.equal(result.status, 2);
  assert.equal(result.calls.length, 1);
  assert(result.messages.some((line) => line.startsWith('NOT RUN integration tests:')));
});

test('the installed dotenv loader cannot replace isolated URLs with an inherited env file', async () => {
  const result = await scenario();
  const childEnv = result.calls.find(({ step }) => step === 'migration').options.env;
  const existingFile = join(dirname(childEnv.DOTENV_CONFIG_PATH), 'existing.env');
  await mkdir(dirname(existingFile), { recursive: true }); // a passing run removes its own directory
  await writeFile(existingFile, 'DATABASE_URL=existing-database\nMIGRATION_ADMIN_URL=existing-admin\n');
  const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const dotenv = createRequire(apiRequire.resolve('@nestjs/config')).resolve('dotenv/config');
  const load = (env) => {
    const child = spawnSync(process.execPath, ['--require', dotenv, '-e',
      'process.stdout.write(JSON.stringify([process.env.DATABASE_URL, process.env.MIGRATION_ADMIN_URL]))'],
    { env, encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  assert.deepEqual(load({ ...childEnv, DOTENV_CONFIG_PATH: existingFile, DOTENV_CONFIG_OVERRIDE: 'true' }),
    ['existing-database', 'existing-admin']);
  assert.deepEqual(load(childEnv), [childEnv.DATABASE_URL, childEnv.MIGRATION_ADMIN_URL]);
  assert.equal(childEnv.DOTENV_CONFIG_OVERRIDE, undefined);
  assert.equal(childEnv.DOTENV_KEY, undefined);
  assert.equal(result.env.DOTENV_CONFIG_OVERRIDE, 'true');
});

for (const unsafe of ['bind', 'external']) test(`rejects ${unsafe} resources before starting Docker`, async () => {
  const result = await scenario({ unsafe });
  assert.equal(result.status, 1);
  assert(!result.calls.some(({step}) => step === 'startup' || step === 'cleanup'));
});

for (const fail of ['startup', 'migration', 'tests', 'cleanup']) test(`${fail} failure is nonzero with scoped cleanup`, async () => {
  const result = await scenario({ fail });
  assert.equal(result.status, 1);
  assert.equal(result.calls.at(-1).step, 'cleanup');
  assert(result.messages.some((line) => line.startsWith('FAIL ')));
  if (fail !== 'cleanup') assert(!result.messages.some((line) => line.startsWith('PASS integration tests:')));
  if (fail === 'startup' || fail === 'migration') assert(!result.calls.some(({step}) => step === 'tests'));
});

test('zero executed tests cannot be reported as PASS', async () => {
  const result = await scenario({ passed: 0 });
  assert.equal(result.status, 1);
  assert(!result.messages.some((line) => line.startsWith('PASS integration tests:')));
  assert.equal(result.calls.at(-1).step, 'cleanup');
});

const UUID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const SPEC_FILES = [`r2a-migrations-${UUID}`, 'r0-independent-regression-db.txt', 'r2b11-committed.json'];

test('a passing run removes its Jest output and spec byproducts, and nothing else', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'verify-tmp-'));
  await mkdir(join(tmpRoot, 'other-task'));
  await writeFile(join(tmpRoot, `stale-${UUID}`), 'from an earlier run\n');
  const result = await scenario({ tmpRoot, specFiles: SPEC_FILES });
  assert.equal(result.status, 0);
  assert.deepEqual((await readdir(tmpRoot)).sort(), ['other-task', `stale-${UUID}`]);
  assert(result.messages.some((line) => line.includes('removed this run') && line.includes('3 spec artifact(s)')));
});

test('a failing run keeps its evidence and gathers its spec byproducts', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'verify-tmp-'));
  const result = await scenario({ tmpRoot, specFiles: SPEC_FILES, passed: 0 });
  assert.equal(result.status, 1);
  const [project] = await readdir(tmpRoot);
  assert.match(project, /^fintech-verify-/);
  assert.deepEqual((await readdir(join(tmpRoot, project, 'artifacts'))).sort(), [...SPEC_FILES].sort());
});

test('only new spec-shaped names are attributed to a run', () => {
  const before = new Set(['old-db.txt']);
  assert.deepEqual(specArtifacts(before, ['old-db.txt', 'new-db.txt', 'refund-error-message-test', `fintech-verify-${UUID}`,
    'agent-workflows', `x-${UUID}`, 'r2b11-committed.json', 'plan.md'], 'fintech-verify-self'),
  ['new-db.txt', `x-${UUID}`, 'r2b11-committed.json']);
});
