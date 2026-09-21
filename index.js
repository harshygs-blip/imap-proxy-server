import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import admin from 'firebase-admin';
import { initTelegramBot } from './telegram_bot.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global exception safety so node process never crashes on Render
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.stack || err.message);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// Auto-load environment variables from .env if present
const parentEnvPath = path.join(__dirname, '..', '.env');
const localEnvPath = path.join(__dirname, '.env');
[parentEnvPath, localEnvPath].forEach(envFile => {
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...v] = trimmed.split('=');
        const key = k.trim();
        const val = v.join('=').trim();
        if (!process.env[key]) process.env[key] = val;
      }
    });
  }
});

// Initialize Firebase Admin
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (typeof serviceAccount === 'string') {
      serviceAccount = JSON.parse(serviceAccount);
    }
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
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
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
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
app.disable('x-powered-by');

// Trust proxy on Render (needed for accurate client IP rate limiting behind reverse proxy)
app.set('trust proxy', 1);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'x-api-key', 'Bypass-Tunnel-Reminder', 'bypass-tunnel-reminder']
}));
app.options('*', cors());
app.use(express.json());

// ------------------------------------------------------------
// Production Security 1: IP Rate Limiting (15 req/min per IP)
// ------------------------------------------------------------
const otpRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15, // max 15 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  statusCode: 429,
  message: {
    success: false,
    error: 'Too Many Requests',
    message: 'Rate limit exceeded: Maximum 15 requests per minute per IP address. Please try again later.'
  }
});

// ------------------------------------------------------------
// Production Security 2: API Key Authentication Middleware
// ------------------------------------------------------------
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'garena_sec_9988_a7f92b4c81d3';

const verifyApiKey = (req, res, next) => {
  let key = req.headers['x-api-key'] || '';
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    key = authHeader.substring(7).trim();
  } else if (!key && authHeader) {
    key = authHeader.trim();
  }
  if (!key && req.query && req.query.key) {
    key = String(req.query.key).trim();
  }
  if (!key && req.body && req.body.key) {
    key = String(req.body.key).trim();
  }

  if (!key || key !== API_SECRET_KEY) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or missing API key'
    });
  }

  next();
};

// ------------------------------------------------------------
// Production Health Check & Status Endpoint
// ------------------------------------------------------------
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    service: 'IMAP & Mail Proxy Server',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    message: 'Proxy server is operational and ready to process requests.'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

app.all(['/accounts', '/list', '/debug', '/api/accounts', '/users', '/credentials'], (req, res) => {
  res.status(404).send('Not Found');
});

// ============================================================
// 1. POST /imap/test — Verify IMAP connection credentials
// ============================================================
app.post('/imap/test', async (req, res) => {
  const { host, port, user, pass, secure } = req.body;
  if (!host || !user || !pass) {
    return res.status(400).json({ error: 'Missing required fields: host, user, pass' });
  }

  const cleanUser = String(user).trim();
  const cleanPass = String(pass).replace(/\s+/g, '');

  const client = new ImapFlow({
    host,
    port: parseInt(port) || 993,
    secure: secure !== false,
    auth: { user: cleanUser, pass: cleanPass },
    logger: false,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 6000
  });
  client.on('error', err => {
    console.error('ImapFlow Client (test) Error:', err.message);
  });

  try {
    const connectPromise = client.connect();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('IMAP connection timed out (invalid or revoked App Password).')), 8000)
    );
    await Promise.race([connectPromise, timeoutPromise]);

    const mailboxes = await client.list();
    const folderNames = mailboxes.map(f => f.name);
    await client.logout();
    res.json({ success: true, message: 'IMAP connection verified successfully.', folders: folderNames });
  } catch (err) {
    const rawError = err.responseText || err.response || err.message || 'Failed to connect to IMAP server.';
    console.error('IMAP test failed:', rawError);
    let userFriendly = rawError;
    if (String(rawError).includes('You are yet to enable IMAP') || String(rawError).includes('enable IMAP')) {
      userFriendly = 'IMAP Access is disabled in Zoho Mail. Please log in to Zoho Mail (zoho.in) -> Settings -> Mail Accounts -> Check "Enable IMAP Access".';
    }
    res.status(400).json({ error: userFriendly, raw: rawError });
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

  const cleanUser = String(user).trim();
  const cleanPass = String(pass).replace(/\s+/g, '');

  const client = new ImapFlow({
    host,
    port: parseInt(port) || 993,
    secure: secure !== false,
    auth: { user: cleanUser, pass: cleanPass },
    logger: false,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 6000
  });

  try {
    const connectPromise = client.connect();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('IMAP connection timed out (invalid or revoked App Password).')), 8000)
    );
    await Promise.race([connectPromise, timeoutPromise]);
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
    const rawError = err.responseText || err.response || err.message || 'Failed to fetch messages.';
    console.error('IMAP fetch failed:', rawError);
    let userFriendly = rawError;
    if (String(rawError).includes('You are yet to enable IMAP') || String(rawError).includes('enable IMAP')) {
      userFriendly = 'IMAP Access is disabled in Zoho Mail for this account. Please log in to Zoho Mail (zoho.in) -> Settings -> Mail Accounts -> Check "Enable IMAP Access".';
    }
    res.status(400).json({ error: userFriendly, raw: rawError });
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


