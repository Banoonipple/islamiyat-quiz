# Lorecraft

Study and exam platform (Mughals → British Raj) with Google sign-in, Postgres progress sync, Level and Achievements leaderboards, and Blitz mode.

```
lorecraft/
  server.js          Express server: Google sign-in, sessions, progress API, leaderboards
  package.json
  Dockerfile         What Railway builds
  public/index.html  The whole app (also works on its own as a single file, offline mode)
```

## Deploy on Railway

### 1. Put the code on GitHub
Create a repository and upload everything inside the `lorecraft` folder (`server.js`, `package.json`, `Dockerfile`, `.gitignore`, `README.md`, and the `public` folder).

### 2. Create the Railway project
1. railway.com → **New Project → Deploy from GitHub repo** → pick the repository.
2. In the project, click **+ Create → Database → PostgreSQL**.
3. Open the Lorecraft service → **Variables** → add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (a reference to the database)
   - `GOOGLE_CLIENT_ID` = your client ID from step 3
4. **Settings → Networking → Generate Domain**. Note the URL, e.g. `https://lorecraft-production.up.railway.app`.

Tables are created automatically when the server starts.

### 3. Create the Google sign-in client
1. console.cloud.google.com → create a project.
2. **APIs & Services → OAuth consent screen**: choose **External**, fill in the app name and your email, save. Publish the app (or add testers) so other people can sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application**.
4. Under **Authorized JavaScript origins** add your Railway URL (step 2.4), with no trailing slash.
   No redirect URI is needed.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) into Railway's `GOOGLE_CLIENT_ID` variable. The client secret is not used.

Railway redeploys after variable changes. Open your URL, click **Sign in**, and continue with Google.

## How it works
- Guests can use everything except leaderboards; progress stays in their browser.
- Signing in with Google creates the account. Progress then syncs to Postgres about 1.5 s after each change.
- On first sign-in, if the device already has progress, the version with more XP is kept.
- Signing out removes progress from the device; it stays in the account.
- Leaderboards show display name, level, XP and achievement count only. Users can rename themselves, hide from leaderboards, or delete their account in **Account**.
- Progress is calculated in the browser, so a determined user could edit their own XP. Fine for a class; add server-side checks before using it for anything with real stakes.

## Blitz XP tiers
| Answer time | XP |
|---|---|
| ≤ 0.75 s | 60 |
| 0.75–1.04 s | 55 |
| 1.04–1.45 s | 50 |
| 1.45–2.01 s | 45 |
| 2.01–2.79 s | 40 |
| 2.79–3.87 s | 35 |
| 3.87–5.38 s | 30 |
| 5.38–7.47 s | 25 |
| 7.47–10.37 s | 20 |
| 10.37–14.4 s | 15 |
| 14.4–20 s | 10 |
| 20 s + | 5 |

Wrong answers earn 0. The clock pauses while feedback is shown. A question already answered correctly in Blitz the same day earns 1/5 of its tier XP (the speed score still counts it in full).

## Environment variables
| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `GOOGLE_CLIENT_ID` | for sign-in | Google OAuth Web client ID |
| `PORT` | set by Railway | Port to listen on |
| `PGSSL` | no | Set to `disable` to turn off SSL for the database connection |
