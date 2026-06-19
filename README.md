# LilyWave &mdash; Transcribe Speech to Text with Azure AI

![Uploading image.png…]()


A clean, calming watercolor-pond web app that turns speech into text using the
**Azure Cognitive Services Speech SDK**. It supports live microphone transcription
with a real-time waveform, `.wav` file transcription, copy-to-clipboard, and
download-as-text.

No frontend build step and no frameworks. For secure Speech auth, run or deploy
the included Azure Function token broker.

---

## Features

- **Live microphone transcription** &mdash; words appear as you speak, with an animated audio waveform, a recording timer, and a blinking cursor.
- **Audio file transcription** &mdash; upload a `.wav` file (Upload Audio tab or "Choose File") and get the transcript.
- **Copy** the transcript to your clipboard.
- **Download** the transcript as a timestamped `.txt` file.
- **Tabbed demo card** &mdash; Live Transcribe, Upload Audio, Transcript, and Settings.
- **Language selector** &mdash; common recognition languages (defaults to English/US).
- **Token broker status** &mdash; the sidebar shows whether the Speech token broker is configured.
- **Calm watercolor-pond theme** &mdash; airy whites, sage greens, and an Azure-blue accent.
- **No Azure keys in the browser** &mdash; Speech and Azure OpenAI keys live in Azure Function app settings; the browser receives only short-lived Speech tokens and polished text.

---

## 1. Get an Azure Speech key (if you don't have one)

1. Sign in to the [Azure portal](https://portal.azure.com/).
2. **Create a resource** &rarr; search for **Speech** &rarr; **Create**.
3. Pick a subscription, resource group, **region** (remember it &mdash; e.g. `eastus`), and a name.
4. Choose a pricing tier (the **Free F0** tier is enough to try this app).
5. After it deploys, open the resource &rarr; **Keys and Endpoint**.
6. Copy **KEY 1** and the **Location/Region**.

---

## 2. Install or deploy the required token broker

The frontend needs an Azure Function endpoint that returns short-lived Speech
authorization tokens. See [`functions/README.md`](functions/README.md) for the
deployable template.

For local testing, install and prepare the broker:

```bash
cd "C:\Users\feldi\Desktop\Speech to Text App\functions"
npm install
npm run setup
```

`npm install` installs the broker dependencies and repo-local Azure Functions
Core Tools. `npm run setup` copies the GitHub-safe
`functions/local.settings.example.json` to ignored `functions/local.settings.json`.
Then edit `functions/local.settings.json` and set your local `SPEECH_KEY`,
`SPEECH_REGION`, and optional Azure OpenAI settings for live cleanup. The real
settings file should not be committed.

`local.settings.json` starts with `IsEncrypted: false` so it is easy to edit.
After adding local secrets, you can encrypt it with Azure Functions Core Tools;
see [`functions/README.md`](functions/README.md#security-notes).

At minimum, your Function app settings need:

- `SPEECH_KEY`: your Azure Speech resource key.
- `SPEECH_REGION`: your Speech resource region, such as `eastus`.
- `AZURE_OPENAI_ENDPOINT`: optional Azure OpenAI or Foundry endpoint.
- `AZURE_OPENAI_KEY`: optional Azure OpenAI key.
- `AZURE_OPENAI_DEPLOYMENT`: optional deployment/model name for live cleanup.
- `AZURE_OPENAI_API_VERSION`: optional classic Azure OpenAI API version. Classic
  `*.openai.azure.com` resources can leave this blank to use the built-in
  fallback list. Leave it blank for Foundry/v1 endpoints.
- `ALLOWED_ORIGINS`: the web app origins allowed to call the function, such as
  `http://localhost:5500,https://YOUR-SITE.example.com`.
- `ALLOW_REQUESTS_WITHOUT_ORIGIN`: keep `false` for normal local/download use.
  Only set it to `true` behind same-origin hosting, Azure auth, or another
  trusted gateway.

For local testing, use either `http://localhost:5500/app` or
`http://127.0.0.1:5500/app` consistently. Browser microphone permissions are
per origin, so switching between those two can produce different permission
behavior even though both point to your machine.

For production, deploy the Function and store `SPEECH_KEY` and
`AZURE_OPENAI_KEY` as Key Vault references rather than as plain app settings.

---

## 3. Run the app

Because the app uses the microphone, browsers require a **secure context**.
`http://localhost` counts as secure, so a tiny local server is the easiest path.

### Option A &mdash; Node.js (recommended on this machine)

```bash
cd "C:\Users\feldi\Desktop\Speech to Text App"
npx serve -l 5500 .
```

Then open the URL it prints (e.g. <http://localhost:5500>).

In another terminal, start the required local token broker:

```bash
cd "C:\Users\feldi\Desktop\Speech to Text App\functions"
npm start
```

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

## 4. Use it

1. Open the **Settings** tab (or the top-right **Settings** button), pick a language, then **Save settings**. The app uses `http://127.0.0.1:7071/api/speech-token` automatically for local development. Use **Advanced token broker** only if you need to override that endpoint.
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
- **Security:** Azure keys should stay in Azure Function app settings, ideally as
  Key Vault references. The browser should only receive short-lived Speech
  tokens and polished text from the broker.
- **Deployment model:** this repo is intended for each user to run their own
  local or self-deployed broker with their own Azure keys. Do not run one shared
  public broker for untrusted users unless you add real authentication and
  gateway-level abuse controls.
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

The `functions/` folder contains the Azure Function token broker template.

The Azure Speech SDK is loaded from Microsoft's CDN in `index.html`:
`https://aka.ms/csspeech/jsbrowserpackageraw`
