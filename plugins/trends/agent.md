# Trends

Reference, no functions. How to find what is rising on TikTok and Instagram with a browser of your own where the user is signed in, and how to turn it into a short list of formats worth a game. Read it when the user asks for trends, ideas from TikTok or Reels, or what is popular now.

## Facts come from the page, not from here

TikTok and Instagram change their pages, data and limits all the time. Nothing below is a fixed recipe: the setup is stable, the sites are not. Work out selectors, URLs and field names from the page in front of you every run, and tell the user when something changed. Playwright's current docs: https://playwright.dev/docs/intro.

## Rules

- **Only this browser.** Use the separate Playwright browser described here, never the user's own Chrome, another browser tool or a browser of the app.
- **The user signs in, never you.** Open the sign-in page in that browser and ask the user to sign in there. Never type, ask for, read, print or copy passwords, cookies or tokens, and never copy the profile folder.
- **Read only.** No likes, follows, comments, messages, saves, posts or settings changes.
- **A person's pace.** Pauses of a few seconds between scrolls and pages, a couple of hundred posts per source at most, short runs. Stop when the site shows a check: switch to a visible window, ask the user to solve it, then carry on.
- **Public post data only.** Keep link, author handle, caption, hashtags, sound, counts and dates. No downloads of videos, except one the user picks for `clipgame.fetch` when that plugin is listed.

## Setup, once per computer

The browser lives in `~/.satura-trends/` (`%USERPROFILE%\.satura-trends\` on Windows): `tool/` holds Playwright and your scripts, `profile/` the signed-in browser profile. Playwright needs the Node.js version its package lists (`npm view playwright engines`).

```sh
mkdir -p ~/.satura-trends/tool ~/.satura-trends/profile
cd ~/.satura-trends/tool
npm init -y
npm install playwright@latest
npx playwright install chromium
```

If `~/.satura-trends/tool/node_modules/playwright` already exists, skip this. Run `npm install playwright@latest && npx playwright install chromium` there again when launching fails with a browser or version error.

Write every script into `~/.satura-trends/tool/` as `.mjs` and run it with `node` from there, so it finds Playwright. One script at a time: a profile opens in one browser only.

## Sign in

Tell the user first: a separate browser window will open on the sign-in page, they sign in there (TikTok's QR code from the phone app is quickest), and the window closes by itself once they are in.

```js
import { chromium } from 'playwright'
import { homedir } from 'node:os'
import { join } from 'node:path'

const site = process.argv[2] === 'instagram'
  ? { login: 'https://www.instagram.com/accounts/login/', origin: 'https://www.instagram.com' }
  : { login: 'https://www.tiktok.com/login', origin: 'https://www.tiktok.com' }
const ctx = await chromium.launchPersistentContext(join(homedir(), '.satura-trends', 'profile'), { headless: false, viewport: null })
const page = ctx.pages()[0] ?? await ctx.newPage()
await page.goto(site.login)
const deadline = Date.now() + 10 * 60_000
let signedIn = false
while (!signedIn && Date.now() < deadline) {
  await page.waitForTimeout(2000)
  signedIn = (await ctx.cookies(site.origin)).some((c) => c.name === 'sessionid' && c.value)
}
console.log(signedIn ? 'signed in' : 'not signed in after 10 minutes')
await ctx.close()
```

Both sites have kept the signed-in cookie under the name `sessionid`; if that stops matching, check for the user's avatar on the page instead. Check only that the cookie exists, never print its value. Give the command a timeout longer than the wait.

## Collect

Runs headless with the same profile, so nothing pops up. If a signed-in page comes back empty, signed out or behind a check, run it with `headless: false`.

The most reliable data is what the site already loads for the page: listen to JSON responses and keep the ones that carry lists of posts. Fall back to reading the page when there are none.

```js
import { chromium } from 'playwright'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const [out, ...urls] = process.argv.slice(2)
mkdirSync(join(out, 'raw'), { recursive: true })
const ctx = await chromium.launchPersistentContext(join(homedir(), '.satura-trends', 'profile'), { headless: true })
const page = ctx.pages()[0] ?? await ctx.newPage()
let n = 0
page.on('response', async (r) => {
  if (!(r.headers()['content-type'] || '').includes('json')) return
  try {
    const body = await r.json()
    const lists = Object.values(body).filter((v) => Array.isArray(v) && v.length && typeof v[0] === 'object')
    if (lists.length) writeFileSync(join(out, 'raw', `${String(++n).padStart(4, '0')}.json`), JSON.stringify({ url: r.url(), body }))
  } catch {}
})
for (const url of urls) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(1500 + Math.random() * 2500)
  }
}
await ctx.close()
console.log(`${n} responses saved`)
```

Pass the output folder and the pages: the user's feed (`https://www.tiktok.com/foryou`, `https://www.instagram.com/reels/`), searches and hashtag or sound pages for the topics the user names, `https://www.tiktok.com/explore`, and TikTok's public trend lists at https://ads.tiktok.com/creative/creativeCenter/trends. Open a few saved responses before writing the next step: on TikTok in November 2026 posts came as `itemList` with `stats` (play, digg, comment, share, collect counts), `music`, `challenges`, `createTime` and `desc`; Instagram's names differ and both change.

## Save

Into the project, out of git: `.sspace/trends/<YYYY-MM-DD>-<topic>/` with

- `raw/`: the saved responses;
- `posts.json`: one row per post, duplicates merged: `platform, url, author, caption, hashtags, sound, views, likes, comments, shares, saves, postedAt, collectedAt`;
- `summary.md`: what you found, with links.

## Read it

- Rank by speed, not size: views per hour since posting.
- Group by sound, hashtag and setup. A format counts when several different authors repeat it.
- Note saves and shares per view, comments asking for more, and small accounts doing well.
- Pick what can be a game: one action that becomes a control, a few seconds of tension or satisfaction, a camera you can copy, room for a score. Skip trends that rest on a person, a celebrity or another game's content.

Give the user five to ten trends, each with what it is, why it is rising (numbers), two or three example links and the game in one line. When the clipgame plugin is listed, offer `clipgame.fetch(url)` on the example they pick.

## Pages for the user

Three HTML pages sit next to this file in `trends/`: `index.html` (how it works and what stays private), `reading.html` (which trends make games), `sources.html`. Open one when the user asks how this works:

```js
await report.open('Packages/com.saturaspace.engine/Documentation~/agent-guide/trends/index.html')
```
