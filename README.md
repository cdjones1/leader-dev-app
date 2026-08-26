# Leadership Development Tracker — Step 1

This is the starting point of the app: the database tables (users, pairings,
plans, modules) and login. Nothing else works yet — that's intentional, we're
building in the order we planned.

## What you need installed on your computer first

1. **Node.js** — download from https://nodejs.org (choose the "LTS" version).
   This lets your computer run the JavaScript code.
2. **A Postgres database.** You don't need to install Postgres yourself —
   the easiest path is a free hosted one:
   - https://neon.tech or https://supabase.com or https://railway.app
   - Sign up, create a new project/database, and it will give you a
     "connection string" that looks like:
     `postgresql://username:password@host:5432/dbname`
   - Copy that — you'll need it in step 3 below.

## Setup steps

**1. Open a terminal in this folder.**
(On Mac: the Terminal app. On Windows: PowerShell or Command Prompt.)
Navigate into this folder, e.g. `cd path/to/leadership-dev-app`.

**2. Install the project's dependencies:**
```
npm install
```
This downloads all the tools listed in `package.json` (the web server,
database tool, encryption library, etc.) into a folder called
`node_modules`. This can take a minute.

**3. Set up your environment file:**
```
cp .env.example .env
```
Then open `.env` in any text editor and:
- Paste your real database connection string into `DATABASE_URL`
- Replace `JWT_SECRET` with any long random string (this secures login tokens)

**4. Create the actual database tables:**
```
npm run migrate
```
This reads `prisma/schema.prisma` (the file describing all our tables) and
creates them for real in your database. It will ask you to name this
migration — you can type something like `init` and press enter.

**5. Start the app:**
```
npm run dev
```
If everything worked, you'll see:
```
Server running on http://localhost:3000
```

## Trying it out

You can't click around in a browser yet since there's no visual interface —
step 1 is just the "engine," not the dashboard. But you can test that it
works using a tool like [Postman](https://www.postman.com/downloads/) (free,
has a simple point-and-click interface) or `curl` in your terminal.

**Create a user:**
```
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Jane Admin","email":"jane@example.com","password":"testpass123","role":"DIRECTOR","isAdmin":true}'
```

**Log in:**
```
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"jane@example.com","password":"testpass123"}'
```
This returns a `token` — copy it.

**Use the token to view pairings (currently empty, but proves login works):**
```
curl http://localhost:3000/pairings \
  -H "Authorization: Bearer PASTE_YOUR_TOKEN_HERE"
```

If that last command returns `[]` instead of an error, step 1 is fully working.

## A visual way to look at your database

Run:
```
npm run studio
```
This opens a browser window where you can see and edit your database tables
directly — useful for checking that registered users actually got saved.

## What's next

Once this is running, the next piece (per our build plan) is the module
auto-lock scheduler — the riskiest part of the system — built and tested on
its own before anything else depends on it.
