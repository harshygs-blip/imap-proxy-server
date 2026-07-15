import express from 'express';
import cors from 'cors';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ IMAP Proxy Server running on port ${PORT}`);
});
