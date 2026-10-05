# AI Usage Bar

A small Mac menubar app that shows how much of your AI quota you’ve used — before you hit a wall mid-task.

Click the battery icon anytime to see **percent used**, **reset times**, and a breakdown per service. It tracks whichever tool is burning quota fastest.

**Supported services:** Claude (claude.ai), OpenAI (API billing), Cursor, Codex / ChatGPT Work

---

## Quick start

### 1. Install

1. Download the latest **[AI Usage … universal.dmg](https://github.com/Petestam/ai-usage-bar/releases)** from Releases.
2. Open the DMG and drag **AI Usage** into **Applications**.
3. Launch **AI Usage** from Applications.

**macOS says it can’t open the app?** That’s normal for now — the build isn’t Apple-notarized yet. Try one of these:

- **Right-click AI Usage → Open → Open** (only needed once), or
- **System Settings → Privacy & Security → Open Anyway** after a blocked launch, or
- In **Terminal**, clear the download quarantine flag, then open again:

```bash
xattr -dr com.apple.quarantine "/Applications/AI Usage.app"
```

### 2. Connect the services you use

On first launch, **Settings** opens automatically. You only need to connect the services you actually use — leave the rest blank.

For Claude, Cursor, and Codex, click **Sign in**. For OpenAI, paste an API key. **Sign in** saves that cookie on its own. If you typed or pasted anything, click **Save & Refresh** (the ← back arrow does **not** save).

### 3. You’re done

A battery icon appears in your menu bar. The number beside it is your current usage %. Click the icon for details.

---

## Connect your services

### Claude, Cursor, or Codex — Sign in

These three work the same way. You log in once in a window the app opens; it reads the session cookie and saves it.

**Do this once per service:**

1. Open **Settings**.
2. Click **Sign in** under the service.
3. Log in in the window that opens. When the session cookie is there, the app saves it, refreshes, and closes the window.

| Service | Settings field | Sign-in site |
|---------|----------------|--------------|
| Claude | **Claude Session Key** | [claude.ai](https://claude.ai) |
| Cursor | **Cursor session (cookie)** | [cursor.com](https://cursor.com) |
| Codex / ChatGPT Work | **Codex / ChatGPT session (cookie)** | [chatgpt.com](https://chatgpt.com) |

**Codex** and **ChatGPT Work** share the same limit; one chatgpt.com sign-in covers both.

**Claude only:** if the app can’t find your usage, paste your **organization ID** (optional field) — the UUID from your claude.ai usage URL.

**If Sign in does not work,** paste a cookie instead:

1. Open the site in **Chrome** or **Safari** while logged in.
2. Open the page inspector:
   - **Chrome:** `View → Developer → Developer Tools` (or `⌥⌘I`)
   - **Safari:** enable **Develop** menu in Settings → Advanced, then **Develop → Show Web Inspector**
3. Click the **Network** tab, then **reload the page**.
4. Click any row from that site.
5. Copy **Request Headers → cookie** (the whole value).
6. Paste into the matching Settings field and click **Save & Refresh**.

The app accepts a full cookie line, a DevTools cookie row (it strips `Domain` / `expires` / `Path`), or a single token.

**When to sign in again:** every few weeks, or whenever the app shows **Session expired — update in Settings**. Click **Sign in** again.

---

### OpenAI — API key (different from Codex)

This tracks **platform.openai.com API spend**, not your ChatGPT / Codex plan.

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys) and create an API key.
2. Paste it into **Settings → OpenAI API Key**.
3. Set **OpenAI Monthly Spend Limit (USD)** to match the monthly cap you use in OpenAI billing (e.g. `20` or `100`).
4. **Save & Refresh**.

If you use **both** Codex (ChatGPT plan) **and** the OpenAI API, set up both — they’re separate meters.

---

### Optional: Claude API billing (Console)

Only if you also pay for the **Anthropic API** (Console) and want that spend on the same gauge:

1. In [Claude Console](https://platform.claude.com) → Organization → **Admin API keys**, create a key (`sk-ant-admin…`).
2. Paste into **Anthropic Console Admin API key**.
3. Set **Anthropic API spend cap (USD)** to your org limit.
4. **Save & Refresh**.

This is separate from claude.ai’s 5-hour / weekly chat limits.

---

## Using the app day to day

**Menu bar icon**

- **`42%`** next to a filled battery → you’re at 42% of the current limit.
- **Dim / empty battery** → nothing has moved much in the last ~30 minutes (idle).
- With multiple services connected, the icon follows whichever is **most active** right now.

**Popover (click the icon)**

- Each service shows usage bars and **resets in …** countdowns.
- **↻ Refresh** pulls the latest numbers immediately.
- **⚙ Settings** to add or update credentials.

**Hide a service you’re not tracking**

In Settings, each service has a **hide / show** link under its field. Hidden services stay configured but won’t appear in the menu bar or popover.

---

## When something goes wrong

| What you see | Fix |
|--------------|-----|
| **Session expired** | Click **Sign in** for that service and log in again. Or paste a fresh cookie (full Network tab line) and **Save & Refresh**. |
| **Connection error** | Check you’re online. Try **↻ Refresh**. Open **Settings → Troubleshooting** for details. |
| **macOS won’t open the app** | Right-click → **Open**, or **System Settings → Privacy & Security → Open Anyway**. |
| **Nothing saves** | Click **Save & Refresh** — not the back arrow. If a field shows `••••••••`, paste a **new** value to replace it. |
| **Claude works in browser but not in app** | Click **Sign in** again, or paste the full **cookie** header from Network (not just `sessionKey`). Add **organization ID** if needed. |

**Settings → Troubleshooting** shows error logs and a **Copy all** button if you need to debug further.

---

## Privacy

Your keys and cookies stay **on your Mac** in:

`~/Library/Application Support/AI Usage/ai-usage-config.json`

Secrets are encrypted with Electron `safeStorage` (macOS Keychain). Never share this file or paste it in public.

---

## For developers

**Run from source**

```bash
git clone https://github.com/Petestam/ai-usage-bar.git
cd ai-usage-bar
npm install
npm start
```

**Test a cookie without launching the app**

```bash
# Cursor — wrap in single quotes (cookie contains semicolons)
CURSOR_TEST_COOKIE='paste cookie here' npm run test:cursor

# Codex / ChatGPT
CODEX_TEST_COOKIE='paste cookie here' npm run test:codex
```

**Build a release**

```bash
npm install
# Local artifacts only:
npm run build

# Or build + upload to GitHub Releases (needs GH_TOKEN with repo scope):
npm run release
```

Output: `dist/AI Usage-x.x.x-universal.dmg`, `.zip`, plus `latest-mac.yml` (required for auto-update).

**Publish:** bump `version` in `package.json`, commit, `git tag vX.Y.Z`, push the tag, then `npm run release` (or attach the `dist/` zip, blockmap, and `latest-mac.yml` to the GitHub Release manually).

**Auto-update:** packaged builds check GitHub Releases ~15s after launch, then every 4 hours. Updates download in the background and install on Quit (or **Settings → Restart now**).

**Advanced config:** edit `poll_interval_ms` (default 90 seconds) or `hide_*_gauge` flags in the config JSON above. Paths are shown in **Settings → Troubleshooting**.

**Code signing:** public builds are unsigned until a Developer ID + notarization pipeline is set up. Auto-update skips signature checks for now (`verifyUpdateCodeSignature = false`); signing + notarization will make installs smoother and let that check turn back on. See [electron.build code signing](https://www.electron.build/code-signing).

---

## License

See the repository for license information. App name in Finder: **AI Usage**.
