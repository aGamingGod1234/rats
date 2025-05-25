const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Override config with environment variables if they exist (for Render.com)
if (process.env.CLIENT_ID) config.client_id = process.env.CLIENT_ID;
if (process.env.CLIENT_SECRET) config.client_secret = process.env.CLIENT_SECRET;
if (process.env.BOT_TOKEN) config.bot_token = process.env.BOT_TOKEN;
if (process.env.CALLBACK_URL) config.callback_url = process.env.CALLBACK_URL;
if (process.env.SESSION_SECRET) config.session_secret = process.env.SESSION_SECRET;
if (process.env.WEBHOOK_URL) config.webhook_url = process.env.WEBHOOK_URL;
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Discord Bot Setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let leaderboardMessageId = null;
let leaderboardChannelId = null;

// Load/save data
const loadData = () => {
  try {
    return JSON.parse(fs.readFileSync('./data.json', 'utf8'));
  } catch {
    return {
      users: {},
      dailyHighscore: 0,
      activeViewers: 0,
      lastReset: new Date().toDateString(),
      botSettings: {
        leaderboardMessageId: null,
        leaderboardChannelId: null
      }
    };
  }
};

const saveData = (data) => {
  fs.writeFileSync('./data.json', JSON.stringify(data, null, 2));
};

let gameData = loadData();

// Load bot settings from data
if (gameData.botSettings) {
  leaderboardMessageId = gameData.botSettings.leaderboardMessageId;
  leaderboardChannelId = gameData.botSettings.leaderboardChannelId;
}

// Reset daily highscore if it's a new day
const today = new Date().toDateString();
if (gameData.lastReset !== today) {
  gameData.dailyHighscore = 0;
  gameData.lastReset = today;
  saveData(gameData);
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: config.client_id,
  clientSecret: config.client_secret,
  callbackURL: config.callback_url,
  scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
  return done(null, profile);
}));

