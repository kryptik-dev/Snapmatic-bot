// Load environment variables and check for required keys
require('dotenv').config();
['IMGBB_API_KEY', 'TOKEN', 'CHANNEL_ID', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'].forEach((key) => {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
});

process.on('unhandledRejection', e => console.error('[Unhandled]', e));
process.on('uncaughtException', e => console.error('[Uncaught]', e));

const { Client, GatewayIntentBits, Events } = require('discord.js');
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const FormData = require('form-data');

const {
  IMGBB_API_KEY,
  TOKEN,
  CHANNEL_ID,
  SUPABASE_URL,
  SUPABASE_ANON_KEY
} = process.env;

const CONFIG = {
  temp: './snapmatic-temp',
  interval: 180000 // 3 minutes
};

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Initialize Discord client with only required intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let scanningBacklog = true;
let before = null;
let lastId = null;
const delay = ms => new Promise(r => setTimeout(r, ms));

// Extract gamertag from embed description
const getTag = embed => embed?.description?.match(/Uploaded by\s+(.+)/i)?.[1]?.trim() || 'Unknown';

// Extract gamertag from filename/path (handles new folder structure)
function extractGamertag(filename) {
  // filename is like 'snapmatic/Baim777/1393931150195560519.jpg'
  const parts = filename.split('/');
  return parts.length >= 2 ? parts[1] : 'Unknown';
}

// Insert photo metadata into Supabase
async function insertPhoto({ image_url, filename, fullPath, created_at }) {
  const uploaderGamertag = extractGamertag(fullPath);
  const { error } = await supabase.from('photos').insert([
    {
      image_url,
      filename: fullPath, // Use full path for deduplication
      created_at,
      uploaderGamertag
    }
  ]);
  if (error) {
    console.error(`[Supabase] Insert error: ${error.message}`);
  } else {
    console.log(`[Supabase] Inserted: ${fullPath}`);
  }
}

// Global flag for rate limit cooldown
let isRateLimited = false;

const pathRatelimit = path.join(__dirname || '.', 'ratelimit.json');

async function exportRateLimit(reason, filename) {
  const data = {
    timestamp: new Date().toISOString(),
    reason,
    filename
  };
  await fs.writeFile(pathRatelimit, JSON.stringify(data, null, 2));
}

// Upload image to GitHub via worker and store metadata in Supabase
const upload = async (filePath, gamertag, name, msgId) => {
  // Deduplication: check if already uploaded in Supabase
  const githubFolder = `snapmatic/${gamertag.replace(/[^a-zA-Z0-9_\-]/g, '')}`;
  const githubName = name.replace(/^.*?_/, ''); // Remove gamertag_ from name
  const githubPath = `${githubFolder}/${githubName}`;
  const { data: existing, error: fetchError } = await supabase
    .from('photos')
    .select('filename')
    .eq('filename', githubPath)
    .limit(1);
  if (fetchError) {
    console.error(`[Supabase] Fetch error: ${fetchError.message}`);
  }
  if (existing && existing.length > 0) {
    console.log(`[GitHub] Skipped duplicate (Supabase): ${githubPath}`);
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
      const reason = 'HTTP 429 Rate Limit (GitHub worker)';
      await exportRateLimit(reason, githubPath);
      console.warn(`[RateLimit] Hit GitHub worker rate limit. Pausing uploads for 2 minutes.`);
      return 'RATE_LIMIT';
    }
    if (!res.ok) {
      const text = await res.text();
      console.error(`[GitHub] Upload failed: ${githubPath} | ${text}`);
      return;
    }
    const json = await res.json();
    // Compose the raw GitHub URL
    // https://raw.githubusercontent.com/lilpizzaro/gtarevived/master/snapmatic/gamertag/image01.jpg
    const image_url = `https://raw.githubusercontent.com/lilpizzaro/gtarevived/master/${githubPath}`;
    console.log(`[GitHub] Uploaded: ${githubPath}`);
      await insertPhoto({
      image_url,
      filename: githubName, // Only the image filename, not the full path
      fullPath: githubPath, // Pass the full path for gamertag extraction
      created_at: new Date().toISOString()
      });
  } catch (e) {
    console.error(`[GitHub Upload] ${githubPath}: ${e.message}`);
  }

  await fs.remove(filePath).catch(e => console.error(`[Cleanup] ${githubPath}: ${e.message}`));
};

// Download and process image embeds from Discord messages
const handleEmbed = async (msg, embed) => {
  const url = embed?.image?.url;
  if (!url) return;

  // Use description for gamertag if available, else fallback to message author username or 'Unknown'
  let gamertag = getTag(embed);
  if (!gamertag || gamertag === 'Unknown') {
    gamertag = msg.author?.username || 'Unknown';
  }
  const ext = path.extname(url.split('?')[0]) || '.jpg';
  const name = `${gamertag.replace(/[^a-zA-Z0-9_\-]/g, '')}_${msg.id}${ext}`;
  const dir = CONFIG.temp;
  const file = path.join(dir, name);

  await fs.ensureDir(dir);

  if (await fs.pathExists(file)) {
    console.log(`[Download] Skipped existing: ${name}`);
  } else {
    const buffer = await (await fetch(url)).buffer();
    if (!buffer.length) return console.warn(`[Download] Empty: ${url}`);
    await fs.writeFile(file, buffer);
    console.log(`[Download] Saved: ${name}`);
  }

  const uploadResult = await upload(file, gamertag, name, msg.id);
  if (uploadResult === 'RATE_LIMIT') {
    throw new Error('RATE_LIMIT');
  }
};

// Fetch images from the Discord channel
const fetchImages = async () => {
  try {
    await fs.ensureDir(CONFIG.temp);
    const channel = await client.channels.fetch(CHANNEL_ID);

    while (true) {
      const opts = {
        limit: 100,
        ...(scanningBacklog && before ? { before } : !scanningBacklog && lastId ? { after: lastId } : {})
      };

      const messages = await channel.messages.fetch(opts);
      if (!messages.size) {
        if (scanningBacklog) {
          scanningBacklog = false;
          console.log(`[Sync] Backlog complete.`);
        }
        break;
      }

      const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const msg of sorted) {
        scanningBacklog ? (before = msg.id) : (lastId = msg.id);
        for (const embed of msg.embeds) {
          try {
            await handleEmbed(msg, embed);
          } catch (e) {
            if (e.message === 'RATE_LIMIT') {
              console.warn(`[RateLimit] Pausing all uploads for 2 minutes due to rate limit.`);
              await delay(2 * 60 * 1000); // 2 minutes
              // After waiting, retry this embed
              return fetchImages();
            } else {
              console.error(`[HandleEmbed] ${e.message}`);
            }
          }
        }
      }

      if (messages.size < 100) break;
    }
  } catch (e) {
    console.error(`[FetchImages] ${e.message}`);
  }
};

// Start the bot and set up periodic scanning
client.once(Events.ClientReady, () => {
  console.log(`[Startup] Logged in as ${client.user.username}`);
  fetchImages();

  setInterval(async () => {
    try {
      console.log(`[Heartbeat] Scanning...`);
      await fetchImages();
      console.log(`[Heartbeat] Done.`);
    } catch (e) {
      console.error(`[Interval] ${e.message}`);
    }
  }, CONFIG.interval);
});

client.login(TOKEN);

// --- Express server for Render web service health check ---
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Snapmatic bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Express] Web service running on port ${PORT}`);
});