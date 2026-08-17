import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Bot token: env var > Firestore > hardcoded fallback
const HARDCODED_BOT_TOKEN = '8700234031:AAEBQCGb3zXS7Jb1xlHT7novzQEm-tamhGk';
let botToken = process.env.TELEGRAM_BOT_TOKEN || HARDCODED_BOT_TOKEN;
let db_ref = null;

// Called from index.js on server startup
export async function initTelegramBot(db, app) {
  db_ref = db;

  // Load token from env first, then Firestore

  if (!botToken) {
    try {
      const settingsSnap = await db.collection('system_settings').doc('telegram').get();
      if (settingsSnap.exists()) {
        botToken = settingsSnap.data().botToken;
        console.log('✅ Telegram Bot Token loaded from Firestore.');
      }
    } catch (e) {
      console.warn('Could not load Telegram Bot Token from Firestore:', e.message);
    }
  }

  if (!botToken) {
    console.warn('⚠️ Telegram Bot Token not found. Bot is disabled.');
    return;
  }

  // Verify token
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await res.json();
    if (!data.ok) {
      console.error('❌ Invalid Telegram Bot Token:', data.description);
      return;
    }
    console.log(`✅ Telegram Bot verified: @${data.result.username} (${data.result.first_name})`);
  } catch (err) {
    console.error('❌ Failed to verify Telegram Bot Token:', err.message);
    return;
  }

  // Register webhook endpoint on the express app
  app.post('/telegram/webhook', async (req, res) => {
    res.sendStatus(200); // Always respond 200 to Telegram immediately
    try {
      const update = req.body;
      if (update && update.message && update.message.text) {
        await handleBotMessage(db, update.message);
      }
    } catch (err) {
      console.error('Telegram webhook error:', err.message);
    }
  });

  // Register the webhook URL with Telegram
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://imap-proxy-server.onrender.com';
  const webhookUrl = `${RENDER_URL}/telegram/webhook`;

  try {
    const whRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const whData = await whRes.json();
    if (whData.ok) {
      console.log(`✅ Telegram Webhook registered: ${webhookUrl}`);
    } else {
      console.error('❌ Failed to register Telegram webhook:', whData.description);
    }
  } catch (err) {
    console.error('❌ Error registering Telegram webhook:', err.message);
  }
}

async function sendTelegramMessage(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error(`Failed to send Telegram message to ${chatId}:`, err.message);
  }
}

