import express from 'express';
import cors from 'cors';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin initialized via FIREBASE_SERVICE_ACCOUNT env var.");
  } catch (err) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT environment variable:", err.message);
  }
} else if (fs.existsSync(serviceAccountPath)) {
  try {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin initialized via serviceAccountKey.json file.");
  } catch (err) {
    console.error("Failed to parse serviceAccountKey.json file:", err.message);
  }
} else if (process.env.VITE_FIREBASE_PROJECT_ID) {
  admin.initializeApp({
    projectId: process.env.VITE_FIREBASE_PROJECT_ID
  });
  console.log("Firebase Admin initialized via VITE_FIREBASE_PROJECT_ID.");
} else {
  console.warn("⚠️ Firebase Admin credentials not provided. Database integration will fail unless run in emulator.");
}

const db = admin.apps.length > 0 ? admin.firestore() : null;

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'imap-proxy-server', timestamp: new Date().toISOString() });
});

// ============================================================
// 1. POST /imap/test — Verify IMAP connection credentials
// ============================================================
app.post('/imap/test', async (req, res) => {
  const { host, port, user, pass, secure } = req.body;
  if (!host || !user || !pass) {
    return res.status(400).json({ error: 'Missing required fields: host, user, pass' });
  }

  const client = new ImapFlow({
    host,
    port: parseInt(port) || 993,
    secure: secure !== false,
    auth: { user, pass },
    logger: false
  });

  try {
    await client.connect();
    const mailboxes = await client.list();
    const folderNames = mailboxes.map(f => f.name);
    await client.logout();
    res.json({ success: true, message: 'IMAP connection verified successfully.', folders: folderNames });
  } catch (err) {
    console.error('IMAP test failed:', err.message);
    res.status(400).json({ error: err.message || 'Failed to connect to IMAP server.' });
  }
});