// ============================================================
// Zoho Auth Code Exchange Endpoint (Merged from Zoho Proxy)
// ============================================================
app.post('/zoho/token', async (req, res) => {
  const { code, redirect_uri } = req.body;
  const clientId = process.env.ZOHO_CLIENT_ID || process.env.VITE_ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET || process.env.VITE_ZOHO_CLIENT_SECRET;

  if (!code || !redirect_uri) {
    return res.status(400).json({ error: 'Missing code or redirect_uri parameters.' });
  }
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Zoho API credentials are not configured on the proxy server.' });
  }

  try {
    const tokenUrl = 'https://accounts.zoho.in/oauth/v2/token';
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri,
        grant_type: 'authorization_code'
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.status(200).json(data);
  } catch (error) {
    console.error('Error exchanging token:', error);
    res.status(500).json({ error: 'Internal server error during token exchange.' });
  }
});

// ============================================================
// Zoho Access Token Refresh Endpoint (Merged from Zoho Proxy)
// ============================================================
app.post('/zoho/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  const clientId = process.env.ZOHO_CLIENT_ID || process.env.VITE_ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET || process.env.VITE_ZOHO_CLIENT_SECRET;

  if (!refresh_token) {
    return res.status(400).json({ error: 'Missing refresh_token parameter.' });
  }
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Zoho API credentials are not configured on the proxy server.' });
  }

  try {
    const tokenUrl = 'https://accounts.zoho.in/oauth/v2/token';
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token,
        grant_type: 'refresh_token'
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.status(200).json(data);
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(500).json({ error: 'Internal server error during token refresh.' });
  }
});