async function handleBotMessage(db, message) {
  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const lowerText = text.toLowerCase();

  // 1. GREETING / START COMMAND
  if (lowerText === '/start' || lowerText === 'hi' || lowerText === 'hello') {
    const welcomeMsg =
      `👋 <b>Welcome to Garena OTP Assistant!</b>\n\n` +
      `I help you receive Garena game OTPs instantly inside Telegram.\n\n` +
      `<b>How to get started:</b>\n` +
      `1️⃣ Type <code>signup YOUR_LICENSE_KEY</code>\n` +
      `   Example: <code>signup TG-9QH7MYR5</code>\n\n` +
      `2️⃣ Copy the assigned email address and use it on Garena\n\n` +
      `3️⃣ After Garena sends OTP, type <code>otp</code> to get your code\n\n` +
      `⚠️ <i>Limit: 1 OTP per 48 hours</i>`;
    await sendTelegramMessage(chatId, welcomeMsg);
    return;
  }

  // 2. BARE KEY DETECTION — user pastes key directly like "TG-9QH7MYR5"
  const upperText = text.toUpperCase().trim();
  if (/^TG-[A-Z0-9]+$/.test(upperText)) {
    await sendTelegramMessage(chatId,
      `🔑 <b>License key detected!</b>\n\n` +
      `To activate key <code>${upperText}</code>, please type:\n` +
      `<code>signup ${upperText}</code>\n\n` +
      `<i>Just add "signup" before the key and send again.</i>`);
    return;
  }

  // 3. SIGNUP FLOW (signup <key> or /signup <key>)
  if (lowerText.startsWith('signup') || lowerText.startsWith('/signup')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      await sendTelegramMessage(chatId,
        `⚠️ <b>Please include your license key!</b>\n\n` +
        `Format: <code>signup TG-XXXXXXXX</code>\n` +
        `Example: <code>signup TG-9QH7MYR5</code>`);
      return;
    }

    if (!db) {
      await sendTelegramMessage(chatId, `⚠️ <b>Server database is not connected yet.</b>\n\nPlease try again in 2 minutes.`);
      return;
    }

    const licenseKeyId = parts[1].trim().toUpperCase();

    // Query Firestore for this key
    const keyRef = db.collection('telegram_license_keys').doc(licenseKeyId);
    const keySnap = await keyRef.get();

    if (!keySnap.exists) {
      await sendTelegramMessage(chatId, `❌ <b>License key not found!</b>\n\nPlease check the spelling or talk to Admin: @example_tgid`);
      return;
    }

    const keyData = keySnap.data();
    if (keyData.status !== 'active') {
      await sendTelegramMessage(chatId, `❌ <b>This license key has already been redeemed!</b>\n\nPlease talk to Admin: @example_tgid`);
      return;
    }

    // Key is valid! Resolve Garena mailbox
    await sendTelegramMessage(chatId, `⏳ Validating key and allocating secure mailbox...`);

    let availableEmail = '';
    if (keyData.assignedMailbox) {
      availableEmail = keyData.assignedMailbox;

      // Check if this mailbox is already in use by another Telegram session
      const sessionSnap = await db.collection('telegram_user_sessions')
        .where('assignedMailboxEmail', '==', availableEmail)
        .get();

      if (!sessionSnap.empty) {
        await sendTelegramMessage(chatId, `❌ <b>Mailbox is currently active in another session!</b>\n\nThis specific Garena mailbox (<code>${availableEmail}</code>) is already linked to another active client. Please talk to Admin @example_tgid.`);
        return;
      }
    } else {
      availableEmail = await findUnassignedMailbox(db);
    }

    if (!availableEmail) {
      await sendTelegramMessage(chatId, `⚠️ <b>No mailboxes available!</b>\n\nAll Garena mailboxes are currently assigned. Please contact Admin @example_tgid to restock.`);
      return;
    }

    const expiryTime = Date.now() + (Number(keyData.validityDays || 2) * 24 * 60 * 60 * 1000);

    // Create User Session
    const userSessionRef = db.collection('telegram_user_sessions').doc(chatId);
    await userSessionRef.set({
      chatId,
      assignedMailboxEmail: availableEmail,
      licenseExpiry: expiryTime,
      lastOtpFetchedAt: null,
      joinedAt: Date.now()
    });

    // Mark key as redeemed
    await keyRef.update({
      status: 'redeemed',
      redeemedByChatId: chatId,
      redeemedAt: Date.now(),
      assignedMailboxEmail: availableEmail
    });

    const successMsg =
      `🎉 <b>License Activated Successfully!</b>\n\n` +
      `📧 <b>Assigned Garena Mailbox:</b>\n<code>${availableEmail}</code>\n\n` +
      `⏳ <b>Expiration Date:</b> ${new Date(expiryTime).toLocaleString()}\n\n` +
      `👉 Copy the email address above to use for your game login. When Garena sends the OTP, come back here and type <b><code>otp</code></b> to view your verification code!`;

    await sendTelegramMessage(chatId, successMsg);
    return;
  }

  // 4. FETCH OTP FLOW (otp or /otp)
  if (lowerText === 'otp' || lowerText === '/otp') {
    const userSessionSnap = await db.collection('telegram_user_sessions').doc(chatId).get();
    if (!userSessionSnap.exists) {
      await sendTelegramMessage(chatId, `❌ <b>You are not registered!</b>\n\nPlease enter a license key to register first:\n<code>signup TG-XXXX-XXXX</code>`);
      return;
    }

    const session = userSessionSnap.data();
    const expiry = session.licenseExpiry || 0;

    // Check expiry
    if (Date.now() > expiry) {
      await sendTelegramMessage(chatId, `❌ <b>Your license has expired!</b>\n\nKindly talk to Admin @example_tgid to purchase a new Telegram license.`);
      return;
    }

    // Check 48 hour limit
    if (session.lastOtpFetchedAt) {
      const limitPeriod = 48 * 60 * 60 * 1000;
      const diff = Date.now() - session.lastOtpFetchedAt;
      if (diff < limitPeriod) {
        const remainingMs = limitPeriod - diff;
        const remainingHours = Math.floor(remainingMs / (3600 * 1000));
        const remainingMins = Math.floor((remainingMs % (3600 * 1000)) / (60 * 1000));
        await sendTelegramMessage(chatId, `⚠️ <b>Limit Reached!</b>\n\nYou can only fetch 1 OTP every 48 hours.\n\n⏳ Please try again after: <b>${remainingHours} hours ${remainingMins} minutes</b>.`);
        return;
      }
    }

    // Fetch credentials for assigned mailbox
    await sendTelegramMessage(chatId, `🔍 Accessing mailbox logs and retrieving OTP...`);
    const mailboxEmail = session.assignedMailboxEmail;

    const credsSnap = await db.collection('imap_credentials')
      .where('imap_email', '==', mailboxEmail)
      .get();

    if (credsSnap.empty) {
      await sendTelegramMessage(chatId, `❌ <b>Configuration error!</b>\n\nIMAP credentials for your Garena mailbox <code>${mailboxEmail}</code> could not be found. Please contact Admin.`);
      return;
    }

    let credData = null;
    credsSnap.forEach(d => { credData = d.data(); });

    try {
      const messages = await fetchInboxMessages(credData);

      // Filter for Garena messages
      const garenaMsgs = messages.filter(m => {
        const fromVal = (m.sender || '').toLowerCase();
        const subjectVal = (m.subject || '').toLowerCase();
        const summaryVal = (m.summary || '').toLowerCase();
        return fromVal.includes('garena') || subjectVal.includes('garena') || summaryVal.includes('garena') || subjectVal.includes('otp') || subjectVal.includes('verification');
      });

      if (garenaMsgs.length === 0) {
        await sendTelegramMessage(chatId, `📭 <b>No Garena emails found!</b>\n\nPlease trigger the OTP send in Garena first, wait 30 seconds, and type <b><code>otp</code></b> again.`);
        return;
      }

      // Sort by time descending (latest first)
      garenaMsgs.sort((a, b) => Number(b.sentTime || 0) - Number(a.sentTime || 0));
      const latestMsg = garenaMsgs[0];
      const searchTarget = `${latestMsg.subject} ${latestMsg.body || latestMsg.summary || ''}`;

      // Extract 4-8 digit numeric code
      const otpMatch = searchTarget.match(/\b(\d{4,8})\b/);
      if (!otpMatch) {
        await sendTelegramMessage(chatId, `⚠️ <b>Email received, but no OTP code detected!</b>\n\nLatest Subject: ${latestMsg.subject}\n\nPlease try resending the OTP.`);
        return;
      }

      const otpCode = otpMatch[1];

      // Update fetch timestamp
      await db.collection('telegram_user_sessions').doc(chatId).update({
        lastOtpFetchedAt: Date.now()
      });

      const otpSuccessMsg =
        `🔑 <b>Your Garena OTP Code is:</b>\n\n` +
        `<code>${otpCode}</code>\n\n` +
        `👉 <i>Click or tap to copy the code. This code will only fetch once and your limit is now locked for the next 48 hours.</i>`;

      await sendTelegramMessage(chatId, otpSuccessMsg);

    } catch (imapErr) {
      console.error('Telegram bot IMAP check failed:', imapErr);
      await sendTelegramMessage(chatId, `❌ <b>Mailbox sync failed!</b>\n\nError: ${imapErr.message || 'Could not connect to Garena server.'}`);
    }
    return;
  }

  // DEFAULT FALLBACK
  await sendTelegramMessage(chatId,
    `❓ <b>Unknown Command!</b>\n\n` +
    `Available commands:\n` +
    `• <code>signup TG-XXXXXXXX</code> — Register your license key\n` +
    `• <code>otp</code> — Get your Garena OTP`);
}

