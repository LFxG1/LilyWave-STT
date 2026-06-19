# LilyWave Azure Function Token Broker

This folder contains deployable Azure Functions that keep Azure keys server-side.
The browser app uses these Function endpoints and never receives the raw Speech
or Azure OpenAI keys.

## Local Setup

This install is required for local Speech transcription and auto-polish. The
frontend can load without it, but Start Listening cannot get Speech tokens until
this broker is running.

1. Run `npm install` in this `functions/` folder. This installs the Function
   dependencies and repo-local Azure Functions Core Tools.
2. Run `npm run setup` to create ignored `local.settings.json` from
   `local.settings.example.json`.
3. Put your local-only `SPEECH_KEY`, `SPEECH_REGION`, `ALLOWED_ORIGINS`, and
   optional Azure OpenAI settings in `local.settings.json`.
4. Run `npm start`.

The local endpoint is usually:

```text
http://localhost:7071/api/speech-token
http://localhost:7071/api/polish-text
```

## Azure App Settings

Set these Function app settings in Azure:

- `SPEECH_KEY`: your Azure Speech resource key. Prefer a Key Vault reference.
- `SPEECH_REGION`: your Speech resource region, such as `eastus`.
- `AZURE_OPENAI_ENDPOINT`: optional Azure OpenAI or Foundry endpoint.
- `AZURE_OPENAI_KEY`: optional Azure OpenAI key. Prefer a Key Vault reference.
- `AZURE_OPENAI_DEPLOYMENT`: optional deployment/model name for live cleanup.
- `AZURE_OPENAI_API_VERSION`: optional classic Azure OpenAI API version. Classic
  `*.openai.azure.com` resources can leave this blank to use the built-in
  fallback list. Leave it blank for Foundry/v1 endpoints.
- `ALLOWED_ORIGINS`: comma-separated web origins that can call the token broker.
- `ALLOW_REQUESTS_WITHOUT_ORIGIN`: keep `false` unless the Function is protected
  by same-origin hosting, Azure auth, or another trusted gateway.
- `RATE_LIMIT_PER_MINUTE`: optional per-instance throttle, default `60`.

## Frontend Setup

For local development, LilyWave uses the matching broker host automatically:

```text
http://localhost:7071/api/speech-token
http://localhost:7071/api/polish-text
http://127.0.0.1:7071/api/speech-token
http://127.0.0.1:7071/api/polish-text
```

Browser microphone permissions are stored per origin, so
`http://localhost:5500/app` and `http://127.0.0.1:5500/app` may ask for
separate permissions. Use one consistently while testing.

For production, host the Function behind the same site at:

```text
/api/speech-token
/api/polish-text
```

If your Function is on a separate domain, open **Advanced token broker** in
LilyWave Settings and paste the deployed endpoint:

```text
https://YOUR-FUNCTION.azurewebsites.net/api/speech-token
```

## Security Notes

- This broker is designed as a per-user template. Each GitHub user should run or
  deploy their own Function with their own Azure keys; do not operate one shared
  public broker for untrusted users.
- Do not commit `local.settings.json`; it is ignored by Git.
- `local.settings.example.json` is safe for GitHub. It contains no real key.
- The setup script creates `local.settings.json` with an empty `SPEECH_KEY`;
  fill it locally or use Azure app settings in a deployed Function.
- `IsEncrypted: false` means local settings are readable plain text on your
  machine. You can encrypt local values after editing them:
  ```powershell
  .\node_modules\.bin\func settings encrypt
  ```
  Decrypt them later before manual editing:
  ```powershell
  .\node_modules\.bin\func settings decrypt
  ```
  This only protects the local file on this computer. Keep
  `local.settings.json` ignored either way.
- Do not hardcode `SPEECH_KEY` or `AZURE_OPENAI_KEY` in frontend files.
- Keep `ALLOWED_ORIGINS` restricted to your app origins. Avoid `*`.
- Requests without a browser `Origin` header are rejected by default. Leave
  `ALLOW_REQUESTS_WITHOUT_ORIGIN=false` unless another layer already authenticates
  and rate-limits the Function.
- CORS and Origin checks reduce accidental browser misuse, but they are not
  authentication because non-browser clients can forge headers.
- For a public hosted deployment, add stronger abuse protection with App Service
  Authentication, API Management, or edge-level rate limiting.
