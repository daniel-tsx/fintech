import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 1 && args[0] === '--check'),
  'Usage: node scripts/sync-agent-skills.mjs [--check]');
const check = args.includes('--check');
const manifest = JSON.parse(await readFile(join(root, '.agents/skill-sources.json'), 'utf8'));
const hash = (data) => createHash('sha256').update(data).digest('hex');

async function filesAt(directory) {
  assert(!(await lstat(directory)).isSymbolicLink(), `Use a real directory: ${directory}`);
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), `Use real files: ${join(directory, entry.name)}`);
    if (entry.isDirectory()) {
      files.push(...(await filesAt(join(directory, entry.name))).map((file) => `${entry.name}/${file}`));
    } else {
      assert(entry.isFile(), `Unsupported entry: ${entry.name}`);
      files.push(entry.name);
    }
  }
  return files.sort();
}

for (const skill of manifest.skills) {
  const source = join(root, '.agents/skills', skill.name);
  const target = join(root, '.claude/skills', skill.name);
  const files = Object.keys(skill.files).sort();
  assert(files.includes('SKILL.md') && files.some((file) => /^LICENSE(\.txt)?$/.test(file)), `Incomplete skill: ${skill.name}`);
  assert.deepEqual(await filesAt(source), files, `Unrecorded source files: ${skill.name}`);
  const copies = [];
  for (const file of files) {
    const data = await readFile(join(source, file));
    // Normalize line endings so Git's Windows checkout policy does not break integrity checks.
    assert.equal(hash(data.toString('utf8').replaceAll('\r\n', '\n')), skill.files[file],
      `Source changed; review provenance and update its hash: ${skill.name}/${file}`);
    copies.push([file, data]);
  }
  if (!check) await mkdir(target, { recursive: true });
  const existing = await filesAt(target);
  assert(existing.every((file) => files.includes(file)), `Unexpected Claude files: ${skill.name}`);
  for (const [file, data] of copies) {
    const destination = join(target, file);
    if (check) {
      assert.equal((await readFile(destination, 'utf8')).replaceAll('\r\n', '\n'),
        data.toString('utf8').replaceAll('\r\n', '\n'), `Out of sync: ${skill.name}/${file}`);
    } else {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, data);
    }
  }
  console.log(`${check ? 'Checked' : 'Synced'} ${skill.name}: ${files.length} files`);
}
