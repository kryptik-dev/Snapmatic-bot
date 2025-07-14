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

// Extract gamertag from filename (handles underscores)
function extractGamertag(filename) {
  const base = filename.replace(/\.[^/.]+$/, '');
  const lastUnderscore = base.lastIndexOf('_');
  if (lastUnderscore === -1) return base;
  return base.substring(0, lastUnderscore);
}

// Insert photo metadata into Supabase
async function insertPhoto({ image_url, filename, created_at }) {
  const uploaderGamertag = extractGamertag(filename);
  const { error } = await supabase.from('photos').insert([
    {
      image_url,
      filename,
      created_at,
      uploaderGamertag
    }
  ]);
  if (error) {
    console.error(`[Supabase] Insert error: ${error.message}`);
  } else {
    console.log(`[Supabase] Inserted: ${filename}`);
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

// Upload image to imgbb and store metadata in Supabase
const upload = async (filePath, gamertag, name, msgId) => {
  // Deduplication: check if already uploaded in Supabase
  const { data: existing, error: fetchError } = await supabase
    .from('photos')
    .select('filename')
    .eq('filename', name)
    .limit(1);
  if (fetchError) {
    console.error(`[Supabase] Fetch error: ${fetchError.message}`);
  }
  if (existing && existing.length > 0) {
    console.log(`[imgbb] Skipped duplicate (Supabase): ${name}`);
    await fs.remove(filePath);
    return;
  }

  const form = new FormData();
  form.append('key', IMGBB_API_KEY);
  form.append('image', fs.createReadStream(filePath));
  form.append('name', name);

  try {
    const res = await fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      body: form,
      headers: form.getHeaders()
    });
    // Rate limit detection
    if (res.status === 429) {
      const reason = 'HTTP 429 Rate Limit';
      await exportRateLimit(reason, name);
      console.warn(`[RateLimit] Hit imgbb rate limit. Pausing uploads for 2 minutes.`);
      return 'RATE_LIMIT';
    }
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await res.text();
      // Check for rate limit in non-JSON response
      if (text.toLowerCase().includes('rate limit')) {
        const reason = 'Non-JSON response: ' + text;
        await exportRateLimit(reason, name);
        console.warn(`[RateLimit] Detected rate limit in response. Pausing uploads for 2 minutes.`);
        return 'RATE_LIMIT';
      }
      console.error(`[imgbb] Non-JSON response:`, text);
      return;
    }
    const json = await res.json();
    if (json.success && json.data && json.data.url) {
      console.log(`[imgbb] Uploaded: ${name}`);
      await insertPhoto({
        image_url: json.data.url,
        filename: name,
        created_at: new Date(parseInt(json.data.time, 10) * 1000).toISOString()
      });
    } else {
      // Check for rate limit in JSON error
      if (json.error && String(json.error.message).toLowerCase().includes('rate limit')) {
        const reason = 'JSON error: ' + (json.error?.message || json.message);
        await exportRateLimit(reason, name);
        console.warn(`[RateLimit] Detected rate limit in JSON. Pausing uploads for 2 minutes.`);
        return 'RATE_LIMIT';
      }
      console.error(`[imgbb] Failed: ${name} | ${json.error?.message || json.message}`);
    }
  } catch (e) {
    console.error(`[imgbb Upload] ${name}: ${e.message}`);
  }

  await fs.remove(filePath).catch(e => console.error(`[Cleanup] ${name}: ${e.message}`));
};

// Download and process image embeds from Discord messages
const handleEmbed = async (msg, embed) => {
  const url = embed?.image?.url;
  if (!url || !embed?.description) return console.warn(`[Embed] Skipped: ${msg.id}`);

  const gamertag = getTag(embed);
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