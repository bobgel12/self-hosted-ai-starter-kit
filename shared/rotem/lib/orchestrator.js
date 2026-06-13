'use strict';

/**
 * Standalone orchestrator used by n8n Code node and local validation.
 * Set ROTEM_SKIP_FETCH=1 to run compare/email logic against mock data.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const { RotemClient } = require('./rotem-client');
const { runPool, parseConcurrencyEnv } = require('./concurrency');
const {
  loadSnapshot,
  saveSnapshot,
  compareWithSnapshot,
  detectAnomalies,
  getReportPeriod,
  filterFarmsForSchedule,
} = require('./compare-anomaly');
const { buildEmail } = require('./email-builder');

const CONFIG_DIR = process.env.ROTEM_DATA_ROOT || '/data/shared/rotem';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function appendLog(entry) {
  const logDir = path.join(CONFIG_DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function decodeResponseBody(chunks, encoding) {
  let buf = Buffer.concat(chunks);
  if (encoding === 'gzip') {
    buf = zlib.gunzipSync(buf);
  } else if (encoding === 'deflate') {
    buf = zlib.inflateSync(buf);
  } else if (encoding === 'br' && typeof zlib.brotliDecompressSync === 'function') {
    buf = zlib.brotliDecompressSync(buf);
  }

  // RotemNet prefixes JSON with a UTF-8 BOM; fetch strips it automatically.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
  }

  return buf.toString('utf8');
}

function parseResponseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function httpRequest(options, redirectCount = 0, retryCount = 0) {
  const url = new URL(options.url);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const payload = options.body ? JSON.stringify(options.body) : undefined;
  const timeoutMs = options.timeout || 60000;
  const maxRetries = options.retries ?? 3;

  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers: { ...(options.headers || {}) },
    };

    if (payload) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = transport.request(reqOptions, (res) => {
      const status = res.statusCode || 0;
      if (
        status >= 300 &&
        status < 400 &&
        res.headers.location &&
        redirectCount < 5
      ) {
        res.resume();
        const nextUrl = new URL(res.headers.location, options.url).toString();
        httpRequest({ ...options, url: nextUrl }, redirectCount + 1, retryCount).then(
          resolve,
          reject,
        );
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = decodeResponseBody(chunks, res.headers['content-encoding']);
        const body = parseResponseBody(text);

        const headers = {};
        for (const [key, value] of Object.entries(res.headers)) {
          headers[key.toLowerCase()] = value;
        }

        const transient = [502, 503, 504].includes(status);
        if (transient && retryCount < maxRetries) {
          const delayMs = 2000 * (retryCount + 1);
          setTimeout(() => {
            httpRequest(options, redirectCount, retryCount + 1).then(resolve, reject);
          }, delayMs);
          return;
        }

        resolve({ body, headers, statusCode: status });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function processFarm(farm, globalConfig, thresholds, options = {}) {
  const skipScheduleCheck = options.skipScheduleCheck === true;
  const dryRun = options.dryRun === true;

  if (!skipScheduleCheck && !filterFarmsForSchedule([farm], farm.timezone)) {
    return { skipped: true, reason: 'outside_report_window', farmId: farm.id };
  }

  const reportPeriod = getReportPeriod(farm.timezone);
  const recipientEmail = farm.recipientEmail || globalConfig.recipientEmail;

  let report;
  if (process.env.ROTEM_SKIP_FETCH === '1' && options.mockReport) {
    report = { ...options.mockReport, farmId: farm.id, timezone: farm.timezone };
  } else {
    const requestFn = options.httpRequest || httpRequest;
    const client = new RotemClient(
      async (opts) => {
        const result = await requestFn(opts);
        if (opts.returnFullResponse) return result;
        return result.body ?? result;
      },
      {
        delayMs: 500,
        timeoutMs: 60000,
        houseConcurrency:
          options.houseConcurrency ?? parseConcurrencyEnv('ROTEM_HOUSE_CONCURRENCY', 4),
      },
    );
    report = await client.fetchFarmReport(farm);
  }

  const previous = loadSnapshot(farm.id);
  let enriched = compareWithSnapshot(report, previous);
  enriched = detectAnomalies(enriched, thresholds);
  enriched.reportPeriod = reportPeriod;
  enriched.recipientEmail = recipientEmail;

  if (!dryRun) {
    saveSnapshot(enriched, reportPeriod);
  }

  const email = buildEmail(enriched, recipientEmail, reportPeriod);
  email.from = globalConfig.senderEmail || recipientEmail;

  return {
    skipped: false,
    farmId: farm.id,
    report: enriched,
    email,
    snapshotSaved: !dryRun,
  };
}

async function loadConfig() {
  const farmsPath = path.join(CONFIG_DIR, 'farms.json');
  const thresholdsPath = path.join(CONFIG_DIR, 'thresholds.json');
  if (!fs.existsSync(farmsPath)) {
    throw new Error(`Missing ${farmsPath}. Copy farms.json.example to farms.json.`);
  }
  return {
    config: readJson(farmsPath),
    thresholds: fs.existsSync(thresholdsPath) ? readJson(thresholdsPath) : {},
  };
}

async function runAll(options = {}) {
  const { config, thresholds } = await loadConfig();
  const farmConcurrency =
    options.farmConcurrency ?? parseConcurrencyEnv('ROTEM_FARM_CONCURRENCY', 2);
  const farms = config.farms || [];

  return runPool(farms, farmConcurrency, async (farm) => {
    try {
      const result = await processFarm(farm, config, thresholds, options);
      if (!result.skipped) {
        appendLog({
          at: new Date().toISOString(),
          farmId: farm.id,
          status: 'ok',
          alertCount: result.report?.alertCount ?? 0,
        });
      }
      return result;
    } catch (err) {
      appendLog({
        at: new Date().toISOString(),
        farmId: farm.id,
        status: 'error',
        error: err.message,
      });
      return { skipped: false, farmId: farm.id, error: err.message };
    }
  });
}

module.exports = {
  processFarm,
  loadConfig,
  runAll,
  httpRequest,
};
