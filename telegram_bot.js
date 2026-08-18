import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Bot token: env var > hardcoded fallback
const HARDCODED_BOT_TOKEN = '8700234031:AAEBQCGb3zXS7Jb1xlHT7novzQEm-tamhGk';
let botToken = process.env.TELEGRAM_BOT_TOKEN || HARDCODED_BOT_TOKEN;

// In-memory conversation state for multi-step signup
// chatId -> { step: 'await_email' | 'await_password', keyId, keyData, availableEmail }
const pendingSignups = new Map();

let _db = null;
let _auth = null;
let _adminRef = null;
const PROJECT_ID = 'ff-store-4a61e';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Helper: parse a Firestore REST field value
function parseField(v) {
  return v.stringValue ?? v.integerValue ?? v.booleanValue ?? v.doubleValue ?? null;
}

// Helper: parse a full Firestore REST document into a plain object
function parseDoc(doc) {
  const data = {};
  if (doc.fields) {
    for (const [k, v] of Object.entries(doc.fields)) {
      data[k] = parseField(v);
    }
  }
  return data;
}

// GET single document via REST
async function firestoreGet(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${FS_BASE}/${path}`, { signal: controller.signal });
    if (res.status === 404) return { exists: false, data: null };
    if (!res.ok) {
      const body = await res.text().catch(() => String(res.status));
      throw new Error(`Firestore GET ${res.status}: ${body.substring(0, 150)}`);
    }
    return { exists: true, data: parseDoc(await res.json()) };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Firestore timed out (10s)');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// LIST all docs in a collection via REST
async function firestoreList(collection) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${FS_BASE}/${collection}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => String(res.status));
      throw new Error(`Firestore LIST ${res.status}: ${body.substring(0, 150)}`);
    }
    const json = await res.json();
    const docs = json.documents || [];
    return docs.map(doc => ({
      id: doc.name.split('/').pop(),
      data: parseDoc(doc)
    }));
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Firestore list timed out (12s)');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}


// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
export async function initTelegramBot(db, app, admin) {
  _db = db;
  _adminRef = admin;
  _auth = admin && admin.apps && admin.apps.length > 0 ? admin.auth() : null;

  // Verify token
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await res.json();
    if (!data.ok) {
      console.error('❌ Invalid Telegram Bot Token:', data.description);
      return;
    }
    console.log(`✅ Telegram Bot verified: @${data.result.username}`);
  } catch (err) {
    console.error('❌ Failed to verify Telegram Bot Token:', err.message);
    return;
  }

  // Register webhook endpoint
  app.post('/telegram/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
      const update = req.body;
      if (update && update.message && update.message.text) {
        await handleBotMessage(update.message);
      }
    } catch (err) {
      console.error('Telegram webhook error:', err.message);
    }
  });

  // Register webhook with Telegram
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://imap-proxy-server.onrender.com';
  const webhookUrl = `${RENDER_URL}/telegram/webhook`;
  try {
    const whRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const whData = await whRes.json();
    if (whData.ok) console.log(`✅ Telegram Webhook registered: ${webhookUrl}`);
    else console.error('❌ Failed to register webhook:', whData.description);
  } catch (err) {
    console.error('❌ Error registering webhook:', err.message);
  }
}

// ─────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────
async function sendMsg(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (err) {
    console.error(`Failed to send message to ${chatId}:`, err.message);
  }
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────
async function handleBotMessage(message) {
  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const lower = text.toLowerCase();

  // ── If user is mid-signup, handle conversation steps first ──
  if (pendingSignups.has(chatId)) {
    await handleSignupConversation(chatId, text);
    return;
  }

  // ── /start ──
  if (lower === '/start' || lower === 'hi' || lower === 'hello') {
    await sendMsg(chatId,
      `👋 <b>Welcome to Garena OTP Assistant!</b>\n\n` +
      `<b>How to use:</b>\n` +
      `1️⃣ Type <code>signup YOUR_LICENSE_KEY</code>\n` +
      `   Example: <code>signup TG-9QH7MYR5</code>\n\n` +
      `2️⃣ Enter your email &amp; set a password\n\n` +
      `3️⃣ Copy the assigned Garena email\n\n` +
      `4️⃣ After OTP arrives, type <code>otp</code>\n\n` +
      `⚠️ <i>Limit: 1 OTP per 48 hours</i>`);
    return;
  }

  // ── Bare TG- key detection ──
  const upperText = text.toUpperCase().trim();
  if (/^TG-[A-Z0-9]+$/.test(upperText)) {
    await sendMsg(chatId,
      `🔑 <b>License key detected!</b>\n\n` +
      `To activate, type:\n<code>signup ${upperText}</code>`);
    return;
  }

  // ── Signup command ──
  if (lower.startsWith('signup') || lower.startsWith('/signup')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      await sendMsg(chatId,
        `⚠️ <b>Please include your license key!</b>\n` +
        `Format: <code>signup TG-XXXXXXXX</code>`);
      return;
    }

    if (!_db) {
      await sendMsg(chatId, `⚠️ <b>Server not ready yet.</b> Please try again in 2 minutes.`);
      return;
    }

    const licenseKeyId = parts[1].trim().toUpperCase();
    await startSignup(chatId, licenseKeyId);
    return;
  }

  // ── OTP command ──
  if (lower === 'otp' || lower === '/otp') {
    await handleOtp(chatId);
    return;
  }

  // ── Cancel ──
  if (lower === 'cancel' || lower === '/cancel') {
    pendingSignups.delete(chatId);
    await sendMsg(chatId, `❌ Signup cancelled. Type <code>signup YOUR_KEY</code> to start again.`);
    return;
  }

  // ── Default ──
  await sendMsg(chatId,
    `❓ <b>Unknown command.</b>\n\n` +
    `• <code>signup TG-XXXXXXXX</code> — Register license key\n` +
    `• <code>otp</code> — Get your Garena OTP\n` +
    `• <code>cancel</code> — Cancel current action`);
}

// ─────────────────────────────────────────────
// STEP 1: Verify key → ask email
// ─────────────────────────────────────────────
async function startSignup(chatId, licenseKeyId) {
  await sendMsg(chatId, `⏳ Verifying license key <code>${licenseKeyId}</code>...`);

  let keyExists = false;
  let keyData = null;

  try {
    const result = await firestoreGet(`telegram_license_keys/${licenseKeyId}`);
    keyExists = result.exists;
    keyData = result.data;
  } catch (err) {
    console.error('Key lookup error:', err.message);
    await sendMsg(chatId, `⚠️ <b>Database error.</b> Please try again.\n\n<i>${err.message}</i>`);
    return;
  }

  if (!keyExists || !keyData) {
    await sendMsg(chatId, `❌ <b>License key not found!</b>\n\nCheck spelling or contact Admin @example_tgid`);
    return;
  }

  if (keyData.status !== 'active') {
    await sendMsg(chatId, `❌ <b>Key already redeemed!</b>\n\nContact Admin @example_tgid`);
    return;
  }


  // Check if this chatId already has an active session (via REST)
  try {
    const existingSession = await firestoreGet(`telegram_user_sessions/${chatId}`);
    if (existingSession.exists) {
      const sess = existingSession.data;
      if (Date.now() < (Number(sess.licenseExpiry) || 0)) {
        await sendMsg(chatId,
          `ℹ️ <b>You already have an active account!</b>\n\n` +
          `📧 Mailbox: <code>${sess.assignedMailboxEmail}</code>\n\n` +
          `Type <code>otp</code> to get your code.`);
        return;
      }
    }
  } catch (e) { /* ignore - proceed with signup */ }

  // Key valid! Resolve mailbox
  let availableEmail = '';
  try {
    if (keyData.assignedMailbox) {
      availableEmail = keyData.assignedMailbox;
      // Check if pre-assigned mailbox already in use (via REST list)
      const sessions = await firestoreList('telegram_user_sessions');
      const inUse = sessions.some(s => s.data.assignedMailboxEmail === availableEmail);
      if (inUse) {
        await sendMsg(chatId, `❌ <b>Mailbox already in use!</b>\n\nContact Admin @example_tgid`);
        return;
      }
    } else {
      availableEmail = await findUnassignedMailbox();
    }
  } catch (err) {
    await sendMsg(chatId, `⚠️ <b>Mailbox lookup failed.</b> Try again.\n<i>${err.message}</i>`);
    return;
  }

  if (!availableEmail) {
    await sendMsg(chatId, `⚠️ <b>No mailboxes available!</b>\n\nContact Admin @example_tgid`);
    return;
  }

  // Key verified ✅ — save state and ask for email
  pendingSignups.set(chatId, {
    step: 'await_email',
    keyId: licenseKeyId,
    keyData,
    availableEmail
  });

  await sendMsg(chatId,
    `✅ <b>License Key Verified!</b>\n\n` +
    `📧 Assigned Garena Mailbox: <code>${availableEmail}</code>\n\n` +
    `Now let's create your account.\n` +
    `Please enter your <b>email address</b>:\n\n` +
    `<i>(Type cancel to abort)</i>`);
}

