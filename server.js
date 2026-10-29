


import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import { randomUUID, randomInt } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { matchClient } from './match-client.js';
import { parseFilename } from './parse-filename.js';
import { getShellType } from './shelltype.js';
import { supabase, supabaseAuth } from './supabase.js';
import nodemailer from 'nodemailer';
import { loadScheduleConfig, saveScheduleConfig } from './models/ScheduleConfig.js';

import { listChildren, downloadFile, moveItem,copyItem, deleteItem,createFolder } from './sharefile.js';

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const UNIDENTIFIED_FOLDER_ID = process.env.SHAREFILE_UNIDENTIFIED_FOLDER_ID || '';




async function moveFileToUnidentified(fileId, fileName) {
  if (!UNIDENTIFIED_FOLDER_ID) return;
  try {
    await moveItem(fileId, UNIDENTIFIED_FOLDER_ID);
    console.log(`[move] "${fileName}" moved to unidentified folder successfully.`);
  } catch (err) {
    console.error(`Failed to move "${fileName}" to unidentified folder:`, err.message);
    pushLog({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      fileName,
      orderId: null,
      seazonaOrderId: null,
      status: 'error',
      message: `Failed to move to unidentified folder: ${err.message}`,
    });
  }
}



async function cleanupOldUnidentifiedFolders() {
  // if (!UNIDENTIFIED_FOLDER_ID) return;
  // try {
  //   const items = await listChildren(UNIDENTIFIED_FOLDER_ID);
  //   const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  //   for (const item of items) {
  //     const isFolder = String(item['odata.type'] || '').endsWith('.Folder');
  //     if (isFolder && new Date(item.CreationDate).getTime() < cutoff) {
  //       await deleteItem(item.Id).catch(() => {});
  //       console.log(`Deleted old unidentified folder: ${item.Name}`);
  //     }
  //   }
  // } catch (err) {
  //   console.error('Failed to clean up unidentified folders:', err.message);
  // }
}


const app = express();
app.use(express.json());






const BACKUP_PARENT_FOLDER_ID = process.env.SHAREFILE_BACKUP_FOLDER_ID || '';
const BACKUP_TIMEZONE = process.env.BACKUP_TIMEZONE || 'America/Toronto';

const BACKUP_CRON = '0 0 1 * *'
let backupCronJob = null;
let backupRunning = false;

function todayFolderName() {
  return new Date().toLocaleDateString('en-CA', { timeZone: BACKUP_TIMEZONE });
}

async function getOrCreateDateFolder(parentId, name) {
  const children = await listChildren(parentId);
  const existing = children.find(
    i => i.Name === name && String(i['odata.type'] || '').endsWith('.Folder')
  );
  if (existing) return existing.Id;
  const created = await createFolder(parentId, name);
  return created.Id;
}

async function backupSourceFolder() {
  if (!BACKUP_PARENT_FOLDER_ID) {
    return { skipped: true, reason: 'SHAREFILE_BACKUP_FOLDER_ID is not set' };
  }
  if (backupRunning) {
    return { skipped: true, reason: 'A backup is already running' };
  }

  backupRunning = true;
  const summary = { folder: null, copied: 0, skipped: 0, failed: 0 };

  try {
    const folderName = todayFolderName();
    const dateFolderId = await getOrCreateDateFolder(BACKUP_PARENT_FOLDER_ID, folderName);
    summary.folder = folderName;

    const [source, existing] = await Promise.all([
      listChildren(SHAREFILE_FOLDER_ID),
      listChildren(dateFolderId),
    ]);
    const alreadyBackedUp = new Set(existing.map(i => i.Name));

    for (const item of source) {
      const isFolder = String(item['odata.type'] || '').endsWith('.Folder');
      if (isFolder || alreadyBackedUp.has(item.Name)) {
        summary.skipped++;
        continue;
      }
      try {
        await copyItem(item.Id, dateFolderId);
        summary.copied++;
        console.log(`[backup] "${item.Name}" copied to ${folderName}.`);
      } catch (err) {
        summary.failed++;
        console.error(`[backup] Failed to copy "${item.Name}":`, err.message);
      }
    }
  } catch (err) {
    summary.error = err.message;
    console.error('[backup] Backup run failed:', err.message);
  } finally {
    backupRunning = false;
  }
  return summary;
}

