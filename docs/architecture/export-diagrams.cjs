// Re-export the editable SVGs. Uses existing sharp; no app dependencies change.
// Usage: node docs/architecture/export-diagrams.cjs [path/to/node_modules]
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const resolve = process.argv[2]
  ? createRequire(path.resolve(process.argv[2], '__diagram_export__.cjs'))
  : require;
const sharp = resolve('sharp');

(async () => {
  for (const name of ['system-overview', 'capture-flow-durable-boundaries']) {
    const source = path.join(__dirname, `${name}.svg`);
    const target = path.join(__dirname, `${name}.png`);
    await sharp(await fs.readFile(source), { density: 144 })
      .resize({ width: 2400 })
      .png()
      .toFile(target);
    const { width, height } = await sharp(target).metadata();
    console.log(`${name}.png: ${width} x ${height}`);
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
