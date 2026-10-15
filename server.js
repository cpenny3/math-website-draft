import express from "express";
import session from "express-session";
import SQLiteStoreFactory from "connect-sqlite3";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import OpenAI from "openai";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

/*
 * Where the database and session files live. On a host like Render or
 * Railway, point this at a persistent disk so posts survive redeploys.
 */
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });

/*
 * Comma-separated usernames that can moderate posts and pick the
 * Question of the Week, e.g. ADMIN_USERNAMES=sarah,elaine,catherine
 */
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || "")
  .split(",")
  .map(name => name.trim().toLowerCase())
  .filter(Boolean);

const AI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

const CATALOG = JSON.parse(
  fs.readFileSync(path.join(__dirname, "public", "catalog.json"), "utf8")
);
const GRADE_IDS = CATALOG.grades.map(g => g.id);
const TOPIC_IDS = CATALOG.topics.map(t => t.id);
const GOAL_IDS = CATALOG.goals.map(g => g.id);
const COMPETITION_IDS = CATALOG.competitions.map(c => c.id);
const competitionName = id =>
  CATALOG.competitions.find(c => c.id === id)?.name || id;

/*
|--------------------------------------------------------------------------
| DATABASE
|--------------------------------------------------------------------------
*/

const db = new Database(
  process.env.DB_PATH || path.join(DATA_DIR, "app.db")
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT UNIQUE COLLATE NOCASE,
    password_hash TEXT,
    google_id TEXT UNIQUE,
    google_email TEXT,
    avatar_url TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contest_logs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS qow (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS qow_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    qow_id INTEGER NOT NULL REFERENCES qow(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS advice_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS advice_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL REFERENCES advice_questions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, target_type, target_id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS qow_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS buddy_swipes (
    from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    liked INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (from_id, to_id)
  );

  CREATE TABLE IF NOT EXISTS buddy_blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (blocker_id, blocked_id)
  );
`);

/*
 * Add newer columns to databases created by an earlier version.
 */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("users", "profile", "TEXT");
ensureColumn("users", "buddy_opt_in", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "buddy_intro", "TEXT NOT NULL DEFAULT ''");
ensureColumn("contest_logs", "mode", "TEXT NOT NULL DEFAULT 'Mock'");
ensureColumn("contest_logs", "correct", "INTEGER");
ensureColumn("contest_logs", "incorrect", "INTEGER");
ensureColumn("contest_logs", "unanswered", "INTEGER");
ensureColumn("contest_logs", "reflections", "TEXT NOT NULL DEFAULT '{}'");

if (!db.prepare("SELECT id FROM qow LIMIT 1").get()) {
  db.prepare("INSERT INTO qow (text) VALUES (?)").run(
    "In what ways do you notice your gender identity impacts your experience in competitive math?"
  );
}

/*
|--------------------------------------------------------------------------
| EXPRESS
|--------------------------------------------------------------------------
*/

const app = express();

app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

/*
|--------------------------------------------------------------------------
| SESSIONS
|--------------------------------------------------------------------------
*/

if (isProduction && !process.env.SESSION_SECRET) {
  console.warn("SESSION_SECRET is not set; everyone is logged out on each restart.");
}

const SQLiteStore = SQLiteStoreFactory(session);

app.use(
  session({
    store: new SQLiteStore({ db: "sessions.db", dir: DATA_DIR }),
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 24 * 30
    }
  })
);

/*
|--------------------------------------------------------------------------
| PASSPORT
|--------------------------------------------------------------------------
*/

app.use(passport.initialize());
app.use(passport.session());

const getUser = id => db.prepare("SELECT * FROM users WHERE id = ?").get(id);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, getUser(id) || false));

/*
|--------------------------------------------------------------------------
| GOOGLE LOGIN
|--------------------------------------------------------------------------
*/

const googleConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
);

if (googleConfigured) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:
          process.env.GOOGLE_CALLBACK_URL ||
          "http://localhost:3000/auth/google/callback"
      },
      (accessToken, refreshToken, profile, done) => {
        try {
          const googleId = profile.id;
          const email = profile.emails?.[0]?.value?.toLowerCase() || null;
          const avatar = profile.photos?.[0]?.value || null;

          /*
           * Existing Google account.
           */
          let user = db.prepare("SELECT * FROM users WHERE google_id = ?").get(googleId);
          if (user) {
            db.prepare("UPDATE users SET google_email = ?, avatar_url = ? WHERE id = ?")
              .run(email, avatar, user.id);
            return done(null, getUser(user.id));
          }

          /*
           * The Google email matches an existing account: connect them.
           */
          if (email) {
            user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
            if (user) {
              db.prepare("UPDATE users SET google_id = ?, google_email = ?, avatar_url = ? WHERE id = ?")
                .run(googleId, email, avatar, user.id);
              return done(null, getUser(user.id));
            }
          }

          /*
           * Create a new account.
           */
          let base = (profile.displayName || "math-user")
            .replace(/[^a-zA-Z0-9_]/g, "")
            .slice(0, 24) || "math_user";
          let username = base;
          let number = 1;
          while (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
            username = `${base}${number++}`;
          }

          const result = db
            .prepare("INSERT INTO users (username, email, google_id, google_email, avatar_url) VALUES (?, ?, ?, ?, ?)")
            .run(username, email, googleId, email, avatar);

          return done(null, getUser(result.lastInsertRowid));
        } catch (error) {
          return done(error);
        }
      }
    )
  );
}

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function parseProfile(user) {
  try {
    return user.profile ? JSON.parse(user.profile) : null;
  } catch {
    return null;
  }
}

const isAdmin = user => ADMIN_USERNAMES.includes(user.username.toLowerCase());

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || user.google_email || "",
    avatar_url: user.avatar_url || null,
    googleLinked: Boolean(user.google_id),
    isAdmin: isAdmin(user),
    profile: parseProfile(user),
    buddyOptIn: Boolean(user.buddy_opt_in),
    buddyIntro: user.buddy_intro || ""
  };
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "You must be logged in." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !isAdmin(req.user)) {
    return res.status(403).json({ error: "Only site admins can do that." });
  }
  next();
}

/*
 * Trim text and cap its length. Returns "" for missing values.
 */
const cleanText = (value, max) => String(value ?? "").trim().slice(0, max);

/*
 * Keep only allowed ids from a list the browser sent.
 */
const pickIds = (value, allowed) =>
  [...new Set(Array.isArray(value) ? value : [])].filter(v => allowed.includes(v));

/*
 * Very small in-memory rate limiter so one account cannot flood the site.
 */
const hits = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.user?.id || req.ip}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: "You're doing that too fast. Try again in a minute." });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}
const postLimit = rateLimit("post", 8, 60 * 1000);

/*
 * Things people can like, report, or (for admins) hide.
 */
const TARGETS = {
  qow_response: "qow_responses",
  question: "advice_questions",
  reply: "advice_replies"
};

const likeCount = type =>
  `(SELECT COUNT(*) FROM likes l WHERE l.target_type = '${type}' AND l.target_id = t.id)`;
const likedByMe = type =>
  `EXISTS (SELECT 1 FROM likes l WHERE l.target_type = '${type}' AND l.target_id = t.id AND l.user_id = @me)`;

/*
|--------------------------------------------------------------------------
| CONFIG + CURRENT USER
|--------------------------------------------------------------------------
*/

app.get("/api/config", (req, res) => {
  res.json({
    googleConfigured,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY)
  });
});

app.get("/api/me", (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

app.patch("/api/me", requireAuth, (req, res) => {
  const username = cleanText(req.body.username, 40);
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
    return res.status(400).json({
      error: "Username must be 3-32 characters using letters, numbers, or underscores."
    });
  }
  const taken = db
    .prepare("SELECT id FROM users WHERE username = ? AND id != ?")
    .get(username, req.user.id);
  if (taken) {
    return res.status(409).json({ error: "That username is already taken." });
  }
  db.prepare("UPDATE users SET username = ? WHERE id = ?").run(username, req.user.id);
  res.json({ user: publicUser(getUser(req.user.id)) });
});

/*
 * The short "customize your journey" form on the dashboard.
 */
app.put("/api/me/profile", requireAuth, (req, res) => {
  const grade = String(req.body.grade || "");
  if (!GRADE_IDS.includes(grade)) {
    return res.status(400).json({ error: "Please choose your grade." });
  }

  const hobbies = [
    ...new Set(
      (Array.isArray(req.body.hobbies) ? req.body.hobbies : [])
        .map(h => cleanText(h, 30).toLowerCase())
        .filter(Boolean)
    )
  ].slice(0, 8);

  const profile = {
    grade,
    country: cleanText(req.body.country, 40),
    region: cleanText(req.body.region, 40),
    competitions: pickIds(req.body.competitions, COMPETITION_IDS),
    topics: pickIds(req.body.topics, TOPIC_IDS),
    goal: GOAL_IDS.includes(req.body.goal) ? req.body.goal : "fun",
    hobbies
  };

  db.prepare("UPDATE users SET profile = ? WHERE id = ?")
    .run(JSON.stringify(profile), req.user.id);
  res.json({ user: publicUser(getUser(req.user.id)) });
});

/*
|--------------------------------------------------------------------------
| REGISTER / LOGIN / LOGOUT
|--------------------------------------------------------------------------
*/

app.post("/api/auth/register", rateLimit("register", 30, 60 * 60 * 1000), async (req, res) => {
  try {
    const username = cleanText(req.body.username, 40);
    const email = cleanText(req.body.email, 200).toLowerCase();
    const password = String(req.body.password || "");

    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      return res.status(400).json({
        error: "Username must be 3-32 characters using letters, numbers, or underscores."
      });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
      return res.status(409).json({ error: "That username is already taken." });
    }
    if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
      return res.status(409).json({ error: "That email is already registered." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = db
      .prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)")
      .run(username, email, passwordHash);
    const user = getUser(result.lastInsertRowid);

    req.login(user, error => {
      if (error) {
        return res.status(500).json({ error: "Account created, but the session could not be started." });
      }
      res.json({ user: publicUser(user) });
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/auth/login", rateLimit("login", 10, 15 * 60 * 1000), async (req, res) => {
  try {
    const username = cleanText(req.body.username, 40);
    const password = String(req.body.password || "");
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);

    /*
     * Do not reveal whether the username exists.
     */
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }

    req.login(user, error => {
      if (error) {
        return res.status(500).json({ error: "Could not start your session." });
      }
      res.json({ user: publicUser(user) });
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not log in." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.logout(error => {
    if (error) {
      return res.status(500).json({ error: "Could not log out." });
    }
    req.session.destroy(() => res.json({ ok: true }));
  });
});

/*
|--------------------------------------------------------------------------
| GOOGLE ROUTES
|--------------------------------------------------------------------------
*/

if (googleConfigured) {
  app.get(
    "/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"], prompt: "select_account" })
  );

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/?google=failed" }),
    (req, res) => res.redirect("/")
  );
} else {
  app.get("/auth/google", (_, res) => {
    res.status(503).send("Google OAuth is not configured on this server yet.");
  });
}

/*
|--------------------------------------------------------------------------
| CONTEST LOGS (private to each user)
|--------------------------------------------------------------------------
*/

app.get("/api/contest-logs", requireAuth, (req, res) => {
  const logs = db
    .prepare(`
      SELECT id, title, date, mode, correct, incorrect, unanswered, reflections
      FROM contest_logs WHERE user_id = ? ORDER BY created_at DESC, id DESC
    `)
    .all(req.user.id)
    .map(log => ({ ...log, reflections: JSON.parse(log.reflections || "{}") }));
  res.json({ logs });
});

app.post("/api/contest-logs", requireAuth, postLimit, (req, res) => {
  const title = cleanText(req.body.title, 100);
  const date = cleanText(req.body.date, 20) || new Date().toISOString().slice(0, 10);
  const count = value => {
    const n = Number(value);
    return value === "" || value == null || !Number.isInteger(n) || n < 0 || n > 1000 ? null : n;
  };
  const reflections = {};
  for (const key of ["went", "proud", "better", "learned"]) {
    reflections[key] = cleanText(req.body.reflections?.[key], 2000);
  }

  if (!title) {
    return res.status(400).json({ error: "Please choose a contest." });
  }

  /*
   * user_id comes from the logged-in session, NOT the browser.
   */
  db.prepare(`
    INSERT INTO contest_logs (user_id, title, date, mode, correct, incorrect, unanswered, reflections)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    title,
    date,
    req.body.mode === "Real" ? "Real" : "Mock",
    count(req.body.correct),
    count(req.body.incorrect),
    count(req.body.unanswered),
    JSON.stringify(reflections)
  );
  res.json({ ok: true });
});

