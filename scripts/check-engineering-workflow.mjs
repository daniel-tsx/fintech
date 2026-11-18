// Dependency-free check for the locally authored, cross-host engineering-workflow skill.
import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const locations = ['.agents/skills/engineering-workflow', '.claude/skills/engineering-workflow'];
const expected = ['SKILL.md', 'references/acceptance.md', 'references/correction.md', 'references/planning.md', 'references/review.md', 'references/resume.md'];
async function readTree(relative) {
  const dir = join(root, relative);
  assert(!(await lstat(dir)).isSymbolicLink(), `Skill directory must be real: ${relative}`);
  const found = {};
  async function visit(at, prefix = '') {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), `No skill symlink/junction: ${prefix}${entry.name}`);
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(at, entry.name), `${name}/`);
      else {
        assert(entry.isFile(), `Unsupported skill entry: ${name}`);
        found[name] = (await readFile(join(at, entry.name), 'utf8')).replaceAll('\r\n', '\n');
      }
    }
  }
  await visit(dir);
  assert.deepEqual(Object.keys(found).sort(), [...expected].sort(), `Unexpected files: ${relative}`);
  return found;
}
const [codex, claude] = await Promise.all(locations.map(readTree));
assert.deepEqual(codex, claude, 'Codex and Claude workflow copies differ');
assert.match(codex['SKILL.md'], /^---\nname: engineering-workflow\ndescription: .+\n---/);
for (const file of expected.slice(1)) assert(codex[file].trim().length > 100, `Empty reference: ${file}`);
for (const marker of ['DESIGN_ONLY', 'HUMAN_APPROVAL', 'two rounds', 'fresh', 'No automatic commit', 'resume.md', 'engineering-workflow-state.mjs']) {
  assert(codex['SKILL.md'].includes(marker), `Missing orchestration guard: ${marker}`);
}
const ledgerScript = (await readFile(join(root, 'scripts/engineering-workflow-state.mjs'), 'utf8')).replaceAll('\r\n', '\n');
for (const marker of ['sourceFingerprint', 'BLOCKED_EVIDENCE_CHANGED', 'correctionRoundsUsed', 'rebaseline']) {
  assert(ledgerScript.includes(marker), `Missing checkpoint/resume guard: ${marker}`);
}
// Other locally authored skills: one SKILL.md each, identical on both hosts.
for (const name of ['independent-review', 'ship-pr']) {
  const [a, b] = await Promise.all(['.agents', '.claude'].map(async (host) => {
    const dir = join(root, host, 'skills', name);
    assert.deepEqual(await readdir(dir), ['SKILL.md'], `Unexpected files: ${host}/skills/${name}`);
    return (await readFile(join(dir, 'SKILL.md'), 'utf8')).replaceAll('\r\n', '\n');
  }));
  assert.equal(a, b, `Codex and Claude copies differ: ${name}`);
  assert.match(a, new RegExp(`^---\nname: ${name}\ndescription: .+\n---`), `Bad frontmatter: ${name}`);
}
// The independent reviewer is pinned: fresh Opus 5.5 context at high effort, without write tools.
// Keys are parsed once each: a duplicate key would silently override the pin (the last one wins).
const reviewer = (await readFile(join(root, '.claude/agents/independent-reviewer.md'), 'utf8')).replaceAll('\r\n', '\n');
const front = reviewer.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
assert(front, 'independent-reviewer agent needs YAML frontmatter');
const keys = new Map();
for (const line of front.split('\n').filter((l) => /^\S/.test(l))) {
  const [, key, value] = line.match(/^([\w-]+):\s*(.*?)\s*$/) ?? [];
  assert(key, `Unparsed frontmatter line in independent-reviewer: ${line}`);
  assert(!keys.has(key), `Duplicate frontmatter key in independent-reviewer: ${key}`);
  keys.set(key, value.replace(/^(['"])(.*)\1$/, '$2'));
}
const list = (key) => (keys.get(key) ?? '').split(',').map((t) => t.trim()).filter(Boolean);
assert.equal(keys.get('name'), 'independent-reviewer');
assert.equal(keys.get('model'), 'claude-opus-5-5', 'independent-reviewer must run claude-opus-5-5');
assert.equal(keys.get('effort'), 'high', 'independent-reviewer must run at high effort');
for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
  assert(list('disallowedTools').includes(tool), `independent-reviewer must disallow ${tool}`);
  assert(!list('tools').includes(tool), `independent-reviewer must not list ${tool}`);
}
assert(!keys.has('permissionMode'), 'independent-reviewer must inherit the permission mode, not set its own');
console.log('engineering-workflow v1.1: 6 files mirrored; checkpoint/resume guards verified; independent-review and ship-pr mirrored; independent-reviewer pinned to claude-opus-5-5/high');
