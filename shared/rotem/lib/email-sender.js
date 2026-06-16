'use strict';

const https = require('https');

function httpsJsonRequest({ url, method, headers, body, timeoutMs = 30000 }) {
  const payload = body ? JSON.stringify(body) : undefined;
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: method || 'POST',
        headers: {
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsedBody;
          try {
            parsedBody = JSON.parse(text);
          } catch {
            parsedBody = text;
          }
          if (res.statusCode >= 400) {
            const msg =
              parsedBody?.message ||
              parsedBody?.error ||
              (typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody));
            reject(new Error(`Resend API HTTP ${res.statusCode}: ${msg}`));
            return;
          }
          resolve({ statusCode: res.statusCode, body: parsedBody });
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error(`Request timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function normalizeRecipients(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Send email via Resend HTTPS API (works on Railway — SMTP ports are blocked on Hobby).
 */
async function sendViaResendApi(email, smtp) {
  const apiKey = smtp.password || smtp.apiKey;
  if (!apiKey) throw new Error('Resend API key missing (smtp.password in farms.json)');

  const to = normalizeRecipients(email.to);
  if (!to.length) throw new Error('Email recipient (to) is required');

  const body = {
    from: email.from,
    to,
    subject: email.subject,
    html: email.html,
  };
  if (email.text) body.text = email.text;

  const { body: response } = await httpsJsonRequest({
    url: 'https://api.resend.com/emails',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });

  return {
    provider: 'resend-api',
    id: response?.id ?? null,
    response,
  };
}

function useResendApi(smtp) {
  if (!smtp) return false;
  if (smtp.provider === 'resend' || smtp.provider === 'resend-api') return true;
  if (String(smtp.host || '').includes('resend.com')) return true;
  // Railway and other PaaS: prefer HTTPS when explicitly requested
  if (smtp.useApi === true || process.env.EMAIL_USE_HTTPS === '1') return true;
  return false;
}

async function sendEmail(email, smtp) {
  if (!email?.to || !email?.subject) {
    throw new Error('Email payload must include to and subject');
  }

  if (useResendApi(smtp)) {
    return sendViaResendApi(email, smtp);
  }

  throw new Error(
    'SMTP is blocked on Railway Hobby/Free plans. Set smtp.host to smtp.resend.com or smtp.provider to "resend" to use the HTTPS API.',
  );
}

module.exports = {
  sendEmail,
  sendViaResendApi,
  useResendApi,
};
