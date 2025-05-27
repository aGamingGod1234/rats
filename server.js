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
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

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
let botReady = false;

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

// Function to update user's rat time
const updateUserRatTime = (userId) => {
  if (gameData.users[userId] && gameData.users[userId].currentSessionStart) {
    const sessionTime = Date.now() - gameData.users[userId].currentSessionStart;
    const sessionMinutes = Math.floor(sessionTime / 60000);
    
    // Add session minutes to total rat time
    gameData.users[userId].totalRatMinutes = (gameData.users[userId].totalRatMinutes || 0) + sessionMinutes;
    
    // Reset session start for next calculation
    gameData.users[userId].currentSessionStart = Date.now();
    
    saveData(gameData);
    return gameData.users[userId].totalRatMinutes;
  }
  return 0;
};

// Auto-save user progress every minute
setInterval(() => {
  let updated = false;
  Object.keys(gameData.users).forEach(userId => {
    if (gameData.users[userId].currentSessionStart) {
      updateUserRatTime(userId);
      updated = true;
    }
  });
  
  if (updated) {
    // Broadcast updated leaderboard to all connected clients
    io.emit('leaderboardUpdate', getLeaderboard());
  }
}, 60000); // Every minute

// Express middleware setup (MUST be before Passport)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration with better security
app.use(session({
  secret: config.session_secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to false for HTTP in development, true for HTTPS in production
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Passport configuration with better error handling
passport.serializeUser((user, done) => {
  console.log('Serializing user:', user.id);
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  console.log('Deserializing user:', id);
  // Fetch user from our game data
  const userData = gameData.users[id];
  if (userData) {
    done(null, { 
      id: id, 
      username: userData.name,
      totalRatMinutes: userData.totalRatMinutes || 0,
      isLoggedIn: userData.isLoggedIn || false
    });
  } else {
    done(null, null);
  }
});

// Discord OAuth Strategy with better error handling
passport.use(new DiscordStrategy({
  clientID: config.client_id,
  clientSecret: config.client_secret,
  callbackURL: config.callback_url,
  scope: ['identify']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    console.log('Discord OAuth successful for user:', profile.username);
    return done(null, profile);
  } catch (error) {
    console.error('Discord OAuth error:', error);
    return done(error, null);
  }
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
    .filter(user => user.isLoggedIn && user.totalRatMinutes > 0)
    .sort((a, b) => b.totalRatMinutes - a.totalRatMinutes)
    .slice(0, 10)
    .map(user => ({
      name: user.name,
      points: user.totalRatMinutes,
      discordId: user.discordId
    }));
};

// Create leaderboard embed
const createLeaderboardEmbed = () => {
  const leaderboard = getLeaderboard();
  const embed = new EmbedBuilder()
    .setTitle('🐀 Spinning Rats Leaderboard')
    .setColor('#FFD700')
    .setURL('https://rats-kruv.onrender.com/')
    .setTimestamp();

  if (leaderboard.length === 0) {
    embed.setDescription('No users on the leaderboard yet! Login at rats-kruv.onrender.com to start earning rat time!');
  } else {
    const leaderboardText = leaderboard.map((user, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      return `${medal} **${user.name}** - ${user.points} minutes`;
    }).join('\n');
    
    embed.setDescription(leaderboardText);
  }

  embed.addFields(
    { name: '📊 Stats', value: `Daily Highscore: ${gameData.dailyHighscore}\nActive Viewers: ${gameData.activeViewers}`, inline: true },
    { name: '🌐 Visit', value: '[spinningrats.online](https://rats-kruv.onrender.com/)', inline: true }
  );

  return embed;
};

// Update leaderboard message
const updateLeaderboardMessage = async () => {
  if (!botReady || !leaderboardMessageId || !leaderboardChannelId) return;

  try {
    const channel = await client.channels.fetch(leaderboardChannelId);
    if (!channel) {
      console.error('Leaderboard channel not found');
      return;
    }

    const message = await channel.messages.fetch(leaderboardMessageId);
    if (!message) {
      console.error('Leaderboard message not found');
      return;
    }

    const embed = createLeaderboardEmbed();
    await message.edit({ embeds: [embed] });
    console.log('Leaderboard updated successfully');
  } catch (error) {
    console.error('Error updating leaderboard:', error);
    // Reset message ID if message not found
    if (error.code === 10008) {
      console.log('Leaderboard message no longer exists, resetting...');
      leaderboardMessageId = null;
      leaderboardChannelId = null;
      gameData.botSettings = gameData.botSettings || {};
      gameData.botSettings.leaderboardMessageId = null;
      gameData.botSettings.leaderboardChannelId = null;
      saveData(gameData);
    }
  }
};

// Send webhook announcement with better error handling
const sendWebhookAnnouncement = async (username, isFirstTime = false) => {
  if (!config.webhook_url) return;

  const message = isFirstTime 
    ? `🧀 **${username}** joined the rat zone for the first time! Welcome to the spinning madness! 🐀`
    : `🐀 **${username}** is back in the rat zone! Time to accumulate more rat minutes! 🧀`;

  try {
    const response = await fetch(config.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: message,
        embeds: [{
          title: isFirstTime ? "New Rat Spinner!" : "Returning Rat Spinner!",
          description: `${username} ${isFirstTime ? 'has entered' : 'is back in'} the rat dimension. Time to spin those rats!`,
          color: isFirstTime ? 0x4CAF50 : 0x2196F3,
          timestamp: new Date().toISOString(),
          footer: {
            text: "spinningrat.online"
          }
        }]
      })
    });

    if (!response.ok) {
      console.error('Webhook error:', response.status, response.statusText);
    } else {
      console.log('Webhook announcement sent for:', username);
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
};

// Discord Bot Events with better error handling
client.once('ready', async () => {
  console.log(`🤖 Discord bot logged in as ${client.user.tag}!`);
  botReady = true;
  
  // Register slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the current spinning rats leaderboard'),
  ];

  const rest = new REST({ version: '10' }).setToken(config.bot_token);

  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(config.client_id), { body: commands });
    console.log('Successfully reloaded application (/) commands.');
    
    // Start leaderboard auto-update after commands are registered
    setInterval(updateLeaderboardMessage, 60000);
    console.log('⏰ Leaderboard auto-update started (every 60 seconds)');
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
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
  } catch (error) {
    console.error('Error handling interaction:', error);
    if (!interaction.replied) {
      await interaction.reply({ content: 'An error occurred while processing your command.', ephemeral: true });
    }
  }
});

