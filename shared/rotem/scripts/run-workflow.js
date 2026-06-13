#!/usr/bin/env node
'use strict';

/**
 * Runs the same pipeline as the n8n workflow (without SMTP).
 * Usage: ROTEM_DATA_ROOT=./shared/rotem node shared/rotem/scripts/run-workflow.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.env.ROTEM_DATA_ROOT = process.env.ROTEM_DATA_ROOT || ROOT;

const { filterFarmsForSchedule } = require(path.join(ROOT, 'lib', 'compare-anomaly.js'));
const { processFarm, loadConfig } = require(path.join(ROOT, 'lib', 'orchestrator.js'));
const { runPool, parseConcurrencyEnv } = require(path.join(ROOT, 'lib', 'concurrency.js'));

const OUTBOX = path.join(process.env.ROTEM_DATA_ROOT, 'outbox');

function saveOutbox(result) {
  fs.mkdirSync(OUTBOX, { recursive: true });
  const slug = `${result.farmId}-${Date.now()}`;
  const htmlPath = path.join(OUTBOX, `${slug}.html`);
  const metaPath = path.join(OUTBOX, `${slug}.meta.json`);
  fs.writeFileSync(htmlPath, result.email.html);
  fs.writeFileSync(path.join(OUTBOX, `${slug}.txt`), result.email.text);
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        to: result.email.to,
        from: result.email.from,
        subject: result.email.subject,
        farmId: result.farmId,
        alertCount: result.report?.alertCount ?? 0,
      },
      null,
      2,
    ),
  );
  return htmlPath;
}

async function main() {
  const manual = process.argv.includes('--manual') || process.argv.includes('--all');
  const farmFilter = process.argv.find((a) => a.startsWith('--farm='))?.split('=')[1];

  const { config, thresholds } = await loadConfig();
  let farms = config.farms || [];

  if (farmFilter) {
    farms = farms.filter((f) => f.id === farmFilter);
  } else if (!manual) {
    farms = farms.filter((f) => filterFarmsForSchedule([f], f.timezone));
  }

  if (farms.length === 0) {
    console.log('No farms due this hour. Use --manual to run all configured farms.');
    process.exit(0);
  }

  console.log(`Processing ${farms.length} farm(s)...`);
  const farmConcurrency = parseConcurrencyEnv('ROTEM_FARM_CONCURRENCY', 2);
  const houseConcurrency = parseConcurrencyEnv('ROTEM_HOUSE_CONCURRENCY', 4);
  console.log(
    `Concurrency: farms=${farmConcurrency}, houses=${houseConcurrency}`,
  );

  const workflowStart = Date.now();
  const results = await runPool(farms, farmConcurrency, async (farm) => {
    const start = Date.now();
    console.log(`\n→ ${farm.displayName} (${farm.id})`);
    try {
      const result = await processFarm(farm, config, thresholds, {
        skipScheduleCheck: manual,
        houseConcurrency,
      });
      const outboxPath = saveOutbox(result);
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`  ✓ ${elapsed}s | houses: ${result.report.houses.length} | alerts: ${result.report.alertCount}`);
      console.log(`  ✓ outbox: ${outboxPath}`);
      console.log(`  ✓ subject: ${result.email.subject}`);
      return { farmId: farm.id, ok: true, elapsed, alerts: result.report.alertCount };
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
      return { farmId: farm.id, ok: false, error: err.message };
    }
  });

  const totalElapsed = Math.round((Date.now() - workflowStart) / 1000);
  console.log(`\nTotal wall time: ${totalElapsed}s`);

  console.log('\nSummary:', JSON.stringify(results, null, 2));
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
