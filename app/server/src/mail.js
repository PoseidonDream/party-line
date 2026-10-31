/* Sending email: codes that confirm someone's address, and codes for resetting a forgotten password. It goes through
   the SMTP server set in deploy/.env (for example Gmail with an app password). Without one, email features stay hidden. */
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from './config.js';

export const mailReady = () => !!(config.smtp.host || config.mailDir);
let transport = null;

export async function sendMail(to, subject, text) {
  if (config.mailDir) {   // tests: one JSON file per email
    fs.mkdirSync(config.mailDir, { recursive: true });
    fs.writeFileSync(path.join(config.mailDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify({ to, subject, text }));
    return;
  }
  if (!config.smtp.host) throw new Error('Email isn’t set up on this server.');
  transport = transport || nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined });
  await transport.sendMail({ from: `Party Line <${config.smtp.from}>`, to, subject, text });
}
