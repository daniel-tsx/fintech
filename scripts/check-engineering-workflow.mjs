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
for (const name of ['codex-review', 'ship-pr']) {
  const [a, b] = await Promise.all(['.agents', '.claude'].map(async (host) => {
    const dir = join(root, host, 'skills', name);
    assert.deepEqual(await readdir(dir), ['SKILL.md'], `Unexpected files: ${host}/skills/${name}`);
    return (await readFile(join(dir, 'SKILL.md'), 'utf8')).replaceAll('\r\n', '\n');
  }));
  assert.equal(a, b, `Codex and Claude copies differ: ${name}`);
  assert.match(a, new RegExp(`^---\nname: ${name}\ndescription: .+\n---`), `Bad frontmatter: ${name}`);
}
console.log('engineering-workflow v1.1: 6 files mirrored; checkpoint/resume guards verified; codex-review and ship-pr mirrored');