app.use(session({
  secret: config.session_secret,
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Socket.io for real-time updates
io.on('connection', (socket) => {
  gameData.activeViewers++;
  
  // Send initial data
  socket.emit('gameData', {
    activeViewers: gameData.activeViewers,
    dailyHighscore: gameData.dailyHighscore,
    leaderboard: getLeaderboard()
  });
  
  // Broadcast updated viewer count
  io.emit('viewerUpdate', gameData.activeViewers);
  
  socket.on('scoreUpdate', (score) => {
    if (score > gameData.dailyHighscore) {
      gameData.dailyHighscore = score;
      saveData(gameData);
      io.emit('highscoreUpdate', score);
    }
  });
  
  socket.on('disconnect', () => {
    gameData.activeViewers = Math.max(0, gameData.activeViewers - 1);
    io.emit('viewerUpdate', gameData.activeViewers);
  });
});

const getLeaderboard = () => {
  return Object.values(gameData.users)
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);
};

// Create leaderboard embed
const createLeaderboardEmbed = () => {
  const leaderboard = getLeaderboard();
  const embed = new EmbedBuilder()
    .setTitle('🐀 Spinning Rats Leaderboard')
    .setColor('#FFD700')
    .setURL('https://spinningrats.onrender.com/')
    .setTimestamp();

  if (leaderboard.length === 0) {
    embed.setDescription('No users on the leaderboard yet! Login at spinningrats.onrender.com to start earning points!');
  } else {
    const leaderboardText = leaderboard.map((user, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      return `${medal} **${user.name}** - ${user.points} minutes`;
    }).join('\n');
    
    embed.setDescription(leaderboardText);
  }

  embed.addFields(
    { name: '📊 Stats', value: `Daily Highscore: ${gameData.dailyHighscore}\nActive Viewers: ${gameData.activeViewers}`, inline: true },
    { name: '🌐 Visit', value: '[spinningrat.online](https://spinningrats.onrender.com/)', inline: true }
  );

  return embed;
};

// Update leaderboard message
const updateLeaderboardMessage = async () => {
  if (!client.isReady() || !leaderboardMessageId || !leaderboardChannelId) return;

  try {
    const channel = await client.channels.fetch(leaderboardChannelId);
    if (!channel) return;

    const message = await channel.messages.fetch(leaderboardMessageId);
    if (!message) return;

    const embed = createLeaderboardEmbed();
    await message.edit({ embeds: [embed] });
    console.log('Leaderboard updated successfully');
  } catch (error) {
    console.error('Error updating leaderboard:', error);
    // Reset message ID if message not found
    if (error.code === 10008) {
      leaderboardMessageId = null;
      gameData.botSettings = gameData.botSettings || {};
      gameData.botSettings.leaderboardMessageId = null;
      saveData(gameData);
    }
  }
};

// Send webhook announcement
const sendWebhookAnnouncement = async (username) => {
  if (!config.webhook_url) return;

  try {
    const response = await fetch(config.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🧀 **${username}** joined the rat zone! Welcome to the spinning madness! 🐀`,
        embeds: [{
          title: "New Rat Spinner!",
          description: `${username} has entered the rat dimension. Time to spin those rats!`,
          color: 0x4CAF50,
          timestamp: new Date().toISOString(),
          footer: {
            text: "spinningrat.online"
          }
        }]
      })
    });

    if (!response.ok) {
      console.error('Webhook error:', response.status, response.statusText);
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
};

// Discord Bot Events
client.once('ready', () => {
  console.log(`🤖 Discord bot logged in as ${client.user.tag}!`);
  
  // Register slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the current spinning rats leaderboard'),
  ];

  const rest = new REST({ version: '10' }).setToken(config.bot_token);

  (async () => {
    try {
      console.log('Started refreshing application (/) commands.');
      await rest.put(Routes.applicationCommands(config.client_id), { body: commands });
      console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
      console.error(error);
    }
  })();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'leaderboard') {
    const embed = createLeaderboardEmbed();
    
    // If no existing leaderboard message, create one and store it
    if (!leaderboardMessageId) {
      const reply = await interaction.reply({ embeds: [embed], fetchReply: true });
      leaderboardMessageId = reply.id;
      leaderboardChannelId = interaction.channelId;
      
      // Save to data
      gameData.botSettings = gameData.botSettings || {};
      gameData.botSettings.leaderboardMessageId = leaderboardMessageId;
      gameData.botSettings.leaderboardChannelId = leaderboardChannelId;
      saveData(gameData);
      
      console.log('New leaderboard message created and stored');
    } else {
      await interaction.reply({ embeds: [embed] });
    }
  }
});

// Start the bot if token is provided
if (config.bot_token && config.bot_token !== 'YOUR_DISCORD_BOT_TOKEN_HERE') {
  client.login(config.bot_token).catch(err => {
    console.error('❌ Failed to login Discord bot:', err.message);
    console.log('🔧 Make sure your bot token is correct in config.json or environment variables');
  });
  
  // Update leaderboard every minute (only after bot is ready)
  client.once('ready', () => {
    setInterval(updateLeaderboardMessage, 60000);
    console.log('⏰ Leaderboard auto-update started (every 60 seconds)');
  });
} else {
  console.log('⚠️  No bot token provided, Discord bot functionality disabled');
  console.log('💡 Add BOT_TOKEN environment variable or update config.json to enable Discord features');
}

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/', (req, res) => {
  const user = req.user;
  if (user) {
    if (!gameData.users[user.id]) {
      gameData.users[user.id] = { 
        name: user.username, 
        points: 0, 
        loginTime: Date.now() 
      };

      // Send webhook announcement for new users
      sendWebhookAnnouncement(user.username);
    } else {
      // Update points based on time spent
      const minutes = Math.floor((Date.now() - gameData.users[user.id].loginTime) / 60000);
      gameData.users[user.id].points = Math.max(gameData.users[user.id].points, minutes);
    }
    saveData(gameData);
  }

  const leaderboard = getLeaderboard();
  
  res.render('index', { 
    user, 
    leaderboard, 
    users: gameData.users,
    dailyHighscore: gameData.dailyHighscore,
    activeViewers: gameData.activeViewers
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐀 Rats are spinning on port ${PORT}!`);
  console.log(`🌐 Visit: http://localhost:${PORT}`);
});