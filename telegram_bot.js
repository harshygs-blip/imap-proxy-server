import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Bot token: env var > hardcoded fallback
const HARDCODED_BOT_TOKEN = '8700234031:AAFmFxuHnvQXREQ91C95ImK2bbZzlMY-1wI';
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

  // Register webhook endpoint (for production webhook deployments)
  app.post('/telegram/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
      const update = req.body;
      if (update) {
        if (update.message && update.message.text) {
          await handleBotMessage(update.message);
        } else if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }
      }
    } catch (err) {
      console.error('Telegram webhook error:', err.message);
    }
  });

  // If running on Render with process.env.RENDER_EXTERNAL_URL, register Webhook
  // Otherwise, run direct Real-Time Long Polling (zero tunnels, zero latency, 100% instant responses!)
  if (process.env.RENDER_EXTERNAL_URL) {
    const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/telegram/webhook`;
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
  } else {
    // Start Direct Real-Time Long Polling for Local Development & Instant Testing
    startLongPolling();
  }
}

// ─────────────────────────────────────────────
// REAL-TIME LONG POLLING LOOP (Zero Tunnels / Instant Response)
// ─────────────────────────────────────────────
let pollingOffset = 0;
let isPolling = false;

async function startLongPolling() {
  if (isPolling) return;
  isPolling = true;

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`);
    console.log("⚡ Telegram Webhook cleared — Direct Real-Time Long Polling active!");
  } catch (err) {
    console.warn("Could not delete webhook:", err.message);
  }

  while (isPolling) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${pollingOffset}&timeout=1`);
      const data = await res.json();

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          pollingOffset = update.update_id + 1;
          // Process updates concurrently so response is instant
          if (update.message && update.message.text) {
            handleBotMessage(update.message).catch(e => console.error("Msg error:", e.message));
          } else if (update.callback_query) {
            handleCallbackQuery(update.callback_query).catch(e => console.error("Cb error:", e.message));
          }
        }
      }
    } catch (err) {
      console.error("Polling loop error:", err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// In-memory chat message history: chatId -> Set of message_ids for auto-cleaning
const chatHistory = new Map();
const agreedTerms = new Set();

function trackMsg(chatId, msgId) {
  if (!msgId) return;
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, new Set());
  chatHistory.get(chatId).add(msgId);
}

// Answer Callback Query (inline button click acknowledgment)
async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text })
    });
  } catch (err) {
    console.error('Failed to answer callback query:', err.message);
  }
}

// Edit Message Text
async function editMsgText(chatId, messageId, text, options = {}) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...options })
    });
  } catch (err) {
    console.error(`Failed to edit message ${messageId}:`, err.message);
  }
}

// Handle Callback Queries (Button Clicks)
async function handleCallbackQuery(callbackQuery) {
  const chatId = String(callbackQuery.message.chat.id);
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  if (data === 'agree_terms') {
    await answerCallbackQuery(callbackQuery.id, '✅ Thank you for agreeing!');
    agreedTerms.add(chatId);

    // Edit message to show agreement confirmed & instructions
    await editMsgText(chatId, messageId,
      `✅ <b>Terms &amp; Conditions Agreed!</b>\n\n` +
      `👋 <b>Welcome to Garena OTP Assistant!</b>\n\n` +
      `<b>How to use:</b>\n` +
      `1️⃣ Type <code>signup YOUR_LICENSE_KEY</code>\n` +
      `   Example: <code>signup TG-GPFPS010</code>\n\n` +
      `2️⃣ Enter your email &amp; set a password\n\n` +
      `3️⃣ Copy the assigned Garena email\n\n` +
      `4️⃣ After OTP arrives, type <code>otp</code>\n\n` +
      `⚠️ <i>Limit: 1 OTP per 48 hours</i>`
    );
    return;
  }

  if (data.startsWith('store_price_')) {
    await answerCallbackQuery(callbackQuery.id, '⚠️ Store is currently disabled.');
    await sendMsg(chatId, `⚠️ <b>Store is currently disabled.</b>\n\nPlease contact admin directly: @alexccseller`);
    return;
  }
}

// Function to delete ALL conversation messages (old and new) from both client and bot side
async function clearChat(chatId, latestMsgId = null) {
  const set = chatHistory.get(chatId) || new Set();
  chatHistory.delete(chatId);

  // Deep sweep: include up to 300 previous message IDs to wipe all old messages
  if (latestMsgId) {
    const start = Math.max(1, Number(latestMsgId) - 300);
    for (let id = start; id <= Number(latestMsgId); id++) {
      set.add(id);
    }
  }

  const msgIds = Array.from(set);
  if (msgIds.length === 0) return;

  // Split into chunks of 100 (Telegram deleteMessages API supports max 100 IDs per call)
  const chunkSize = 100;
  for (let i = 0; i < msgIds.length; i += chunkSize) {
    const chunk = msgIds.slice(i, i + chunkSize);
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/deleteMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_ids: chunk })
      });
    } catch (err) {
      console.error(`Failed to delete messages chunk for ${chatId}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────
