const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const jwt = require('jsonwebtoken'); 
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-brainbattle-key';

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

// ── AUTOMATED WEEKLY RESET LOGIC ──
const runWeeklyReset = () => {
  db.query('SELECT user_id, highest_score FROM weekly_leaderboard ORDER BY highest_score DESC LIMIT 10', (err, topUsers) => {
    if (!topUsers || topUsers.length === 0) return;
    const endDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    topUsers.forEach((u, index) => {
      const rank = index + 1;
      let c=0, p50=0, pT=0, pP=0;
      if (rank === 1) { 
        c=100; p50=2; pT=2; pP=2; 
        db.query('INSERT INTO achievements (user_id, title, description, icon) VALUES (?, ?, ?, ?)', [u.user_id, "Weekly Champion", `You ranked 1st in the Weekly Ranks ended on ${endDate}.`, '👑']);
      }
      else if (rank <= 3) { c=50; p50=1; pT=1; pP=1; }
      else { c=20; p50=0; pT=0; pP=0; }
      
      const msg = `University Weekly Reset! You placed Rank #${rank}!`;
      db.query('INSERT INTO notifications (user_id, message, coins_reward, power_5050_reward, power_time_reward, power_poll_reward) VALUES (?, ?, ?, ?, ?, ?)', [u.user_id, msg, c, p50, pT, pP]);
    });
    db.query('TRUNCATE TABLE weekly_leaderboard', () => console.log("SUCCESS: Automated Weekly Reset completed!"));
  });
};

let hasResetThisWeek = false;
setInterval(() => {
  const now = new Date();
  if (now.getDay() === 1 && now.getHours() === 0 && now.getMinutes() === 0) {
    if (!hasResetThisWeek) { runWeeklyReset(); hasResetThisWeek = true; }
  } else { hasResetThisWeek = false; }
}, 60000); 

// ── API ROUTES ──
app.get('/api/categories', async (req, res) => {
  try {
    const response = await fetch('https://opentdb.com/api_category.php');
    const data = await response.json();
    res.json(data.trivia_categories);
  } catch (error) { res.status(500).json({ error: "Failed to fetch categories" }); }
});

app.get('/api/token', async (req, res) => {
  try {
    const response = await fetch('https://opentdb.com/api_token.php?command=request');
    const data = await response.json();
    res.json(data);
  } catch (error) { res.status(500).json({ error: "Failed to fetch session token" }); }
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
  } catch (error) { res.status(500).json({ error: "Failed to fetch questions" }); }
});