// ============================================================
// 2. POST /imap/fetch — Fetch recent messages from folders
// ============================================================
app.post('/imap/fetch', async (req, res) => {
  const { host, port, user, pass, secure, folders, limit, query: searchQuery } = req.body;
  if (!host || !user || !pass) {
    return res.status(400).json({ error: 'Missing required fields: host, user, pass' });
  }

  const limitVal = Math.min(parseInt(limit) || 15, 50);
  const foldersToQuery = (folders && folders.length > 0) ? folders : ['INBOX'];

  const client = new ImapFlow({
    host,
    port: parseInt(port) || 993,
    secure: secure !== false,
    auth: { user, pass },
    logger: false
  });

  try {
    await client.connect();
    const allMessages = [];

    for (const folder of foldersToQuery) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          const status = client.mailbox;
          const total = status.exists || 0;
          if (total === 0) continue;

          // Get the latest N message sequence numbers
          const startSeq = Math.max(1, total - (limitVal - 1));
          const range = `${startSeq}:*`;

          for await (const msg of client.fetch(range, {
            envelope: true,
            source: true
          })) {
            try {
              const parsed = await simpleParser(msg.source);
              
              const fromAddr = parsed.from?.text || 
                (msg.envelope?.from?.[0] ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address || ''}>`.trim() : 'Unknown');
              
              const bodyText = parsed.text || '';
              const bodyHtml = parsed.html || '';

              // If search query provided, filter
              if (searchQuery && searchQuery.trim()) {
                const q = searchQuery.trim().toLowerCase();
                const matchFrom = fromAddr.toLowerCase().includes(q);
                const matchSubject = (parsed.subject || '').toLowerCase().includes(q);
                const matchBody = bodyText.toLowerCase().includes(q);
                if (!matchFrom && !matchSubject && !matchBody) continue;
              }

              allMessages.push({
                messageId: msg.envelope?.messageId || String(msg.seq),
                uid: msg.uid,
                subject: parsed.subject || msg.envelope?.subject || '(No Subject)',
                sender: fromAddr,
                sentTime: (parsed.date || msg.envelope?.date || new Date()).getTime(),
                summary: bodyText.substring(0, 250).replace(/\s+/g, ' ').trim(),
                body: bodyHtml || bodyText || 'No content',
                folderName: folder
              });
            } catch (parseErr) {
              console.warn(`Parse error for msg in ${folder}:`, parseErr.message);
            }
          }
        } finally {
          lock.release();
        }
      } catch (folderErr) {
        console.warn(`Skipping folder "${folder}":`, folderErr.message);
      }
    }

    await client.logout();

    // Sort by date descending (newest first)
    allMessages.sort((a, b) => b.sentTime - a.sentTime);

    res.json({ data: allMessages });
  } catch (err) {
    console.error('IMAP fetch failed:', err.message);
    res.status(400).json({ error: err.message || 'Failed to fetch messages.' });
  }
});

// ============================================================
// 3. POST /api/license/generate — Auto-generate License Keys via API Key
// ============================================================
app.post('/api/license/generate', async (req, res) => {
  if (!db) {
    return res.status(500).json({ error: 'Database service is not initialized on the server.' });
  }

  // 1. Extract API Key from headers (Authorization: Bearer <key> or x-api-key)
  let apiKey = req.headers['x-api-key'] || '';
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.substring(7).trim();
  }

  if (!apiKey) {
    return res.status(401).json({ error: 'Unauthorized: Missing API Key in Authorization or x-api-key headers.' });
  }

  try {
    // 2. Validate API Key from Firestore
    const apiKeyDoc = await db.collection('api_keys').doc(apiKey).get();
    if (!apiKeyDoc.exists) {
      return res.status(401).json({ error: 'Unauthorized: Invalid API Key.' });
    }

    const keyData = apiKeyDoc.data();
    if (keyData.status !== 'active') {
      return res.status(403).json({ error: 'Forbidden: API Key has been revoked or is inactive.' });
    }

    const { assignedMailbox, mailboxType } = req.body;
    if (!assignedMailbox) {
      return res.status(400).json({ error: 'Bad Request: Missing required field "assignedMailbox".' });
    }

    // 3. Generate random 16 character key: XXXX-XXXX-XXXX-XXXX
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let p1 = '', p2 = '', p3 = '', p4 = '';
    for (let i = 0; i < 4; i++) {
      p1 += chars.charAt(Math.floor(Math.random() * chars.length));
      p2 += chars.charAt(Math.floor(Math.random() * chars.length));
      p3 += chars.charAt(Math.floor(Math.random() * chars.length));
      p4 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const generatedKey = `${p1}-${p2}-${p3}-${p4}`;

    // 4. Save key in Firestore
    const newLicenseData = {
      keyId: generatedKey,
      assignedMailbox: assignedMailbox,
      mailboxType: mailboxType || 'gmail',
      status: 'active',
      createdAt: new Date().toISOString(),
      createdByUid: `api_key_${apiKey}`,
      createdByEmail: `API Key: ${keyData.label}`,
      createdByRole: 'api',
      redeemedBy: null,
      redeemedAt: null
    };

    await db.collection('license_keys').doc(generatedKey).set(newLicenseData);

    // 5. Fire webhook if configured
    const webhookTarget = req.body.webhookUrl || keyData.webhookUrl;
    if (webhookTarget) {
      console.log(`Sending webhook notification to: ${webhookTarget}`);
      const payload = {
        event: 'license.created',
        licenseKey: generatedKey,
        assignedMailbox,
        mailboxType: mailboxType || 'gmail',
        createdAt: newLicenseData.createdAt
      };

      if (typeof fetch !== 'undefined') {
        fetch(webhookTarget, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(err => {
          console.error(`Webhook trigger failed for ${webhookTarget}:`, err.message);
        });
      } else {
        // Fallback using HTTPS module
        import('https').then((https) => {
          try {
            const url = new URL(webhookTarget);
            const reqData = JSON.stringify(payload);
            const options = {
              hostname: url.hostname,
              port: url.port || 443,
              path: url.pathname + url.search,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(reqData)
              }
            };
            const wReq = https.request(options, (wRes) => {
              wRes.on('data', () => {});
            });
            wReq.on('error', (err) => {
              console.error(`Webhook fallback failed for ${webhookTarget}:`, err.message);
            });
            wReq.write(reqData);
            wReq.end();
          } catch (urlErr) {
            console.error(`Invalid webhook URL fallback error:`, urlErr.message);
          }
        });
      }
    }

    // 6. Return response
    return res.json({
      success: true,
      licenseKey: generatedKey,
      assignedMailbox,
      mailboxType: mailboxType || 'gmail',
      status: 'active'
    });

  } catch (err) {
    console.error('License Key auto-generation failed:', err);
    return res.status(500).json({ error: err.message || 'Internal server error during key generation.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ IMAP Proxy Server running on port ${PORT}`);
});
