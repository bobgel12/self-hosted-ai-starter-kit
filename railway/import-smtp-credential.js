#!/usr/bin/env node
'use strict';

/**
 * Import SMTP credential into n8n from farms.json smtp block or SMTP_* env vars.
 * Uses fixed credential id so workflow nodes can reference it after deploy.
 */

const fs = require('fs');
const { execSync } = require('child_process');

const CREDENTIAL_ID = 'Ca4xOxTfpdmbJbHo';
const FARMS_PATH = '/data/shared/rotem/farms.json';

function loadSmtpConfig() {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD) {
    return {
      host: process.env.SMTP_HOST,
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
      port: process.env.SMTP_PORT || undefined,
      secure: process.env.SMTP_SECURE === 'true',
    };
  }

  if (!fs.existsSync(FARMS_PATH)) return null;
  const cfg = JSON.parse(fs.readFileSync(FARMS_PATH, 'utf8'));
  const smtp = cfg.smtp;
  if (!smtp?.host || !smtp?.user || !smtp?.password) return null;
  return smtp;
}

function main() {
  const smtp = loadSmtpConfig();
  if (!smtp) {
    console.log('SMTP not configured — skip credential import (reports still saved to outbox).');
    return;
  }

  const data = {
    user: smtp.user,
    password: smtp.password,
    host: smtp.host,
  };
  if (smtp.port) data.port = Number(smtp.port);
  if (smtp.secure != null) data.secure = smtp.secure;

  const payload = [
    {
      id: CREDENTIAL_ID,
      name: 'SMTP account',
      type: 'smtp',
      data,
    },
  ];

  const outPath = '/tmp/smtp-credential.json';
  fs.writeFileSync(outPath, JSON.stringify(payload));

  try {
    execSync(`n8n import:credentials --input=${outPath} --include=id,name,type,data`, {
      stdio: 'inherit',
    });
    console.log('SMTP credential imported.');
  } catch (err) {
    console.error('SMTP credential import failed:', err.message);
    process.exit(1);
  }
}

main();