/*
|--------------------------------------------------------------------------
| COMMUNITY: QUESTION OF THE WEEK
|--------------------------------------------------------------------------
*/

app.get("/api/community/qow", (req, res) => {
  const all = db.prepare("SELECT id, text, created_at FROM qow ORDER BY id DESC").all();
  res.json({ current: all[0] || null, past: all.slice(1) });
});

app.get("/api/community/qow/:id/responses", (req, res) => {
  const qow = db.prepare("SELECT id, text, created_at FROM qow WHERE id = ?").get(Number(req.params.id));
  if (!qow) return res.status(404).json({ error: "Question not found." });

  const responses = db
    .prepare(`
      SELECT t.id, u.username AS author, t.text, t.created_at,
        ${likeCount("qow_response")} AS likes,
        ${likedByMe("qow_response")} AS liked
      FROM qow_responses t JOIN users u ON u.id = t.user_id
      WHERE t.qow_id = @qow AND t.hidden = 0
      ORDER BY t.created_at DESC, t.id DESC
    `)
    .all({ qow: qow.id, me: req.user?.id || 0 });
  res.json({ qow, responses });
});

app.post("/api/community/qow/:id/responses", requireAuth, postLimit, (req, res) => {
  const current = db.prepare("SELECT id FROM qow ORDER BY id DESC LIMIT 1").get();
  if (!current || current.id !== Number(req.params.id)) {
    return res.status(400).json({ error: "You can only respond to this week's question." });
  }
  const text = cleanText(req.body.text, 3000);
  if (!text) return res.status(400).json({ error: "Please write a response first." });

  db.prepare("INSERT INTO qow_responses (qow_id, user_id, text) VALUES (?, ?, ?)")
    .run(current.id, req.user.id, text);
  res.json({ ok: true });
});

