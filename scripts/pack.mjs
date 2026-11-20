#!/usr/bin/env node
/**
 * @file Builds a clean, reproducible extension ZIP package in `dist/` using the built-in ZIP library.
 * Excludes git metadata, tests, docs, scripts, and OS junk files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const zipLib = require('../src/lib/zip.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE_PATHS = ['manifest.json', 'LICENSE', 'src', 'assets'];
const EXCLUDED_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

function collectEntries(relPath, out = []) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) return out;
  const stat = fs.statSync(fullPath);

  if (stat.isDirectory()) {
    const children = fs.readdirSync(fullPath).sort();
    for (const child of children) {
      if (EXCLUDED_NAMES.has(child)) continue;
      collectEntries(path.join(relPath, child), out);
    }
  } else {
    const zipPath = relPath.split(path.sep).join('/');
    const bytes = new Uint8Array(fs.readFileSync(fullPath));
    const isCompressedBinary = /\.(png|jpe?g|webp|gif)$/i.test(zipPath);
    out.push({
      path: zipPath,
      data: bytes,
      store: isCompressedBinary,
      mtime: stat.mtime,
    });
  }
  return out;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const entries = [];
  for (const rel of INCLUDE_PATHS) {
    collectEntries(rel, entries);
  }

  const zipBytes = await zipLib.createZipBytes(entries);
  const distDir = path.join(ROOT, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  const outFile = path.join(distDir, `perlego-book-exporter-v${manifest.version}.zip`);
  fs.writeFileSync(outFile, zipBytes);

  const kb = (zipBytes.byteLength / 1024).toFixed(1);
  console.log(`Packed ${entries.length} files -> ${path.relative(ROOT, outFile)} (${kb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
