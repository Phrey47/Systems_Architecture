const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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

app.get('/api/categories', async (req, res) => {
  try {
    const response = await fetch('https://opentdb.com/api_category.php');
    const data = await response.json();
    res.json(data.trivia_categories);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

app.get('/api/token', async (req, res) => {
  try {
    const response = await fetch('https://opentdb.com/api_token.php?command=request');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch session token" });
  }
});

app.get('/api/questions/:categoryId', async (req, res) => {
  const { categoryId } = req.params;
  const { token } = req.query;
  try {
    let url = `https://opentdb.com/api.php?amount=15&category=${categoryId}&type=multiple`;
    if (token) url += `&token=${token}`;

    const response = await fetch(url);
    const data = await response.json();
    
    if (data.response_code === 5) return res.status(429).json({ error: "Rate limit reached. Please wait 5 seconds before trying again." });
    if (data.response_code === 4) return res.status(404).json({ error: "EXHAUSTED" });

    res.json(data.results || []);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch questions" });
  }
});

// ── UPDATED: Awards Coins based on Correct Answers ──
app.post('/api/match', (req, res) => {
  const { user_id, username, score, accuracy, correctAnswers, category } = req.body;
  if (!user_id) return res.status(400).json({ error: "Missing user_id" });

  const is_win = accuracy >= 50 ? 1 : 0; 
  const xp_earned = Math.floor(score / 10) + (is_win ? 50 : 10);
  const correct_answers = correctAnswers || 0;
  const coins_earned = correct_answers; // 1 Coin per correct answer

  db.query('SELECT xp, level, wins, losses, streak, coins FROM users WHERE user_id = ?', [user_id], (err, users) => {
    if (err || users.length === 0) return res.status(500).json({ error: "User not found" });

    let { xp, level, wins, losses, streak, coins } = users[0];
    
    xp += xp_earned;
    level = Math.floor(xp / 1000) + 1; 
    coins += coins_earned;
    if (is_win) { wins += 1; streak += 1; } else { losses += 1; streak = 0; }

    db.query('UPDATE users SET xp=?, level=?, wins=?, losses=?, streak=?, coins=? WHERE user_id=?', [xp, level, wins, losses, streak, coins, user_id], () => {
      db.query('INSERT INTO game_history (user_id, category, difficulty, score, total_questions, is_win) VALUES (?, ?, ?, ?, ?, ?)', [user_id, category, 'Medium', score, 15, is_win], () => {
        db.query('SELECT * FROM leaderboard WHERE username = ?', [username], (err, lbResults) => {
          if (lbResults && lbResults.length > 0) {
            if (score > lbResults[0].score) db.query('UPDATE leaderboard SET score=?, accuracy=?, category=? WHERE username=?', [score, accuracy, category, username]);
          } else {
            db.query('INSERT INTO leaderboard (username, score, accuracy, category) VALUES (?, ?, ?, ?)', [username, score, accuracy, category]);
          }
          
          db.query(`UPDATE active_tasks SET current_progress = current_progress + 1, is_completed = CASE WHEN current_progress + 1 >= target_amount THEN 1 ELSE 0 END WHERE user_id = ? AND task_description LIKE 'Play%' AND is_completed = 0`, [user_id]);
          db.query(`UPDATE active_tasks SET current_progress = current_progress + ?, is_completed = CASE WHEN current_progress + ? >= target_amount THEN 1 ELSE 0 END WHERE user_id = ? AND task_description LIKE 'Score%' AND is_completed = 0`, [score, score, user_id]);
          db.query(`UPDATE active_tasks SET current_progress = current_progress + ?, is_completed = CASE WHEN current_progress + ? >= target_amount THEN 1 ELSE 0 END WHERE user_id = ? AND task_description LIKE 'Answer%' AND is_completed = 0`, [correct_answers, correct_answers, user_id]);

          res.json({ message: "Match logged", xp_earned, coins_earned, updatedUser: { xp, level, wins, losses, streak, coins } });
        });
      });
    });
  });
});

app.get('/api/history/:user_id', (req, res) => {
  const query = 'SELECT category, score, is_win, played_at FROM game_history WHERE user_id = ? ORDER BY played_at DESC LIMIT 5';
  db.query(query, [req.params.user_id], (err, results) => {
    if (err) return res.status(500).json({ error: "Failed to fetch history" });
    res.json(results);
  });
});

app.get('/api/scores', (req, res) => {
  db.query('SELECT username, score, accuracy, category FROM leaderboard ORDER BY score DESC LIMIT 10', (err, results) => {
    if (err) return res.status(500).json({ error: "Failed to fetch leaderboard" });
    res.json(results);
  });
});

app.get('/api/quests/:user_id', (req, res) => {
  const { user_id } = req.params;
  db.query('SELECT * FROM active_tasks WHERE user_id = ?', [user_id], (err, results) => {
    if (err) return res.status(500).json({ error: "Database error" });
    
    if (results.length === 0) {
      const starterQuests = [
        [user_id, 'Play 5 Arena Matches', 5, 0, 0],
        [user_id, 'Score 15,000 Total Points', 15000, 0, 0],
        [user_id, 'Answer 40 Questions Correctly', 40, 0, 0]
      ];
      const insertQ = 'INSERT INTO active_tasks (user_id, task_description, target_amount, current_progress, is_completed) VALUES ?';
      db.query(insertQ, [starterQuests], (insertErr) => {
        if (insertErr) return res.status(500).json({ error: "Failed to generate quests" });
        db.query('SELECT * FROM active_tasks WHERE user_id = ?', [user_id], (e, newResults) => res.json(newResults));
      });
    } else {
      res.json(results);
    }
  });
});

// ── NEW: Shop & Power-up API ──
app.post('/api/shop/buy', (req, res) => {
  const { user_id, item, cost } = req.body;
  
  db.query('SELECT coins, power_5050, power_time, power_poll FROM users WHERE user_id = ?', [user_id], (err, users) => {
    if (err || users.length === 0) return res.status(500).json({ error: "User not found" });
    let u = users[0];
    
    if (u.coins < cost) return res.status(400).json({ error: "Not enough coins." });
    
    u.coins -= cost;
    if (item === '5050') u.power_5050 += 1;
    if (item === 'time') u.power_time += 1;
    if (item === 'poll') u.power_poll += 1;

    db.query('UPDATE users SET coins=?, power_5050=?, power_time=?, power_poll=? WHERE user_id=?', 
      [u.coins, u.power_5050, u.power_time, u.power_poll, user_id], () => {
      res.json({ message: "Purchase successful", updatedUser: { coins: u.coins, power_5050: u.power_5050, power_time: u.power_time, power_poll: u.power_poll } });
    });
  });
});

app.post('/api/powerup/use', (req, res) => {
  const { user_id, item, deductCoins } = req.body;
  
  db.query('SELECT coins, power_5050, power_time, power_poll FROM users WHERE user_id = ?', [user_id], (err, users) => {
    if (err || users.length === 0) return res.status(500).json({ error: "User not found" });
    let u = users[0];

    if (deductCoins) {
      if (u.coins < 5) return res.status(400).json({ error: "Not enough coins." });
      u.coins -= 5;
    } else {
      if (item === '5050' && u.power_5050 <= 0) return res.status(400).json({ error: "Out of 50/50s." });
      if (item === 'time' && u.power_time <= 0) return res.status(400).json({ error: "Out of +10s." });
      if (item === 'poll' && u.power_poll <= 0) return res.status(400).json({ error: "Out of Polls." });
      
      if (item === '5050') u.power_5050 -= 1;
      if (item === 'time') u.power_time -= 1;
      if (item === 'poll') u.power_poll -= 1;
    }

    db.query('UPDATE users SET coins=?, power_5050=?, power_time=?, power_poll=? WHERE user_id=?', 
      [u.coins, u.power_5050, u.power_time, u.power_poll, user_id], () => {
      res.json({ updatedUser: { coins: u.coins, power_5050: u.power_5050, power_time: u.power_time, power_poll: u.power_poll } });
    });
  });
});

app.post('/api/signup', (req, res) => {
  const { username, email, password, avatarColor } = req.body;
  db.query('INSERT INTO users (username, email, password, avatarColor) VALUES (?, ?, ?, ?)', [username, email, password, avatarColor], (err, result) => {
    if (err) return res.status(400).json({ error: "Username or Email already exists." });
    const newUser = { user_id: result.insertId, username, email, avatarColor, initials: username.slice(0,2).toUpperCase(), level: 1, xp: 0, streak: 0, wins: 0, losses: 0, coins: 0, power_5050: 1, power_time: 1, power_poll: 1 };
    res.json({ message: "Account created!", user: newUser });
  });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.query('SELECT * FROM users WHERE email = ? AND password = ?', [email, password], (err, results) => {
    if (err || results.length === 0) return res.status(400).json({ error: "Invalid email or password." });
    const r = results[0];
    const user = { user_id: r.user_id, username: r.username, email: r.email, avatarColor: r.avatarColor, initials: r.username.slice(0,2).toUpperCase(), level: r.level, xp: r.xp, streak: r.streak, wins: r.wins, losses: r.losses, coins: r.coins, power_5050: r.power_5050, power_time: r.power_time, power_poll: r.power_poll };
    res.json({ message: "Login successful!", user });
  });
});

const PORT = 5001;
app.listen(PORT, () => console.log(`Backend Server is running on port ${PORT}`));