// ─────────────────────────────────────────────
// STEP 2 & 3: Handle email → password → create account
// ─────────────────────────────────────────────
async function handleSignupConversation(chatId, text) {
  const state = pendingSignups.get(chatId);

  // Cancel anytime
  if (text.toLowerCase() === 'cancel' || text.toLowerCase() === '/cancel') {
    pendingSignups.delete(chatId);
    await sendMsg(chatId, `❌ Signup cancelled.`);
    return;
  }

  // ── STEP: Waiting for email ──
  if (state.step === 'await_email') {
    const email = text.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      await sendMsg(chatId,
        `⚠️ <b>Invalid email format!</b>\n\nPlease enter a valid email address.\nExample: <code>yourname@gmail.com</code>`);
      return;
    }

    // Check if email already in use in Firebase Auth
    if (_auth) {
      try {
        await _auth.getUserByEmail(email);
        // If no error thrown, user exists
        await sendMsg(chatId,
          `❌ <b>Email already registered!</b>\n\nPlease use a different email address.`);
        return;
      } catch (e) {
        // Error means user NOT found — good, continue
      }
    }

    // Save email, ask for password
    state.step = 'await_password';
    state.email = email;
    pendingSignups.set(chatId, state);

    await sendMsg(chatId,
      `✅ Email saved: <code>${email}</code>\n\n` +
      `Now set a <b>password</b> for your account:\n` +
      `<i>(Minimum 6 characters)</i>`);
    return;
  }

  // ── STEP: Waiting for password ──
  if (state.step === 'await_password') {
    const password = text.trim();
    if (password.length < 6) {
      await sendMsg(chatId, `⚠️ Password must be at least <b>6 characters</b>. Try again:`);
      return;
    }

    await sendMsg(chatId, `⏳ Creating your account...`);

    try {
      // Auto-generate display name: User 1, User 2, etc.
      let displayName = 'User 1';
      if (_auth) {
        try {
          const userList = await _auth.listUsers(1000);
          displayName = `User ${userList.users.length + 1}`;
        } catch (e) { /* fallback to User 1 */ }
      }

      // Create Firebase Auth user
      let firebaseUser = null;
      if (_auth) {
        firebaseUser = await _auth.createUser({
          email: state.email,
          password: password,
          displayName: displayName,
        });
      }

      // Create Firestore user document (same as website)
      const expiryTime = Date.now() + (Number(state.keyData.validityDays || 2) * 24 * 60 * 60 * 1000);
      const uid = firebaseUser ? firebaseUser.uid : `tg_${chatId}`;

      await _db.collection('users').doc(uid).set({
        uid,
        name: displayName,
        email: state.email,
        role: 'client',
        assignedMailbox: state.availableEmail,
        createdAt: Date.now(),
        source: 'telegram',
        telegramChatId: chatId
      });

      // Create Telegram session
      await _db.collection('telegram_user_sessions').doc(chatId).set({
        chatId,
        uid,
        email: state.email,
        displayName,
        assignedMailboxEmail: state.availableEmail,
        licenseExpiry: expiryTime,
        lastOtpFetchedAt: null,
        joinedAt: Date.now()
      });

      // Mark key as redeemed
      await _db.collection('telegram_license_keys').doc(state.keyId).update({
        status: 'redeemed',
        redeemedByChatId: chatId,
        redeemedAt: Date.now(),
        assignedMailboxEmail: state.availableEmail,
        redeemedByEmail: state.email
      });

      // Clear state
      pendingSignups.delete(chatId);

      await sendMsg(chatId,
        `🎉 <b>Account Created Successfully!</b>\n\n` +
        `👤 <b>Name:</b> ${displayName}\n` +
        `📧 <b>Login Email:</b> <code>${state.email}</code>\n` +
        `🎮 <b>Garena Mailbox:</b>\n<code>${state.availableEmail}</code>\n` +
        `⏳ <b>Expires:</b> ${new Date(expiryTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n` +
        `👉 Copy the Garena mailbox email above and use it to sign in on Garena.\n` +
        `When Garena sends the OTP, come back and type <code>otp</code>`);

    } catch (err) {
      console.error('Account creation error:', err.message);
      pendingSignups.delete(chatId);
      await sendMsg(chatId,
        `❌ <b>Account creation failed!</b>\n\n` +
        `Error: ${err.message}\n\n` +
        `Contact Admin @example_tgid`);
    }
    return;
  }
}

