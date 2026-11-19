#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { reconstructTimeline, DISCLAIMER } from '../src/index.js';

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('用法: node bin/cli.js <events.json> [config.json]');
    process.exit(1);
  }

  const raw = JSON.parse(await readFile(inputPath, 'utf8'));
  const events = Array.isArray(raw) ? raw : raw.events;
  const config = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : raw.config ?? {};

  const report = reconstructTimeline(events, config);
  console.log(JSON.stringify(report, null, 2));
  console.error(`\n${DISCLAIMER}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