// Handle Discord bot errors
client.on('error', error => {
  console.error('Discord bot error:', error);
});

client.on('warn', warning => {
  console.warn('Discord bot warning:', warning);
});

// Start the bot if token is provided
if (config.bot_token && config.bot_token !== 'YOUR_DISCORD_BOT_TOKEN_HERE') {
  console.log('🔄 Starting Discord bot...');
  client.login(config.bot_token).catch(err => {
    console.error('❌ Failed to login Discord bot:', err.message);
    console.log('🔧 Make sure your bot token is correct in config.json or environment variables');
    console.log('🔧 Ensure your bot has the following permissions: Send Messages, Use Slash Commands, Embed Links');
  });
} else {
  console.log('⚠️  No bot token provided, Discord bot functionality disabled');
  console.log('💡 Add BOT_TOKEN environment variable or update config.json to enable Discord features');
}

// Auth routes with better error handling and debugging
app.get('/auth/discord', (req, res, next) => {
  console.log('Discord auth initiated');
  console.log('Session ID:', req.sessionID);
  passport.authenticate('discord', {
    scope: ['identify']
  })(req, res, next);
});

app.get('/auth/discord/callback',
  (req, res, next) => {
    console.log('Discord callback received');
    console.log('Query params:', req.query);
    console.log('Session ID:', req.sessionID);
    next();
  },
  passport.authenticate('discord', { 
    failureRedirect: '/?error=auth_failed',
    failureFlash: false 
  }),
  (req, res) => {
    console.log('Discord auth callback successful for user:', req.user.username);
    
    // Handle user login and time tracking
    const userId = req.user.id;
    const username = req.user.username;
    const isFirstTime = !gameData.users[userId];
    
    if (!gameData.users[userId]) {
      // New user - create profile
      gameData.users[userId] = { 
        name: username, 
        totalRatMinutes: 0,
        discordId: userId,
        isLoggedIn: true,
        currentSessionStart: Date.now(),
        firstLogin: new Date().toISOString()
      };
      console.log('New user registered:', username);
    } else {
      // Existing user - mark as logged in and start new session
      gameData.users[userId].isLoggedIn = true;
      gameData.users[userId].currentSessionStart = Date.now();
      gameData.users[userId].name = username; // Update name in case it changed
      console.log('Existing user logged back in:', username);
    }
    
    saveData(gameData);
    
    // Send webhook announcement
    sendWebhookAnnouncement(username, isFirstTime);
    
    res.redirect('/');
  }
);