async function sendMsg(chatId, text, options = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...options })
    });
    const data = await res.json();
    if (data.ok && data.result && data.result.message_id) {
      trackMsg(chatId, data.result.message_id);
      return data.result.message_id;
    }
  } catch (err) {
    console.error(`Failed to send message to ${chatId}:`, err.message);
  }
  return null;
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────
async function handleBotMessage(message) {
  const chatId = String(message.chat.id);
  const msgId = message.message_id;
  if (msgId) {
    trackMsg(chatId, msgId);
  }
  const rawText = (message.text || '').trim();
  if (!rawText) return;

  // Strip Telegram bot username suffix (e.g. /store@id_providerbot -> /store)
  const cleanText = rawText.split('@')[0].trim();
  const lower = cleanText.toLowerCase();

  // If user typed a slash command while mid-signup, clear pending signup state
  if (lower.startsWith('/') && lower !== '/cancel' && pendingSignups.has(chatId)) {
    pendingSignups.delete(chatId);
  }

  // ── Clear / Clean command ──
  if (['clear', '/clear', 'clean', '/clean'].includes(lower)) {
    await clearChat(chatId, msgId);
    return;
  }

  // ── If user is mid-signup, handle conversation steps ──
  if (pendingSignups.has(chatId)) {
    await handleSignupConversation(chatId, rawText);
    return;
  }

  // ── /start / hi / hello / menu ──
  if (['/start', 'start', 'hi', 'hello', 'hey', 'menu', '/menu'].includes(lower)) {
    await sendMsg(chatId,
      `📋 <b>Terms &amp; Conditions Agreement</b>\n\n` +
      `Are you agree with the terms and condition\n` +
      `https://ff-store-4a61e.web.app/refund-policy\n` +
      `https://ff-store-4a61e.web.app/privacy-policy`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ I Agree', callback_data: 'agree_terms' }
            ]
          ]
        }
      }
    );
    return;
  }

  // ── Store / Catalog / Shop Commands (Disabled) ──
  if (['store', '/store', 'catalog', '/catalog', 'shop', '/shop', 'buy', '/buy', 'ids', '/ids', 'id', '/id', 'price', '/price'].includes(lower)) {
    await sendMsg(chatId,
      `⚠️ <b>Account Store is currently disabled.</b>\n\n` +
      `For any account inquiries or purchases, please contact admin directly: @alexccseller`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💬 Contact Admin (@alexccseller)', url: 'https://t.me/alexccseller' }
            ]
          ]
        }
      }
    );
    return;
  }

  // ── Bare TG- key detection ──
  const upperText = cleanText.toUpperCase();
  if (/^TG-[A-Z0-9]+$/.test(upperText)) {
    await sendMsg(chatId,
      `🔑 <b>License key detected!</b>\n\n` +
      `To activate, type:\n<code>signup ${upperText}</code>`);
    return;
  }

  // ── Signup command ──
  if (lower.startsWith('signup') || lower.startsWith('/signup')) {
    const parts = cleanText.split(/\s+/);
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

  // ── Logout ──
  if (lower === 'logout' || lower === '/logout') {
    pendingSignups.delete(chatId);
    if (!_db) { await sendMsg(chatId, `❌ Server not ready.`); return; }
    try {
      await _db.collection('telegram_user_sessions').doc(chatId).delete();
    } catch(e) { /* ignore */ }
    await sendMsg(chatId,
      `✅ <b>Logged out successfully!</b>\n\n` +
      `You can now signup with a new license key:\n` +
      `<code>signup TG-XXXXXXXX</code>`);
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
    await sendMsg(chatId, `❌ Action cancelled.`);
    return;
  }

  // ── Smart Helper Fallback (Garena OTP Assistant) ──
  await sendMsg(chatId,
    `👋 <b>Garena OTP Assistant Bot</b>\n\n` +
    `• <code>signup TG-XXXXXXXX</code> — Register license key\n` +
    `• <code>otp</code> — Get your Garena OTP\n` +
    `• <code>logout</code> — Switch license key\n` +
    `• <code>clear</code> — Wipe chat history\n\n` +
    `💬 <b>Contact Admin:</b> @alexccseller`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💬 Contact Admin (@alexccseller)', url: 'https://t.me/alexccseller' }
          ]
        ]
      }
    }
  );
}

