# LilyWave &mdash; Transcribe Speech to Text with Azure AI

<img width="1014" height="668" alt="Screenshot 2026-06-16 132125" src="https://github.com/user-attachments/assets/656ff521-aaba-431e-a8d1-64879031e801" />

A clean, calming watercolor-pond web app that turns speech into text using the
**Azure Cognitive Services Speech SDK**. It supports live microphone transcription
with a real-time waveform, `.wav` file transcription, copy-to-clipboard, and
download-as-text.

No build step, no backend, no frameworks &mdash; just open the page in a browser.

---

## Features

- **Live microphone transcription** &mdash; words appear as you speak, with an animated audio waveform, a recording timer, and a blinking cursor.
- **Audio file transcription** &mdash; upload a `.wav` file (Upload Audio tab or "Choose File") and get the transcript.
- **Copy** the transcript to your clipboard.
- **Download** the transcript as a timestamped `.txt` file.
- **Tabbed demo card** &mdash; Live Transcribe, Upload Audio, Transcript, and Settings.
- **Language selector** &mdash; common recognition languages (defaults to English/US).
- **Azure Connected status** &mdash; the sidebar shows whether your key/region are set.
- **Calm watercolor-pond theme** &mdash; airy whites, sage greens, and an Azure-blue accent.
- **Session-only credentials** &mdash; your Azure key and region live in this browser tab's `sessionStorage`, clear when the tab session ends, and are sent straight to Azure by the SDK.

---

## 1. Get an Azure Speech key (if you don't have one)

1. Sign in to the [Azure portal](https://portal.azure.com/).
2. **Create a resource** &rarr; search for **Speech** &rarr; **Create**.
3. Pick a subscription, resource group, **region** (remember it &mdash; e.g. `eastus`), and a name.
4. Choose a pricing tier (the **Free F0** tier is enough to try this app).
5. After it deploys, open the resource &rarr; **Keys and Endpoint**.
6. Copy **KEY 1** and the **Location/Region**.

---

## 2. Run the app

Because the app uses the microphone, browsers require a **secure context**.
`http://localhost` counts as secure, so a tiny local server is the easiest path.

### Option A &mdash; Node.js (recommended on this machine)

```bash
cd "C:\Users\feldi\Desktop\Speech to Text App"
npx serve -l 5500 .
```

Then open the URL it prints (e.g. <http://localhost:5500>).

### Option B &mdash; Python

```bash
cd "C:\Users\feldi\Desktop\Speech to Text App"
python -m http.server 5500
```

Then open: <http://localhost:5500>

> Note: on this machine, `python` is only the Microsoft Store stub and won't
> serve files. Use the Node option above (Node v24 is installed).

### Option C &mdash; VS Code

Install the **Live Server** extension, right-click `index.html` &rarr; **Open with Live Server**.

---

## 3. Use it

1. Open the **Settings** tab (or the top-right **Settings** button), paste your **key** + **region**, pick a language, then **Save settings**. The sidebar should switch to **Azure Connected**.
2. On the **Live Transcribe** tab, click **Start Listening** and allow microphone access &mdash; speak and watch the transcript and waveform.
3. Click **Stop Listening** when done.
4. Or use **Upload Audio** / **Choose File** to transcribe a `.wav` file.
5. Use the **copy** / **download** icons or **Clear Transcript** in the right-hand panel.

---

## Notes & limitations

- **File format:** the browser Speech SDK accepts **PCM `.wav`** audio. Other formats
  (mp3, m4a, etc.) aren't supported directly in the browser. To convert with FFmpeg:
  ```bash
  ffmpeg -i input.mp3 -ar 16000 -ac 1 output.wav
  ```
- **Security:** the key is kept in tab-scoped `sessionStorage` instead of persistent
  `localStorage`, so it clears when the tab session ends. For a shared or public
  deployment, move the key behind a small backend / token service instead of
  exposing it in the browser.
- **Browser support:** use a recent Chrome, Edge, or Firefox. The microphone requires
  `https://` or `http://localhost`.

---

## Project structure

```
Speech to Text App/
├── index.html        # Markup: nav, hero, demo card, feature bar, footer
├── styles.css        # Watercolor-pond theme + animations
├── app.js            # Azure Speech SDK logic, tabs, waveform, timer
├── assets/
│   └── pond-bg.png   # Watercolor pond background
└── README.md         # This file
```

The Azure Speech SDK is loaded from Microsoft's CDN in `index.html`:
`https://aka.ms/csspeech/jsbrowserpackageraw`
