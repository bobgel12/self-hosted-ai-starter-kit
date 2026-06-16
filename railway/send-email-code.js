const SEND_EMAIL_CODE = `const fs = require('fs');
const { sendEmail } = require('/data/shared/rotem/lib/email-sender.js');

const item = $input.item.json;
const email = item.email;
if (!email) {
  return { json: { ...item, emailSent: false, emailError: 'Missing email payload' } };
}

const config = JSON.parse(fs.readFileSync('/data/shared/rotem/farms.json', 'utf8'));
const smtp = { ...(config.smtp || {}), useApi: true };

try {
  const result = await sendEmail(email, smtp);
  return {
    json: {
      ...item,
      emailSent: true,
      emailProvider: result.provider,
      emailId: result.id,
    },
  };
} catch (err) {
  return {
    json: {
      ...item,
      emailSent: false,
      emailError: err.message,
    },
  };
}`;

module.exports = { SEND_EMAIL_CODE };