app.get('/logout', (req, res) => {
  const userId = req.user ? req.user.id : null;
  const username = req.user ? req.user.username : 'Unknown';
  
  // Update final rat time before logout
  if (userId && gameData.users[userId]) {
    updateUserRatTime(userId);
    gameData.users[userId].isLoggedIn = false;
    gameData.users[userId].currentSessionStart = null;
    saveData(gameData);
    console.log(`User ${username} logged out with ${gameData.users[userId].totalRatMinutes} total rat minutes`);
  }
  
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
    } else {
      console.log('User logged out:', username);
    }
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destroy error:', err);
      }
      res.redirect('/');
    });
  });
});

// API endpoint to get current user's rat time
app.get('/api/user/rattime', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.json({ ratMinutes: 0, isLoggedIn: false });
  }
  
  const userId = req.user.id;
  const currentRatTime = updateUserRatTime(userId);
  
  res.json({ 
    ratMinutes: currentRatTime, 
    isLoggedIn: true,
    username: req.user.username
  });
});

// Debug route to check session
app.get('/debug/session', (req, res) => {
  res.json({
    isAuthenticated: req.isAuthenticated(),
    user: req.user,
    session: req.session,
    sessionID: req.sessionID,
    userData: req.user ? gameData.users[req.user.id] : null
  });
});

// Main route with better error handling
app.get('/', (req, res) => {
  try {
    console.log('Main route accessed');
    console.log('Is authenticated:', req.isAuthenticated());
    
    const user = req.user;
    let currentUserRatTime = 0;
    
    if (user) {
      // Update user's current rat time
      currentUserRatTime = updateUserRatTime(user.id);
    }

    const leaderboard = getLeaderboard();
    
    res.render('index', { 
      user, 
      leaderboard, 
      users: gameData.users,
      dailyHighscore: gameData.dailyHighscore,
      activeViewers: gameData.activeViewers,
      currentUserRatTime,
      error: req.query.error
    });
  } catch (error) {
    console.error('Error in main route:', error);
    res.status(500).send('Internal Server Error: ' + error.message);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).send('Something went wrong! ' + err.message);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐀 Rats are spinning on port ${PORT}!`);
  console.log(`🌐 Visit: http://localhost:${PORT}`);
  console.log('🔧 Make sure your Discord OAuth2 redirect URI is set to:', config.callback_url);
  console.log('🔧 Config check:');
  console.log('  - Client ID:', config.client_id ? 'Set' : 'Missing');
  console.log('  - Client Secret:', config.client_secret ? 'Set' : 'Missing');
  console.log('  - Callback URL:', config.callback_url);
  console.log('  - Session Secret:', config.session_secret ? 'Set' : 'Missing');
});