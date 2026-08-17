import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

let botToken = process.env.TELEGRAM_BOT_TOKEN;
let botUsername = '';

export async function initTelegramBot(db) {
  if (!botToken) {
    // Check if there is a document in Firestore with settings
    try {
      const settingsSnap = await db.collection('system_settings').doc('telegram').get();
      if (settingsSnap.exists()) {
        botToken = settingsSnap.data().botToken;
      }
    } catch (e) {
      console.warn("Could not load Telegram Bot Token from Firestore settings.");
    }
  }

  if (!botToken) {
    console.warn("⚠️ Telegram Bot Token is not configured (TELEGRAM_BOT_TOKEN env var is missing). Telegram Bot is disabled.");
    return;
  }

  console.log("🤖 Initializing Garena OTP Telegram Bot...");
  
  // Verify Bot Token and get bot name/username
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await res.json();
    if (data.ok) {
      botUsername = data.result.username;
      console.log(`✅ Telegram Bot verified: @${botUsername} (${data.result.first_name})`);
      
      // Start Long Polling
      startPolling(db);
    } else {
      console.error("❌ Invalid Telegram Bot Token.");
    }
  } catch (err) {
    console.error("❌ Failed to connect to Telegram API:", err.message);
  }
}

async function startPolling(db) {
  let offset = 0;
  
  // Clean up any pending updates on startup
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=-1`);
  } catch (err) {}

  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=30`);
      if (!res.ok) {
        // Wait 5 seconds before retrying if server error
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      
      const resData = await res.json();
      if (resData.ok && resData.result.length > 0) {
        for (const update of resData.result) {
          offset = update.update_id + 1;
          if (update.message && update.message.text) {
            // Handle message asynchronously so polling isn't blocked
            handleBotMessage(db, update.message).catch(err => {
              console.error("Error processing Telegram message:", err);
            });
          }
        }
      }
    } catch (err) {
      console.error("Telegram polling error:", err.message);
      // Wait 5 seconds before retrying if network error
      await new Promise(r => setTimeout(r, 5000));
    }
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
    // Treat as signup attempt with this key
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

  // 3. FETCH OTP FLOW (otp or /otp)
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
      const limitPeriod = 48 * 60 * 60 * 1000; // 48 hours in ms
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
    credsSnap.forEach(d => {
      credData = d.data();
    });

    try {
      const messages = await fetchInboxMessages(credData);
      
      // Filter for Garena messages
      const garenaMsgs = messages.filter(m => {
        const fromVal = (m.sender || '').toLowerCase();
        const subjectVal = (m.subject || '').toLowerCase();
        const summaryVal = (m.summary || '').toLowerCase();
        return fromVal.includes('garena') || subjectVal.includes('garena') || summaryVal.includes('garena');
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
      console.error("Telegram bot IMAP check failed:", imapErr);
      await sendTelegramMessage(chatId, `❌ <b>Mailbox sync failed!</b>\n\nError: ${imapErr.message || 'Could not connect to Garena server.'}`);
    }
    return;
  }

  // DEFAULT FALLBACK
  const unknownMsg = `❓ <b>Unknown Command!</b>\n\nType <code>otp</code> to fetch code, or <code>signup &lt;key&gt;</code> to register.`;
  await sendTelegramMessage(chatId, unknownMsg);
}

async function findUnassignedMailbox(db) {
  const imapSnap = await db.collection('imap_credentials').get();
  for (const doc of imapSnap.docs) {
    const data = doc.data();
    const email = data.imap_email;
    if (!email) continue;

    // Check Telegram sessions
    const sessionSnap = await db.collection('telegram_user_sessions')
      .where('assignedMailboxEmail', '==', email)
      .get();

    if (sessionSnap.empty) {
      // Check Web clients
      const userSnap = await db.collection('users')
        .where('role', '==', 'client')
        .where('email', '==', email)
        .get();

      if (userSnap.empty) {
        return email;
      }
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
        // Fetch last 15 messages
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
