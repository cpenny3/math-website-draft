# math-website-draft
a test version of a math training website, focused on supporting the community and embracing growth

## What's here

- `public/index.html`: the website (Dashboard, Log Contests, Community, Study Buddies, About us, Settings)
- `public/catalog.json`: the list of competitions, topics, grades and goals used by the forms and suggestions
- `server.js`: the server that stores accounts, posts, contest logs and Study Buddy matches in a SQLite database
- `index.html`: a small page for GitHub Pages that forwards visitors to the hosted site

GitHub Pages can only show files, so posting and logging in need `server.js` running on a host.

## Run it on your computer

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Put it online (Render)

1. Sign in to https://render.com with GitHub and choose **New > Web Service**, then pick this repo.
2. Build command: `npm install`. Start command: `npm start`.
3. Add a **Disk** (Settings > Disks) mounted at `/var/data`. Without a disk, every post is erased when the site restarts. (Disks need a paid instance.)
4. Under **Environment**, add the variables from `.env.example`. At minimum set `NODE_ENV=production`, `SESSION_SECRET` (any long random string), `DATA_DIR=/var/data` and `ADMIN_USERNAMES` (your usernames on the site).
5. After it deploys, copy the site address (like `https://math-website.onrender.com`) into `SITE_URL` in the root `index.html` so the GitHub Pages link forwards there.

Railway and Fly.io work too. Just make sure the database folder (`DATA_DIR`) is on a persistent volume.

## Moderating

People listed in `ADMIN_USERNAMES` see an admin section at the bottom of **Settings**. There they can:

- post a new Question of the Week or pick one from community suggestions
- review reports, hide posts, and remove someone from Study Buddies

## Study Buddies safety

- People only see others in the same school level (grade group).
- Only username, country and state/region are shown. Email, city and school are never shown.
- There is no private messaging. Matches can say hi by replying to each other's public Community posts.
- Anyone can block or report a profile. Reporting someone also blocks them for you.