app.post('/api/match', (req, res) => {
  const { user_id, username, score, accuracy, correctAnswers, category } = req.body;
  if (!user_id) return res.status(400).json({ error: "Missing user_id" });

  const is_win = accuracy >= 50 ? 1 : 0; 
  const xp_earned = Math.floor(score / 10) + (is_win ? 50 : 10);
  const correct_answers = correctAnswers || 0;
  const coins_earned = correct_answers; 

  db.query('SELECT xp, level, wins, losses, streak, coins FROM users WHERE user_id = ?', [user_id], (err, users) => {
    if (err || users.length === 0) return res.status(500).json({ error: "User not found" });
    let { xp, level, wins, losses, streak, coins } = users[0];
    
    // We remove automatic leveling up from here. Quests handle rank ups now!
    xp += xp_earned; coins += coins_earned;
    if (is_win) { wins += 1; streak += 1; } else { losses += 1; streak = 0; }

    db.query('UPDATE users SET xp=?, wins=?, losses=?, streak=?, coins=? WHERE user_id=?', [xp, wins, losses, streak, coins, user_id], () => {
      db.query('INSERT INTO game_history (user_id, category, difficulty, score, total_questions, is_win) VALUES (?, ?, ?, ?, ?, ?)', [user_id, category, 'Medium', score, 15, is_win], () => {
        db.query('SELECT * FROM leaderboard WHERE username = ?', [username], (err, lbResults) => {
          if (lbResults && lbResults.length > 0) {
            if (score > lbResults[0].score) db.query('UPDATE leaderboard SET score=?, accuracy=?, category=? WHERE username=?', [score, accuracy, category, username]);
          } else {
            db.query('INSERT INTO leaderboard (username, score, accuracy, category) VALUES (?, ?, ?, ?)', [username, score, accuracy, category]);
          }
          db.query('SELECT * FROM weekly_leaderboard WHERE user_id = ?', [user_id], (err, wRes) => {
            if (wRes && wRes.length > 0) {
              if (score > wRes[0].highest_score) db.query('UPDATE weekly_leaderboard SET highest_score = ? WHERE user_id = ?', [score, user_id]);
            } else {
              db.query('INSERT INTO weekly_leaderboard (user_id, highest_score, week_start_date) VALUES (?, ?, CURDATE())', [user_id, score]);
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
});

app.get('/api/history/:user_id', (req, res) => {
  db.query('SELECT category, score, is_win, played_at FROM game_history WHERE user_id = ? ORDER BY played_at DESC LIMIT 5', [req.params.user_id], (err, results) => {
    res.json(results || []);
  });
});

// ── UPDATED: All-Time Leaderboard (Now fetches Avatars) ──
app.get('/api/scores', (req, res) => {
  const query = `
    SELECT l.username, l.score, l.accuracy, l.category, u.avatarColor, u.avatar_url 
    FROM leaderboard l 
    LEFT JOIN users u ON l.username = u.username 
    ORDER BY l.score DESC LIMIT 10
  `;
  db.query(query, (err, results) => {
    res.json(results || []);
  });
});

// ── UPDATED: Weekly Leaderboard (Now fetches Avatars) ──
app.get('/api/scores/weekly', (req, res) => {
  const query = `
    SELECT u.username, w.highest_score as score, u.avatarColor, u.avatar_url 
    FROM weekly_leaderboard w 
    JOIN users u ON w.user_id = u.user_id 
    ORDER BY w.highest_score DESC LIMIT 10
  `;
  db.query(query, (err, results) => {
    res.json(results || []);
  });
});

// ── GET QUESTS (Dynamically scaling based on level) ──
app.get('/api/quests/:user_id', (req, res) => {
  const { user_id } = req.params;
  db.query('SELECT * FROM active_tasks WHERE user_id = ?', [user_id], (err, results) => {
    if (err) return res.status(500).json({ error: "Database error" });
    
    if (results.length === 0) {
      db.query('SELECT level FROM users WHERE user_id = ?', [user_id], (err, uRes) => {
        const lvl = (uRes && uRes.length > 0) ? uRes[0].level : 1;
        const starterQuests = [
          [user_id, `Play ${lvl * 5} Arena Matches`, lvl * 5, 0, 0],
          [user_id, `Score ${lvl * 15},000 Total Points`, lvl * 15000, 0, 0],
          [user_id, `Answer ${lvl * 40} Questions Correctly`, lvl * 40, 0, 0]
        ];
        db.query('INSERT INTO active_tasks (user_id, task_description, target_amount, current_progress, is_completed) VALUES ?', [starterQuests], () => {
          db.query('SELECT * FROM active_tasks WHERE user_id = ?', [user_id], (e, newResults) => res.json(newResults));
        });
      });
    } else {
      res.json(results);
    }
  });
});

// ── NEW: CLAIM RANK UP (Infinite Quests Engine) ──
app.post('/api/quests/rankup', (req, res) => {
  const { user_id } = req.body;
  // 1. Ensure all quests are actually done
  db.query('SELECT * FROM active_tasks WHERE user_id = ? AND is_completed = 0', [user_id], (err, pending) => {
    if (pending.length > 0) return res.status(400).json({ error: "Not all quests are completed yet!" });

    // 2. Wipe old quests
    db.query('DELETE FROM active_tasks WHERE user_id = ?', [user_id], () => {
      // 3. Level Up user
      db.query('UPDATE users SET level = level + 1 WHERE user_id = ?', [user_id], () => {
        db.query('SELECT level FROM users WHERE user_id = ?', [user_id], (err, uRes) => {
          const newLvl = uRes[0].level;
          // 4. Generate new dynamically harder quests
          const newQuests = [
            [user_id, `Play ${newLvl * 5} Arena Matches`, newLvl * 5, 0, 0],
            [user_id, `Score ${newLvl * 15},000 Total Points`, newLvl * 15000, 0, 0],
            [user_id, `Answer ${newLvl * 40} Questions Correctly`, newLvl * 40, 0, 0]
          ];
          db.query('INSERT INTO active_tasks (user_id, task_description, target_amount, current_progress, is_completed) VALUES ?', [newQuests], () => {
            db.query('SELECT * FROM active_tasks WHERE user_id = ?', [user_id], (e, freshQuests) => {
              res.json({ message: "Ranked Up!", level: newLvl, quests: freshQuests });
            });
          });
        });
      });
    });
  });
});

app.get('/api/achievements/:user_id', (req, res) => {
  db.query('SELECT * FROM achievements WHERE user_id = ? ORDER BY earned_at DESC', [req.params.user_id], (err, results) => {
    res.json(results || []);
  });
});

app.post('/api/shop/buy', (req, res) => {
  const { user_id, item, cost } = req.body;
  db.query('SELECT coins, power_5050, power_time, power_poll FROM users WHERE user_id = ?', [user_id], (err, users) => {
    let u = users[0];
    if (u.coins < cost) return res.status(400).json({ error: "Not enough coins." });
    u.coins -= cost;
    if (item === '5050') u.power_5050 += 1;
    if (item === 'time') u.power_time += 1;
    if (item === 'poll') u.power_poll += 1;
    db.query('UPDATE users SET coins=?, power_5050=?, power_time=?, power_poll=? WHERE user_id=?', [u.coins, u.power_5050, u.power_time, u.power_poll, user_id], () => {
      res.json({ updatedUser: { coins: u.coins, power_5050: u.power_5050, power_time: u.power_time, power_poll: u.power_poll } });
    });
  });
});

app.post('/api/powerup/use', (req, res) => {
  const { user_id, item, deductCoins } = req.body;
  db.query('SELECT coins, power_5050, power_time, power_poll FROM users WHERE user_id = ?', [user_id], (err, users) => {
    let u = users[0];
    if (deductCoins) {
      if (u.coins < 5) return res.status(400).json({ error: "Not enough coins." });
      u.coins -= 5;
    } else {
      if (item === '5050') u.power_5050 -= 1;
      if (item === 'time') u.power_time -= 1;
      if (item === 'poll') u.power_poll -= 1;
    }
    db.query('UPDATE users SET coins=?, power_5050=?, power_time=?, power_poll=? WHERE user_id=?', [u.coins, u.power_5050, u.power_time, u.power_poll, user_id], () => {
      res.json({ updatedUser: { coins: u.coins, power_5050: u.power_5050, power_time: u.power_time, power_poll: u.power_poll } });
    });
  });
});

app.get('/api/notifications/:user_id', (req, res) => {
  db.query('SELECT * FROM notifications WHERE user_id = ? AND is_claimed = 0 ORDER BY created_at DESC', [req.params.user_id], (err, results) => {
    res.json(results || []);
  });
});

app.post('/api/notifications/claim', (req, res) => {
  const { notification_id, user_id } = req.body;
  db.query('SELECT * FROM notifications WHERE id = ? AND is_claimed = 0', [notification_id], (err, notes) => {
    if (err || notes.length === 0) return res.status(400).json({ error: "Reward already claimed or not found." });
    const n = notes[0];
    db.query('UPDATE notifications SET is_claimed = 1 WHERE id = ?', [notification_id], () => {
      db.query('SELECT coins, power_5050, power_time, power_poll FROM users WHERE user_id = ?', [user_id], (err, users) => {
        let u = users[0];
        u.coins += n.coins_reward; u.power_5050 += n.power_5050_reward; u.power_time += n.power_time_reward; u.power_poll += n.power_poll_reward;
        db.query('UPDATE users SET coins=?, power_5050=?, power_time=?, power_poll=? WHERE user_id=?', [u.coins, u.power_5050, u.power_time, u.power_poll, user_id], () => {
          res.json({ updatedUser: { coins: u.coins, power_5050: u.power_5050, power_time: u.power_time, power_poll: u.power_poll } });
        });
      });
    });
  });
});

// ── NEW: UPDATE SETTINGS PROFILE ──
// ── NEW: UPDATE SETTINGS PROFILE (Email is securely locked!) ──
app.post('/api/user/update', (req, res) => {
  const { user_id, username, email, avatarColor, avatar_url } = req.body;
  
  // Safely handle empty image links so the database doesn't panic
  const safeAvatarUrl = avatar_url === "" ? null : avatar_url;

  // We completely removed 'email=?' from this query so it never touches the locked column
  db.query('UPDATE users SET username=?, avatarColor=?, avatar_url=? WHERE user_id=?',
    [username, avatarColor, safeAvatarUrl, user_id], (err) => {
    
    if (err) {
      console.error("Settings Update Error:", err); // This prints the real error to your terminal!
      return res.status(400).json({ error: "That username is already taken by another player." });
    }

    res.json({ 
      message: "Profile updated successfully!", 
      updatedUser: { 
        username, 
        email, // We just pass the exact same email back to React
        avatarColor, 
        avatar_url: safeAvatarUrl, 
        initials: username.slice(0,2).toUpperCase() 
      }
    });
  });
});

app.post('/api/signup', (req, res) => {
  const { username, email, password, avatarColor } = req.body;
  db.query('INSERT INTO users (username, email, password, avatarColor) VALUES (?, ?, ?, ?)', [username, email, password, avatarColor], (err, result) => {
    if (err) return res.status(400).json({ error: "Username or Email already exists." });
    const newUser = { user_id: result.insertId, username, email, avatarColor, avatar_url: null, initials: username.slice(0,2).toUpperCase(), level: 1, xp: 0, streak: 0, wins: 0, losses: 0, coins: 0, power_5050: 1, power_time: 1, power_poll: 1 };
    db.query('INSERT INTO achievements (user_id, title, description, icon) VALUES (?, ?, ?, ?)', [result.insertId, "Welcome to the Arena", "You created an account and began your journey.", "🔥"]);
    const token = jwt.sign({ user_id: result.insertId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: "Account created!", user: newUser, token });
  });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.query('SELECT * FROM users WHERE email = ? AND password = ?', [email, password], (err, results) => {
    if (err || results.length === 0) return res.status(400).json({ error: "Invalid email or password." });
    const r = results[0];
    const user = { user_id: r.user_id, username: r.username, email: r.email, avatarColor: r.avatarColor, avatar_url: r.avatar_url, initials: r.username.slice(0,2).toUpperCase(), level: r.level, xp: r.xp, streak: r.streak, wins: r.wins, losses: r.losses, coins: r.coins, power_5050: r.power_5050, power_time: r.power_time, power_poll: r.power_poll };
    const token = jwt.sign({ user_id: r.user_id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: "Login successful!", user, token });
  });
});

app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token provided" });
  const token = authHeader.split(' ')[1]; 
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    db.query('SELECT * FROM users WHERE user_id = ?', [decoded.user_id], (err, results) => {
      if (err || results.length === 0) return res.status(401).json({ error: "User not found" });
      const r = results[0];
      const user = { user_id: r.user_id, username: r.username, email: r.email, avatarColor: r.avatarColor, avatar_url: r.avatar_url, initials: r.username.slice(0,2).toUpperCase(), level: r.level, xp: r.xp, streak: r.streak, wins: r.wins, losses: r.losses, coins: r.coins, power_5050: r.power_5050, power_time: r.power_time, power_poll: r.power_poll };
      res.json({ user });
    });
  } catch (e) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

const PORT = 5001;
app.listen(PORT, () => console.log(`Backend Server is running on port ${PORT}`));