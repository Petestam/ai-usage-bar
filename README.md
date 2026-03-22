# AI Usage Bar

Mac menubar app showing a battery icon for whichever AI service is currently burning tokens. Click to see exact usage and reset times.

## Setup

```bash
npm install
npm start
```

## Getting your credentials

### Claude session key

1. Open [claude.ai](https://claude.ai) in Chrome
2. Open DevTools → Application → Cookies → `https://claude.ai`
3. Copy the value of the `sessionKey` cookie
4. Paste into the app's Settings

The session key expires after a few weeks. When it does the card will show "Session expired" — just paste a fresh one.

### OpenAI API key

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create a key (read-only access is enough)
3. Paste into Settings

Also set your **monthly spend limit** in Settings to match whatever you've configured in your OpenAI billing settings. The gauge tracks your spend against this number.

## How the icon works

- The **tray image** is a bitmap of `[████░░]` only (black fill, grey empty segments), **filled by consumed %**. The **numeric percent** next to it is **native macOS menu bar text** (`tray.setTitle`), not part of the bitmap — crisp and system-consistent.
- **Grey / dim** → no active service (nothing burned in the last 30 min)

The icon always reflects the service that's actively changing. If you switch between Claude and OpenAI mid-session, the icon follows the active one.

## Polling

By default, Claude and OpenAI are polled every **90 seconds** (Claude via your session cookie; OpenAI via billing/usage endpoints). To change the interval, add `"poll_interval_ms": 60000` (or any value in ms) to `ai-usage-config.json` in the app’s Application Support folder.

Hit the refresh button in the popover to pull fresh data immediately.

## Build a .app (share with friends)

```bash
npm run build
```

This produces a **universal** binary (Apple Silicon + Intel) in `dist/`:

- **`AI Usage-x.x.x-universal.dmg`** — drag the app to **Applications** (easiest to share).
- **`AI Usage-x.x.x-universal-mac.zip`** — unzip and move the `.app` anywhere.

**First open on another Mac:** the app is **not** signed with an Apple Developer ID. Your friends may need to **right‑click → Open** the first time, or allow it in **System Settings → Privacy & Security**.

Optional: `npm run build:arm64` or `npm run build:x64` for a single-arch build (smaller).

### Notarization (optional)

For a build that opens without Gatekeeper warnings, you need an Apple Developer account, code signing, and notarization — see [electron.build](https://www.electron.build/code-signing) and Apple’s notarization docs.
