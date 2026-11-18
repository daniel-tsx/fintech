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
// The independent reviewer is pinned: fresh Opus 5.5 context at high effort, with an explicit
// read-only tool allowlist. Without `tools` an agent inherits every parent and MCP tool (and
// `disallowedTools` is ignored once `tools` is set), so the allowlist is the real restriction.
// Keys are parsed once each (a duplicate key silently overrides: the last one wins), and only
// known keys are allowed (hooks, permissionMode, mcpServers, background, maxTurns could each
// weaken or bypass the review).
const REVIEWER_KEYS = new Set(['name', 'description', 'model', 'effort', 'tools', 'disallowedTools', 'color']);
const REVIEWER_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash']);
const reviewer = (await readFile(join(root, '.claude/agents/independent-reviewer.md'), 'utf8')).replace(/^﻿/, '').replaceAll('\r\n', '\n');
const front = reviewer.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
assert(front, 'independent-reviewer agent needs YAML frontmatter');
const keys = new Map();
let listKey = null; // a `key:` with an empty value followed by `  - item` lines
for (const raw of front.split('\n')) {
  const line = raw.replace(/\s+#.*$/, '').trimEnd();
  if (!line.trim() || line.trim().startsWith('#')) continue;
  const item = line.match(/^\s+-\s+(.+)$/);
  if (item && listKey) { keys.get(listKey).push(item[1].replace(/^(['"])(.*)\1$/, '$2')); continue; }
  if (/^\s/.test(line)) continue; // continuation of a folded or multi-line scalar (description)
  const [, key, value] = line.match(/^([\w-]+):\s*(.*)$/) ?? [];
  assert(key, `Unparsed frontmatter line in independent-reviewer: ${raw}`);
  assert(REVIEWER_KEYS.has(key), `Unexpected frontmatter key in independent-reviewer: ${key}`);
  assert(!keys.has(key), `Duplicate frontmatter key in independent-reviewer: ${key}`);
  listKey = value === '' ? key : null;
  const flow = value.match(/^\[(.*)\]$/);
  const scalar = value.replace(/^(['"])(.*)\1$/, '$2');
  keys.set(key, value === '' ? [] : flow ? flow[1].split(',') : scalar.includes(',') ? scalar.split(',') : scalar);
}
const list = (key) => [keys.get(key) ?? []].flat().map((t) => t.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean);
assert.equal(keys.get('name'), 'independent-reviewer');
assert.equal(keys.get('model'), 'claude-opus-5-5', 'independent-reviewer must run claude-opus-5-5');
assert.equal(keys.get('effort'), 'high', 'independent-reviewer must run at high effort');
assert(list('tools').length, 'independent-reviewer must declare a tools allowlist');
for (const tool of list('tools')) assert(REVIEWER_TOOLS.has(tool), `independent-reviewer tool not allowed: ${tool}`);
for (const tool of ['Write', 'Edit', 'NotebookEdit']) assert(list('disallowedTools').includes(tool), `independent-reviewer must disallow ${tool}`);
// The separate-session command overrides the frontmatter, so it must carry the same pin.
for (const dir of ['.agents', '.claude']) {
  const skill = await readFile(join(root, dir, 'skills/independent-review/SKILL.md'), 'utf8');
  for (const flags of skill.match(/claude -p --agent independent-reviewer[^\n]*/g) ?? ['(missing)']) {
    assert(flags.includes('--model claude-opus-5-5 --effort high'), `${dir} independent-review command must pin --model claude-opus-5-5 --effort high`);
  }
}
console.log('engineering-workflow v1.1: 6 files mirrored; checkpoint/resume guards verified; independent-review and ship-pr mirrored; independent-reviewer pinned to claude-opus-5-5/high');
