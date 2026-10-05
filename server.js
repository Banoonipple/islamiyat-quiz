// Lorecraft server: serves the app, handles Google sign-in, stores progress in Postgres, serves leaderboards.
"use strict";
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const { OAuth2Client } = require("google-auth-library");

const PORT = Number(process.env.PORT) || 8080;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_DAYS = 30;
const COOKIE = "lc_session";

if (!DATABASE_URL) { console.error("DATABASE_URL is not set. Add a Postgres database and reference its DATABASE_URL."); process.exit(1); }
if (!GOOGLE_CLIENT_ID) console.warn("GOOGLE_CLIENT_ID is not set: Google sign-in is disabled until you add it.");

// Railway's private network (*.railway.internal) does not use SSL; public Postgres URLs do.
const useSsl = !/localhost|127\.0\.0\.1|\.railway\.internal/.test(DATABASE_URL) && process.env.PGSSL !== "disable";
const pool = new Pool({ connectionString: DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : false, max: 10 });
const google = new OAuth2Client(GOOGLE_CLIENT_ID);

// Must match the achievement ids in public/index.html
const ACHIEVEMENT_IDS = new Set(["first_steps", "card_shark", "memory_master", "test_taker", "perfect_score", "on_fire", "scholar", "expert", "master", "week_warrior", "monthly_grind", "comeback", "speed_demon"]);
const threshold = n => 25 * (n - 1) * (n + 2);
const levelOf = xp => { let n = 1; while (threshold(n + 1) <= xp) n++; return n; };

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_sub TEXT UNIQUE NOT NULL,
      email TEXT,
      display_name TEXT NOT NULL,
      show_on_leaderboard BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state JSONB NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      achievements INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS progress_xp_idx ON progress (xp DESC);
    CREATE INDEX IF NOT EXISTS progress_ach_idx ON progress (achievements DESC, xp DESC);
    DELETE FROM sessions WHERE expires_at < now();
  `);
}

// ---------- helpers ----------
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()); }
  return null;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${token ? encodeURIComponent(token) : ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}
const publicUser = u => ({ id: u.id, displayName: u.display_name, showOnLeaderboard: u.show_on_leaderboard, email: u.email, createdAt: u.created_at });
const cleanName = s => String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function currentUser(req) {
  const token = readCookie(req, COOKIE); if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha(token)]);
  return rows[0] || null;
}
const requireUser = wrap(async (req, res, next) => {
  const u = await currentUser(req); if (!u) return res.status(401).json({ error: "Sign in first." });
  req.user = u; next();
});

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin"); next(); });
app.use(express.json({ limit: "3mb" }));
// Cookie-authenticated writes must be JSON (blocks cross-site form posts)
app.use("/api", (req, res, next) => { if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !req.is("application/json")) return res.status(415).json({ error: "Send JSON." }); next(); });

app.get("/api/config", (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID || null }));
app.get("/api/health", wrap(async (req, res) => { await pool.query("SELECT 1"); res.json({ ok: true }); }));

app.post("/api/auth/google", wrap(async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: "Google sign-in isn't configured on this server." });
  const credential = req.body && req.body.credential;
  if (typeof credential !== "string") return res.status(400).json({ error: "Missing Google credential." });
  let payload;
  try { payload = (await google.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID })).getPayload(); }
  catch (e) { return res.status(401).json({ error: "Google sign-in could not be verified. Try again." }); }
  if (!payload || !payload.sub) return res.status(401).json({ error: "Google sign-in could not be verified." });
  const name = cleanName(payload.given_name || payload.name || "Scholar") || "Scholar";
  const { rows } = await pool.query(
    `INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3)
     ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, last_login_at = now()
     RETURNING *`, [payload.sub, payload.email || null, name]);
  const user = rows[0];
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`, [sha(token), user.id, String(SESSION_DAYS)]);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  res.json({ user: publicUser(user) });
}));

app.post("/api/auth/logout", wrap(async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha(token)]);
  setSessionCookie(req, res, null, 0);
  res.json({ ok: true });
}));

app.get("/api/me", wrap(async (req, res) => {
  const u = await currentUser(req); if (!u) return res.status(401).json({ error: "Not signed in." });
  res.json({ user: publicUser(u) });
}));