// ─────────────────────────────────────────────
// TELEGRAM STORE & ACCOUNT CATALOG FLOW
// ─────────────────────────────────────────────
async function handleStoreCommand(chatId) {
  await sendMsg(chatId,
    `🛒 <b>FF Trusted Deals — Game Account Catalog</b>\n\n` +
    `Select your budget/price category to view available Free Fire accounts:`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💰 ₹300 IDs', callback_data: 'store_price_300' },
            { text: '💰 ₹500 IDs', callback_data: 'store_price_500' }
          ],
          [
            { text: '💰 ₹1,000 IDs', callback_data: 'store_price_1000' },
            { text: '💰 ₹1,500 IDs', callback_data: 'store_price_1500' }
          ],
          [
            { text: '💰 ₹2,000 IDs', callback_data: 'store_price_2000' },
            { text: '💰 ₹3,000 IDs', callback_data: 'store_price_3000' }
          ],
          [
            { text: '💰 ₹5,000 IDs', callback_data: 'store_price_5000' },
            { text: '💰 ₹7,000 IDs', callback_data: 'store_price_7000' }
          ],
          [
            { text: '🔍 Show All Available IDs', callback_data: 'store_price_all' }
          ]
        ]
      }
    }
  );
}

async function handleStoreCategory(chatId, priceLimit) {
  if (!_db) {
    await sendMsg(chatId, `⚠️ <b>Server not ready yet.</b> Please try again in a moment.`);
    return;
  }

  try {
    // Parallel Firestore collection queries for maximum speed ⚡
    const [gSnap, zSnap, iSnap, fSnap] = await Promise.all([
      _db.collection('gmail_credentials').get(),
      _db.collection('zoho_credentials').get(),
      _db.collection('imap_credentials').get(),
      _db.collection('ff_store').get()
    ]);

    const allDocs = [];
    gSnap.forEach(docSnap => allDocs.push(docSnap.data()));
    zSnap.forEach(docSnap => allDocs.push(docSnap.data()));
    iSnap.forEach(docSnap => allDocs.push(docSnap.data()));

    fSnap.forEach(docSnap => {
      const data = docSnap.data();
      allDocs.push({
        game_id_name: data.title || data.game_id_name || 'FF Store Rare Account',
        price_inr: data.price || data.price_inr,
        instagram_link: data.instagram_link || data.mediaUrl || 'https://www.instagram.com/ff_trusted_deals1/',
        youtube_link: data.youtube_link || (data.mediaType === 'video' ? data.mediaUrl : '')
      });
    });

    // STRICT FILTERING RULES:
    // 1. MUST have instagram_link (non-empty string)
    // 2. MUST have price_inr > 0
    // 3. If priceLimit !== 'all', price_inr <= Number(priceLimit)
    const validAccounts = allDocs.filter(item => {
      const instaLink = item.instagram_link ? String(item.instagram_link).trim() : '';
      const price = item.price_inr !== undefined && item.price_inr !== null ? Number(item.price_inr) : 0;
      
      if (!instaLink || price <= 0) return false;

      if (priceLimit !== 'all') {
        const maxPrice = Number(priceLimit);
        if (price > maxPrice) return false;
      }
      return true;
    });

    if (validAccounts.length === 0) {
      await sendMsg(chatId,
        `❌ <b>No accounts available ${priceLimit === 'all' ? 'right now' : `in ₹${priceLimit} category`}!</b>\n\n` +
        `⏳ <b>Next Restock / Available Time:</b>\n` +
        `<i>Stock updates daily at 12:00 PM & 06:00 PM IST</i>\n\n` +
        `💬 <b>Contact Admin directly on Telegram:</b> @alexccseller`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💬 Contact Admin (@alexccseller)', url: 'https://t.me/alexccseller' }
              ],
              [
                { text: '📸 Visit Instagram Deals Page', url: 'https://www.instagram.com/ff_trusted_deals1/' }
              ]
            ]
          }
        }
      );
      return;
    }

    // Sort cheapest first
    validAccounts.sort((a, b) => Number(a.price_inr || 0) - Number(b.price_inr || 0));

    // Send catalog header + items concurrently ⚡
    const displayList = validAccounts.slice(0, 10);

    let summaryText = `🛒 <b>FF Trusted Deals Catalog</b>\n` +
                      `Price Filter: <b>${priceLimit === 'all' ? 'All Available IDs' : `Up to ₹${priceLimit}`}</b>\n` +
                      `Found: <b>${validAccounts.length} Account(s)</b>\n\n` +
                      `💬 <b>Contact Admin:</b> @alexccseller`;

    await sendMsg(chatId, summaryText);

    // Send all matched account cards concurrently
    const sendPromises = displayList.map(item => {
      const idName = item.game_id_name || 'Free Fire Rare Account';
      const price = item.price_inr;
      const rawInsta = String(item.instagram_link).trim();
      const instaUrl = rawInsta.startsWith('http') ? rawInsta : `https://${rawInsta}`;
      const rawYt = item.youtube_link ? String(item.youtube_link).trim() : '';
      const ytUrl = rawYt ? (rawYt.startsWith('http') ? rawYt : `https://${rawYt}`) : '';

      let cardText = `🎯 <b>ID Name:</b> ${idName}\n` +
                     `💰 <b>Price:</b> ₹${price}\n` +
                     `📸 <b>Insta Link:</b> ${instaUrl}`;

      if (ytUrl) {
        cardText += `\n🔴 <b>YouTube Stream:</b> ${ytUrl}`;
      }

      cardText += `\n💬 <b>Contact Admin:</b> @alexccseller`;

      return sendMsg(chatId, cardText, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💬 Contact Admin (@alexccseller)', url: 'https://t.me/alexccseller' }
            ],
            [
              { text: '📸 Contact on Instagram', url: 'https://www.instagram.com/ff_trusted_deals1/' }
            ]
          ]
        }
      });
    });

    await Promise.all(sendPromises);

  } catch (err) {
    console.error("Store catalog fetch error:", err.message);
    await sendMsg(chatId, `⚠️ <b>Error fetching catalog:</b> ${err.message}`);
  }
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


  // Check if this chatId already has an active session (Admin SDK - bypasses rules)
  try {
    if (_db) {
      const existingSession = await _db.collection('telegram_user_sessions').doc(chatId).get();
      if (existingSession.exists) {
        const sess = existingSession.data();
        if (Date.now() < (Number(sess.licenseExpiry) || 0)) {
          await sendMsg(chatId,
            `ℹ️ <b>You already have an active account!</b>\n\n` +
            `📧 Current Mailbox: <code>${sess.assignedMailboxEmail}</code>\n\n` +
            `To switch to a new license, type <code>logout</code> first, then signup again.`);
          return;
        }
        // Expired session - auto-clear
        await _db.collection('telegram_user_sessions').doc(chatId).delete().catch(() => {});
      }
    }
  } catch (e) { /* ignore - proceed with signup */ }

  // Key valid! Resolve mailbox
  let availableEmail = '';
  try {
    if (keyData.assignedMailbox) {
      availableEmail = keyData.assignedMailbox;
      // Check if pre-assigned mailbox already in use (Admin SDK)
      if (_db) {
        const sessSnap = await _db.collection('telegram_user_sessions')
          .where('assignedMailboxEmail', '==', availableEmail).get();
        if (!sessSnap.empty) {
          await sendMsg(chatId, `❌ <b>Mailbox already in use!</b>\n\nContact Admin @example_tgid`);
          return;
        }
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

      // Create Firestore user document — same schema as website's createClientRecord
      const expiryTime = Date.now() + (Number(state.keyData.validityDays || 2) * 24 * 60 * 60 * 1000);
      const uid = firebaseUser ? firebaseUser.uid : `tg_${chatId}`;
      const now = new Date();
      const expiryDate = new Date(expiryTime);

      // 1. users/{uid} — matches website's user document schema
      await _db.collection('users').doc(uid).set({
        uid,
        role: 'client',
        name: displayName,
        email: state.email,
        mobile: '',
        linkedGmail: '',
        linkedZoho: '',
        linkedImap: state.availableEmail,   // assigned Garena mailbox
        bindingStatus: 'none',
        bindingStartDate: null,
        bindingEmail: '',
        mailboxDisabled: false,
        mailboxDisabledReason: '',
        initialPassword: password,
        warningDismissed: false,
        assignedAdminId: null,
        source: 'telegram',
        telegramChatId: chatId,
        createdAt: now
      });

      // 2. subscriptions/{uid} — required for getAllClients to show user in dashboard
      await _db.collection('subscriptions').doc(uid).set({
        uid,
        productName: 'Garena OTP Bot',
        purchaseDate: now,
        expiryDate: expiryDate,
        validityDays: Number(state.keyData.validityDays || 2),
        amountPaid: Number(state.keyData.price || 0),
        remainingBalance: 0,
        commission: 0,
        commissionPaid: 0,
        status: 'Active',
        notes: `Signed up via Telegram Bot. License: ${state.keyId}`,
        updatedAt: now
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

      const ffUid = state.keyData?.game_uid || state.keyData?.ff_uid || state.keyData?.gameUid || '';

      await sendMsg(chatId,
        `🎉 <b>Account Created Successfully!</b>\n\n` +
        `👤 <b>Name:</b> ${displayName}\n` +
        `📧 <b>Login Email:</b> <code>${state.email}</code>\n` +
        `🎮 <b>Garena Mailbox:</b>\n<code>${state.availableEmail}</code>\n` +
        (ffUid ? `🎯 <b>Free Fire UID:</b> <code>${ffUid}</code>\n` : '') +
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

  if (session.otpUsed || !session.assignedMailboxEmail) {
    await sendMsg(chatId,
      `🔒 <b>OTP Already Scanned! (1/1 Limit Reached)</b>\n\n` +
      `Your 1-time OTP scan for this license key has been completed and the console mailbox is now locked & unlinked.\n\n` +
      `To get another OTP, type <code>logout</code>, then register a new license key: <code>signup TG-XXXXXXXX</code>.`);
    return;
  }

  await sendMsg(chatId, `🔍 Fetching your OTP from mailbox...`);

  const mailboxEmail = session.assignedMailboxEmail;
  let credData = null;

  try {
    credData = await findCredDataForEmail(mailboxEmail);
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

    // Update last OTP fetch time, increment scan count AND auto-unlink mailbox after 1-time scan
    const newCount = (Number(session.otpScanCount) || 0) + 1;
    try {
      await _db.collection('telegram_user_sessions').doc(chatId).update({
        lastOtpFetchedAt: Date.now(),
        otpUsed: true,
        otpScanCount: newCount,
        assignedMailboxEmail: ''
      });
      if (session.uid) {
        await _db.collection('users').doc(session.uid).update({
          linkedImap: '',
          linkedGmail: '',
          linkedZoho: '',
          otpUsed: true,
          otpScanCount: newCount,
          lastOtpScannedAt: Date.now(),
          lastOtpViewedAt: new Date().toISOString()
        });
      }
    } catch (e) { console.error('Auto-unlink error:', e.message); }

    await sendMsg(chatId,
      `🔑 <b>Your Garena OTP:</b>\n\n` +
      `<code>${otp}</code>\n\n` +
      `👆 Tap to copy.\n` +
      `<i>⚡ Mailbox unlinked from console after 1-time OTP scan.</i>\n` +
      `<i>💡 Type <code>clear</code> to wipe chat history anytime.</i>`);

  } catch (err) {
    await sendMsg(chatId, `❌ <b>Mailbox connection error!</b>\n\n<i>${err.message}</i>\n\nCheck if App Password is correct in Email Monitor.`);
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
async function findCredDataForEmail(mailboxEmail) {
  if (!mailboxEmail) return null;
  const targetEmail = mailboxEmail.toLowerCase().trim();

  // Query all 3 collections in parallel using Admin SDK
  const [gSnap, zSnap, iSnap] = await Promise.all([
    _db.collection('gmail_credentials').get(),
    _db.collection('zoho_credentials').get(),
    _db.collection('imap_credentials').get()
  ]);

  const allCredDocs = [];
  gSnap.forEach(d => allCredDocs.push({ ...d.data(), _col: 'gmail' }));
  zSnap.forEach(d => allCredDocs.push({ ...d.data(), _col: 'zoho' }));
  iSnap.forEach(d => allCredDocs.push({ ...d.data(), _col: 'imap' }));

  for (const data of allCredDocs) {
    const email = (data.gmail_email || data.zoho_email || data.imap_email || data.email || data.imap_user || data.user || '').toLowerCase().trim();
    if (email === targetEmail) {
      return data;
    }
  }
  return null;
}

async function findUnassignedMailbox() {
  // Query all 3 credential collections using Admin SDK
  const [gSnap, zSnap, iSnap, sessSnap] = await Promise.all([
    _db.collection('gmail_credentials').get(),
    _db.collection('zoho_credentials').get(),
    _db.collection('imap_credentials').get(),
    _db.collection('telegram_user_sessions').get()
  ]);

  const usedEmails = new Set();
  sessSnap.forEach(d => {
    const e = d.data().assignedMailboxEmail;
    if (e) usedEmails.add(e.toLowerCase().trim());
  });

  const allCredDocs = [];
  gSnap.forEach(d => allCredDocs.push({ ...d.data(), _col: 'gmail' }));
  zSnap.forEach(d => allCredDocs.push({ ...d.data(), _col: 'zoho' }));
  iSnap.forEach(d => allCredDocs.push({ ...d.data(), _col: 'imap' }));

  for (const data of allCredDocs) {
    const email = (data.gmail_email || data.zoho_email || data.imap_email || data.email || data.imap_user || '').toLowerCase().trim();
    if (!email) continue;
    if (!usedEmails.has(email)) return email;
  }
  return null;
}

async function fetchInboxMessages(credData) {
  const email = (credData.gmail_email || credData.zoho_email || credData.imap_email || credData.email || credData.imap_user || credData.user || '').toLowerCase().trim();
  
  let host = credData.imap_host || credData.host || '';
  if (!host) {
    if (email.endsWith('@gmail.com') || credData._col === 'gmail') {
      host = 'imap.gmail.com';
    } else if (email.includes('@zoho') || credData._col === 'zoho') {
      host = 'imap.zoho.in';
    } else {
      host = 'imap.gmail.com';
    }
  }

  const port = Number(credData.imap_port || credData.port || 993);
  const user = credData.imap_user || email;
  const pass = credData.imap_password || credData.gmail_app_password || credData.zoho_password || credData.password || credData.pass || credData.app_password || credData.gmail_refresh_token || credData.zoho_refresh_token;
  const secure = credData.imap_secure !== false;

  if (!pass) {
    throw new Error(`Password / App Password is missing for ${email} in Email Monitor.`);
  }

  const PORT = process.env.PORT || 8080;
  const res = await fetch(`http://localhost:${PORT}/imap/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      host,
      port,
      user,
      pass,
      secure,
      folders: ['INBOX'],
      limit: 15
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.status }));
    throw new Error(err.error || `IMAP fetch failed: ${res.status}`);
  }

  const data = await res.json();
  const messages = data.data || [];

  return messages.map(m => ({
    subject: m.subject || '',
    sender: m.sender || m.from || '',
    sentTime: m.sentTime || m.date || Date.now(),
    body: m.text || m.body || m.snippet || '',
    summary: m.summary || m.snippet || ''
  }));
}