app.post("/api/community/suggestions", requireAuth, postLimit, (req, res) => {
  const text = cleanText(req.body.text, 500);
  if (!text) return res.status(400).json({ error: "Please write a question first." });
  db.prepare("INSERT INTO qow_suggestions (user_id, text) VALUES (?, ?)").run(req.user.id, text);
  res.json({ ok: true });
});

/*
|--------------------------------------------------------------------------
| COMMUNITY: ADVICE QUESTIONS + REPLIES
|--------------------------------------------------------------------------
*/

app.get("/api/community/questions", (req, res) => {
  const search = cleanText(req.query.q, 100);
  const questions = db
    .prepare(`
      SELECT t.id, t.title, u.username AS author, t.created_at,
        (SELECT COUNT(*) FROM advice_replies r WHERE r.question_id = t.id AND r.hidden = 0) AS replies,
        ${likeCount("question")} AS likes
      FROM advice_questions t JOIN users u ON u.id = t.user_id
      WHERE t.hidden = 0 AND (@q = '' OR t.title LIKE @like OR t.body LIKE @like)
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 100
    `)
    .all({ q: search, like: `%${search}%` });
  res.json({ questions });
});

app.post("/api/community/questions", requireAuth, postLimit, (req, res) => {
  const title = cleanText(req.body.title, 200);
  const body = cleanText(req.body.body, 3000);
  if (!title) return res.status(400).json({ error: "Please write your question." });

  const result = db
    .prepare("INSERT INTO advice_questions (user_id, title, body) VALUES (?, ?, ?)")
    .run(req.user.id, title, body);
  res.json({ id: result.lastInsertRowid });
});

