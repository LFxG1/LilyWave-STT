# Code Review — Stellar Speech (Speech to Text App)

> Reviewer notes for the build agent. This is a **security + operational review** of the
> client-side Azure Speech-to-Text app (`index.html`, `app.js`, `styles.css`).
> Nothing in the source was modified during review — these are findings + suggested fixes.

_Last reviewed: 2026-06-16. Live smoke-tested in a real browser against `http://localhost:5500`._

---

## Live test results — PASSING

Served the app and exercised it in a real browser:

- Page loads with **zero console errors** and **zero failed network requests**.
- Azure Speech SDK loads from the CDN (`window.SpeechSDK.SpeechConfig.fromSubscription` available).
- Init logic correct: with no credentials, settings panel auto-opens and status prompts for a key.
- Settings **save** flow works: badge → "Configured", values persisted to `localStorage`, panel auto-closes.
- Settings **clear** flow works: `localStorage` entry removed, fields cleared, badge → "Not configured".
- Copy / Download / Clear correctly disabled while the transcript is empty.

Not tested (needs a real Azure key + microphone): live mic transcription and real `.wav` recognition.

---

## Security findings

### 1. Azure key stored in `localStorage` as plaintext — Medium (personal) / High (if deployed)
Confirmed live: the saved blob is `{"key":"<your-key>","region":"...","language":"..."}` in cleartext.
Any XSS on the page could read and exfiltrate the key. This is documented as a deliberate
tradeoff in the README and is acceptable for a **local/personal** tool.

**For any shared or public deployment:** move auth behind a small token service. Azure can issue
short-lived (~10 min) auth tokens from your key server-side, and the browser uses
`SpeechConfig.fromAuthorizationToken(token, region)` instead of the raw subscription key.

### 2. `setStatus()` uses `innerHTML` — Low–Medium (latent XSS)
`app.js` (~line 116): `els.statusText.innerHTML = message;`
Currently safe because the only dynamic value (uploaded file name) is passed through
`escapeHtml()` first. But it's a footgun: any future caller that forgets to escape introduces
injection. The transcript output correctly uses `textContent` — good.

**Suggested fix:** use `textContent` for plain messages, or keep a single helper that always escapes.
The few messages that need `&hellip;`/`&mdash;` can use the literal Unicode chars (`…`, `—`) instead of HTML entities, which removes the need for `innerHTML` entirely.

### 3. No Subresource Integrity (SRI) / no Content-Security-Policy — Low
Scripts load from `aka.ms` (a redirect) and Google Fonts with no integrity hashes and no CSP.
Supply-chain / MITM risk. The `aka.ms` redirect makes SRI awkward (the final URL is versioned),
but a CSP `<meta>` tag would meaningfully harden the page.

**Suggested CSP starting point** (verify the SDK still works — it may need `wasm-unsafe-eval`/`blob:` for workers):
```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               script-src 'self' https://aka.ms https://*.microsoft.com;
               style-src 'self' https://fonts.googleapis.com 'unsafe-inline';
               font-src https://fonts.gstatic.com;
               connect-src https://*.cognitive.microsoft.com wss://*.cognitiveservices.azure.com;
               img-src 'self' data:;">
```

### Already good
- Transcript + interim text use `textContent` (no DOM injection).
- Key input is `type="password"`, `autocomplete="off"`.
- File type validated before processing.
- README is honest about the credential tradeoff.

---

## Operational findings

The state machine (`isRecording` / `isFileProcessing` guards), idempotent `finishFileUI()`,
recognizer cleanup, and the `beforeunload` warning are all well done. Two things to harden:

### A. No fallback timeout on file transcription — Medium
`transcribeFile()` (~line 421) relies entirely on `sessionStopped` / `canceled(EndOfStream)`
to re-enable the UI. If neither fires (network stall, malformed WAV), the record button stays
disabled and status sticks on "Transcribing…" with no recovery path.

**Suggested fix:** start a watchdog `setTimeout` when transcription begins; if it fires before
completion, call `finishFileUI()` and show a friendly error. Clear it on normal completion.

### B. Non-PCM `.wav` and oversized files — Low (UX)
A `.wav` that isn't PCM passes the name/MIME check but fails inside the SDK; `friendlyError()`
handles websocket/403 cases but would surface a raw error string here. There's also no file-size
guard, so a very large WAV could hang the tab.

**Suggested fix:** extend `friendlyError()` to map format errors to a clear message, and optionally
warn above a size threshold (e.g. > 50 MB).

---

## Environment note (for running locally)
- The README "Option A — Python" path assumes Python is installed. On this machine only the
  Microsoft Store stub exists, so `python -m http.server` won't work as written.
- **Node works** (`v24.x`). Use: `npx serve -l 5500 .` then open the printed URL.

---

## Suggested fix priority
1. (A) File-transcription watchdog timeout — robustness.
2. (2) Move `setStatus` off `innerHTML` — quick, removes a latent XSS path.
3. (3) Add a CSP meta tag — hardening.
4. (1) Token-service auth — only if this will ever be deployed beyond a personal machine.