function startBackupSchedule() {
  if (backupCronJob) {
    backupCronJob.stop();
    backupCronJob = null;
  }
  if (!BACKUP_PARENT_FOLDER_ID) {
    console.log('[backup] Monthly backup disabled (SHAREFILE_BACKUP_FOLDER_ID not set).');
    return;
  }
  if (!cron.validate(BACKUP_CRON)) {
    console.error(`[backup] Invalid BACKUP_CRON "${BACKUP_CRON}". Backup schedule not started.`);
    return;
  }
  backupCronJob = cron.schedule(
    BACKUP_CRON,
    async () => {
      console.log('[backup] Scheduled backup started.');
      const result = await backupSourceFolder();
      console.log('[backup] Scheduled backup finished:', result);
    },
    { timezone: BACKUP_TIMEZONE }
  );
  console.log(`[backup] Backup scheduled: "${BACKUP_CRON}" (${BACKUP_TIMEZONE}).`);
}


const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

const SEAZONA_BASE_URL = (process.env.SEAZONA_BASE_URL || '').replace(/\/$/, '');
const SEAZONA_CLIENT_ID = process.env.SEAZONA_CLIENT_ID || '';
const SEAZONA_CLIENT_SECRET = process.env.SEAZONA_CLIENT_SECRET || '';

const SHAREFILE_FOLDER_ID = process.env.SHAREFILE_FOLDER_ID || '';

const seazonaAuth = 'Basic ' + Buffer.from(`${SEAZONA_CLIENT_ID}:${SEAZONA_CLIENT_SECRET}`).toString('base64');

// const FIXED_USER_ID = '1f2d7738-5699-42b0-8d37-de61c8209ad3';
// const DUE_DAYS_FROM_CREATION = 7;
const FIXED_USER_ID = '1f2d7738-5699-42b0-8d37-de61c8209ad3';
const DUE_DAYS_FROM_CREATION = 7;
const FIXED_ACCOUNT_NUMBER = process.env.SEAZONA_ACCOUNT_NUMBER || '2419';


const PRODUCT_ID_BY_SHELL_CATEGORY = {
  Functional: '47943fcf-d6b0-4d01-8411-537cc017b4ef',
  Accomodative: 'd20b9455-8470-40cc-807b-62cb25316d7f',
};

let clientsCache = [];
let clientsCacheFetchedAt = null;

let logs = [];
let stats = {
  totalRuns: 0,
  totalFilesProcessed: 0,
  totalSuccess: 0,
  totalErrors: 0,
  lastRunAt: null,
};

let schedule = {
  enabled: false,
  intervalMinutes: 30,
  nextRunAt: null,
  lastRunAt: null,
};

let cronJob = null;
let sseClients = [];


async function saveProcessed({ driveFileId, fileName, status, seazonaOrderId = null, errorMessage = null }) {
  const { error } = await supabase.from('processed_files').upsert(
    {
      drive_file_id: driveFileId,
      file_name: fileName,
      status,
      seazona_order_id: seazonaOrderId,
      error_message: errorMessage,
      processed_at: new Date().toISOString(),
    },
    { onConflict: 'drive_file_id' }
  );
  if (error) throw error;
}

async function countByStatus(status) {
  const { count, error } = await supabase
    .from('processed_files')
    .select('*', { count: 'exact', head: true })
    .eq('status', status);
  if (error) throw error;
  return count || 0;
}


