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

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
export async function initTelegramBot(db, app, admin) {
  _db = db;
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

  let keySnap;
  try {
    keySnap = await _db.collection('telegram_license_keys').doc(licenseKeyId).get();
  } catch (err) {
    console.error('Firestore error (key lookup):', err.message);
    await sendMsg(chatId, `⚠️ <b>Database error.</b> Please try again in a few minutes.\n\n<i>${err.message}</i>`);
    return;
  }

  if (!keySnap.exists) {
    await sendMsg(chatId, `❌ <b>License key not found!</b>\n\nCheck spelling or contact Admin @example_tgid`);
    return;
  }

  const keyData = keySnap.data();
  if (keyData.status !== 'active') {
    await sendMsg(chatId, `❌ <b>Key already redeemed!</b>\n\nContact Admin @example_tgid`);
    return;
  }

  // Check if this chatId already has an active session
  try {
    const existingSession = await _db.collection('telegram_user_sessions').doc(chatId).get();
    if (existingSession.exists) {
      const sess = existingSession.data();
      if (Date.now() < (sess.licenseExpiry || 0)) {
        await sendMsg(chatId,
          `ℹ️ <b>You already have an active account!</b>\n\n` +
          `📧 Mailbox: <code>${sess.assignedMailboxEmail}</code>\n\n` +
          `Type <code>otp</code> to get your code.`);
        return;
      }
    }
  } catch (e) { /* ignore */ }

  // Key valid! Resolve mailbox
  let availableEmail = '';
  try {
    if (keyData.assignedMailbox) {
      availableEmail = keyData.assignedMailbox;
      const sessionSnap = await _db.collection('telegram_user_sessions')
        .where('assignedMailboxEmail', '==', availableEmail).get();
      if (!sessionSnap.empty) {
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
    userSessionSnap = await _db.collection('telegram_user_sessions').doc(chatId).get();
  } catch (err) {
    await sendMsg(chatId, `⚠️ <b>Database error.</b> Try again.\n<i>${err.message}</i>`);
    return;
  }

  if (!userSessionSnap.exists) {
    await sendMsg(chatId,
      `❌ <b>Not registered!</b>\n\nType <code>signup TG-XXXXXXXX</code> to get started.`);
    return;
  }

  const session = userSessionSnap.data();

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
    // Check all credential collections
    for (const col of ['imap_credentials', 'gmail_credentials', 'zoho_credentials']) {
      const snap = await _db.collection(col).where('imap_email', '==', mailboxEmail).get();
      if (!snap.empty) { snap.forEach(d => { credData = d.data(); }); break; }
      // Also try email field for gmail/zoho
      const snap2 = await _db.collection(col).where('email', '==', mailboxEmail).get();
      if (!snap2.empty) { snap2.forEach(d => { credData = d.data(); }); break; }
    }
  } catch (err) {
    await sendMsg(chatId, `❌ <b>Credential lookup failed.</b>\n<i>${err.message}</i>`);
    return;
  }

  if (!credData) {
    await sendMsg(chatId, `❌ <b>Mailbox credentials not found!</b> Contact Admin.`);
    return;
  }

  try {
    const messages = await fetchInboxMessages(credData);
    const garenaMsgs = messages.filter(m => {
      const f = (m.sender || '').toLowerCase();
      const s = (m.subject || '').toLowerCase();
      const b = (m.body || m.summary || '').toLowerCase();
      return f.includes('garena') || s.includes('garena') || b.includes('garena') ||
             s.includes('otp') || s.includes('verification') || s.includes('verify');
    });

    if (garenaMsgs.length === 0) {
      await sendMsg(chatId,
        `📭 <b>No Garena emails found!</b>\n\nTrigger OTP on Garena, wait 30 seconds, then type <code>otp</code> again.`);
      return;
    }

    garenaMsgs.sort((a, b) => Number(b.sentTime || 0) - Number(a.sentTime || 0));
    const latest = garenaMsgs[0];
    const target = `${latest.subject} ${latest.body || latest.summary || ''}`;
    const match = target.match(/\b(\d{4,8})\b/);

    if (!match) {
      await sendMsg(chatId,
        `⚠️ <b>Email received but no OTP found!</b>\n\nSubject: ${latest.subject}\n\nResend OTP and try again.`);
      return;
    }

    await _db.collection('telegram_user_sessions').doc(chatId).update({ lastOtpFetchedAt: Date.now() });

    await sendMsg(chatId,
      `🔑 <b>Your Garena OTP:</b>\n\n` +
      `<code>${match[1]}</code>\n\n` +
      `👆 Tap to copy. Limit locked for next 48 hours.`);

  } catch (err) {
    await sendMsg(chatId, `❌ <b>Mailbox error!</b>\n<i>${err.message}</i>`);
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
async function findUnassignedMailbox() {
  const snap = await _db.collection('imap_credentials').get();
  for (const doc of snap.docs) {
    const email = doc.data().imap_email;
    if (!email) continue;
    const used = await _db.collection('telegram_user_sessions')
      .where('assignedMailboxEmail', '==', email).get();
    if (used.empty) return email;
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