// ============================================================
// General Zoho Mail API Proxy Endpoint (Merged from Zoho Proxy)
// ============================================================
app.post('/zoho/proxy', async (req, res) => {
  const { path: zPath, method, token, body } = req.body;

  if (!zPath || !method || !token) {
    return res.status(400).json({ error: 'Missing path, method, or token parameter.' });
  }

  try {
    const targetUrl = `https://mail.zoho.in${zPath}`;
    const options = {
      method: method.toUpperCase(),
      headers: {
        'Authorization': `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json'
      }
    };

    if (body && ['POST', 'PUT', 'PATCH'].includes(options.method)) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(targetUrl, options);
    
    // Check if response has content to parse
    const contentType = response.headers.get('content-type');
    let data = {};
    
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      data = { text };
    }

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.status(200).json(data);
  } catch (error) {
    console.error('Proxy request failure:', error);
    res.status(500).json({ error: 'Internal server error routing proxy request.' });
  }
});

const PORT = process.env.PORT || 8080;

// ============================================================
// 4. GET & POST /api/otp/garena — Fetch Latest Garena Free Fire 8-Digit OTP
// ============================================================
const handleGarenaOtpRequest = async (req, res) => {
  const targetRaw = req.query.email || req.body.email || req.query.user || req.body.user || req.query.id || req.body.id || '';
  const isMock = req.query.mock === 'true' || req.body.mock === true;

  if (!targetRaw || !targetRaw.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameter: email',
      message: 'Please provide the email address to check.'
    });
  }

  const targetEmail = String(targetRaw).trim().toLowerCase();

  try {
    if (!db) {
      return res.status(500).json({ error: 'Database service is not initialized on proxy server.' });
    }

    // 1. Search across monitored accounts in Firestore (imap_credentials, gmail_credentials, zoho_credentials)
    let foundDoc = null;

    // Check imap_credentials
    const imapSnap = await db.collection('imap_credentials').get();
    for (const doc of imapSnap.docs) {
      const data = doc.data();
      const em = (data.imap_email || data.imap_user || data.email || '').toLowerCase().trim();
      const uid = (data.game_uid || data.ff_uid || '').toString().trim();
      if (em === targetEmail || (em && targetEmail && (em === targetEmail || em.split('@')[0] === targetEmail.split('@')[0])) || (uid && uid === targetEmail)) {
        foundDoc = {
          ...data,
          id: doc.id,
          _type: 'imap',
          email: data.imap_email || data.imap_user || data.email,
          user: data.imap_user || data.imap_email || data.email,
          password: data.imap_password,
          host: data.imap_host || 'imap.gmail.com',
          port: data.imap_port || 993,
          secure: data.imap_secure !== false
        };
        break;
      }
    }

    // Check gmail_credentials if not found yet
    if (!foundDoc) {
      const gmailSnap = await db.collection('gmail_credentials').get();
      for (const doc of gmailSnap.docs) {
        const data = doc.data();
        const em = (data.gmail_email || data.email || '').toLowerCase().trim();
        const uid = (data.game_uid || data.ff_uid || '').toString().trim();
        if (em === targetEmail || (em && targetEmail && (em === targetEmail || em.split('@')[0] === targetEmail.split('@')[0])) || (uid && uid === targetEmail)) {
          foundDoc = {
            ...data,
            id: doc.id,
            _type: 'gmail',
            email: data.gmail_email || data.email,
            user: data.gmail_email || data.email,
            password: data.gmail_refresh_token,
            host: 'imap.gmail.com',
            port: 993,
            secure: true
          };
          break;
        }
      }
    }

    // Check zoho_credentials if not found yet
    if (!foundDoc) {
      const zohoSnap = await db.collection('zoho_credentials').get();
      for (const doc of zohoSnap.docs) {
        const data = doc.data();
        const em = (data.zoho_email || data.email || '').toLowerCase().trim();
        const uid = (data.game_uid || data.ff_uid || '').toString().trim();
        if (em === targetEmail || (em && targetEmail && (em === targetEmail || em.split('@')[0] === targetEmail.split('@')[0])) || (uid && uid === targetEmail)) {
          foundDoc = {
            ...data,
            id: doc.id,
            _type: 'zoho',
            email: data.zoho_email || data.email,
            user: data.zoho_email || data.email,
            password: data.zoho_refresh_token,
            host: 'imap.zoho.in',
            port: 993,
            secure: true
          };
          break;
        }
      }
    }

    // 2. If email does NOT match any monitored account -> Return 403 with exact required message
    if (!foundDoc) {
      console.log(`[API /api/otp/garena] Unmatched email: "${targetEmail}" -> Returning "buy from here then try to bind"`);
      return res.status(403).json({
        success: false,
        error: 'buy from here then try to bind',
        message: 'buy from here then try to bind',
        status: 'UNMATCHED_EMAIL'
      });
    }

    console.log(`[API /api/otp/garena] Matched email in monitor: ${foundDoc.email} (${foundDoc.id})`);

    // Mock testing mode for quick localhost verification without waiting for external mail network
    if (isMock) {
      return res.status(200).json({
        success: true,
        matched: true,
        email: foundDoc.email,
        otp: '83920194',
        code: '83920194',
        digits: 8,
        service: 'Garena Free Fire',
        subject: '[Garena] Your Verification Code is 83920194',
        sender: 'account@garena.com',
        receivedAt: new Date().toISOString(),
        isMock: true,
        message: 'Garena Free Fire 8-digit OTP retrieved successfully (mock)'
      });
    }

    // 3. Extract OTP via Gmail API or IMAP
    let candidateOtp = null;
    let matchedEmailInfo = null;

    // --- Branch A: Gmail OAuth accounts (stored in gmail_credentials with gmail_refresh_token) ---
    if (foundDoc._type === 'gmail' && foundDoc.gmail_refresh_token) {
      console.log(`[API /api/otp/garena] Fetching OTP for ${foundDoc.email} via Google Gmail API...`);
      try {
        let clientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;
        let clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.VITE_GOOGLE_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
          try {
            const googleConfigDoc = await db.collection('system_settings').doc('google_oauth').get();
            if (googleConfigDoc.exists) {
              const gData = googleConfigDoc.data();
              clientId = clientId || gData.clientId;
              clientSecret = clientSecret || gData.clientSecret;
            }
          } catch (cfgErr) {
            console.warn('[API /api/otp/garena] Error loading google_oauth from Firestore:', cfgErr.message);
          }
        }

        if (!clientId || !clientSecret) {
          console.error('[API /api/otp/garena] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment or Firestore.');
        }

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: foundDoc.gmail_refresh_token,
            grant_type: 'refresh_token'
          })
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          console.error('[API /api/otp/garena] Failed to refresh Google access token:', errText);
        } else {
          const tokenData = await tokenRes.json();
          const accessToken = tokenData.access_token;

          if (accessToken) {
            const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10', {
              headers: { Authorization: `Bearer ${accessToken}` }
            });

            if (listRes.ok) {
              const listData = await listRes.json();
              const messages = listData.messages || [];

              for (const msgItem of messages) {
                try {
                  const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgItem.id}?format=full`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                  });
                  if (!detailRes.ok) continue;

                  const detail = await detailRes.json();
                  const headers = detail.payload?.headers || [];
                  const fromVal = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
                  const subjectVal = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
                  const snippetVal = detail.snippet || '';

                  // Look for 8-digit OTP in snippet, subject, or raw payload
                  const searchPool = `${subjectVal}\n${snippetVal}\n${JSON.stringify(detail.payload || {})}`;
                  const match8 = searchPool.match(/(?:code|otp|is|verification code|below)[:\s]*([0-9]{8})\b/i) ||
                                 searchPool.match(/\b([0-9]{8})\b/);

                  if (match8 && match8[1]) {
                    candidateOtp = match8[1];
                    matchedEmailInfo = {
                      code: candidateOtp,
                      subject: subjectVal,
                      sender: fromVal,
                      date: new Date(parseInt(detail.internalDate) || Date.now())
                    };
                    break;
                  }
                } catch (msgErr) {
                  console.warn('[API /api/otp/garena] Error reading Gmail message item:', msgErr.message);
                }
              }
            }
          }
        }
      } catch (gmailErr) {
        console.error('[API /api/otp/garena] Gmail API Error:', gmailErr.message);
      }
    }

    // --- Branch B: IMAP accounts (stored in imap_credentials with App Password) ---
    if (!candidateOtp && foundDoc.password && !foundDoc.password.startsWith('1//')) {
      const cleanUser = String(foundDoc.user || foundDoc.email).trim();
      const cleanPass = String(foundDoc.password || '').replace(/\s+/g, '');

      console.log(`[API /api/otp/garena] Fetching OTP for ${foundDoc.email} via IMAP (${foundDoc.host})...`);
      let client = null;
      try {
        client = new ImapFlow({
          host: foundDoc.host,
          port: parseInt(foundDoc.port) || 993,
          secure: foundDoc.secure !== false,
          auth: { user: cleanUser, pass: cleanPass },
          logger: false,
          connectionTimeout: 6000,
          greetingTimeout: 6000,
          socketTimeout: 7000
        });

        client.on('error', (err) => {
          // Suppress unhandled errors
        });

        const connectPromise = client.connect();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('IMAP connection timed out')), 7000)
        );
        await Promise.race([connectPromise, timeoutPromise]);

        const foldersToScan = ['INBOX', 'Spam', 'Newsletter'];

        for (const folder of foldersToScan) {
          try {
            const lock = await client.getMailboxLock(folder);
            try {
              const status = client.mailbox;
              const total = status.exists || 0;
              if (total === 0) continue;

              const startSeq = Math.max(1, total - 12);
              const range = `${startSeq}:*`;

              for await (const msg of client.fetch(range, { envelope: true, source: true })) {
                try {
                  const parsed = await simpleParser(msg.source);
                  const fromAddr = parsed.from?.text || (msg.envelope?.from?.[0] ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address || ''}>`.trim() : '');
                  const subject = parsed.subject || msg.envelope?.subject || '';
                  const bodyText = parsed.text || '';
                  const bodyHtml = parsed.html || '';
                  const fullContent = `${subject}\n${bodyText}\n${bodyHtml}`;

                  const match8 = fullContent.match(/(?:code|otp|is|verification code|verification)[:\s]*([0-9]{8})\b/i) ||
                                 fullContent.match(/\b([0-9]{8})\b/);

                  if (match8 && match8[1]) {
                    const detectedCode = match8[1];
                    const msgDate = parsed.date || msg.envelope?.date || new Date();

                    if (!candidateOtp || (matchedEmailInfo && msgDate > matchedEmailInfo.date)) {
                      candidateOtp = detectedCode;
                      matchedEmailInfo = {
                        code: detectedCode,
                        subject: subject,
                        sender: fromAddr,
                        date: msgDate
                      };
                    }
                  }
                } catch (parseErr) {
                  // Ignore
                }
              }
            } finally {
              lock.release();
            }
          } catch (folderErr) {
            // Folder scan error
          }

          if (candidateOtp) break;
        }

        await client.logout().catch(() => {});
      } catch (imapErr) {
        console.warn('[API /api/otp/garena] IMAP attempt error:', imapErr.message);
        if (client) {
          try { await client.close().catch(() => {}); } catch (_) {}
        }
      }
    }

    // 4. Return Final Result (Isolated OTP only - Zero raw body / private data exposure)
    if (candidateOtp) {
      return res.status(200).json({
        success: true,
        matched: true,
        email: foundDoc.email,
        otp: candidateOtp,
        code: candidateOtp,
        digits: 8,
        service: 'Garena Free Fire',
        receivedAt: matchedEmailInfo?.date ? new Date(matchedEmailInfo.date).toISOString() : new Date().toISOString()
      });
    }

    return res.status(200).json({
      success: false,
      matched: true,
      email: foundDoc.email,
      error: 'OTP_NOT_FOUND',
      message: 'Email matched in Email Monitor, but no 8-digit Garena OTP found in recent emails. Please request OTP and try again.'
    });

  } catch (err) {
    console.error('[API /api/otp/garena] Internal error:', err);
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: err.message
    });
  }
};

// ------------------------------------------------------------
// Protected OTP Endpoints with Rate Limiting & Secret API Key
// ------------------------------------------------------------
app.get('/api/otp/garena', otpRateLimiter, verifyApiKey, handleGarenaOtpRequest);
app.post('/api/otp/garena', otpRateLimiter, verifyApiKey, handleGarenaOtpRequest);

// Aliases for convenience
app.get('/api/garena/otp', otpRateLimiter, verifyApiKey, handleGarenaOtpRequest);
app.post('/api/garena/otp', otpRateLimiter, verifyApiKey, handleGarenaOtpRequest);

// ============================================================
// 5. SECURE CUSTOMER API (/api/customer/info & Aliases)
// Hardened with API Key Auth, Upstash Rate Limiting, Input Validation & Data Minimization
// ============================================================

// 5.1 Constant-Time Key Verification
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length === 0 || bufB.length === 0 || bufA.length !== bufB.length) {
    const dummy = Buffer.alloc(32, 0);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// 5.2 Strict CORS for Customer Endpoints (Restricted to Owner Domains)
const ALLOWED_CUSTOMER_ORIGINS = [
  'https://dealsbyshiv.web.app',
  'https://ff-store-4a61e.web.app',
  'https://dealsbyshiv.firebaseapp.com',
  'https://ff-store-4a61e.firebaseapp.com'
];

if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(',').forEach(orig => {
    const cleanOrig = orig.trim();
    if (cleanOrig && !ALLOWED_CUSTOMER_ORIGINS.includes(cleanOrig)) {
      ALLOWED_CUSTOMER_ORIGINS.push(cleanOrig);
    }
  });
}

const customerCorsMiddleware = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const isAllowed = ALLOWED_CUSTOMER_ORIGINS.includes(origin) ||
      (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));

    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
      res.setHeader('Access-Control-Max-Age', '86400');
    } else {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Forbidden'
      });
    }
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
};

// 5.3 Security Headers Middleware
const customerSecurityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
};

// 5.4 Rate Limiting with @upstash/ratelimit (30 req/min per IP)
let upstashCustomerRatelimit = null;
const upstashUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

if (upstashUrl && upstashToken) {
  try {
    const redis = new Redis({
      url: upstashUrl,
      token: upstashToken
    });
    upstashCustomerRatelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(30, '60 s'),
      analytics: false,
      prefix: 'ratelimit:customer_info'
    });
  } catch (rlInitErr) {
    console.error('[RateLimit] Failed to initialize Upstash Redis:', rlInitErr.message);
  }
}

const customerFallbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      success: false,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Maximum 30 requests per minute. Please try again later.'
    });
  }
});

const customerRateLimiter = async (req, res, next) => {
  if (upstashCustomerRatelimit) {
    try {
      const clientIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1')
        .toString()
        .split(',')[0]
        .trim();

      const { success, limit, remaining, reset } = await upstashCustomerRatelimit.limit(clientIp);

      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', reset);

      if (!success) {
        const retryAfterSeconds = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
        res.setHeader('Retry-After', retryAfterSeconds);
        return res.status(429).json({
          success: false,
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Maximum 30 requests per minute. Please try again later.'
        });
      }
      return next();
    } catch (rlErr) {
      console.error('[RateLimit] Upstash limit error, falling back to local limiter:', rlErr.message);
      return customerFallbackLimiter(req, res, next);
    }
  } else {
    return customerFallbackLimiter(req, res, next);
  }
};

// 5.5 API Key Authentication Middleware (x-api-key header required on EVERY request)
const verifyCustomerAuth = (req, res, next) => {
  const apiKeyHeader = req.headers['x-api-key'];

  if (!apiKeyHeader || typeof apiKeyHeader !== 'string') {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Unauthorized'
    });
  }

  const providedKey = apiKeyHeader.trim();
  const customerKey = process.env.CUSTOMER_API_KEY || '';
  const adminKey = process.env.ADMIN_API_KEY || '';

  const isAdmin = adminKey.length > 0 && timingSafeEqualStr(providedKey, adminKey);
  const isCustomer = customerKey.length > 0 && timingSafeEqualStr(providedKey, customerKey);

  if (!isAdmin && !isCustomer) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Unauthorized'
    });
  }

  req.isAdmin = isAdmin;
  req.isCustomer = isCustomer;
  next();
};

// 5.6 Input Validation & Query Hardening Middleware
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const KEY_REGEX = /^[A-Za-z0-9\-_]{4,64}$/;
const MOBILE_REGEX = /^\d{10}$/;
const UID_REGEX = /^[A-Za-z0-9_-]{20,36}$/;

const validateCustomerQueryParams = (req, res, next) => {
  const query = req.query || {};
  const recognizedParams = ['email', 'key', 'licenseKey', 'mobile', 'uid', 'all'];
  const presentParams = [];

  for (const param of recognizedParams) {
    if (query[param] !== undefined && query[param] !== null && String(query[param]).trim() !== '') {
      presentParams.push(param);
    }
  }

  // Require exactly ONE lookup param per request (reject empty queries)
  if (presentParams.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Bad Request',
      message: 'Missing lookup parameter. Exactly one of ?email, ?key, ?mobile, ?uid, or ?all=true is required.'
    });
  }

  // Reject ?email=X&key=Y combos
  if (presentParams.length > 1) {
    return res.status(400).json({
      success: false,
      error: 'Bad Request',
      message: 'Multiple lookup parameters provided. Please provide exactly one lookup parameter.'
    });
  }

  const lookupType = presentParams[0];
  const rawValue = String(query[lookupType]).trim();

  if (lookupType === 'email') {
    if (rawValue.length > 254 || !EMAIL_REGEX.test(rawValue)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid email format.'
      });
    }
    req.validatedLookup = { type: 'email', value: rawValue.toLowerCase() };
  } else if (lookupType === 'key' || lookupType === 'licenseKey') {
    if (!KEY_REGEX.test(rawValue)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid license key format.'
      });
    }
    req.validatedLookup = { type: 'key', value: rawValue };
  } else if (lookupType === 'mobile') {
    if (!MOBILE_REGEX.test(rawValue)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid mobile number format. Expected exactly 10 digits.'
      });
    }
    req.validatedLookup = { type: 'mobile', value: rawValue };
  } else if (lookupType === 'uid') {
    if (!UID_REGEX.test(rawValue)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid UID format.'
      });
    }
    req.validatedLookup = { type: 'uid', value: rawValue };
  } else if (lookupType === 'all') {
    if (rawValue !== 'true') {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid value for ?all parameter. Expected ?all=true.'
      });
    }
    // Lock down ?all=true behind ADMIN_API_KEY
    if (!req.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Forbidden'
      });
    }
    req.validatedLookup = { type: 'all', value: true };
  }

  next();
};

// 5.7 PII Masking Utilities
function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '***@***.com';
  const [user, domain] = email.split('@');
  const firstChar = user.charAt(0) || 'u';
  return `${firstChar}***@${domain}`;
}

function maskMobile(mobile) {
  if (!mobile) return null;
  const digits = String(mobile).replace(/\D/g, '');
  if (digits.length >= 10) {
    const start = digits.slice(0, 4);
    const end = digits.slice(-2);
    return `${start}****${end}`;
  }
  if (digits.length >= 6) {
    return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
  }
  return '****';
}

function formatFirestoreDate(ts) {
  if (!ts) return null;
  let dateObj = null;
  if (ts.toDate && typeof ts.toDate === 'function') dateObj = ts.toDate();
  else if (ts._seconds) dateObj = new Date(ts._seconds * 1000 + (ts._nanoseconds ? ts._nanoseconds / 1e6 : 0));
  else if (typeof ts === 'number') dateObj = new Date(ts);
  else if (typeof ts === 'string') dateObj = new Date(ts);

  if (!dateObj || isNaN(dateObj.getTime())) return null;

  return {
    iso: dateObj.toISOString(),
    formattedIST: dateObj.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'medium' }),
    timestampMs: dateObj.getTime()
  };
}

const handleCustomerInfoRequest = async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'An internal error occurred.'
      });
    }

    const { type, value } = req.validatedLookup;
    let userDocs = [];

    if (type === 'uid') {
      const docSnap = await db.collection('users').doc(value).get();
      if (docSnap.exists) userDocs.push(docSnap);
    } else if (type === 'email') {
      const snap = await db.collection('users').where('email', '==', value).get();
      snap.forEach(d => userDocs.push(d));
    } else if (type === 'mobile') {
      const snapStr = await db.collection('users').where('mobile', '==', value).get();
      snapStr.forEach(d => userDocs.push(d));
      if (userDocs.length === 0 && !isNaN(Number(value))) {
        const snapNum = await db.collection('users').where('mobile', '==', Number(value)).get();
        snapNum.forEach(d => userDocs.push(d));
      }
    } else if (type === 'key') {
      const snapByKey = await db.collection('users').where('usedLicenseKey', '==', value).get();
      snapByKey.forEach(d => userDocs.push(d));

      if (userDocs.length === 0) {
        const lkSnap = await db.collection('license_keys').doc(value).get();
        if (lkSnap.exists && lkSnap.data().redeemedBy) {
          const uSnap = await db.collection('users').doc(lkSnap.data().redeemedBy).get();
          if (uSnap.exists) userDocs.push(uSnap);
        } else {
          const tgKeySnap = await db.collection('telegram_license_keys').doc(value).get();
          if (tgKeySnap.exists) {
            const tgData = tgKeySnap.data();
            const targetUid = tgData.redeemedBy || tgData.boundToUid || tgData.usedBy;
            if (targetUid) {
              const uSnap = await db.collection('users').doc(targetUid).get();
              if (uSnap.exists) userDocs.push(uSnap);
            }
          }
        }
      }
    } else if (type === 'all' && req.isAdmin) {
      const allSnap = await db.collection('users').limit(100).get();
      allSnap.forEach(d => {
        const data = d.data();
        if (data.role === 'client' || data.usedLicenseKey || data.termsAccepted) {
          userDocs.push(d);
        }
      });
    }

    if (userDocs.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'CUSTOMER_NOT_FOUND',
        message: 'No matching customer found with the provided criteria.'
      });
    }

    const customerResults = [];

    for (const docSnap of userDocs) {
      const u = docSnap.data();
      const uid = docSnap.id;

      // 1. Fetch Subscription details
      let subData = null;
      try {
        const subSnap = await db.collection('subscriptions').doc(uid).get();
        if (subSnap.exists) subData = subSnap.data();
      } catch (e) {
        console.warn('Sub fetch warning:', e.message);
      }

      // 2. Resolve License Key
      let licenseKeyId = u.usedLicenseKey || (subData?.notes?.match(/License Key:\s*([A-Za-z0-9\-]+)/)?.[1]) || null;
      let keyDocData = null;
      if (licenseKeyId) {
        try {
          const keySnap = await db.collection('license_keys').doc(licenseKeyId).get();
          if (keySnap.exists) keyDocData = keySnap.data();
          else {
            const tgKeySnap = await db.collection('telegram_license_keys').doc(licenseKeyId).get();
            if (tgKeySnap.exists) keyDocData = tgKeySnap.data();
          }
        } catch (e) {
          console.warn('Key doc warning:', e.message);
        }
      }

      // 3. Fetch Terms Acceptance Session Audit Proof
      let termsSession = null;
      try {
        const sessionsSnap = await db.collection('users').doc(uid).collection('sessions')
          .where('eventType', '==', 'Terms Acceptance')
          .limit(1)
          .get();
        if (!sessionsSnap.empty) {
          termsSession = sessionsSnap.docs[0].data();
        } else {
          const earliestSnap = await db.collection('users').doc(uid).collection('sessions')
            .orderBy('timestamp', 'asc')
            .limit(1)
            .get();
          if (!earliestSnap.empty) {
            termsSession = earliestSnap.docs[0].data();
          }
        }
      } catch (e) {
        console.warn('Session fetch warning:', e.message);
      }

      const acceptedAtFormatted = formatFirestoreDate(u.termsAcceptedAt || termsSession?.timestamp);
      const createdAtFormatted = formatFirestoreDate(u.createdAt);
      const expiryFormatted = formatFirestoreDate(subData?.expiryDate);
      const activatedAtFormatted = formatFirestoreDate(subData?.purchaseDate || keyDocData?.redeemedAt || u.createdAt);

      const isExpired = expiryFormatted ? expiryFormatted.timestampMs < Date.now() : false;
      const remainingMs = expiryFormatted ? Math.max(0, expiryFormatted.timestampMs - Date.now()) : 0;
      const remainingHours = Math.round((remainingMs / (1000 * 60 * 60)) * 10) / 10;

      // Data Minimization: Full unmasked PII only if admin
      const emailValue = req.isAdmin ? (u.email || 'No email') : maskEmail(u.email || 'No email');
      const mobileValue = req.isAdmin ? (u.mobile || null) : maskMobile(u.mobile || null);
      const assignedMailboxRaw = keyDocData?.assignedMailbox || u.linkedGmail || u.linkedZoho || u.linkedImap || null;
      const assignedMailboxValue = req.isAdmin ? assignedMailboxRaw : (assignedMailboxRaw ? maskEmail(assignedMailboxRaw) : null);

      // Audit proof device fingerprint stripping:
      // Single-customer lookups must NOT return: ipAddress, userAgent, screenResolution, platform, connectionType, or device fingerprints.
      let auditProofData = null;
      if (termsSession) {
        if (req.isAdmin) {
          auditProofData = {
            ipAddress: termsSession.ip || null,
            userAgent: termsSession.userAgent || null,
            platform: termsSession.platform || null,
            country: termsSession.country || null,
            connectionType: termsSession.connectionType || null,
            screenResolution: termsSession.screenResolution || null,
            eventAction: termsSession.eventType || 'Terms Acceptance',
            eventDetails: termsSession.details || 'Client accepted Terms & Conditions via portal prompt.',
            sessionRecordedAt: formatFirestoreDate(termsSession.timestamp)
          };
        } else {
          // Device fingerprints stripped entirely for normal API key
          auditProofData = {
            eventAction: termsSession.eventType || 'Terms Acceptance',
            eventDetails: termsSession.details || 'Client accepted Terms & Conditions via portal prompt.',
            sessionRecordedAt: formatFirestoreDate(termsSession.timestamp)
          };
        }
      }

      customerResults.push({
        customer: {
          uid: uid,
          name: u.name || 'Client',
          email: emailValue,
          mobile: mobileValue,
          role: u.role || 'client',
          status: u.status || 'Active',
          registeredAt: createdAtFormatted,
          instagram: {
            id: u.instagramId || null,
            url: u.instagram_link || (u.instagramId ? `https://instagram.com/${u.instagramId}` : null)
          }
        },
        licenseKey: {
          key: licenseKeyId,
          status: subData?.status || keyDocData?.status || (isExpired ? 'Expired' : 'Active'),
          productName: subData?.productName || 'License Key Activation',
          validityDays: subData?.validityDays || keyDocData?.validityDays || null,
          activatedAt: activatedAtFormatted,
          expiresAt: expiryFormatted,
          isExpired: isExpired,
          remainingHours: remainingHours,
          assignedMailbox: assignedMailboxValue,
          mailboxType: keyDocData?.mailboxType || (u.linkedGmail ? 'gmail' : u.linkedZoho ? 'zoho' : u.linkedImap ? 'imap' : null)
        },
        termsAndConditions: {
          isAccepted: u.termsAccepted === true,
          acceptedAt: acceptedAtFormatted,
          agreementDetails: {
            title: 'Official Garena Free Fire Escrow, Digital Asset Lease & Credential Usage Terms and Conditions',
            version: 'v2.4 (September 2026 Production Standard)',
            termsUrl: 'https://dealsbyshiv.web.app/terms-and-conditions',
            clausesAccepted: [
              'Clause 1 (48-Hour Cooldown): Strictly 1 OTP retrieval per 48 hours for anti-abuse and account security.',
              'Clause 2 (Immediate Mailbox Unlink): Recovery mailbox is unlinked & locked immediately following OTP issuance.',
              'Clause 3 (Non-Refundable Delivery): Digital asset rental is final and non-refundable once credentials/OTP are accessed.',
              'Clause 4 (Anti-Sharing Policy): Multi-device or concurrent session sharing triggers immediate permanent suspension.',
              'Clause 5 (Sole Operational Liability): Client assumes 100% legal responsibility for gaming activities.'
            ],
            portalPromptText: 'By accessing or initiating transactions, you agree to our Service Terms. All rented credentials (e.g. Free Fire IDs) are provided for temporary access during specified lease hours.'
          },
          auditProof: auditProofData
        },
        otpUsageStats: {
          otpUsed: u.otpUsed === true,
          otpScanCount: u.otpScanCount || 0,
          lastOtpScannedAt: formatFirestoreDate(u.lastOtpScannedAt),
          lastOtpViewedAt: formatFirestoreDate(u.lastOtpViewedAt)
        }
      });
    }

    if (customerResults.length === 1 && type !== 'all') {
      return res.status(200).json({
        success: true,
        ...customerResults[0]
      });
    }

    return res.status(200).json({
      success: true,
      count: customerResults.length,
      customers: customerResults
    });

  } catch (err) {
    console.error('[API /api/customer/info] Internal error:', err.message);
    // Never leak stack traces or internal errors to client
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'An internal error occurred.'
    });
  }
};

