# AI Usage Bar

macOS menubar app that shows a battery-style icon for whichever AI service is using quota right now (**Claude** web limits, **OpenAI** monthly spend, and/or **Cursor** plan usage). Click the icon to open the popover with percentages and reset times.

---

## Install from a release (recommended)

1. Open **[Releases](https://github.com/Petestam/ai-usage-bar/releases)** and download the latest **`AI Usage-x.x.x-universal.dmg`** (or the `.zip` if you prefer).
2. Open the DMG, drag **AI Usage** into **Applications**.
3. **First launch (Gatekeeper):** public builds are **not** signed with an Apple **Developer ID** and are **not notarized**, so macOS may say the app **can’t be opened**, **is damaged**, or **Apple cannot verify** it. That’s expected until the project ships a signed + notarized build. Try in order:
   - **System Settings → Privacy & Security** — scroll down and click **Open Anyway** next to the message about **AI Usage** (appears after a blocked launch attempt).
   - Or **Control‑click (right‑click) AI Usage → Open → Open** once.
   - If the app still won’t run, remove the **quarantine** flag from the downloaded app, then open again:  
     `xattr -dr com.apple.quarantine "/Applications/AI Usage.app"`
4. Launch **AI Usage** from Applications. If no credentials are set yet, **Settings** opens automatically.

Then continue with **[Add credentials](#add-credentials)** below.

---

## Run from source (developers)

**Requirements:** macOS, [Node.js](https://nodejs.org/) 18+ (for local dev / builds).

```bash
git clone https://github.com/Petestam/ai-usage-bar.git
cd ai-usage-bar
npm install
npm start
```

The menubar icon appears after the app starts. Use **Settings** (gear) in the popover to add keys.

### Test Cursor cookie / parsing (optional)

From the repo root (requires network):

```bash
CURSOR_TEST_COOKIE='paste full cookie header from cursor.com Network tab' npm run test:cursor
```

Wrap the cookie in **single quotes** — it contains **`;`** and the shell will split on semicolons otherwise (`command not found: cursor-web-target-synced-user=...`).

You should see **HTTP 200** and a parsed **utilization** percentage. **401** means the cookie is expired or invalid — log in again at [cursor.com](https://cursor.com) and copy a fresh `cookie` header.

---

## Add credentials

You can configure **Claude**, **OpenAI**, and/or **Cursor**. At least one is required for the app to show usage.

### Claude (claude.ai web usage)

Claude’s **5-hour** and **weekly** limits are only exposed through **claude.ai** while you are logged in. There is no separate “API key” for that same meter, so the app uses your **browser session** (cookie).

#### 1. Get a valid session (best method)

1. Log in at **[claude.ai](https://claude.ai)** in **Chrome** or **Safari**.
2. Open **DevTools** → **Network**.
3. Reload the page or trigger any request to `claude.ai`.
4. Click a request whose URL starts with `https://claude.ai/`.
5. Open **Headers** → **Request Headers**.
6. Find **`cookie:`** (long string with many `name=value` pieces).
7. Copy the **entire** `cookie` value (everything after `cookie:` on that one line).

Paste that string into **Settings → Claude Session Key** and save.

This usually works best because it includes whatever cookies the site expects (not only `sessionKey`).

#### 2. Alternative: `sessionKey` only

1. **DevTools** → **Application** (Chrome) or **Storage** (Safari) → **Cookies** → `https://claude.ai`.
2. Find **`sessionKey`** and copy **only its value** (the long token).

Paste into **Claude Session Key** and save.

#### 3. If you copied a whole cookie row from the table

If DevTools shows one long line like `sessionKey=…; Domain=.claude.ai; expires=…; HttpOnly; …`, you can paste it as-is — the app **strips** the extra parts (`Domain`, `expires`, `Path`, etc.) and keeps a valid `Cookie` header.

#### 4. Optional: organization UUID

If usage works in the browser but the app still struggles to find your org automatically:

1. In the browser, open something like:  
   `https://claude.ai/api/organizations/<uuid>/usage`  
   (or infer `<uuid>` from the Network tab when the site loads usage).
2. Copy the **UUID** segment.
3. In **Settings → Claude organization ID (optional)**, paste that UUID and save.

This skips extra discovery calls when you already know the correct org.

#### Claude notes

- The **session key** expires periodically. When it does, the Claude card shows a session/auth error — paste a fresh cookie or `sessionKey` value.
- The app sends Claude traffic using **Electron’s network stack** (same TLS family as Chromium) to reduce **HTTP 403** issues compared to plain Node requests.

---

### OpenAI (monthly spend vs limit)

1. Go to **[platform.openai.com/api-keys](https://platform.openai.com/api-keys)** and create an API key (normal secret key is fine).
2. Paste it into **Settings → OpenAI API Key** and save.
3. Set **OpenAI Monthly Spend Limit (USD)** to match the **monthly budget / hard limit** you use in OpenAI billing. The bar is **spend this month ÷ that limit** (not raw token counts only).

---

### Cursor (plan usage %)

Cursor does not publish a stable public API for personal plan usage; the app calls the same **`usage-summary`** endpoint the **cursor.com** dashboard uses, authenticated with your **browser session**.

1. Log in at **[cursor.com](https://cursor.com)** (or open the dashboard while logged in).
2. **DevTools** → **Network** → reload or navigate until you see requests to **`cursor.com`**.
3. Select a request → **Headers** → **Request Headers** → copy the full **`cookie`** value (must include **`WorkosCursorSessionToken`** and/or **`next-auth.session-token`** style cookies — whatever the browser sends).
4. Paste into **Settings → Cursor session (cookie)** and save.

If you paste only the raw `WorkosCursorSessionToken` value (no `name=`), the app prefixes it automatically. DevTools cookie rows that include `Domain=` / `expires=` are sanitized like Claude.

**Note:** This integration relies on **undocumented** endpoints; Cursor may change them. The API returns **`individualUsage`** / **`teamUsage`** (often with a nested **`plan`** object) with **Total**, **Auto**, and **API** percentages like the Spending page. The gauge uses **Total**; the popover shows **Auto** / **API** when present, plus billing-cycle reset when dates are available. The popover also shows **on-demand** spend vs cap when the API includes **`individualUsage.onDemand`** / **`teamUsage.onDemand`** (`used` and `limit` in **cents**, as in the web app). If those objects are absent, the parser falls back to **`spendLimitUsage`** and uses **`totalSpend`** / limit fields there.

---

## Where settings are stored

Configuration is saved as JSON next to the app’s other data:

- **Path:** `~/Library/Application Support/AI Usage/ai-usage-config.json`  
  (If the folder name differs slightly, open **Settings → Troubleshooting** in the app — it prints the exact **Config** path.)

You can edit `poll_interval_ms` there (default **90000** ms). Optional **`hide_*_gauge`** booleans hide a provider from the menubar icon and popover while keeping credentials stored (same toggles as **Settings**). Example:

```json
{
  "poll_interval_ms": 60000,
  "claude_session_key": "…",
  "openai_api_key": "sk-…",
  "openai_manual_limit": 20,
  "cursor_cookie": "WorkosCursorSessionToken=…",
  "hide_claude_gauge": false,
  "hide_openai_gauge": false,
  "hide_cursor_gauge": false
}
```

Do not share this file; it contains secrets.

---

## Deploy a new build (maintainers)

From a clean checkout with dependencies installed:

```bash
npm install
npm run build
```

Artifacts appear under **`dist/`**:

| Output | Use |
|--------|-----|
| **`AI Usage-x.x.x-universal.dmg`** | Easiest for users (drag to Applications). |
| **`AI Usage-x.x.x-universal-mac.zip`** | Unzip and move the `.app`. |

`npm run build` uses **`--publish never`** so local builds do not require `GH_TOKEN`.

Optional single-arch (smaller):

```bash
npm run build:arm64   # Apple Silicon
npm run build:x64     # Intel
```

### Publish a GitHub release

1. Bump **`version`** in `package.json`, commit, push `main`.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`
3. Create a release on GitHub and attach **`dist/AI Usage-x.x.x-universal.dmg`** (and optionally the `.zip`), or use **`gh release create`** with those files.

**Signing / notarization:** For installs **without** Gatekeeper warnings, ship a **Developer ID Application** signed build and **notarize** it with Apple (paid Apple Developer Program membership required).

- **electron-builder:** set `mac.hardenedRuntime` and `mac.gatekeeperAssess` as in the [macOS](https://www.electron.build/configuration/mac) docs, and provide credentials via **environment variables** at build time, for example:
  - `CSC_LINK` — path to your **`.p12`** certificate export, or `keychain:` to use the keychain
  - `CSC_KEY_PASSWORD` — password for that `.p12`
  - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — for **notarization** (app-specific password from [appleid.apple.com](https://appleid.apple.com))
- Overview: [electron.build code signing](https://www.electron.build/code-signing) and Apple’s notarization workflow.

Until that is done, end users must use **Open Anyway** / **right‑click → Open** or `xattr -dr com.apple.quarantine` as in [Install from a release](#install-from-a-release-recommended).

---

## How the menubar icon works

- The **tray image** is a small battery bitmap (`[████░░]`), filled by consumed **%**.
- On macOS, the **numeric percent** beside it is **menu bar text** (`tray.setTitle`), not part of the bitmap.
- **Dim / idle** → no service has moved much in the last ~30 minutes.
- If multiple services are configured, the icon follows whichever is **most active** (burning quota faster).

---

## Polling and refresh

- Default poll interval: **90 seconds** (Claude via session; OpenAI via API/billing-related calls; Cursor via cursor.com session).
- Change interval with **`poll_interval_ms`** in `ai-usage-config.json` (see above).
- Use the **refresh** control in the popover for an immediate pull.

---

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| **macOS won’t open the app** (“damaged”, “can’t verify”, malware warning) | Builds are **unsigned** until Developer ID + notarization are configured. Use **System Settings → Privacy & Security → Open Anyway**, or **right‑click → Open**, or `xattr -dr com.apple.quarantine "/Applications/AI Usage.app"` then open again. |
| **HTTP 403** on Claude | Paste the **full** `cookie` header from Network (not only `sessionKey`). Add **organization ID** if you have it. Ensure you’re on the latest build. |
| **Cursor** errors or no % | Paste the full **`cookie`** header from a **cursor.com** Network request (must include session cookies). Log in again at cursor.com if expired. |
| **Session expired** | Copy a fresh `sessionKey` or full cookie after logging in at claude.ai. |
| **Nothing saves** | Use **Save & Refresh** in Settings. The back arrow does **not** save. If the Claude field shows bullets (`••••••••`), paste a **new** full value to replace the stored key. |
| **Debug** | **Settings → Troubleshooting** shows config/log paths, recent errors, and a **Copy all** button. |

---

## License / project

See the repository for license information. Product name in the Finder: **AI Usage**.