app.get("/api/community/questions/:id", (req, res) => {
  const me = req.user?.id || 0;
  const question = db
    .prepare(`
      SELECT t.id, t.title, t.body, u.username AS author, t.created_at,
        ${likeCount("question")} AS likes, ${likedByMe("question")} AS liked
      FROM advice_questions t JOIN users u ON u.id = t.user_id
      WHERE t.id = @id AND t.hidden = 0
    `)
    .get({ id: Number(req.params.id), me });
  if (!question) return res.status(404).json({ error: "Question not found." });

  const replies = db
    .prepare(`
      SELECT t.id, u.username AS author, t.text, t.created_at,
        ${likeCount("reply")} AS likes, ${likedByMe("reply")} AS liked
      FROM advice_replies t JOIN users u ON u.id = t.user_id
      WHERE t.question_id = @id AND t.hidden = 0
      ORDER BY t.created_at ASC, t.id ASC
    `)
    .all({ id: question.id, me });
  res.json({ question, replies });
});

app.post("/api/community/questions/:id/replies", requireAuth, postLimit, (req, res) => {
  const question = db
    .prepare("SELECT id FROM advice_questions WHERE id = ? AND hidden = 0")
    .get(Number(req.params.id));
  if (!question) return res.status(404).json({ error: "Question not found." });

  const text = cleanText(req.body.text, 3000);
  if (!text) return res.status(400).json({ error: "Please write a reply first." });

  db.prepare("INSERT INTO advice_replies (question_id, user_id, text) VALUES (?, ?, ?)")
    .run(question.id, req.user.id, text);
  res.json({ ok: true });
});

