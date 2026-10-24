import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationHistory, DIR } from './check-migration-history.mjs';

const J = `${DIR}/meta/_journal.json`;
const entry = (idx, tag) => ({ idx, version: '7', when: 1000 + idx, tag, breakpoints: true });
const journal = (...entries) => JSON.stringify({ version: '7', dialect: 'postgresql', entries });
const base = () => new Map([
  [`${DIR}/0000_a.sql`, 'create table a();'],
  [`${DIR}/0001_b.sql`, 'create table b();'],
  [`${DIR}/meta/0000_snapshot.json`, '{"id":"0"}'],
  [J, journal(entry(0, '0000_a'), entry(1, '0001_b'))],
]);
const withChanges = (fn) => { const head = base(); fn(head); return checkMigrationHistory(base(), head); };

test('unchanged history passes', () => assert.deepEqual(checkMigrationHistory(base(), base()), []));

test('appending a migration, journal entry and snapshot passes', () => {
  assert.deepEqual(withChanges((h) => {
    h.set(`${DIR}/0002_c.sql`, 'create table c();');
    h.set(`${DIR}/meta/0002_snapshot.json`, '{"id":"2"}');
    h.set(J, journal(entry(0, '0000_a'), entry(1, '0001_b'), entry(2, '0002_c')));
  }), []);
});

test('modified SQL migration fails', () => {
  assert.match(withChanges((h) => h.set(`${DIR}/0000_a.sql`, 'drop table a;')).join(), /Modified: .*0000_a\.sql/);
});

test('deleted SQL migration fails', () => {
  assert.match(withChanges((h) => h.delete(`${DIR}/0001_b.sql`)).join(), /Deleted or renamed: .*0001_b\.sql/);
});

test('renamed SQL migration fails', () => {
  assert.match(withChanges((h) => { h.set(`${DIR}/0001_renamed.sql`, h.get(`${DIR}/0001_b.sql`)); h.delete(`${DIR}/0001_b.sql`); }).join(), /Deleted or renamed/);
});

test('modified or deleted snapshot fails', () => {
  assert.match(withChanges((h) => h.set(`${DIR}/meta/0000_snapshot.json`, '{"id":"x"}')).join(), /Modified: .*0000_snapshot/);
  assert.match(withChanges((h) => h.delete(`${DIR}/meta/0000_snapshot.json`)).join(), /Deleted or renamed: .*0000_snapshot/);
});

test('edited journal entry fails', () => {
  assert.match(withChanges((h) => h.set(J, journal(entry(0, '0000_a'), { ...entry(1, '0001_b'), when: 1 }))).join(), /entry 1 .*changed/);
});

test('reordered journal entries fail', () => {
  assert.match(withChanges((h) => h.set(J, journal(entry(1, '0001_b'), entry(0, '0000_a')))).join(), /reordered/);
});

test('removed journal entry fails', () => {
  assert.match(withChanges((h) => h.set(J, journal(entry(0, '0000_a')))).join(), /entry 1 .*removed/);
});

test('appended journal entry needs its SQL file and next idx', () => {
  const problems = withChanges((h) => h.set(J, journal(entry(0, '0000_a'), entry(1, '0001_b'), entry(5, '0002_c')))).join();
  assert.match(problems, /idx 5, expected 2/);
  assert.match(problems, /no .*0002_c\.sql/);
});
