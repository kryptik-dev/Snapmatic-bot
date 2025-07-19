require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

const HEALTH_CHECK_TOKEN = process.env.HEALTH_CHECK_TOKEN;
const EMPIRE_CHANNEL_ID = process.env.EMPIRE_CHANNEL_ID;
const HEALTH_CHECK_URL = 'https://snapmatic-bot.onrender.com/';
const HEALTH_CHECK_INTERVAL = 30000;
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
  const color = isUp ? 0x57F287 : 0xED4245;
  const dot = isUp ? '🟢' : '🔴';
  const desc = isUp
    ? `${dot} **кяуρтιк your Snapmatic scraper is online.**`
    : `${dot} **кяуρтιк your naai, your stupid snapmatic scraper is down.** <@${TAG_USER_ID}>`;
  const embed = new EmbedBuilder()
    .setTitle('Snapmatic Bot Status')
    .setURL(HEALTH_CHECK_URL)
    .setDescription(desc)
    .addFields({ name: 'Last checked', value: getLocalTimestamp(), inline: false })
    .setColor(color);
  if (statusMessageId) {
    try {
      const msg = await channel.messages.fetch(statusMessageId);
      await msg.edit({ embeds: [embed] });
    } catch (e) {
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

  try {
    await empireClient.application.commands.create({
      name: 'lastupload',
      description: 'Show the last uploaded image log',
    }, channel.guild.id);
    await empireClient.application.commands.create({
      name: 'checkup_on_kryptik',
      description: 'Check what кяуρтιк is up to',
    }, channel.guild.id);
  } catch (e) {
    console.error('[EmpireHealthLogger] Failed to register commands:', e);
  }
});

empireClient.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === 'lastupload') {
    const lastUpload = [...logs].reverse().find(l => l.includes('[GitHub] Uploaded:'));
    if (lastUpload) {
      await interaction.reply({ content: `Last uploaded image log:\n\`\`\`${lastUpload}\`\`\``, flags: 1 << 6 });
    } else {
      await interaction.reply({ content: 'No image upload logs found.', flags: 1 << 6 });
    }
  }
  if (interaction.commandName === 'checkup_on_kryptik') {
    try {
      const user = await empireClient.users.fetch('1347203516304986147');
      const guild = interaction.guild;
      const member = await guild.members.fetch('1347203516304986147');
      
      let activity = 'doing absolutely nothing productive';
      let status = 'offline';
      
      if (member.presence) {
        status = member.presence.status;
        if (member.presence.activities && member.presence.activities.length > 0) {
          const game = member.presence.activities.find(a => a.type === 'PLAYING');
          if (game) {
            activity = `playing ${game.name}`;
          }
        }
      }
      
      const funnyActivities = [
        'crying in the corner',
        'eating glue',
        'talking to his plants',
        'dancing with his shadow',
        'having an existential crisis',
        'pretending to code',
        'arguing with his reflection',
        'teaching his cat to code',
        'having a tea party with his bugs',
        'contemplating life choices',
        'staring at a wall',
        'having a mental breakdown',
        'talking to himself',
        'watching paint dry',
        'counting his problems'
      ];
      
      if (activity === 'doing absolutely nothing productive') {
        activity = funnyActivities[Math.floor(Math.random() * funnyActivities.length)];
      }
      
      const embed = new EmbedBuilder()
        .setTitle('кяуρтιк Status Report')
        .setDescription(`**Current Status:** ${status}\n**Activity:** ${activity}`)
        .setColor(0x00ff00)
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], flags: 1 << 6 });
    } catch (e) {
      await interaction.reply({ content: 'Failed to check up on кяуρтιк. Probably hiding.', flags: 1 << 6 });
    }
  }
});

empireClient.login(HEALTH_CHECK_TOKEN);

module.exports = {
  log: (level, message) => addLog(level, message)
}; 