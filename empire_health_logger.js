require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

const HEALTH_CHECK_TOKEN = process.env.HEALTH_CHECK_TOKEN;
const EMPIRE_CHANNEL_ID = process.env.EMPIRE_CHANNEL_ID;
const HEALTH_CHECK_URL = 'https://snapmatic-bot.onrender.com/';
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const LOG_LINES = 5;
const TAG_USER_ID = '1347203516304986147';

if (!HEALTH_CHECK_TOKEN || !EMPIRE_CHANNEL_ID) {
  console.error('[EmpireHealthLogger] Missing HEALTH_CHECK_TOKEN or EMPIRE_CHANNEL_ID in .env');
  process.exit(1);
}

const empireClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

let statusMessageId = null;
let logsMessageId = null;
let lastStatus = null;
let logs = [];

function getLocalTimestamp() {
  return new Date().toLocaleString();
}

function formatLogs() {
  const lines = logs.slice(-LOG_LINES).map(l => l).join('\n');
  return `\u200B\n\`\`\`\n${lines || 'No logs yet.'}\n\`\`\``;
}

function addLog(level, message) {
  const line = `[${getLocalTimestamp()}] [${level.toUpperCase()}] ${message}`;
  logs.push(line);
  if (logs.length > 100) logs.shift();
  updateLogsMessage();
}

async function updateStatusMessage(channel, status, tag = false) {
  const isUp = status === 'up';
  const color = isUp ? 0x57F287 : 0xED4245; // Discord green/red
  const dot = isUp ? '🟢' : '🔴';
  const desc = isUp
    ? `${dot} **кяуρтιк your Snapmatic Scraper is online.**`
    : `${dot} **кяуρтιк your naai, your stupid Snapmatic Scraper is down. Wake Up!** <@${TAG_USER_ID}>`;
  const embed = new EmbedBuilder()
    .setTitle('Snapmatic Scraper Status')
    .setURL(HEALTH_CHECK_URL)
    .setDescription(desc)
    .addFields({ name: 'Last checked', value: getLocalTimestamp(), inline: false })
    .setColor(color);
  if (statusMessageId) {
    try {
      const msg = await channel.messages.fetch(statusMessageId);
      await msg.edit({ embeds: [embed] });
    } catch (e) {
      // If message was deleted, send a new one
      const newMsg = await channel.send({ embeds: [embed] });
      statusMessageId = newMsg.id;
    }
  } else {
    const msg = await channel.send({ embeds: [embed] });
    statusMessageId = msg.id;
  }
}

async function updateLogsMessage() {
  if (!empireClient.isReady()) return;
  const channel = await empireClient.channels.fetch(EMPIRE_CHANNEL_ID);
  const content = `**Live Logs (last ${LOG_LINES}):**\n${formatLogs()}`;
  if (logsMessageId) {
    try {
      const msg = await channel.messages.fetch(logsMessageId);
      await msg.edit(content);
    } catch (e) {
      // If message was deleted, send a new one
      const newMsg = await channel.send(content);
      logsMessageId = newMsg.id;
    }
  } else {
    const msg = await channel.send(content);
    logsMessageId = msg.id;
  }
}

async function healthCheckLoop(channel) {
  while (true) {
    let status = 'up';
    let tag = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(HEALTH_CHECK_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.status === 502) {
        status = 'down';
        tag = true;
      }
    } catch (e) {
      status = 'down';
      tag = true;
    }
    if (status !== lastStatus) {
      await updateStatusMessage(channel, status, tag);
      lastStatus = status;
    } else {
      // Always update last checked time
      await updateStatusMessage(channel, status, tag);
    }
    await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL));
  }
}

empireClient.once('ready', async () => {
  const channel = await empireClient.channels.fetch(EMPIRE_CHANNEL_ID);
  await updateStatusMessage(channel, 'up', false);
  await updateLogsMessage();
  healthCheckLoop(channel);

  // Register /lastupload command
  try {
    await empireClient.application.commands.create({
      name: 'lastupload',
      description: 'Show the last uploaded image log',
    }, channel.guild.id);
  } catch (e) {
    console.error('[EmpireHealthLogger] Failed to register /lastupload command:', e);
  }
});

empireClient.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === 'lastupload') {
    // Find the last log entry that looks like an image upload
    const lastUpload = [...logs].reverse().find(l => l.includes('[GitHub] Uploaded:'));
    if (lastUpload) {
      await interaction.reply({ content: `Last uploaded image log:\n\`\`\`${lastUpload}\`\`\``, flags: 1 << 6 });
    } else {
      await interaction.reply({ content: 'No image upload logs found.', flags: 1 << 6 });
    }
  }
});

empireClient.login(HEALTH_CHECK_TOKEN);

// Export log function for use in main app if needed
module.exports = {
  log: (level, message) => addLog(level, message)
}; 