const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. Database Connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'brainbattle',
  port: process.env.DB_PORT || 8889
});

db.connect((err) => {
  if (err) return console.error('Error connecting to MySQL:', err);
  console.log('Successfully connected to the MySQL database!');
});

// 2. Fetch Categories
app.get('/api/categories', async (req, res) => {
  try {
    const response = await fetch('https://opentdb.com/api_category.php');
    const data = await response.json();
    res.json(data.trivia_categories);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// 3. Fetch Questions (With Rate Limit Protection)
app.get('/api/questions/:categoryId', async (req, res) => {
  const { categoryId } = req.params;
  try {
    const response = await fetch(`https://opentdb.com/api.php?amount=15&category=${categoryId}&type=multiple`);
    const data = await response.json();
    if (data.response_code === 5) return res.status(429).json({ error: "Rate limit reached. Please wait 5 seconds before trying again." });
    res.json(data.results || []);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch questions" });
  }
});

// ── NEW 4. Process Match & Progression ──
app.post('/api/match', (req, res) => {
  const { user_id, username, score, accuracy, category } = req.body;
  if (!user_id) return res.status(400).json({ error: "Missing user_id" });

  const is_win = accuracy >= 50 ? 1 : 0; // Win condition: >50% accuracy
  const xp_earned = Math.floor(score / 10) + (is_win ? 50 : 10);

  // A. Fetch current user stats
  db.query('SELECT xp, level, wins, losses, streak FROM users WHERE user_id = ?', [user_id], (err, users) => {
    if (err || users.length === 0) return res.status(500).json({ error: "User not found" });

    let { xp, level, wins, losses, streak } = users[0];
    
    // B. Calculate new stats
    xp += xp_earned;
    level = Math.floor(xp / 1000) + 1; // 1 Level per 1000 XP
    if (is_win) { wins += 1; streak += 1; } 
    else { losses += 1; streak = 0; }

    // C. Update users table
    db.query('UPDATE users SET xp=?, level=?, wins=?, losses=?, streak=? WHERE user_id=?', [xp, level, wins, losses, streak, user_id], () => {
      
      // D. Log into game_history
      db.query('INSERT INTO game_history (user_id, category, difficulty, score, total_questions, is_win) VALUES (?, ?, ?, ?, ?, ?)', 
        [user_id, category, 'Medium', score, 15, is_win], () => {

        // E. Update Leaderboard
        db.query('SELECT * FROM leaderboard WHERE username = ?', [username], (err, lbResults) => {
          if (lbResults && lbResults.length > 0) {
            if (score > lbResults[0].score) {
              db.query('UPDATE leaderboard SET score=?, accuracy=?, category=? WHERE username=?', [score, accuracy, category, username]);
            }
          } else {
            db.query('INSERT INTO leaderboard (username, score, accuracy, category) VALUES (?, ?, ?, ?)', [username, score, accuracy, category]);
          }
          
          // F. Send back updated profile to React
          res.json({ message: "Match logged", xp_earned, updatedUser: { xp, level, wins, losses, streak } });
        });
      });
    });
  });
});

// ── NEW 5. Fetch User History ──
app.get('/api/history/:user_id', (req, res) => {
  const query = 'SELECT category, score, is_win, played_at FROM game_history WHERE user_id = ? ORDER BY played_at DESC LIMIT 5';
  db.query(query, [req.params.user_id], (err, results) => {
    if (err) return res.status(500).json({ error: "Failed to fetch history" });
    res.json(results);
  });
});

// 6. Fetch Leaderboard
app.get('/api/scores', (req, res) => {
  db.query('SELECT username, score, accuracy, category FROM leaderboard ORDER BY score DESC LIMIT 10', (err, results) => {
    if (err) return res.status(500).json({ error: "Failed to fetch leaderboard" });
    res.json(results);
  });
});

// 7. Sign Up
app.post('/api/signup', (req, res) => {
  const { username, email, password, avatarColor } = req.body;
  db.query('INSERT INTO users (username, email, password, avatarColor) VALUES (?, ?, ?, ?)', [username, email, password, avatarColor], (err, result) => {
    if (err) return res.status(400).json({ error: "Username or Email already exists." });
    const newUser = { user_id: result.insertId, username, email, avatarColor, initials: username.slice(0,2).toUpperCase(), level: 1, xp: 0, streak: 0, wins: 0, losses: 0 };
    res.json({ message: "Account created!", user: newUser });
  });
});

// 8. Log In
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.query('SELECT * FROM users WHERE email = ? AND password = ?', [email, password], (err, results) => {
    if (err || results.length === 0) return res.status(400).json({ error: "Invalid email or password." });
    const r = results[0];
    const user = { user_id: r.user_id, username: r.username, email: r.email, avatarColor: r.avatarColor, initials: r.username.slice(0,2).toUpperCase(), level: r.level, xp: r.xp, streak: r.streak, wins: r.wins, losses: r.losses };
    res.json({ message: "Login successful!", user });
  });
});

const PORT = 5001;
app.listen(PORT, () => console.log(`Backend Server is running on port ${PORT}`));