const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Load/save data
const loadData = () => {
  try {
    return JSON.parse(fs.readFileSync('./data.json', 'utf8'));
  } catch {
    return {
      users: {},
      dailyHighscore: 0,
      activeViewers: 0,
      lastReset: new Date().toDateString()
    };
  }
};

const saveData = (data) => {
  fs.writeFileSync('./data.json', JSON.stringify(data, null, 2));
};

let gameData = loadData();

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

      if (config.webhook_url) {
        fetch(config.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `🧀 **${user.username}** joined the rat zone.`
          })
        }).catch(err => console.error('Webhook error:', err));
      }
    } else {
      const minutes = Math.floor((Date.now() - gameData.users[user.id].loginTime) / 60000);
      gameData.users[user.id].points = minutes;
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

server.listen(3000, () => console.log('Rat spinning on http://localhost:3000'));