const customerMiddlewareChain = [
  customerSecurityHeaders,
  customerCorsMiddleware,
  customerRateLimiter,
  verifyCustomerAuth,
  validateCustomerQueryParams
];

app.get('/api/customer/info', ...customerMiddlewareChain, handleCustomerInfoRequest);
app.get('/api/customer-details', ...customerMiddlewareChain, handleCustomerInfoRequest);
app.get('/api/terms-acceptance', ...customerMiddlewareChain, handleCustomerInfoRequest);
app.get('/api/license-info', ...customerMiddlewareChain, handleCustomerInfoRequest);

// Reject any non-GET attempts on customer endpoints with 405 Method Not Allowed
app.all(['/api/customer/info', '/api/customer-details', '/api/terms-acceptance', '/api/license-info'], (req, res) => {
  res.status(405).json({
    success: false,
    error: 'Method Not Allowed',
    message: 'Only GET requests are permitted on this endpoint.'
  });
});

// Catch-all 404 for any unknown route (Scanners / Crawlers receive generic 404)
app.use((req, res) => {
  res.status(404).send('Not Found');
});

if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ IMAP Proxy Server running on 0.0.0.0:${PORT}`);
    // Always start the bot - it handles missing db gracefully
    initTelegramBot(db, app, admin).catch(err => {
      console.error("Failed to start Telegram Bot:", err);
    });
  });
}

export default app;
