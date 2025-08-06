require('dotenv').config();

const requiredEnv = [
  'IMGBB_API_KEY',
  'TOKEN',
  'CHANNEL_ID',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY'
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

process.on('unhandledRejection', e => {
  // Prevent recursive logging for Discord API errors
  if (e && e.message && e.message.includes('DiscordAPIError[50035]')) {
    console.log('[Unhandled] Discord API error - message too long (prevented recursive logging)');
  } else {
    console.error('[Unhandled]', e);
  }
});

process.on('uncaughtException', e => {
  // Prevent recursive logging for Discord API errors
  if (e && e.message && e.message.includes('DiscordAPIError[50035]')) {
    console.log('[Uncaught] Discord API error - message too long (prevented recursive logging)');
  } else {
    console.error('[Uncaught]', e);
  }
});

const { Client, GatewayIntentBits, Events } = require('discord.js');
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const {
  IMGBB_API_KEY,
  TOKEN,
  CHANNEL_ID,
  SUPABASE_URL,
  SUPABASE_ANON_KEY
} = process.env;

const START_DATE = new Date('2025-07-15T00:00:00Z');

const CONFIG = {
  tempDir: './snapmatic-temp',
  scanInterval: 30000
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let scanningBacklog = true;
let beforeMessageId = null;
let lastMessageId = null;
let knownFilenames = new Set();

async function loadKnownFilenames() {
  let page = 0;
  const pageSize = 1000;
  let done = false;

  while (!done) {
    const { data, error } = await supabase
      .from('photos')
      .select('filename')
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) {
      console.error(`[Supabase] Error fetching filenames: ${error.message}`);
      break;
    }

    if (data && data.length > 0) {
      for (const row of data) {
        knownFilenames.add(row.filename);
      }
      if (data.length < pageSize) {
        done = true;
      } else {
        page++;
      }
    } else {
      done = true;
    }
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function extractGamertagFromEmbed(embed) {
  return embed?.description?.match(/Uploaded by\s+(.+)/i)?.[1]?.trim() || 'Unknown';
}

function extractGamertagFromPath(filename) {
  const parts = filename.split('/');
  return parts.length >= 2 ? parts[1] : 'Unknown';
}

async function insertPhotoToSupabase({ imageUrl, filename, fullPath, createdAt }) {
  const uploaderGamertag = extractGamertagFromPath(fullPath);
  const { error } = await supabase.from('photos').insert([
    {
      image_url: imageUrl,
      filename: fullPath,
      created_at: createdAt,
      uploaderGamertag
    }
  ]);
  if (error) {
    console.error(`[Supabase] Insert error: ${error.message}`);
  } else {
    console.log(`[Supabase] Inserted: ${fullPath}`);
  }
}

const ratelimitPath = path.join(__dirname || '.', 'ratelimit.json');

async function saveRateLimit(reason, filename) {
  const data = {
    timestamp: new Date().toISOString(),
    reason,
    filename
  };
  await fs.writeFile(ratelimitPath, JSON.stringify(data, null, 2));
}

async function uploadImage(filePath, gamertag, name, messageId) {
  const githubFolder = `snapmatic/${gamertag.replace(/[^a-zA-Z0-9_\-]/g, '')}`;
  const githubName = name.replace(/^.*?_/, '');
  const githubPath = `${githubFolder}/${githubName}`;

  if (knownFilenames.has(githubPath)) {
    console.log(`[GitHub] Skipped duplicate (Supabase cache): ${githubPath}`);
    await fs.remove(filePath);
    return;
  }

  try {
    const fileBuffer = await fs.readFile(filePath);
    const githubUploadUrl = `https://snapmatic.the360unity.workers.dev/upload?path=${encodeURIComponent(githubPath)}`;
    const res = await fetch(githubUploadUrl, {
      method: 'POST',
      body: fileBuffer,
      headers: { 'Content-Type': 'application/octet-stream' }
    });

    if (res.status === 429) {
      await saveRateLimit('HTTP 429 Rate Limit (GitHub worker)', githubPath);
      console.warn(`[RateLimit] Hit GitHub worker rate limit. Pausing uploads for 2 minutes.`);
      return 'RATE_LIMIT';
    }

    if (!res.ok) {
      const text = await res.text();
      console.error(`[GitHub] Upload failed: ${githubPath} | ${text}`);
      return;
    }

    const json = await res.json();
    const imageUrl = `https://raw.githubusercontent.com/lilpizzaro/gtarevived/master/${githubPath}`;
    console.log(`[GitHub] Uploaded: ${githubPath}`);

    await insertPhotoToSupabase({
      imageUrl,
      filename: githubName,
      fullPath: githubPath,
      createdAt: new Date().toISOString()
    });
    knownFilenames.add(githubPath);
  } catch (e) {
    console.error(`[GitHub Upload] ${githubPath}: ${e.message}`);
  }

  await fs.remove(filePath).catch(e => console.error(`[Cleanup] ${githubPath}: ${e.message}`));
}

async function processEmbed(msg, embed) {
  const url = embed?.image?.url;
  if (!url) return;

  let gamertag = extractGamertagFromEmbed(embed);
  if (!gamertag || gamertag === 'Unknown') {
    gamertag = msg.author?.username || 'Unknown';
  }

  const ext = path.extname(url.split('?')[0]) || '.jpg';
  const name = `${gamertag.replace(/[^a-zA-Z0-9_\-]/g, '')}_${msg.id}${ext}`;
  const dir = CONFIG.tempDir;
  const file = path.join(dir, name);

  await fs.ensureDir(dir);

  if (await fs.pathExists(file)) {
    console.log(`[Download] Skipped existing: ${name}`);
  } else {
    const buffer = await (await fetch(url)).buffer();
    if (!buffer.length) {
      console.warn(`[Download] Empty: ${url}`);
      return;
    }
    await fs.writeFile(file, buffer);
    console.log(`[Download] Saved: ${name}`);
  }

  const uploadResult = await uploadImage(file, gamertag, name, msg.id);
  if (uploadResult === 'RATE_LIMIT') {
    throw new Error('RATE_LIMIT');
  }
}

async function fetchImages() {
  try {
    await fs.ensureDir(CONFIG.tempDir);
    const channel = await discordClient.channels.fetch(CHANNEL_ID);

    const fetchOptions = { limit: 100 };
    const messages = await channel.messages.fetch(fetchOptions);
    if (!messages.size) {
      return;
    }

    const sortedMessages = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const msg of sortedMessages) {
      if (msg.createdTimestamp < START_DATE.getTime()) continue;
      for (const embed of msg.embeds) {
        const url = embed?.image?.url;
        if (!url) continue;
        let gamertag = extractGamertagFromEmbed(embed);
        if (!gamertag || gamertag === 'Unknown') {
          gamertag = msg.author?.username || 'Unknown';
        }
        const ext = path.extname(url.split('?')[0]) || '.jpg';
        const name = `${gamertag.replace(/[^a-zA-Z0-9_\-]/g, '')}_${msg.id}${ext}`;
        const githubFolder = `snapmatic/${gamertag.replace(/[^a-zA-Z0-9_\-]/g, '')}`;
        const githubName = name.replace(/^.*?_/, '');
        const githubPath = `${githubFolder}/${githubName}`;
        if (knownFilenames.has(githubPath)) {
          continue;
        }
        try {
          await processEmbed(msg, embed);
        } catch (e) {
          if (e.message === 'RATE_LIMIT') {
            console.warn(`[RateLimit] Pausing all uploads for 2 minutes due to rate limit.`);
            await delay(2 * 60 * 1000);
            return fetchImages();
          } else {
            console.error(`[HandleEmbed] ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    console.error(`[FetchImages] ${e.message}`);
  }
}

discordClient.once(Events.ClientReady, async () => {
  console.log(`[Startup] Logged in as ${discordClient.user.username}`);
  console.log(`[Startup] Fetching existing filenames from Supabase...`);
  await loadKnownFilenames();
  console.log(`[Startup] Loaded ${knownFilenames.size} filenames from Supabase.`);
  await fetchImages();

  setInterval(async () => {
    try {
      console.log(`[Heartbeat] Scanning...`);
      await fetchImages();
      console.log(`[Heartbeat] Done.`);
    } catch (e) {
      console.error(`[Interval] ${e.message}`);
    }
  }, CONFIG.scanInterval);
});

discordClient.login(TOKEN);

const logs = [];
const MAX_LOGS = 50;

const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

const empireLogger = require('./empire_health_logger');

function logWithCapture(...args) {
  let msg;
  try {
    msg = args.map(a => {
      if (typeof a === 'string') {
        return a;
      } else if (typeof a === 'object' && a !== null) {
        const str = JSON.stringify(a);
        return str.length > 500 ? str.substring(0, 500) + '... [truncated]' : str;
      } else {
        return String(a);
      }
    }).join(' ');
  } catch (e) {
    msg = '[Log - could not stringify arguments]';
  }
  
  logs.push(`[${new Date().toLocaleString()}] ${msg}`);
  if (logs.length > MAX_LOGS) logs.shift();
  origLog.apply(console, args);
  if (empireLogger && typeof empireLogger.log === 'function') {
    empireLogger.log('info', msg);
  }
}

function errorWithCapture(...args) {
  let msg;
  try {
    msg = args.map(a => {
      if (typeof a === 'string') {
        return a;
      } else if (typeof a === 'object' && a !== null) {
        // For error objects, only include essential information to prevent massive JSON strings
        if (a.message && a.code) {
          return `${a.message} (Code: ${a.code})`;
        } else if (a.message) {
          return a.message;
        } else {
          // Truncate object stringification to prevent memory issues
          const str = JSON.stringify(a);
          return str.length > 500 ? str.substring(0, 500) + '... [truncated]' : str;
        }
      } else {
        return String(a);
      }
    }).join(' ');
  } catch (e) {
    msg = '[Error - could not stringify arguments]';
  }
  
  logs.push(`[${new Date().toLocaleString()}] ERROR: ${msg}`);
  if (logs.length > MAX_LOGS) logs.shift();
  origError.apply(console, args);
  
  // Don't send Discord API errors to empire logger to prevent recursion
  if (empireLogger && typeof empireLogger.log === 'function' && !msg.includes('DiscordAPIError[50035]')) {
    empireLogger.log('error', msg);
  }
}

function warnWithCapture(...args) {
  let msg;
  try {
    msg = args.map(a => {
      if (typeof a === 'string') {
        return a;
      } else if (typeof a === 'object' && a !== null) {
        const str = JSON.stringify(a);
        return str.length > 500 ? str.substring(0, 500) + '... [truncated]' : str;
      } else {
        return String(a);
      }
    }).join(' ');
  } catch (e) {
    msg = '[Warn - could not stringify arguments]';
  }
  
  logs.push(`[${new Date().toLocaleString()}] WARN: ${msg}`);
  if (logs.length > MAX_LOGS) logs.shift();
  origWarn.apply(console, args);
  if (empireLogger && typeof empireLogger.log === 'function') {
    empireLogger.log('warn', msg);
  }
}

console.log = logWithCapture;
console.error = errorWithCapture;
console.warn = warnWithCapture;

const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(logs.slice(-MAX_LOGS).join('\n'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logWithCapture(`[Express] Web service running on port ${PORT}`);
});

// Start Empire Health Logger (separate bot for health check and live logs)
try {
  require('./empire_health_logger');
} catch (e) {
  console.error('[EmpireHealthLogger] Failed to start:', e);
}