function pushLog(entry) {
  logs.unshift(entry);
  if (logs.length > 500) logs = logs.slice(0, 500);
  const logPayload = `data: ${JSON.stringify({ type: 'log', entry })}\n\n`;
  const statsPayload = `data: ${JSON.stringify({ type: 'stats', stats })}\n\n`;
  sseClients.forEach(c => {
    try {
      c.res.write(logPayload);
      c.res.write(statsPayload);
    } catch {}
  });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '') || req.query.token || '';
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function seazonaGet(path) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`${SEAZONA_BASE_URL}${path}`, {
    method: 'GET',
    headers: { Authorization: seazonaAuth, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Seazona ${res.status}: ${text}`);
  }
  return res.json();
}

async function seazonaPost(path, body) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`${SEAZONA_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: seazonaAuth,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Seazona ${res.status}: ${text}`);
  }
  return res.json();
}

async function getSeazonaClients() {
  const clients = await seazonaGet('/clients/?lastModified=');
  clientsCache = Array.isArray(clients) ? clients : [];
  clientsCacheFetchedAt = new Date().toISOString();
  return clientsCache;
}

function findClientByAccountNumber(clients, accountNumber) {
  const target = String(accountNumber).trim();
  const match = clients.find(c => String(c.accountNumber ?? '').trim() === target);
  if (!match) return null;
  return {
    matched: true,
    clientId: match.id,
    matchedCompany: match.company || match.fullName || `Account ${target}`,
    matchType: 'fixed-account',
    confidence: 1,
  };
}



function extractCaseId(filename) {

  return filename.replace(/\.[^/.]+$/, '');
}

async function getDriveFiles() {
  const items = await listChildren(SHAREFILE_FOLDER_ID);
  return items
    .filter(i => (i.Name || '').toLowerCase().endsWith('.pdf'))
    .map(i => ({
      id: i.Id,
      name: i.Name,
      mimeType: 'application/pdf',
      modifiedTime: i.CreationDate,
      size: i.FileSizeBytes ? String(i.FileSizeBytes) : null,
      caseId: extractCaseId(i.Name),
    }));
}



async function downloadDriveFile(fileId) {
  return downloadFile(fileId);
}



async function getShellTypeFromBase64(fileNameHint, base64Data) {
  const tempPath = join(tmpdir(), `seazona-${randomUUID()}-${fileNameHint}`);
  try {
    await writeFile(tempPath, Buffer.from(base64Data, 'base64'));
    return await getShellType(tempPath);
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

function isRushOrder(text) {
  return /\brush\b/i.test(text || '');
}

function buildOrderNotes({ pdfNotes, workOrderText }) {
  const cleaned = pdfNotes ? pdfNotes.replace(/\s*\n\s*/g, ' ').trim() : '';
  const parts = [];
  if (isRushOrder(cleaned)) parts.push('*** RUSH ORDER - ASSIGN TO PAN IMMEDIATELY ***');
  if (cleaned) parts.push(`**PLEASE READ NOTES BELOW CAREFULLY:**\n${cleaned}`);
  if (workOrderText) parts.push(workOrderText);
  return parts.join('\n\n');
}


async function runSync() {
  stats.totalRuns++;
  const now = new Date().toISOString();
  stats.lastRunAt = now;
  schedule.lastRunAt = now;
  await saveScheduleConfig({ lastRunAt: new Date(now) });

  await cleanupOldUnidentifiedFolders();

  let files;
  try {
    files = await getDriveFiles();
  } catch (err) {
    stats.totalErrors++;
    pushLog({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      fileName: '',
      orderId: null,
      seazonaOrderId: null,
      status: 'error',
      message: `Failed to list Drive files: ${err.message}`,
    });
    return;
  }

  const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));

  if (pdfs.length === 0) {
    pushLog({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      fileName: '',
      orderId: null,
      seazonaOrderId: null,
      status: 'skipped',
      message: 'No PDF files found in Drive folder.',
    });
    return;
  }

  const { data: succeededRows, error: succeededErr } = await supabase
    .from('processed_files')
    .select('drive_file_id')
    .eq('status', 'success')
    .in('drive_file_id', pdfs.map(f => f.id));
  if (succeededErr) throw succeededErr;

  const alreadySucceededIds = new Set(succeededRows.map(r => r.drive_file_id));
  const pdfsToProcess = pdfs.filter(f => !alreadySucceededIds.has(f.id));
  const skippedCount = pdfs.length - pdfsToProcess.length;

  if (skippedCount > 0) {
    pushLog({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      fileName: '',
      orderId: null,
      seazonaOrderId: null,
      status: 'skipped',
      message: `Skipped ${skippedCount} file(s) already successfully synced.`,
    });
  }
  if (pdfsToProcess.length === 0) return;

  for (const file of pdfsToProcess) {
    const caseId = file.caseId;

    let fileData;
    try {
      fileData = await downloadDriveFile(file.id);
    } catch (err) {
      stats.totalErrors++;
      stats.totalFilesProcessed++;
      const message = `PDF reader failed to download file "${file.name}": ${err.message}`;
      pushLog({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        fileName: file.name,
        orderId: caseId,
        seazonaOrderId: null,
        status: 'error',
        message,
      });
      await moveFileToUnidentified(file.id, file.name);
      await saveProcessed({ driveFileId: file.id, fileName: file.name, status: 'error', errorMessage: message });
      continue;
    }

    let shellResult;
    try {
      shellResult = await getShellTypeFromBase64(file.name, fileData);
    } catch (err) {
      stats.totalErrors++;
      stats.totalFilesProcessed++;
      const message = `PDF reader failed to parse shell type from "${file.name}": ${err.message}`;
      pushLog({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        fileName: file.name,
        orderId: caseId,
        seazonaOrderId: null,
        status: 'error',
        message,
      });
      await moveFileToUnidentified(file.id, file.name);
      await saveProcessed({ driveFileId: file.id, fileName: file.name, status: 'error', errorMessage: message });
      continue;
    }

    const parsed = parseFilename(file.name, shellResult.pdfMetadata);
    if (!parsed.complete) {
      stats.totalErrors++;
      stats.totalFilesProcessed++;
      const message =
        `Could not parse filename or recover clinic and patient details from PDF: ` +
        `${parsed.filenameError || parsed.error || 'Required details are missing.'}`;
      pushLog({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        fileName: file.name,
        orderId: caseId,
        seazonaOrderId: null,
        status: 'error',
        message,
      });
      await moveFileToUnidentified(file.id, file.name);
      await saveProcessed({ driveFileId: file.id, fileName: file.name, status: 'error', errorMessage: message });
      continue;
    }

    try {
      await getSeazonaClients();
    } catch (err) {
      stats.totalErrors++;
      stats.totalFilesProcessed++;
      const message = `Failed to fetch Seazona clients list: ${err.message}`;
      pushLog({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        fileName: file.name,
        orderId: caseId,
        seazonaOrderId: null,
        status: 'error',
        message,
      });
      await moveFileToUnidentified(file.id, file.name);
      await saveProcessed({ driveFileId: file.id, fileName: file.name, status: 'error', errorMessage: message });
      continue;
    }

    const clientMatch = findClientByAccountNumber(clientsCache, FIXED_ACCOUNT_NUMBER) || {
      matched: false,
      candidates: [],
      confidence: 0,
    };
    if (!clientMatch.matched) {
      stats.totalErrors++;
      stats.totalFilesProcessed++;
      const message = `No active Seazona client found with accountNumber ${FIXED_ACCOUNT_NUMBER}.`;
      pushLog({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        fileName: file.name,
        orderId: caseId,
        seazonaOrderId: null,
        status: 'error',
        message,
      });
      await moveFileToUnidentified(file.id, file.name);
      await saveProcessed({ driveFileId: file.id, fileName: file.name, status: 'error', errorMessage: message });
      continue;
    }

    if (!shellResult.category) {
      stats.totalErrors++;
      stats.totalFilesProcessed++;
      const message = `Could not detect a selected Shell Type in the PDF. Skipping — will not guess a product.`;
      pushLog({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        fileName: file.name,
        orderId: caseId,
        seazonaOrderId: null,
        status: 'error',
        message,
      });
      await moveFileToUnidentified(file.id, file.name);
      await saveProcessed({ driveFileId: file.id, fileName: file.name, status: 'error', errorMessage: message });
      continue;
    }

    const productId = PRODUCT_ID_BY_SHELL_CATEGORY[shellResult.category];
    if (!productId) {
      stats.totalErrors++;
      stats.totalFilesProcessed++;
      const message = `Detected Shell Type "${shellResult.category}" has no mapped product ID. Skipping.`;
      pushLog({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        fileName: file.name,
        orderId: caseId,
        seazonaOrderId: null,
        status: 'error',
        message,
      });
      await moveFileToUnidentified(file.id, file.name);
      await saveProcessed({ driveFileId: file.id, fileName: file.name, status: 'error', errorMessage: message });
      continue;
    }

    try {
      const dueDate = new Date(Date.now() + DUE_DAYS_FROM_CREATION * 24 * 60 * 60 * 1000);
      const orderNotes = buildOrderNotes({
        pdfNotes: shellResult.notes,
        workOrderText: shellResult.workOrderText,
      });
      const result = await seazonaPost('/orders/', {
        clientId: clientMatch.clientId,
        patientName: parsed.patientFullName,
        due: dueDate.toISOString(),
        userId: FIXED_USER_ID,
        notes: orderNotes,
        items: [{ id: productId }],
        files: [{ fileName: file.name, data: fileData }],
      });

      const seazonaOrderId = result.orderId || null;
      stats.totalSuccess++;
      stats.totalFilesProcessed++;
      pushLog({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        fileName: file.name,
        orderId: caseId,
        seazonaOrderId,
        status: 'success',
        message: `Order created (orderId: ${seazonaOrderId})${isRushOrder(shellResult.notes) ? ' [RUSH]' : ''}. Client "${clientMatch.matchedCompany}" (${clientMatch.matchType}, ${(clientMatch.confidence * 100).toFixed(1)}% confidence). Patient: ${parsed.patientFullName}. Shell Type: ${shellResult.category}${shellResult.subOption ? ` (${shellResult.subOption})` : ''} -> product ${productId}. Due: ${dueDate.toISOString()}.`,
      });

      await saveProcessed({ driveFileId: file.id, fileName: file.name, status: 'success', seazonaOrderId });
    } catch (err) {
      stats.totalErrors++;
      stats.totalFilesProcessed++;
      pushLog({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        fileName: file.name,
        orderId: caseId,
        seazonaOrderId: null,
        status: 'error',
        message: err.message,
      });

      await saveProcessed({ driveFileId: file.id, fileName: file.name, status: 'error', errorMessage: err.message });
    }
  }
}



function reschedule() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  if (!schedule.enabled) {
    schedule.nextRunAt = null;
    saveScheduleConfig({ nextRunAt: null }).catch(console.error);
    return;
  }
  const minutes = schedule.intervalMinutes;
  cronJob = cron.schedule(`*/${minutes} * * * *`, async () => {
    try {
      await runSync();
    } catch (err) {
      console.error('Scheduled runSync() crashed:', err);
      stats.totalErrors++;

      pushLog({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        fileName: '',
        orderId: null,
        seazonaOrderId: null,
        status: 'error',
        message: `Scheduled sync run crashed unexpectedly: ${err.message}`,
      });
    }
    schedule.lastRunAt = stats.lastRunAt;
    const next = new Date(Date.now() + minutes * 60 * 1000);
    schedule.nextRunAt = next.toISOString();
    await saveScheduleConfig({ lastRunAt: new Date(schedule.lastRunAt), nextRunAt: next }).catch(console.error);
  });
  const next = new Date(Date.now() + minutes * 60 * 1000);
  schedule.nextRunAt = next.toISOString();
  saveScheduleConfig({ nextRunAt: next }).catch(console.error);
}


app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const cleanEmail = email.trim().toLowerCase();

    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', cleanEmail)
      .maybeSingle();
    if (profileErr) throw profileErr;
    if (!profile) return res.status(404).json({ error: 'No account found with that email' });

    const otp = String(randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const { error: delErr } = await supabase.from('otps').delete().eq('email', cleanEmail);
    if (delErr) throw delErr;
    const { data: inserted, error: insErr } = await supabase
    .from('otps')
    .insert({ email: cleanEmail, otp, expires_at: expiresAt.toISOString() })
    .select();
  if (insErr) throw insErr;
  console.log('OTP row saved:', inserted);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
    await transporter.sendMail({
      from: `"Fiver Sync" <${process.env.GMAIL_USER}>`,
      to: cleanEmail,
      subject: 'Your password reset OTP',
      html: `
        <p>You requested a password reset for your Fiver Sync account.</p>
        <p>Your OTP is: <strong style="font-size:24px;letter-spacing:4px">${otp}</strong></p>
        <p>This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
      `,
    });
    res.json({ message: 'OTP sent to your email' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { email, otp, password } = req.body || {};
  if (!email || !otp || !password) return res.status(400).json({ error: 'All fields are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const cleanEmail = email.trim().toLowerCase();

    const { data: record, error: otpErr } = await supabase
      .from('otps')
      .select('id, expires_at')
      .eq('email', cleanEmail)
      .eq('otp', String(otp))
      .limit(1)
      .maybeSingle();
    if (otpErr) throw otpErr;
    if (!record) return res.status(400).json({ error: 'Invalid OTP' });
    if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: 'OTP has expired' });

    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', cleanEmail)
      .maybeSingle();
    if (profileErr) throw profileErr;
    if (!profile) return res.status(404).json({ error: 'User not found' });

    const { error: updateErr } = await supabase.auth.admin.updateUserById(profile.id, { password });
    if (updateErr) throw updateErr;

    const { error: delErr } = await supabase.from('otps').delete().eq('email', cleanEmail);
    if (delErr) throw delErr;

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });
  try {
    const cleanEmail = email.trim().toLowerCase();
    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email: cleanEmail, password });
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ email: data.user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, email: data.user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const cleanEmail = email.trim().toLowerCase();

    const { data: existing, error: existingErr } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', cleanEmail)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const { data, error } = await supabase.auth.admin.createUser({
      email: cleanEmail,
      password,
      email_confirm: true,
    });
    if (error) throw error;

    const token = jwt.sign({ email: data.user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({ token, email: data.user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.get('/api/drive/files', authMiddleware, async (req, res) => {
  try {
    const files = await getDriveFiles();

    if (!req.query.page && !req.query.pageSize) return res.json(files);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const start = (page - 1) * pageSize;

    res.json({
      items: files.slice(start, start + pageSize),
      page,
      pageSize,
      total: files.length,
      totalPages: Math.ceil(files.length / pageSize),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/process/run', authMiddleware, async (req, res) => {
  try {
    await runSync();
    const [totalSuccess, totalErrors] = await Promise.all([
      countByStatus('success'),
      countByStatus('error'),
    ]);
    res.json({
      started: true,
      message: 'Sync completed.',
      totalFilesProcessed: totalSuccess + totalErrors,
      totalSuccess,
      totalErrors,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/process/logs', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('processed_files')
      .select('*')
      .order('processed_at', { ascending: false })
      .limit(500);
    if (error) throw error;

    const logs = data.map(row => ({
      id: row.id,
      timestamp: row.processed_at,
      fileName: row.file_name,
      orderId: row.drive_file_id,
      seazonaOrderId: row.seazona_order_id || null,
      status: row.status,
      message: row.status === 'error' ? row.error_message : `Order created (orderId: ${row.seazona_order_id})`,
    }));
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/process/stats', authMiddleware, async (req, res) => {
  try {
    const [totalSuccess, totalErrors, scheduleDoc] = await Promise.all([
      countByStatus('success'),
      countByStatus('error'),
      loadScheduleConfig(),
    ]);
    res.json({
      totalFilesProcessed: totalSuccess + totalErrors,
      totalSuccess,
      totalErrors,
      lastRunAt: scheduleDoc.lastRunAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/schedule', authMiddleware, async (req, res) => {
  try {
    const s = await loadScheduleConfig();
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/schedule', authMiddleware, async (req, res) => {
  const { enabled, intervalMinutes } = req.body || {};
  if (typeof enabled === 'boolean') schedule.enabled = enabled;
  if (typeof intervalMinutes === 'number' && intervalMinutes >= 1) {
    schedule.intervalMinutes = intervalMinutes;
  }
  reschedule();

  await saveScheduleConfig({
    enabled: schedule.enabled,
    intervalMinutes: schedule.intervalMinutes,
    nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt) : null,
  }).catch(console.error);
  res.json(schedule);
});

app.get('/api/clients/preview-matches', authMiddleware, async (req, res) => {
  try {
    const [files, clients] = await Promise.all([getDriveFiles(), getSeazonaClients()]);
    const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
    const results = [];

    for (const file of pdfs) {
      try {
        const fileData = await downloadDriveFile(file.id);
        const shellResult = await getShellTypeFromBase64(file.name, fileData);
        const parsed = parseFilename(file.name, shellResult.pdfMetadata);
    
        if (!parsed.complete) {
          results.push({
            fileName: file.name,
            parseError:
              parsed.filenameError ||
              parsed.error ||
              'Could not recover clinic and patient details from the PDF.',
          });
          continue;
        }
    
        const match = matchClient(parsed.clientName, clients);
        results.push({
          fileName: file.name,
          parsedClientName: parsed.clientName,
          patientFullName: parsed.patientFullName,
          source: parsed.source,
          match,
        });
      } catch (err) {
        results.push({
          fileName: file.name,
          parseError: err.message,
        });
      }
    }
    res.json({ clientsFetched: clients.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/processed-files', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('processed_files')
      .select('*')
      .order('processed_at', { ascending: false })
      .limit(1000); 
    if (error) throw error;

    
    const docs = data.map(row => ({
      _id: row.id,
      driveFileId: row.drive_file_id,
      fileName: row.file_name,
      status: row.status,
      seazonaOrderId: row.seazona_order_id,
      errorMessage: row.error_message,
      processedAt: row.processed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/processed-files/:driveFileId', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('processed_files')
      .delete()
      .eq('drive_file_id', req.params.driveFileId);
    if (error) throw error;
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/process/events', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const client = { res };
  sseClients.push(client);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== client);
  });
});

app.post('/api/backup/run', authMiddleware, async (req, res) => {
  try {
    const result = await backupSourceFolder();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  try {
    schedule = await loadScheduleConfig(); 
    reschedule();
    startBackupSchedule();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to connect to Supabase:', err.message);
    process.exit(1);
  }
}

start();