// ─────────────────────────────────────────────
// OTP FLOW
// ─────────────────────────────────────────────
async function handleOtp(chatId) {
  if (!_db) {
    await sendMsg(chatId, `⚠️ <b>Server not ready.</b> Try again in 2 minutes.`);
    return;
  }

  let userSessionSnap;
  try {
    userSessionSnap = await firestoreGet(`telegram_user_sessions/${chatId}`);
  } catch (err) {
    await sendMsg(chatId, `⚠️ <b>Database error.</b> Try again.\n<i>${err.message}</i>`);
    return;
  }

  if (!userSessionSnap.exists) {
    await sendMsg(chatId,
      `❌ <b>Not registered!</b>\n\nType <code>signup TG-XXXXXXXX</code> to get started.`);
    return;
  }

  const session = userSessionSnap.data;

  if (Date.now() > (session.licenseExpiry || 0)) {
    await sendMsg(chatId,
      `❌ <b>License expired!</b>\n\nContact Admin @example_tgid to renew.`);
    return;
  }

  if (session.lastOtpFetchedAt) {
    const diff = Date.now() - session.lastOtpFetchedAt;
    const limit = 48 * 60 * 60 * 1000;
    if (diff < limit) {
      const remaining = limit - diff;
      const hrs = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      await sendMsg(chatId,
        `⚠️ <b>Limit reached!</b>\n\n1 OTP per 48 hours.\n\n⏳ Try again after: <b>${hrs}h ${mins}m</b>`);
      return;
    }
  }

  await sendMsg(chatId, `🔍 Fetching your OTP from mailbox...`);

  const mailboxEmail = session.assignedMailboxEmail;
  let credData = null;

  try {
    // Use REST list to find credentials (avoids gRPC rate limit)
    const allCreds = await firestoreList('imap_credentials');
    const found = allCreds.find(c =>
      c.data.imap_email === mailboxEmail || c.data.email === mailboxEmail
    );
    if (found) credData = found.data;
  } catch (err) {
    await sendMsg(chatId, `❌ <b>Credential lookup failed.</b>\n<i>${err.message}</i>`);
    return;
  }

  if (!credData) {
    await sendMsg(chatId, `❌ <b>Mailbox credentials not found!</b>\n\nAdmin needs to add <code>${mailboxEmail}</code> to Email Monitor.`);
    return;
  }

  try {
    const messages = await fetchInboxMessages(credData);

    // Filter Garena emails
    const garenaMsgs = messages.filter(m => {
      const f = (m.sender || '').toLowerCase();
      const s = (m.subject || '').toLowerCase();
      const b = (m.body || '').toLowerCase();
      return f.includes('garena') || f.includes('account@garena') ||
             s.includes('garena') || s.includes('verification') ||
             b.includes('garena') || b.includes('verification code');
    });

    if (garenaMsgs.length === 0) {
      await sendMsg(chatId,
        `📭 <b>No Garena emails found!</b>\n\nTrigger OTP on Garena, wait 30 seconds, then type <code>otp</code> again.`);
      return;
    }

    // Sort newest first
    garenaMsgs.sort((a, b) => Number(b.sentTime || 0) - Number(a.sentTime || 0));
    const latest = garenaMsgs[0];
    const bodyText = latest.body || '';

    // Garena OTP: standalone 6-8 digit number on its own line
    // e.g. "51137492" appears alone on a line
    const match =
      bodyText.match(/^\s*(\d{6,8})\s*$/m) ||   // standalone on its own line
      bodyText.match(/code[:\s]+([\s\n]*(\d{6,8}))/i) ||  // after word "code"
      bodyText.match(/\b(\d{6,8})\b/);           // anywhere as fallback

    const otp = match ? (match[2] || match[1]) : null;

    if (!otp) {
      // Show raw email so user can manually read it
      const preview = bodyText.replace(/\s+/g, ' ').trim().substring(0, 500);
      await sendMsg(chatId,
        `⚠️ <b>OTP auto-extract failed!</b>\n\n` +
        `📧 <b>Latest Garena Email:</b>\n` +
        `<i>From:</i> ${latest.sender}\n` +
        `<i>Subject:</i> ${latest.subject}\n\n` +
        `<pre>${preview}</pre>\n\n` +
        `Copy the code manually from above ☝️`);
      return;
    }

    // Update last OTP fetch time
    try {
      await _db.collection('telegram_user_sessions').doc(chatId).update({ lastOtpFetchedAt: Date.now() });
    } catch (e) { /* non-critical */ }

    await sendMsg(chatId,
      `🔑 <b>Your Garena OTP:</b>\n\n` +
      `<code>${otp}</code>\n\n` +
      `👆 Tap to copy. Limit locked for next 48 hours.`);

  } catch (err) {
    await sendMsg(chatId, `❌ <b>Mailbox connection error!</b>\n\n<i>${err.message}</i>\n\nCheck if App Password is correct in Email Monitor.`);
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
async function findUnassignedMailbox() {
  // Use REST API to list imap_credentials - avoids gRPC rate limit
  const creds = await firestoreList('imap_credentials');
  const sessions = await firestoreList('telegram_user_sessions');
  const usedEmails = new Set(sessions.map(s => s.data.assignedMailboxEmail).filter(Boolean));

  for (const cred of creds) {
    const email = cred.data.imap_email || cred.data.email;
    if (!email) continue;
    if (!usedEmails.has(email)) return email;
  }
  return null;
}


async function fetchInboxMessages(credData) {
  const client = new ImapFlow({
    host: credData.imap_host,
    port: parseInt(credData.imap_port) || 993,
    secure: credData.imap_secure !== false,
    auth: { user: credData.imap_user || credData.email, pass: credData.imap_password || credData.password },
    logger: false
  });

  await client.connect();
  const msgs = [];
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists || 0;
      if (total > 0) {
        const range = `${Math.max(1, total - 14)}:*`;
        for await (const msg of client.fetch(range, { envelope: true, source: true })) {
          const parsed = await simpleParser(msg.source);
          msgs.push({
            subject: msg.envelope.subject || '',
            sender: msg.envelope.from?.value?.map(f => f.address).join(', ') || '',
            sentTime: msg.envelope.date?.getTime() || Date.now(),
            body: parsed.text || '',
            summary: parsed.textAsHtml || ''
          });
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout(); }
  return msgs;
}
