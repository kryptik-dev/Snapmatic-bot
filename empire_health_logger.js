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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers]
});

let statusMessageId = null;
let logsMessageId = null;
let lastStatus = null;
let logs = [];
let logsMessageReady = false;

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
  if (logsMessageReady) {
    updateLogsMessage();
  }
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
      if (res.status !== 200) {
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
    }
    await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL));
  }
}

empireClient.once('ready', async () => {
  console.log('[EmpireHealthLogger] Bot is ready, waiting 60 seconds before starting...');
  
  setTimeout(async () => {
    const channel = await empireClient.channels.fetch(EMPIRE_CHANNEL_ID);
    await updateStatusMessage(channel, 'up', false);
    
    setTimeout(async () => {
      await updateLogsMessage();
      logsMessageReady = true;
    }, 10000);
    
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
      await empireClient.application.commands.create({
        name: 'gtao',
        description: 'Show GTA Online stats in a fancy format',
      }, channel.guild.id);
    } catch (e) {
      console.error('[EmpireHealthLogger] Failed to register commands:', e);
    }
  }, 60000);
});

empireClient.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  
  if (interaction.commandName === 'lastupload') {
    try {
      const lastUpload = [...logs].reverse().find(l => l.includes('[GitHub] Uploaded:'));
      if (lastUpload) {
        await interaction.reply({ content: `Last uploaded image log:\n\`\`\`${lastUpload}\`\`\``, flags: 1 << 6 });
      } else {
        await interaction.reply({ content: 'No image upload logs found.', flags: 1 << 6 });
      }
    } catch (e) {
      console.error('[EmpireHealthLogger] Error in lastupload command:', e);
      try {
        if (!interaction.replied) {
          await interaction.reply({ content: 'Error processing command.', flags: 1 << 6 });
        }
      } catch (replyError) {
        console.error('[EmpireHealthLogger] Failed to send error reply:', replyError);
      }
    }
  }
  
  if (interaction.commandName === 'checkup_on_kryptik') {
    try {
      const user = await empireClient.users.fetch('1347203516304986147');
      const guild = interaction.guild;
      const member = await guild.members.fetch('1347203516304986147');
      
      let activity = null;
      let status = 'offline';
      let details = '';
      let state = '';
      let largeImage = null;
      let largeText = '';
      let startTimestamp = null;
      
      if (member.presence) {
        status = member.presence.status;
        if (member.presence.activities && member.presence.activities.length > 0) {
          activity = member.presence.activities.find(a => a.type === 0 || a.type === 1 || a.type === 2 || a.type === 3 || a.type === 5);
          if (activity) {
            details = activity.details || '';
            state = activity.state || '';
            if (activity.assets && activity.assets.largeImage) {
              largeImage = `https://cdn.discordapp.com/app-assets/${activity.applicationId}/${activity.assets.largeImage}.png`;
              largeText = activity.assets.largeText || '';
            }
            if (activity.timestamps && activity.timestamps.start) {
              startTimestamp = activity.timestamps.start;
            }
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
      
      const embed = new EmbedBuilder()
        .setTitle('кяуρтιк')
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .setColor(0x00ccaa)
        .setTimestamp();
      
      embed.addFields({ name: 'Status', value: status, inline: true });
      
      if (activity) {
        embed.addFields({ name: 'Activity', value: activity.name, inline: true });
        if (details) embed.addFields({ name: 'Details', value: details, inline: false });
        if (state) embed.addFields({ name: 'State', value: state, inline: false });
        if (largeImage) embed.setImage(largeImage);
        if (largeText) embed.setFooter({ text: largeText });
        if (startTimestamp) embed.addFields({ name: 'Started', value: `<t:${Math.floor(new Date(startTimestamp).getTime()/1000)}:R>`, inline: false });
      } else {
        embed.addFields({ name: 'Activity', value: funnyActivities[Math.floor(Math.random() * funnyActivities.length)], inline: true });
      }
      
      await interaction.reply({ embeds: [embed], flags: 1 << 6 });
    } catch (e) {
      console.error('[EmpireHealthLogger] Error in checkup_on_kryptik command:', e);
      try {
        if (!interaction.replied) {
          await interaction.reply({ content: 'Failed to check up on кяуρтιк. Probably hiding.', flags: 1 << 6 });
        }
      } catch (replyError) {
        console.error('[EmpireHealthLogger] Failed to send error reply:', replyError);
      }
    }
  }
  
  if (interaction.commandName === 'gtao') {
    try {
      await interaction.deferReply({ ephemeral: true });
      const endpoints = [
        {
          name: 'Total Members',
          url: 'https://gtarev.the360unity.workers.dev/api.php?action=member_count&apikey=1ebb20d0-1e62-43d8-851c-8b00d8dee7fa&format=json',
          emoji: '👥'
        },
        {
          name: 'Total Crews',
          url: 'https://gtarev.the360unity.workers.dev/api.php?action=crew_count&apikey=1ebb20d0-1e62-43d8-851c-8b00d8dee7fa&format=json',
          emoji: '🛡️'
        },
        {
          name: 'Total Online',
          url: 'https://gtarev.the360unity.workers.dev/api.php?action=online_count&apikey=1ebb20d0-1e62-43d8-851c-8b00d8dee7fa&format=json',
          emoji: '🌐'
        },
        {
          name: 'Online Xbox 360',
          url: 'https://gtarev.the360unity.workers.dev/api.php?action=xbox360_online_count&apikey=1ebb20d0-1e62-43d8-851c-8b00d8dee7fa&format=json',
          emoji: '🎮 Xbox 360'
        },
        {
          name: 'Online PS3/RPCS3',
          url: 'https://gtarev.the360unity.workers.dev/api.php?action=ps3_online_count&apikey=1ebb20d0-1e62-43d8-851c-8b00d8dee7fa&format=json',
          emoji: '🎮 PS3'
        },
        {
          name: 'Online PS4/PS5 (WIP)',
          url: 'https://gtarev.the360unity.workers.dev/api.php?action=ps4_online_count&apikey=1ebb20d0-1e62-43d8-851c-8b00d8dee7fa&format=json',
          emoji: '🎮 PS4/PS5'
        }
      ];
      const fetches = endpoints.map(e => fetch(e.url).then(r => r.json()).catch(() => null));
      const results = await Promise.all(fetches);
      const embed = new EmbedBuilder()
        .setTitle('GTA Online Stats')
        .setColor(0x3498db)
        .setTimestamp();
      let hasError = false;
      endpoints.forEach((ep, i) => {
        let value = 'N/A';
        if (results[i] && typeof results[i].result !== 'undefined') {
          value = results[i].result.toLocaleString();
        } else {
          hasError = true;
        }
        embed.addFields({ name: `${ep.emoji} ${ep.name}`, value: value, inline: true });
      });
      if (hasError) {
        embed.setFooter({ text: 'Some stats may be unavailable.' });
      }
      await interaction.editReply({ embeds: [embed] });
    } catch (e) {
      console.error('[EmpireHealthLogger] Error in gtao command:', e);
      try {
        if (!interaction.replied) {
          await interaction.reply({ content: 'Failed to fetch GTAO stats.', flags: 1 << 6 });
        } else {
          await interaction.editReply({ content: 'Failed to fetch GTAO stats.' });
        }
      } catch (replyError) {
        console.error('[EmpireHealthLogger] Failed to send error reply:', replyError);
      }
    }
  }
});

empireClient.login(HEALTH_CHECK_TOKEN);

module.exports = {
  log: (level, message) => addLog(level, message)
}; 