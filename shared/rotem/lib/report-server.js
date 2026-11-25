'use strict';

/**
 * Farm fetch outside n8n's JS task runner.
 *
 * bobby-angel on current main takes longer than n8n's default 300s runner
 * timeout (measured ~9 minutes). The runner abort fails the Code node and
 * never reaches Build Error Email, so the inbox keeps the previous
 * "[RotemNet] Error — …" message. This process is a normal Node server on
 * localhost; the workflow's HTTP Request node waits on the main process,
 * which uses the workflow execution timeout instead.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { processFarm } = require('./orchestrator');

const ROOT = process.env.ROTEM_DATA_ROOT || '/data/shared/rotem';
const PORT = Number(process.env.ROTEM_REPORT_PORT || 8791);
const HOST = '127.0.0.1';

process.on('SIGHUP', () => {});

function readStamp() {
  try {
    return fs.readFileSync(path.join(ROOT, 'IMAGE_STAMP.txt'), 'utf8').trim();
  } catch {
    return 'IMAGE_STAMP missing';
  }
}

function stampLine() {
  return readStamp().split('\n').slice(0, 4).join(' | ');
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function runFarm(body) {
  const stamp = stampLine();
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'farms.json'), 'utf8'));
  const thresholdsPath = path.join(ROOT, 'thresholds.json');
  const thresholds = fs.existsSync(thresholdsPath)
    ? JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'))
    : {};
  const farm = (config.farms || []).find((item) => item.id === body.farmId);
  if (!farm) {
    return {
      error: true,
      skipped: false,
      farmId: body.farmId,
      farmName: body.farmId || 'unknown farm',
      message: `Farm not found in farms.json: ${body.farmId} | ${stamp}`,
      libStamp: stamp,
    };
  }
  if (!farm.rotemUsername || !farm.rotemPassword) {
    return {
      error: true,
      skipped: false,
      farmId: farm.id,
      farmName: farm.displayName || farm.id,
      message: `Missing rotemUsername or rotemPassword in farms.json | ${stamp}`,
      libStamp: stamp,
    };
  }

  const result = await processFarm(farm, config, thresholds, {
    skipScheduleCheck: body.skipScheduleCheck === true,
  });
  if (result.skipped) {
    return {
      error: false,
      skipped: true,
      reason: result.reason,
      farmId: result.farmId,
      farmName: farm.displayName || farm.id,
      libStamp: stamp,
    };
  }

  const houses = result.report?.houses || [];
  return {
    error: false,
    skipped: false,
    farmId: result.farmId,
    farmName: result.report?.farmName || farm.displayName || farm.id,
    houseCount: houses.length,
    libStamp: stamp,
    snapshotSaved: result.snapshotSaved,
    snapshotError: result.snapshotError,
    email: result.email,
    report: result.report,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, {
        ok: true,
        stamp: readStamp(),
        dataRoot: ROOT,
        houseConcurrency: process.env.ROTEM_HOUSE_CONCURRENCY || '4',
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/run') {
      const body = await readBody(req);
      const started = Date.now();
      try {
        const result = await runFarm(body);
        result.elapsedMs = Date.now() - started;
        send(res, 200, result);
      } catch (err) {
        send(res, 200, {
          error: true,
          skipped: false,
          farmId: body.farmId,
          farmName: body.farmId || 'unknown farm',
          message: `${err && err.message ? err.message : err} | ${stampLine()}`,
          libStamp: stampLine(),
          elapsedMs: Date.now() - started,
        });
      }
      return;
    }
    send(res, 404, { error: true, message: 'not found' });
  } catch (err) {
    send(res, 400, { error: true, message: err && err.message ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Rotem report server listening on http://${HOST}:${PORT}`);
});
