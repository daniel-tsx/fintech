import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let activeChild;
let interrupted = false;

function command(file, args, { capture = false, env = process.env, cleanup = false } = {}) {
  return new Promise((accept, reject) => {
    if (interrupted && !cleanup) return reject(new Error('Verification interrupted'));
    const child = spawn(file, args, { cwd: root, env, windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    activeChild = child;
    let output = '';
    child.stdout?.on('data', (data) => { output += data; });
    // Availability diagnostics contain no application configuration or credentials.
    let diagnostic = '';
    child.stderr?.on('data', (data) => { diagnostic += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (code === 0) accept(output.trim());
      else reject(new Error(`${file} exited ${code ?? signal}${capture ? `: ${diagnostic.trim()}` : ''}`));
    });
  });
}

// Inject only command execution for tests; all resource identities are generated here.
export async function verifyIntegration({ run = command, env = process.env, log = console.log } = {}) {
  const project = `fintech-verify-${randomUUID()}`;
  const compose = ['compose', '-p', project, '-f', join(root, 'docker-compose.yml'),
    '-f', join(root, 'docker-compose.integration.yml')];
  const composeRun = (args, options) => run('docker', [...compose, ...args], options);
  const directory = join(root, '.tmp', project);
  const resultFile = join(directory, 'jest.json');
  let started = false;
  let stage = 'Docker availability';
  let status = 0;
  log(`Verification project: ${project}`);
  try {
    assert(env.npm_execpath, 'Run through pnpm test:integration:docker');
    await run('docker', ['info', '--format', '{{.ServerVersion}}'], { capture: true });
    await run('docker', ['compose', 'version'], { capture: true });
    stage = 'isolated Compose configuration';
    const config = JSON.parse(await composeRun(['config', '--format', 'json'], { capture: true }));
    const pg = config.services.postgres;
    assert.equal(config.name, project);
    assert(!pg.container_name && !pg.network_mode && !pg.depends_on, 'Postgres must remain independently isolated');
    assert.equal(pg.ports.length, 1);
    assert.equal(pg.ports[0].host_ip, '127.0.0.1');
    assert.equal(pg.ports[0].target, 5432);
    assert(!pg.ports[0].published || pg.ports[0].published === '0', 'Host port must be dynamically allocated');
    for (const resource of [...Object.values(config.volumes ?? {}), ...Object.values(config.networks ?? {})]) {
      assert(!resource.external && resource.name.startsWith(`${project}_`), 'Use only run-owned volumes and networks');
    }
    assert(pg.volumes.every((volume) => volume.type === 'volume' && config.volumes[volume.source]), 'No host bind mounts');
    assert(pg.environment.POSTGRES_USER === 'fintech' && pg.environment.POSTGRES_PASSWORD === 'fintech'
      && pg.environment.POSTGRES_DB === 'fintech_lab', 'Use the checked-in disposable fixture credentials');
    await mkdir(directory, { recursive: true });
    const emptyEnv = join(directory, 'empty.env');
    await writeFile(emptyEnv, '', { flag: 'wx' });
    stage = 'Docker startup';
    started = true; // Even a partially failed startup must be cleaned up.
    await composeRun(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres']);
    const binding = await composeRun(['port', 'postgres', '5432'], { capture: true });
    const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
    assert(port && Number(port) > 0 && Number(port) <= 65535, 'Expected one allocated localhost port');
    const testEnv = { ...env, NODE_ENV: 'test', RUN_DB_TESTS: '1', RUN_MIGRATION_TESTS: '1',
      DATABASE_URL: `postgres://fintech:fintech@127.0.0.1:${port}/fintech_lab`,
      MIGRATION_ADMIN_URL: `postgres://fintech:fintech@127.0.0.1:${port}/postgres`,
      REDIS_URL: 'redis://127.0.0.1:1', RABBITMQ_URL: 'amqp://guest:guest@127.0.0.1:1',
      STRIPE_SECRET_KEY: 'sk_test_placeholder', STRIPE_WEBHOOK_SECRET: 'whsec_placeholder' };
    // dotenv/config must not redirect migrations through an inherited file, override or vault key.
    for (const key of Object.keys(testEnv)) if (key.toUpperCase().startsWith('DOTENV_')) delete testEnv[key];
    testEnv.DOTENV_CONFIG_PATH = emptyEnv;
    const pnpm = (args) => run(process.execPath, [env.npm_execpath, ...args], { env: testEnv });
    stage = 'migrations';
    await pnpm(['db:migrate']);
    log('PASS migrations: checked-in chain applied to the isolated database');
    stage = 'integration tests';
    await pnpm(['test:integration', '--json', '--outputFile', resultFile, '--cacheDirectory', join(directory, 'jest-cache')]);
    const result = JSON.parse(await readFile(resultFile, 'utf8'));
    assert(result.success && result.numPassedTests > 0 && result.numFailedTests === 0, 'No passing test evidence');
    log(`PASS integration tests: ${result.numPassedTests} passed, ${result.numPendingTests} skipped; evidence: ${resultFile}`);
  } catch (error) {
    status = stage === 'Docker availability' ? 2 : 1;
    log(`${status === 2 ? 'NOT RUN' : 'FAIL'} ${stage}: ${error.message}`);
    if (stage !== 'integration tests') log(`NOT RUN integration tests: ${stage} did not complete`);
  } finally {
    if (started) {
      try {
        await composeRun(['down', '--volumes', '--timeout', '10'], { cleanup: true });
        log(`PASS cleanup: removed only project ${project}`);
      } catch (error) {
        status = 1;
        log(`FAIL cleanup for ${project}: ${error.message}; retry this project's compose down --volumes only`);
      }
    }
  }
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Let the active command end and the finally block remove this run's resources.
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    interrupted = true;
    activeChild?.kill(signal);
  });
  const status = await verifyIntegration();
  process.exitCode = interrupted ? 130 : status;
}
