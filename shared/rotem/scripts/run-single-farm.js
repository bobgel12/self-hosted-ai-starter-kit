#!/usr/bin/env node
'use strict';

/**
 * Process one farm and print JSON result to stdout for n8n Execute Command node.
 * Usage: node run-single-farm.js <farmId>
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.env.ROTEM_DATA_ROOT = process.env.ROTEM_DATA_ROOT || ROOT;

const { processFarm, loadConfig } = require(path.join(ROOT, 'lib', 'orchestrator.js'));

async function main() {
  const farmId = process.argv[2];
  if (!farmId) {
    console.error(JSON.stringify({ error: true, message: 'farmId argument required' }));
    process.exit(1);
  }

  const { config, thresholds } = await loadConfig();
  const farm = (config.farms || []).find((f) => f.id === farmId);
  if (!farm) {
    console.error(JSON.stringify({ error: true, message: `Unknown farm id: ${farmId}` }));
    process.exit(1);
  }

  const result = await processFarm(farm, config, thresholds, {
    skipScheduleCheck: true,
  });

  process.stdout.write(JSON.stringify({ error: false, ...result }));
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({
      error: true,
      message: err.message,
      farmId: process.argv[2] || null,
    }),
  );
  process.exit(1);
});