async function findUnassignedMailbox(db) {
  const imapSnap = await db.collection('imap_credentials').get();
  for (const doc of imapSnap.docs) {
    const data = doc.data();
    const email = data.imap_email;
    if (!email) continue;

    const sessionSnap = await db.collection('telegram_user_sessions')
      .where('assignedMailboxEmail', '==', email)
      .get();

    if (sessionSnap.empty) {
      const userSnap = await db.collection('users')
        .where('role', '==', 'client')
        .where('email', '==', email)
        .get();

      if (userSnap.empty) return email;
    }
  }
  return null;
}

async function fetchInboxMessages(credData) {
  const client = new ImapFlow({
    host: credData.imap_host,
    port: parseInt(credData.imap_port) || 993,
    secure: credData.imap_secure !== false,
    auth: {
      user: credData.imap_user,
      pass: credData.imap_password
    },
    logger: false
  });

  await client.connect();
  const allMessages = [];

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = client.mailbox;
      const total = status.exists || 0;
      if (total > 0) {
        const startSeq = Math.max(1, total - 14);
        const range = `${startSeq}:*`;

        for await (const msg of client.fetch(range, { envelope: true, source: true })) {
          const parsed = await simpleParser(msg.source);
          allMessages.push({
            messageId: msg.envelope.messageId,
            subject: msg.envelope.subject || '(No Subject)',
            sender: msg.envelope.from ? msg.envelope.from.value.map(f => f.address).join(', ') : '',
            sentTime: msg.envelope.date ? msg.envelope.date.getTime() : Date.now(),
            summary: parsed.textAsHtml || parsed.text || '',
            body: parsed.text || ''
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return allMessages;
}