/*
|--------------------------------------------------------------------------
| LIKES + REPORTS
|--------------------------------------------------------------------------
*/

function findTarget(type, id) {
  const table = TARGETS[type];
  if (!table) return null;
  return db.prepare(`SELECT id FROM ${table} WHERE id = ? AND hidden = 0`).get(Number(id));
}

app.post("/api/likes", requireAuth, (req, res) => {
  const { type, id } = req.body;
  if (!findTarget(type, id)) return res.status(404).json({ error: "Post not found." });

  const key = [req.user.id, type, Number(id)];
  const removed = db
    .prepare("DELETE FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?")
    .run(...key).changes;
  if (!removed) {
    db.prepare("INSERT INTO likes (user_id, target_type, target_id) VALUES (?, ?, ?)").run(...key);
  }
  res.json({ liked: !removed });
});

app.post("/api/reports", requireAuth, postLimit, (req, res) => {
  const { type, id } = req.body;
  const reason = cleanText(req.body.reason, 500);
  if (type !== "user" && !findTarget(type, id)) {
    return res.status(404).json({ error: "Post not found." });
  }
  if (type === "user" && !getUser(Number(id))) {
    return res.status(404).json({ error: "User not found." });
  }
  if (!reason) return res.status(400).json({ error: "Please say why you're reporting this." });

  db.prepare("INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)")
    .run(req.user.id, type, Number(id), reason);
  res.json({ ok: true });
});

/*
|--------------------------------------------------------------------------
| ADMIN: MODERATION + QUESTION OF THE WEEK
|--------------------------------------------------------------------------
*/

function reportedContent(type, id) {
  if (type === "user") {
    const user = getUser(id);
    return user ? `User @${user.username}: "${user.buddy_intro}"` : "(deleted user)";
  }
  const table = TARGETS[type];
  if (!table) return "(unknown)";
  const column = type === "question" ? "title || ' ' || body" : "text";
  const row = db
    .prepare(`SELECT ${column} AS text, u.username AS author, hidden FROM ${table} t JOIN users u ON u.id = t.user_id WHERE t.id = ?`)
    .get(id);
  return row ? `@${row.author}: "${row.text}"${row.hidden ? " (hidden)" : ""}` : "(deleted)";
}

app.get("/api/admin/overview", requireAdmin, (req, res) => {
  const suggestions = db
    .prepare(`
      SELECT s.id, s.text, u.username AS author, s.created_at
      FROM qow_suggestions s JOIN users u ON u.id = s.user_id
      WHERE s.used = 0 ORDER BY s.id DESC LIMIT 50
    `)
    .all();
  const reports = db
    .prepare(`
      SELECT r.id, r.target_type, r.target_id, r.reason, r.created_at, u.username AS reporter
      FROM reports r JOIN users u ON u.id = r.reporter_id
      WHERE r.resolved = 0 ORDER BY r.id DESC LIMIT 100
    `)
    .all()
    .map(r => ({ ...r, content: reportedContent(r.target_type, r.target_id) }));
  res.json({ suggestions, reports });
});

app.post("/api/admin/qow", requireAdmin, (req, res) => {
  const text = cleanText(req.body.text, 500);
  if (!text) return res.status(400).json({ error: "Please write the new question." });
  db.prepare("INSERT INTO qow (text) VALUES (?)").run(text);
  if (req.body.suggestionId) {
    db.prepare("UPDATE qow_suggestions SET used = 1 WHERE id = ?").run(Number(req.body.suggestionId));
  }
  res.json({ ok: true });
});