app.patch("/api/me", requireUser, wrap(async (req, res) => {
  const b = req.body || {}; const sets = []; const vals = [];
  if (b.displayName !== undefined) { const n = cleanName(b.displayName); if (n.length < 2) return res.status(400).json({ error: "Display name must be 2–24 characters." }); vals.push(n); sets.push(`display_name = $${vals.length}`); }
  if (b.showOnLeaderboard !== undefined) { vals.push(!!b.showOnLeaderboard); sets.push(`show_on_leaderboard = $${vals.length}`); }
  if (!sets.length) return res.json({ user: publicUser(req.user) });
  vals.push(req.user.id);
  const { rows } = await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
  res.json({ user: publicUser(rows[0]) });
}));

app.delete("/api/me", requireUser, wrap(async (req, res) => {
  await pool.query(`DELETE FROM users WHERE id = $1`, [req.user.id]); // cascades to sessions + progress
  setSessionCookie(req, res, null, 0);
  res.json({ ok: true });
}));

app.get("/api/progress", requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT state, updated_at FROM progress WHERE user_id = $1`, [req.user.id]);
  res.json(rows[0] ? { state: rows[0].state, updatedAt: rows[0].updated_at } : { state: null });
}));

app.put("/api/progress", requireUser, wrap(async (req, res) => {
  const state = req.body && req.body.state;
  if (!state || typeof state !== "object" || Array.isArray(state) || !state.profile || typeof state.profile !== "object") return res.status(400).json({ error: "Invalid progress data." });
  const xp = Math.max(0, Math.min(10_000_000, Math.floor(Number(state.profile.xp) || 0)));
  const achievements = Object.keys(state.achievements && typeof state.achievements === "object" ? state.achievements : {}).filter(k => ACHIEVEMENT_IDS.has(k)).length;
  await pool.query(
    `INSERT INTO progress (user_id, state, xp, level, achievements, updated_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, xp = EXCLUDED.xp, level = EXCLUDED.level, achievements = EXCLUDED.achievements, updated_at = now()`,
    [req.user.id, state, xp, levelOf(xp), achievements]);
  res.json({ ok: true, xp, level: levelOf(xp), achievements });
}));

app.get("/api/leaderboard", wrap(async (req, res) => {
  const type = req.query.type === "achievements" ? "achievements" : "level";
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  const order = type === "achievements" ? "p.achievements DESC, p.xp DESC, p.updated_at ASC" : "p.xp DESC, p.updated_at ASC";
  const { rows } = await pool.query(
    `SELECT u.id, u.display_name, p.xp, p.level, p.achievements FROM progress p JOIN users u ON u.id = p.user_id
     WHERE u.show_on_leaderboard ORDER BY ${order} LIMIT $1`, [limit]);
  const me = await currentUser(req);
  let mine = null;
  if (me) {
    const r = await pool.query(`SELECT xp, level, achievements FROM progress WHERE user_id = $1`, [me.id]);
    if (r.rows[0]) {
      const p = r.rows[0];
      const ahead = type === "achievements"
        ? await pool.query(`SELECT COUNT(*)::int AS n FROM progress p JOIN users u ON u.id = p.user_id WHERE u.show_on_leaderboard AND u.id <> $1 AND (p.achievements > $2 OR (p.achievements = $2 AND p.xp > $3))`, [me.id, p.achievements, p.xp])
        : await pool.query(`SELECT COUNT(*)::int AS n FROM progress p JOIN users u ON u.id = p.user_id WHERE u.show_on_leaderboard AND u.id <> $1 AND p.xp > $2`, [me.id, p.xp]);
      mine = { rank: ahead.rows[0].n + 1, xp: p.xp, level: p.level, achievements: p.achievements, hidden: !me.show_on_leaderboard, displayName: me.display_name };
    }
  }
  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM progress p JOIN users u ON u.id = p.user_id WHERE u.show_on_leaderboard`)).rows[0].n;
  res.json({ type, total, me: mine, totalAchievements: ACHIEVEMENT_IDS.size,
    rows: rows.map((r, i) => ({ rank: i + 1, id: r.id, displayName: r.display_name, xp: r.xp, level: r.level, achievements: r.achievements, isMe: !!me && me.id === r.id })) });
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: "5m" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Something went wrong on the server." }); });

migrate()
  .then(() => app.listen(PORT, () => console.log(`Lorecraft listening on ${PORT}`)))
  .catch(err => { console.error("Database setup failed:", err); process.exit(1); });
