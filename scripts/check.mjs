#!/usr/bin/env node
/**
 * @file Validates manifest.json, referenced icons/files, and JavaScript syntax across the repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walkFiles(dir, extensions) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) {
    throw new Error(`${filePath} is not a valid PNG file`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function main() {
  const manifestPath = path.join(ROOT, 'manifest.json');
  const pkgPath = path.join(ROOT, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  if (manifest.manifest_version !== 3) {
    throw new Error(`Expected manifest_version 3, found ${manifest.manifest_version}`);
  }
  if (manifest.version !== pkg.version) {
    throw new Error(`Version mismatch: manifest.json (${manifest.version}) !== package.json (${pkg.version})`);
  }

  // Verify declared icons exist with matching pixel dimensions
  const iconMaps = [manifest.icons, manifest.action?.default_icon].filter(Boolean);
  for (const iconMap of iconMaps) {
    for (const [sizeStr, relPath] of Object.entries(iconMap)) {
      const fullPath = path.join(ROOT, relPath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Missing icon referenced in manifest.json: ${relPath}`);
      }
      const expected = parseInt(sizeStr, 10);
      const { width, height } = readPngDimensions(fullPath);
      if (width !== expected || height !== expected) {
        throw new Error(`Icon ${relPath} is ${width}x${height}, expected ${expected}x${expected}`);
      }
    }
  }

  // Verify popup & service worker files exist
  const requiredPaths = [
    manifest.action?.default_popup,
    manifest.background?.service_worker,
  ].filter(Boolean);
  for (const relPath of requiredPaths) {
    const fullPath = path.join(ROOT, relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Missing extension entry referenced in manifest.json: ${relPath}`);
    }
  }

  // Syntax-check all JS/MJS files
  const jsFiles = [
    ...walkFiles(path.join(ROOT, 'src'), ['.js', '.mjs']),
    ...walkFiles(path.join(ROOT, 'tests'), ['.js', '.mjs']),
    ...walkFiles(path.join(ROOT, 'scripts'), ['.js', '.mjs']),
  ];
  for (const file of jsFiles) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }

  console.log(`Check passed: manifest v3 (${manifest.version}), icons verified, ${jsFiles.length} JS/MJS files syntax-checked.`);
}

main();