app.post("/api/admin/hide", requireAdmin, (req, res) => {
  const { type, id } = req.body;
  const table = TARGETS[type];
  if (type === "user") {
    db.prepare("UPDATE users SET buddy_opt_in = 0 WHERE id = ?").run(Number(id));
  } else if (table) {
    db.prepare(`UPDATE ${table} SET hidden = 1 WHERE id = ?`).run(Number(id));
  } else {
    return res.status(400).json({ error: "Unknown post type." });
  }
  db.prepare("UPDATE reports SET resolved = 1 WHERE target_type = ? AND target_id = ?")
    .run(type, Number(id));
  res.json({ ok: true });
});

app.post("/api/admin/reports/:id/resolve", requireAdmin, (req, res) => {
  db.prepare("UPDATE reports SET resolved = 1 WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

/*
|--------------------------------------------------------------------------
| STUDY BUDDIES (dating-app-style matching)
|--------------------------------------------------------------------------
|
| People opt in, then see one suggested buddy at a time, ranked by a
| compatibility score. Each person picks "Connect" or "Pass". When both
| people pick "Connect", it's a match and they appear in each other's
| match list.
|
| Safety rules:
|   - You only ever see people in the same school level (grade group).
|   - Only country and state/region are shown, never a city or address.
|   - Passing, blocking, or being blocked removes someone for good.
|
*/

const norm = value => String(value || "").trim().toLowerCase();

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const item of setA) if (setB.has(item)) shared++;
  return shared / (setA.size + setB.size - shared);
}

const sharedItems = (a, b) => a.filter(item => b.includes(item));

/*
 * Score from 0 to 100: location 30, competitions 40, hobbies 25, topics 5.
 */
function matchScore(me, them) {
  const reasons = [];
  let score = 0;

  const sameCountry = me.country && norm(me.country) === norm(them.country);
  const sameRegion = sameCountry && me.region && norm(me.region) === norm(them.region);
  if (sameRegion) {
    score += 30;
    reasons.push(`Both in ${them.region}`);
  } else if (sameCountry) {
    score += 15;
    reasons.push(`Both in ${them.country}`);
  }

  const competitions = sharedItems(me.competitions, them.competitions);
  score += 40 * jaccard(me.competitions, them.competitions);
  if (competitions.length) {
    reasons.push(`Both doing ${competitions.map(competitionName).join(", ")}`);
  }

  const hobbies = sharedItems(me.hobbies, them.hobbies);
  score += 25 * jaccard(me.hobbies, them.hobbies);
  if (hobbies.length) {
    reasons.push(`Both like ${hobbies.join(", ")}`);
  }

  const topics = sharedItems(me.topics, them.topics);
  score += 5 * jaccard(me.topics, them.topics);
  if (topics.length) {
    const labels = topics.map(id => CATALOG.topics.find(t => t.id === id)?.label || id);
    reasons.push(`Both working on ${labels.join(", ")}`);
  }

  return { score: Math.round(score), reasons };
}

function buddyCard(user, me) {
  const profile = parseProfile(user);
  return {
    id: user.id,
    username: user.username,
    country: profile.country,
    region: profile.region,
    competitions: profile.competitions.map(competitionName),
    hobbies: profile.hobbies,
    intro: user.buddy_intro,
    ...matchScore(me, profile)
  };
}

/*
 * Everyone opted in, in the same grade group, and not blocked either way.
 */
function eligibleBuddies(meUser) {
  const me = parseProfile(meUser);
  if (!me || !meUser.buddy_opt_in) return [];
  return db
    .prepare(`
      SELECT * FROM users u
      WHERE u.id != @me AND u.buddy_opt_in = 1 AND u.profile IS NOT NULL
        AND json_extract(u.profile, '$.grade') = @grade
        AND NOT EXISTS (
          SELECT 1 FROM buddy_blocks b
          WHERE (b.blocker_id = @me AND b.blocked_id = u.id)
             OR (b.blocker_id = u.id AND b.blocked_id = @me)
        )
    `)
    .all({ me: meUser.id, grade: me.grade });
}

app.put("/api/buddy/settings", requireAuth, (req, res) => {
  if (req.body.optIn && !parseProfile(req.user)) {
    return res.status(400).json({ error: "Fill out the short form on your dashboard first." });
  }
  db.prepare("UPDATE users SET buddy_opt_in = ?, buddy_intro = ? WHERE id = ?")
    .run(req.body.optIn ? 1 : 0, cleanText(req.body.intro, 300), req.user.id);
  res.json({ user: publicUser(getUser(req.user.id)) });
});

app.get("/api/buddy/candidates", requireAuth, (req, res) => {
  const me = parseProfile(req.user);
  const swipes = db.prepare("SELECT from_id, to_id, liked FROM buddy_swipes WHERE from_id = ? OR to_id = ?")
    .all(req.user.id, req.user.id);
  const iSwiped = new Set(swipes.filter(s => s.from_id === req.user.id).map(s => s.to_id));
  const theyPassed = new Set(swipes.filter(s => s.to_id === req.user.id && !s.liked).map(s => s.from_id));

  const candidates = eligibleBuddies(req.user)
    .filter(u => !iSwiped.has(u.id) && !theyPassed.has(u.id))
    .map(u => buddyCard(u, me))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  res.json({ candidates });
});

app.post("/api/buddy/swipe", requireAuth, (req, res) => {
  const targetId = Number(req.body.targetId);
  const target = eligibleBuddies(req.user).find(u => u.id === targetId);
  if (!target) return res.status(404).json({ error: "That person isn't available." });

  const liked = req.body.liked ? 1 : 0;
  db.prepare("INSERT OR REPLACE INTO buddy_swipes (from_id, to_id, liked) VALUES (?, ?, ?)")
    .run(req.user.id, targetId, liked);

  const matched = Boolean(
    liked &&
      db.prepare("SELECT 1 FROM buddy_swipes WHERE from_id = ? AND to_id = ? AND liked = 1")
        .get(targetId, req.user.id)
  );
  res.json({ matched });
});

app.get("/api/buddy/matches", requireAuth, (req, res) => {
  const me = parseProfile(req.user);
  const mutual = new Set(
    db.prepare(`
      SELECT a.to_id AS id FROM buddy_swipes a
      JOIN buddy_swipes b ON b.from_id = a.to_id AND b.to_id = a.from_id
      WHERE a.from_id = ? AND a.liked = 1 AND b.liked = 1
    `).all(req.user.id).map(row => row.id)
  );
  const matches = eligibleBuddies(req.user)
    .filter(u => mutual.has(u.id))
    .map(u => buddyCard(u, me))
    .sort((a, b) => b.score - a.score);
  res.json({ matches });
});

app.post("/api/buddy/block", requireAuth, (req, res) => {
  const targetId = Number(req.body.targetId);
  if (!getUser(targetId) || targetId === req.user.id) {
    return res.status(404).json({ error: "User not found." });
  }
  db.prepare("INSERT OR IGNORE INTO buddy_blocks (blocker_id, blocked_id) VALUES (?, ?)")
    .run(req.user.id, targetId);
  res.json({ ok: true });
});

/*
|--------------------------------------------------------------------------
| AI
|--------------------------------------------------------------------------
|
| The API key stays on the SERVER. The browser calls /api/ai/chat and the
| server calls OpenAI.
|
*/

app.post("/api/ai/chat", requireAuth, rateLimit("ai", 15, 60 * 1000), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: "The AI tutor isn't set up on this site yet."
    });
  }

  const message = cleanText(req.body.message, 4000);
  if (!message) {
    return res.status(400).json({ error: "Please type a question." });
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    /*
     * Keep only the recent conversation.
     */
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-10) : [];

    const input = [
      {
        role: "developer",
        content:
          "You are the math competition assistant for this website. Help students learn competition mathematics. Prefer explanations and hints over simply giving an answer. Be encouraging, concise, and age-appropriate."
      },
      ...history.map(item => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: cleanText(item.text, 4000)
      })),
      { role: "user", content: message }
    ];

    const response = await client.responses.create({ model: AI_MODEL, input });
    res.json({ reply: response.output_text || "I wasn't able to generate a response." });
  } catch (error) {
    console.error("AI ERROR:", error);
    res.status(502).json({ error: "The AI service returned an error." });
  }
});

/*
|--------------------------------------------------------------------------
| FRONTEND
|--------------------------------------------------------------------------
*/

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

app.use(express.static(path.join(__dirname, "public")));

/*
 * If someone visits another URL, send them the main application.
 */
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {
  console.log(`Math Competition Hub running at http://localhost:${PORT}`);
  if (!googleConfigured) console.log("Google OAuth is not configured yet.");
  if (!process.env.OPENAI_API_KEY) console.log("OpenAI API is not configured yet.");
  if (!ADMIN_USERNAMES.length) console.log("No ADMIN_USERNAMES set; nobody can moderate.");
});
