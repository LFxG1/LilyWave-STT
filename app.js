/* =========================================================================
   LilyWave - Azure Speech to Text (browser)
   -------------------------------------------------------------------------
   Flows:
     1. Continuous real-time microphone transcription (with live waveform).
     2. One-shot transcription of an uploaded .wav file.
   Plus: tabbed sidebar, recording timer, copy / download / clear, and an
   connection status driven by the configured token broker.

   Azure Speech keys stay server-side in a user-deployed Azure Function. The
   browser only asks that Function for short-lived Speech authorization tokens.
   ========================================================================= */

(function () {
    "use strict";

    // ---- Constants --------------------------------------------------------
    var STORAGE_KEY = "lilywave-settings";
    var TRANSCRIPTS_KEY = "lilywave-transcripts"; // tab-session transcripts
    var SpeechSDK = window.SpeechSDK;

    var FILE_WATCHDOG_MS = 120000; // abort stuck file transcription after 2 min
    var MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
    var TOKEN_REFRESH_SKEW_MS = 60000; // refresh 1 min before token expiry
    var LOCAL_FUNCTION_PORT = "7071";
    var SAME_ORIGIN_TOKEN_ENDPOINT = "/api/speech-token";

    // ---- DOM references ---------------------------------------------------
    var els = {
        navSettingsBtn: document.getElementById("navSettingsBtn"),
        tabs: Array.prototype.slice.call(document.querySelectorAll(".tab")),
        views: {
            live: document.getElementById("view-live"),
            upload: document.getElementById("view-upload"),
            settings: document.getElementById("view-settings"),
            transcript: document.getElementById("view-transcript"),
        },
        transcriptLog: document.getElementById("transcriptLog"),

        azureStatus: document.getElementById("azureStatus"),
        azureStatusText: document.getElementById("azureStatusText"),

        liveBadge: document.getElementById("liveBadge"),
        liveBadgeText: document.getElementById("liveBadgeText"),
        waveform: document.getElementById("waveform"),
        liveText: document.getElementById("liveText"),
        recordToggle: document.getElementById("recordToggle"),
        recordToggleLabel: document.getElementById("recordToggleLabel"),
        timer: document.getElementById("timer"),
        timerDot: document.querySelector(".timer__dot"),

        uploadRow: document.getElementById("uploadRow"),
        chooseFileBtn: document.getElementById("chooseFileBtn"),
        dropzone: document.getElementById("dropzone"),
        fileInput: document.getElementById("fileInput"),

        speechTokenEndpoint: document.getElementById("speechTokenEndpoint"),
        languageSelect: document.getElementById("languageSelect"),
        cleanupStyle: document.getElementById("cleanupStyle"),
        saveSettings: document.getElementById("saveSettings"),
        clearSettings: document.getElementById("clearSettings"),

        transcriptPanel: document.getElementById("transcriptPanel"),
        transcript: document.getElementById("transcript"),
        wordCount: document.getElementById("wordCount"),
        copyBtn: document.getElementById("copyBtn"),
        downloadBtn: document.getElementById("downloadBtn"),
        clearBtn: document.getElementById("clearBtn"),

        toast: document.getElementById("toast"),
    };

    // ---- Application state ------------------------------------------------
    var state = {
        recognizer: null,
        isRecording: false,
        isFileProcessing: false,
        isStartingSpeech: false,
        finalText: "",
        interimText: "",
        fileWatchdog: null,
        speechToken: null,
        tokenRefreshTimer: null,
        timerStart: 0,
        timerInterval: null,
        // Live auto-polish: each finalized utterance becomes a segment that is
        // cleaned up asynchronously by the backend broker and swapped in place.
        segments: [],
        segSeq: 0,
        polishQueue: [],
        polishing: false,
        polishWarned: false,
        // Timestamped sessions for the Transcript tab. Each recording / file
        // transcription is one session; segments are tagged with a session id.
        sessions: [],
        sessionSeq: 0,
        currentSessionId: null,
        selectedSessionId: null, // highlighted entry in the Transcript list
    };

    var toastTimer = null;

    // Audio visualization state.
    var audio = {
        context: null,
        analyser: null,
        stream: null,
        source: null,
        rafId: null,
        data: null,
    };

    // Idle ("breathing") waveform animation loop handle.
    var idleRafId = null;

    function prefersReducedMotion() {
        return Boolean(
            window.matchMedia &&
                window.matchMedia("(prefers-reduced-motion: reduce)").matches
        );
    }

    // =======================================================================
    // Settings persistence
    // =======================================================================

    function defaultSpeechTokenEndpoint() {
        var host = window.location.hostname;
        if (host === "localhost" || host === "127.0.0.1") {
            return "http://" + host + ":" + LOCAL_FUNCTION_PORT + "/api/speech-token";
        }
        if (host === "::1") {
            return "http://[::1]:" + LOCAL_FUNCTION_PORT + "/api/speech-token";
        }
        return SAME_ORIGIN_TOKEN_ENDPOINT;
    }

    function resolveSpeechTokenEndpoint(endpointOverride) {
        return (endpointOverride || "").trim() || defaultSpeechTokenEndpoint();
    }

    function isLocalEndpointHost(hostname) {
        return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    }

    function normalizeTokenEndpointOverride(value) {
        var raw = String(value || "").trim();
        if (!raw) {
            return "";
        }

        var url;
        try {
            url = new URL(raw, window.location.origin);
        } catch (err) {
            throw new Error("Token endpoint override must be a valid URL.");
        }

        if (url.protocol === "https:" || (url.protocol === "http:" && isLocalEndpointHost(url.hostname))) {
            return url.toString();
        }

        throw new Error("Token endpoint override must use HTTPS, except localhost for local development.");
    }

    function safeTokenEndpointOverride(value) {
        try {
            return normalizeTokenEndpointOverride(value);
        } catch (err) {
            return "";
        }
    }

    function readSessionItem(key) {
        var raw = null;
        try {
            raw = sessionStorage.getItem(key);
        } catch (err) {
            console.warn("Could not read browser session storage:", err);
            return null;
        }

        try {
            var legacy = localStorage.getItem(key);
            if (!raw && legacy) {
                sessionStorage.setItem(key, legacy);
                raw = legacy;
            }
            if (legacy !== null) {
                localStorage.removeItem(key);
            }
            return raw;
        } catch (err) {
            console.warn("Could not clear legacy persistent storage:", err);
            return raw;
        }
    }

    function writeSessionItem(key, value) {
        try {
            sessionStorage.setItem(key, value);
        } catch (err) {
            console.warn("Could not write browser session storage:", err);
            return false;
        }

        try {
            localStorage.removeItem(key);
        } catch (err) {
            console.warn("Could not clear legacy persistent storage:", err);
        }
        return true;
    }

    function removeSessionItem(key) {
        try {
            sessionStorage.removeItem(key);
        } catch (err) {
            console.warn("Could not clear browser session storage:", err);
        }

        try {
            localStorage.removeItem(key);
        } catch (err) {
            console.warn("Could not clear legacy persistent storage:", err);
        }
    }

    function loadSettings() {
        try {
            var raw = readSessionItem(STORAGE_KEY);
            if (!raw) {
                return null;
            }
            var settings = sanitizeSettings(JSON.parse(raw));
            writeSessionItem(STORAGE_KEY, JSON.stringify(settings));
            return settings;
        } catch (err) {
            console.warn("Could not read saved settings:", err);
            return null;
        }
    }

    function persistSettings(settings) {
        if (writeSessionItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)))) {
            return true;
        }
        showToast("Unable to save settings for this browser tab.", "error");
        return false;
    }

    function sanitizeSettings(settings) {
        var s = settings && typeof settings === "object" ? settings : {};
        var endpoint = safeTokenEndpointOverride(
            s.speechTokenEndpointOverride !== undefined
                ? s.speechTokenEndpointOverride
                : s.speechTokenEndpoint || s.tokenEndpoint || ""
        );
        if (endpoint === defaultSpeechTokenEndpoint()) {
            endpoint = "";
        }
        return {
            speechTokenEndpoint: endpoint,
            language: s.language || "en-US",
            cleanupStyle: s.cleanupStyle || "off",
        };
    }

    function getCurrentSettings() {
        var endpointOverride = safeTokenEndpointOverride(els.speechTokenEndpoint.value);
        return {
            speechTokenEndpoint: resolveSpeechTokenEndpoint(endpointOverride),
            speechTokenEndpointOverride: endpointOverride,
            language: els.languageSelect.value,
            cleanupStyle: els.cleanupStyle.value,
        };
    }

    function hasValidCredentials() {
        var s = getCurrentSettings();
        return Boolean(s.speechTokenEndpoint);
    }

    // Auto-polish is available when the backend broker is configured and the
    // cleanup style isn't "off".
    function autoPolishEnabled() {
        var s = getCurrentSettings();
        return Boolean(
            s.cleanupStyle &&
            s.cleanupStyle !== "off" &&
            s.speechTokenEndpoint
        );
    }

    function refreshAzureStatus() {
        if (hasValidCredentials()) {
            els.azureStatus.classList.remove("status-line--off");
            els.azureStatus.classList.add("status-line--on");
            els.azureStatusText.textContent = autoPolishEnabled()
                ? "Token broker + Auto-polish"
                : "Token broker configured";
        } else {
            els.azureStatus.classList.remove("status-line--on");
            els.azureStatus.classList.add("status-line--off");
            els.azureStatusText.textContent = "Not connected";
        }
    }

    // =======================================================================
    // UI helpers
    // =======================================================================

    function showToast(message, variant) {
        els.toast.textContent = message;
        els.toast.className = "toast is-visible" + (variant ? " toast--" + variant : "");
        if (toastTimer) {
            clearTimeout(toastTimer);
        }
        toastTimer = setTimeout(function () {
            els.toast.className = "toast";
        }, 3200);
    }

    function setBadge(label, variant) {
        els.liveBadgeText.textContent = label;
        els.liveBadge.className = "badge badge--" + variant;
    }

    function activateTab(name) {
        els.tabs.forEach(function (tab) {
            var isActive = tab.getAttribute("data-tab") === name;
            tab.classList.toggle("is-active", isActive);
            tab.setAttribute("aria-selected", isActive ? "true" : "false");
        });

        Object.keys(els.views).forEach(function (key) {
            els.views[key].classList.toggle("is-active", key === name);
        });

        // The persistent upload row only belongs with the live view.
        els.uploadRow.style.display = name === "live" ? "" : "none";

        if (name === "transcript") {
            renderTranscriptLog();
        }
        if (name === "settings") {
            window.setTimeout(function () {
                els.languageSelect.focus();
            }, 60);
        }

        // Run the resting animation only on the live view when not recording;
        // pause it everywhere else so it doesn't draw off-screen.
        if (name === "live" && !state.isRecording && !audio.analyser) {
            startIdleAnimation();
        } else {
            stopIdleAnimation();
        }
    }

    function flashTranscript() {
        els.transcriptPanel.classList.remove("is-flash");
        // Force reflow so the animation can replay.
        void els.transcriptPanel.offsetWidth;
        els.transcriptPanel.classList.add("is-flash");
        els.transcriptPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    function countWords(text) {
        var t = text.trim();
        return t ? t.split(/\s+/).length : 0;
    }

    function replaceChildrenSafe(el) {
        while (el.firstChild) {
            el.removeChild(el.firstChild);
        }
        for (var i = 1; i < arguments.length; i += 1) {
            el.appendChild(arguments[i]);
        }
    }

    function transcriptFolderIcon(size) {
        var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", String(size));
        svg.setAttribute("height", String(size));
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.5");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.setAttribute("aria-hidden", "true");

        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute(
            "d",
            "M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5V17a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17Z"
        );
        svg.appendChild(path);
        return svg;
    }

    function renderTranscriptPlaceholder() {
        var placeholder = document.createElement("span");
        placeholder.className = "transcript-placeholder";
        placeholder.appendChild(transcriptFolderIcon(44));
        placeholder.appendChild(
            document.createTextNode("Create or select a project to save transcripts.")
        );
        replaceChildrenSafe(els.transcript, placeholder);
    }

    function renderLivePlaceholder() {
        var placeholder = document.createElement("span");
        placeholder.className = "live-text__placeholder";
        placeholder.textContent = "Press Start Listening and begin speaking...";
        replaceChildrenSafe(els.liveText, placeholder);
    }

    function renderEmptyTranscriptLog(log) {
        var empty = document.createElement("p");
        empty.className = "transcript-log__empty";
        empty.textContent = "No transcripts yet - start listening or upload a file.";
        replaceChildrenSafe(log, empty);
    }

    // Render the committed transcript into both the right panel and the live
    // view (the live view also shows the in-progress interim text + a cursor).
    function render() {
        var text = state.finalText.trim();

        // Right-hand transcript panel (plain committed text).
        if (text) {
            els.transcript.textContent = text;
        } else {
            renderTranscriptPlaceholder();
        }

        // Live view: committed + interim + cursor (or placeholder when idle).
        if (text || state.interimText || state.isRecording) {
            els.liveText.textContent = text;
            if (state.interimText) {
                var interim = document.createElement("span");
                interim.className = "interim";
                interim.textContent = (text ? " " : "") + state.interimText;
                els.liveText.appendChild(interim);
            }
            if (state.isRecording) {
                var cursor = document.createElement("span");
                cursor.className = "cursor";
                els.liveText.appendChild(cursor);
            }
            if (state.polishing || state.polishQueue.length) {
                var hint = document.createElement("span");
                hint.className = "polishing-hint";
                hint.textContent = " · polishing…";
                hint.textContent = " - polishing...";
                els.liveText.appendChild(hint);
            }
            els.liveText.scrollTop = els.liveText.scrollHeight;
        } else {
            renderLivePlaceholder();
        }

        var words = countWords(text);
        els.wordCount.textContent = words + (words === 1 ? " word" : " words");

        var hasContent = Boolean(text);
        els.copyBtn.disabled = !hasContent;
        els.downloadBtn.disabled = !hasContent;
        els.clearBtn.disabled = !hasContent;

        els.transcript.scrollTop = els.transcript.scrollHeight;

        // Keep the Transcript tab live, but only touch the DOM when it's shown.
        if (els.views.transcript && els.views.transcript.classList.contains("is-active")) {
            renderTranscriptLog();
        }
    }

    // Recompute the committed transcript from segments. While a segment is
    // pending/failed it shows its raw text; once polished it shows the cleaned
    // text (which may be empty for pure-filler utterances, dropping it).
    // The live view + right panel show ONLY the current session's text, so a new
    // recording/upload starts fresh instead of accumulating across sessions.
    function rebuildFinalText() {
        state.finalText = state.segments
            .filter(function (seg) { return seg.sessionId === state.currentSessionId; })
            .map(function (seg) {
                var disp = seg.status === "done" ? (seg.polished || "") : seg.raw;
                return (disp || "").trim();
            })
            .filter(function (t) { return t.length > 0; })
            .join(" ");
    }

    // =======================================================================
    // Sessions (Transcript tab)
    // =======================================================================

    function beginSession(source) {
        var session = {
            id: ++state.sessionSeq,
            startedAt: new Date(),
            endedAt: null,
            source: source || "Microphone",
            text: "", // authoritative text for restored sessions
        };
        state.sessions.push(session);
        state.currentSessionId = session.id;
        return session.id;
    }

    function findSession(id) {
        for (var i = 0; i < state.sessions.length; i++) {
            if (state.sessions[i].id === id) {
                return state.sessions[i];
            }
        }
        return null;
    }

    function endCurrentSession() {
        var s = findSession(state.currentSessionId);
        if (s && !s.endedAt) {
            s.text = sessionText(s);
            s.endedAt = new Date();
        }
    }

    // Joined display text for one session (polished where available, else raw).
    // Restored sessions have no live segments, so fall back to their saved text.
    function sessionText(session) {
        var segs = state.segments.filter(function (seg) {
            return seg.sessionId === session.id;
        });
        if (segs.length) {
            return segs
                .map(function (seg) {
                    var disp = seg.status === "done" ? (seg.polished || "") : seg.raw;
                    return (disp || "").trim();
                })
                .filter(function (t) { return t.length > 0; })
                .join(" ");
        }
        return session.text || "";
    }

    function formatSessionTime(d) {
        try {
            var date = d.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
            });
            var time = d.toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
            });
            return date + " · " + time;
        } catch (e) {
            return String(d);
        }
    }

    function sessionDurationSeconds(session) {
        if (!session.endedAt) {
            return null;
        }
        return Math.max(0, Math.round((session.endedAt - session.startedAt) / 1000));
    }

    function formatDuration(secs) {
        if (secs == null) {
            return "—";
        }
        var m = Math.floor(secs / 60);
        var s = secs % 60;
        return (m ? m + "m " : "") + s + "s";
    }

    function sessionDurationLabel(session) {
        var secs = sessionDurationSeconds(session);
        return secs == null ? "" : " · " + formatDuration(secs);
    }

    function snippet(text) {
        var t = (text || "").trim();
        if (t.length <= 150) {
            return t;
        }
        return t.slice(0, 150).replace(/\s+\S*$/, "") + "…";
    }

    function makeStat(value, label) {
        var wrap = document.createElement("div");
        wrap.className = "stat";
        var v = document.createElement("span");
        v.className = "stat__value";
        v.textContent = value;
        var l = document.createElement("span");
        l.className = "stat__label";
        l.textContent = label;
        wrap.appendChild(v);
        wrap.appendChild(l);
        return wrap;
    }

    // ---- Persistence (saved sessions) ------------------------------------

    function saveTranscripts() {
        try {
            var data = state.sessions
                .map(function (session) {
                    return {
                        id: session.id,
                        startedAt: session.startedAt ? session.startedAt.toISOString() : null,
                        endedAt: session.endedAt ? session.endedAt.toISOString() : null,
                        source: session.source,
                        text: sessionText(session),
                    };
                })
                .filter(function (d) { return d.text && d.text.length > 0; });
            writeSessionItem(TRANSCRIPTS_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn("Could not save transcripts:", e);
        }
    }

    function loadTranscripts() {
        try {
            var raw = readSessionItem(TRANSCRIPTS_KEY);
            if (!raw) {
                return;
            }
            var data = JSON.parse(raw);
            if (!Array.isArray(data)) {
                return;
            }
            var maxId = state.sessionSeq;
            data.forEach(function (d) {
                state.sessions.push({
                    id: d.id,
                    startedAt: d.startedAt ? new Date(d.startedAt) : new Date(),
                    endedAt: d.endedAt ? new Date(d.endedAt) : null,
                    source: d.source || "Microphone",
                    text: d.text || "",
                    restored: true,
                });
                if (typeof d.id === "number" && d.id > maxId) {
                    maxId = d.id;
                }
            });
            state.sessionSeq = maxId;
        } catch (e) {
            console.warn("Could not load transcripts:", e);
        }
    }

    // ---- Selection / per-session copy ------------------------------------

    function selectSession(id) {
        state.selectedSessionId = parseInt(id, 10);
        renderTranscriptLog();
    }

    function copySessionText(id) {
        var session = findSession(parseInt(id, 10));
        if (!session) {
            return;
        }
        copyToClipboard(sessionText(session), "Session copied to clipboard.");
    }

    // Render the Transcript tab: an interactive, selectable list of saved
    // sessions (newest first). Only touches the DOM when the view is visible.
    function renderTranscriptLog() {
        var log = els.transcriptLog;
        if (!log) {
            return;
        }

        var entries = [];
        state.sessions.forEach(function (session) {
            var text = sessionText(session);
            var isCurrent =
                session.id === state.currentSessionId &&
                (state.isRecording || state.isFileProcessing);
            if (!text && !isCurrent) {
                return; // skip finished sessions that produced nothing
            }
            entries.push({ session: session, text: text, isCurrent: isCurrent });
        });
        entries.reverse(); // newest first

        if (!entries.length) {
            renderEmptyTranscriptLog(log);
            return;
        }

        replaceChildrenSafe(log);
        entries.forEach(function (e) {
            var session = e.session;
            var selected = session.id === state.selectedSessionId;

            var entry = document.createElement("div");
            entry.className = "log-entry" + (selected ? " is-selected" : "");
            entry.setAttribute("data-session-id", session.id);
            entry.setAttribute("role", "button");
            entry.setAttribute("tabindex", "0");
            entry.setAttribute("aria-pressed", selected ? "true" : "false");

            var head = document.createElement("div");
            head.className = "log-entry__head";
            var time = document.createElement("span");
            time.className = "log-entry__time";
            time.textContent = formatSessionTime(session.startedAt);
            var src = document.createElement("span");
            src.className = "log-entry__source";
            src.textContent = session.source + sessionDurationLabel(session);
            head.appendChild(time);
            head.appendChild(src);
            entry.appendChild(head);

            var body = document.createElement("div");
            body.className = "log-entry__text";
            if (!e.text && e.isCurrent) {
                body.textContent = "(listening…)";
                body.classList.add("is-listening");
            } else {
                body.textContent = selected ? e.text : snippet(e.text);
            }
            entry.appendChild(body);

            if (selected && e.text) {
                var stats = document.createElement("div");
                stats.className = "log-entry__stats";
                stats.appendChild(makeStat(String(countWords(e.text)), "words"));
                stats.appendChild(makeStat(String(e.text.length), "characters"));
                stats.appendChild(
                    makeStat(formatDuration(sessionDurationSeconds(session)), "duration")
                );
                entry.appendChild(stats);

                var actions = document.createElement("div");
                actions.className = "log-entry__actions";
                var copyBtn = document.createElement("button");
                copyBtn.type = "button";
                copyBtn.className = "log-entry__copy";
                copyBtn.setAttribute("data-session-id", session.id);
                copyBtn.textContent = "Copy";
                actions.appendChild(copyBtn);
                entry.appendChild(actions);
            }

            log.appendChild(entry);
        });
    }

    // A finalized utterance arrived. Add it as a segment (shown immediately as
    // raw), then queue it for auto-polish if Azure OpenAI is configured.
    function addSegment(rawText) {
        var clean = (rawText || "").trim();
        if (!clean) {
            return;
        }
        // Ensure there's a session to attach to (covers edge cases where a
        // segment arrives without an explicit recording/file start).
        if (state.currentSessionId == null) {
            beginSession("Microphone");
        }
        var willPolish = autoPolishEnabled();
        var seg = {
            id: ++state.segSeq,
            raw: clean,
            polished: null,
            status: willPolish ? "pending" : "done",
            sessionId: state.currentSessionId,
        };
        state.segments.push(seg);
        state.interimText = "";
        rebuildFinalText();
        render();
        saveTranscripts();

        if (willPolish) {
            state.polishQueue.push(seg.id);
            processPolishQueue();
        }
    }

    function findSegment(id) {
        for (var i = 0; i < state.segments.length; i++) {
            if (state.segments[i].id === id) {
                return state.segments[i];
            }
        }
        return null;
    }

    // True only when an utterance is nothing but non-lexical filler sounds
    // (um, uh, er, ah, hmm). Real words make this false, so we never drop them.
    function isFillerOnly(text) {
        var words = (text || "")
            .toLowerCase()
            .replace(/[^a-z\s]/g, "")
            .split(/\s+/)
            .filter(Boolean);
        if (!words.length) {
            return true;
        }
        return words.every(function (w) {
            return /^(u+m+|u+h+|e+r+m*|a+h+|h+m+|m+|hu+h)$/.test(w);
        });
    }

    // Decide what to display for a polished segment. If cleanup returned text,
    // use it. If it came back empty, only drop the segment when the raw was pure
    // filler; otherwise keep the raw words so real speech is never erased.
    function chooseDisplay(cleaned, raw) {
        var c = (cleaned || "").trim();
        if (c) {
            return c;
        }
        return isFillerOnly(raw) ? "" : raw;
    }

    // Process one polish request at a time (keeps order, and avoids
    // hammering the endpoint when many utterances arrive quickly).
    function processPolishQueue() {
        if (state.polishing) {
            return;
        }
        var nextId = state.polishQueue.shift();
        if (nextId == null) {
            updatePolishingHint();
            return;
        }
        var seg = findSegment(nextId);
        if (!seg) {
            processPolishQueue();
            return;
        }
        state.polishing = true;
        updatePolishingHint();

        polishText(seg.raw)
            .then(function (cleaned) {
                seg.polished = chooseDisplay(cleaned, seg.raw);
                seg.status = "done";
            })
            .catch(function (err) {
                console.warn("Auto-polish failed:", err);
                seg.status = "failed"; // fall back to raw text
                if (!state.polishWarned) {
                    state.polishWarned = true;
                    showToast(
                        "Auto-polish unavailable — showing raw text. Check Azure OpenAI settings.",
                        "error"
                    );
                }
            })
            .then(function () {
                state.polishing = false;
                rebuildFinalText();
                render();
                saveTranscripts();
                processPolishQueue();
            });
    }

    // Subtle "polishing…" hint appended in the live view while work is pending.
    function updatePolishingHint() {
        render();
    }

    function polishEndpointFromSpeechEndpoint(endpoint) {
        var value = (endpoint || "").trim();
        if (!value) {
            return "";
        }
        try {
            var url = new URL(value, window.location.origin);
            url.pathname = url.pathname.replace(/\/speech-token\/?$/i, "/polish-text");
            if (!/\/polish-text\/?$/i.test(url.pathname)) {
                url.pathname = "/api/polish-text";
            }
            return url.toString();
        } catch (err) {
            return value.replace(/\/speech-token\/?$/i, "/polish-text");
        }
    }

    function handlePolishResponse(res) {
        if (!res.ok) {
            return res.text().then(function (body) {
                var message = "Auto-polish " + res.status;
                try {
                    var parsed = JSON.parse(body);
                    if (parsed && parsed.error) {
                        message += ": " + parsed.error;
                    }
                } catch (err) {
                    if (body) {
                        message += ": " + body.slice(0, 120);
                    }
                }
                throw new Error(message);
            });
        }
        return res.json().then(function (data) {
            return (data && data.text ? data.text : "").trim();
        });
    }

    var polishConnected = false;
    function notePolishConnected() {
        if (polishConnected) {
            return;
        }
        polishConnected = true;
        showToast("Auto-polish connected.", "success");
        refreshAzureStatus();
    }

    function polishText(rawText) {
        var s = getCurrentSettings();
        var url = polishEndpointFromSpeechEndpoint(s.speechTokenEndpoint);
        if (!url) {
            return Promise.reject(new Error("Auto-polish broker endpoint is not configured."));
        }
        return fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({
                text: rawText,
                style: s.cleanupStyle,
            }),
        })
            .then(handlePolishResponse)
            .then(function (content) {
                notePolishConnected();
                return content;
            });
    }

    // Recording timer
    // =======================================================================

    function startTimer() {
        state.timerStart = Date.now();
        els.timerDot.classList.add("is-live");
        updateTimer();
        state.timerInterval = setInterval(updateTimer, 250);
    }

    function stopTimer() {
        if (state.timerInterval) {
            clearInterval(state.timerInterval);
            state.timerInterval = null;
        }
        els.timerDot.classList.remove("is-live");
    }

    function updateTimer() {
        var elapsed = Math.floor((Date.now() - state.timerStart) / 1000);
        var h = Math.floor(elapsed / 3600);
        var m = Math.floor((elapsed % 3600) / 60);
        var s = elapsed % 60;
        els.timer.textContent = pad(h) + ":" + pad(m) + ":" + pad(s);
    }

    function pad(n) {
        return n < 10 ? "0" + n : String(n);
    }

    // =======================================================================
    // Waveform visualization
    // =======================================================================

    function sizeCanvas() {
        var canvas = els.waveform;
        var rect = canvas.getBoundingClientRect();
        var dpr = window.devicePixelRatio || 1;
        if (rect.width === 0) {
            return;
        }
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(90 * dpr);
        var ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawWaveform(amplitudes) {
        var canvas = els.waveform;
        var ctx = canvas.getContext("2d");
        var dpr = window.devicePixelRatio || 1;
        var width = canvas.width / dpr;
        var height = canvas.height / dpr;

        ctx.clearRect(0, 0, width, height);

        var barWidth = 3;
        var gap = 4;
        var step = barWidth + gap;
        var bars = Math.floor(width / step);
        var mid = height / 2;

        var gradient = ctx.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, "#5ec79f");
        gradient.addColorStop(0.5, "#4a90e2");
        gradient.addColorStop(1, "#5ec79f");
        ctx.fillStyle = gradient;

        for (var i = 0; i < bars; i++) {
            var amp = amplitudes[i % amplitudes.length];
            // Taper the edges so the waveform looks centered/organic.
            var center = 1 - Math.abs(i / bars - 0.5) * 1.4;
            center = Math.max(0.12, center);
            var barHeight = Math.max(2, amp * (height - 8) * center);
            var x = i * step;
            var y = mid - barHeight / 2;
            roundRect(ctx, x, y, barWidth, barHeight, 1.5);
        }
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
        ctx.fill();
    }

    // Whether the live transcription view is the one currently shown.
    function isLiveViewVisible() {
        return Boolean(els.views.live && els.views.live.classList.contains("is-active"));
    }

    // Build the resting waveform's bar amplitudes for a given time (ms).
    // A slow travelling sine gives a calm "breathing"/shimmer; modest range.
    function idleAmplitudes(t) {
        var canvas = els.waveform;
        var dpr = window.devicePixelRatio || 1;
        var width = canvas.width / dpr;
        var amplitudes = [];
        var count = Math.ceil(width / 7) + 2;
        for (var i = 0; i < count; i++) {
            var wave = 0.5 + 0.5 * Math.sin(t * 0.0016 + i * 0.4);
            amplitudes.push(0.1 + 0.1 * wave); // ~0.10..0.20, tranquil
        }
        return amplitudes;
    }

    // Static resting wave (used as the reduced-motion fallback).
    function drawIdleWave() {
        drawWaveform(idleAmplitudes(0));
    }

    // Gentle animated idle: bars slowly rise/fall over time. Pauses on other
    // tabs / when hidden / while recording, and respects reduced motion.
    function startIdleAnimation() {
        stopIdleAnimation();

        if (prefersReducedMotion()) {
            drawIdleWave();
            return;
        }

        var loop = function (now) {
            // The live (mic) visualizer or a hidden/other view takes precedence.
            if (
                state.isRecording ||
                audio.analyser ||
                document.hidden ||
                !isLiveViewVisible()
            ) {
                idleRafId = null;
                return;
            }
            drawIdleFrame(now);
            idleRafId = requestAnimationFrame(loop);
        };
        idleRafId = requestAnimationFrame(loop);
    }

    function drawIdleFrame(t) {
        drawWaveform(idleAmplitudes(t));
    }

    function stopIdleAnimation() {
        if (idleRafId) {
            cancelAnimationFrame(idleRafId);
            idleRafId = null;
        }
    }

    function startVisualizer() {
        // The mic visualizer supersedes the idle "breathing" loop.
        stopIdleAnimation();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return;
        }
        // A dedicated stream for visualization; recognition uses its own mic input.
        navigator.mediaDevices
            .getUserMedia({ audio: true })
            .then(function (stream) {
                // The user may have stopped before permission resolved; if so,
                // release the freshly granted stream instead of leaking it.
                if (!state.isRecording) {
                    stream.getTracks().forEach(function (t) { t.stop(); });
                    return;
                }
                audio.stream = stream;
                var Ctx = window.AudioContext || window.webkitAudioContext;
                audio.context = new Ctx();
                audio.source = audio.context.createMediaStreamSource(stream);
                audio.analyser = audio.context.createAnalyser();
                audio.analyser.fftSize = 256;
                audio.analyser.smoothingTimeConstant = 0.8;
                audio.source.connect(audio.analyser);
                audio.data = new Uint8Array(audio.analyser.frequencyBinCount);
                renderVisualizerFrame();
            })
            .catch(function (err) {
                console.warn("Visualizer mic unavailable:", err);
            });
    }

    function renderVisualizerFrame() {
        if (!audio.analyser) {
            return;
        }
        audio.analyser.getByteFrequencyData(audio.data);

        var canvas = els.waveform;
        var dpr = window.devicePixelRatio || 1;
        var width = canvas.width / dpr;
        var step = 7;
        var bars = Math.floor(width / step);
        var amplitudes = [];
        var binCount = audio.data.length;
        for (var i = 0; i < bars; i++) {
            var idx = Math.floor((i / bars) * binCount * 0.7);
            amplitudes.push(audio.data[idx] / 255);
        }
        drawWaveform(amplitudes);
        audio.rafId = requestAnimationFrame(renderVisualizerFrame);
    }

    function stopVisualizer() {
        if (audio.rafId) {
            cancelAnimationFrame(audio.rafId);
            audio.rafId = null;
        }
        if (audio.source) {
            try { audio.source.disconnect(); } catch (e) {}
            audio.source = null;
        }
        if (audio.stream) {
            audio.stream.getTracks().forEach(function (t) { t.stop(); });
            audio.stream = null;
        }
        if (audio.context) {
            try { audio.context.close(); } catch (e) {}
            audio.context = null;
        }
        audio.analyser = null;
        // Return to the gentle resting animation (if the live view is showing).
        startIdleAnimation();
    }

    // =======================================================================
    // Azure Speech SDK wiring
    // =======================================================================

    function clearTokenRefreshTimer() {
        if (state.tokenRefreshTimer) {
            clearTimeout(state.tokenRefreshTimer);
            state.tokenRefreshTimer = null;
        }
    }

    function clearSpeechTokenCache() {
        clearTokenRefreshTimer();
        state.speechToken = null;
    }

    function parseTokenPayload(data) {
        var token = data && (data.token || data.authToken || data.accessToken);
        var region = data && data.region;
        var expiresAt = data && data.expiresAt ? Date.parse(data.expiresAt) : 0;
        var expiresIn = data && Number(data.expiresIn || data.expires_in || 0);

        if (!expiresAt && expiresIn > 0) {
            expiresAt = Date.now() + expiresIn * 1000;
        }
        if (!expiresAt) {
            expiresAt = Date.now() + 9 * 60 * 1000;
        }
        if (!token || !region) {
            throw new Error("Token endpoint must return JSON with token and region.");
        }
        return {
            token: token,
            region: region,
            expiresAt: expiresAt,
        };
    }

    function hasFreshSpeechToken() {
        return Boolean(
            state.speechToken &&
            Date.now() + TOKEN_REFRESH_SKEW_MS < state.speechToken.expiresAt
        );
    }

    function tokenEndpointError(err) {
        var message = err && err.message ? err.message : String(err || "");
        if (/failed to fetch|network/i.test(message)) {
            return "Could not reach the Speech token endpoint. Check the Function URL and CORS.";
        }
        if (/401|403/.test(message)) {
            return "Speech token endpoint rejected the request. Check Function auth and CORS settings.";
        }
        if (/429/.test(message)) {
            return "Speech token endpoint is rate limited. Wait a moment and try again.";
        }
        return "Speech token error: " + message;
    }

    function scheduleTokenRefresh() {
        clearTokenRefreshTimer();
        if (!state.speechToken) {
            return;
        }
        var delay = Math.max(
            30000,
            state.speechToken.expiresAt - Date.now() - TOKEN_REFRESH_SKEW_MS
        );
        state.tokenRefreshTimer = setTimeout(function () {
            if (!state.isRecording && !state.isFileProcessing) {
                state.tokenRefreshTimer = null;
                return;
            }
            fetchSpeechToken(true)
                .then(function (tokenInfo) {
                    if (state.recognizer) {
                        state.recognizer.authorizationToken = tokenInfo.token;
                    }
                })
                .catch(function (err) {
                    console.warn("Could not refresh Speech token:", err);
                    showToast(tokenEndpointError(err), "error");
                });
        }, delay);
    }

    function fetchSpeechToken(forceRefresh) {
        var s = getCurrentSettings();
        if (!forceRefresh && hasFreshSpeechToken()) {
            return Promise.resolve(state.speechToken);
        }
        return fetch(s.speechTokenEndpoint, {
            method: "GET",
            headers: { "Accept": "application/json" },
            cache: "no-store",
        })
            .then(function (res) {
                if (!res.ok) {
                    return res.text().then(function (body) {
                        throw new Error(
                            "HTTP " + res.status + (body ? ": " + body.slice(0, 120) : "")
                        );
                    });
                }
                return res.json();
            })
            .then(function (data) {
                state.speechToken = parseTokenPayload(data);
                scheduleTokenRefresh();
                return state.speechToken;
            });
    }

    function buildSpeechConfig() {
        var s = getCurrentSettings();
        if (!s.speechTokenEndpoint) {
            showToast("Token broker endpoint is not configured.", "error");
            activateTab("settings");
            return Promise.resolve(null);
        }
        if (!SpeechSDK) {
            showToast("Speech SDK failed to load. Check your connection.", "error");
            return Promise.resolve(null);
        }
        return fetchSpeechToken(false)
            .then(function (tokenInfo) {
                var config = SpeechSDK.SpeechConfig.fromAuthorizationToken(
                    tokenInfo.token,
                    tokenInfo.region
                );
                config.speechRecognitionLanguage = s.language;
                return config;
            })
            .catch(function (err) {
                console.warn("Could not get Speech token:", err);
                showToast(tokenEndpointError(err), "error");
                return null;
            });
    }

    function attachHandlers(recognizer, onStopped) {
        recognizer.recognizing = function (sender, event) {
            state.interimText = event.result.text || "";
            render();
        };

        recognizer.recognized = function (sender, event) {
            if (
                event.result.reason === SpeechSDK.ResultReason.RecognizedSpeech &&
                event.result.text
            ) {
                addSegment(event.result.text);
            } else {
                state.interimText = "";
                render();
            }
        };

        recognizer.canceled = function (sender, event) {
            state.interimText = "";
            if (event.reason === SpeechSDK.CancellationReason.Error) {
                console.error("Recognition canceled:", event.errorDetails);
                showToast(friendlyError(event.errorDetails || ""), "error");
            }
            if (onStopped) {
                onStopped();
            }
        };

        recognizer.sessionStopped = function () {
            state.interimText = "";
            if (onStopped) {
                onStopped();
            }
        };
    }

    function friendlyError(detail) {
        var lower = (detail || "").toLowerCase();
        if (lower.indexOf("websocket") !== -1 || lower.indexOf("1006") !== -1) {
            return "Connection failed. Check your key, region, and network.";
        }
        if (lower.indexOf("403") !== -1 || lower.indexOf("authentication") !== -1) {
            return "Authentication failed. Verify your token endpoint and Speech resource settings.";
        }
        if (
            lower.indexOf("format") !== -1 ||
            lower.indexOf("riff") !== -1 ||
            lower.indexOf("header") !== -1 ||
            lower.indexOf("unsupported") !== -1
        ) {
            return "Unsupported audio format. Use a PCM WAV file (e.g. 16 kHz mono).";
        }
        return "Recognition error: " + detail;
    }

    function safelyCloseRecognizer() {
        if (state.recognizer) {
            try {
                state.recognizer.close();
            } catch (err) {
                console.warn("Error closing recognizer:", err);
            }
            state.recognizer = null;
        }
    }

    // =======================================================================
    // Real-time microphone transcription
    // =======================================================================


    function stopRecording() {
        if (!state.isRecording || !state.recognizer) {
            return;
        }
        setBadge("Finishing…", "working");
        state.recognizer.stopContinuousRecognitionAsync(
            function () {
                finishRecordingUI();
                safelyCloseRecognizer();
            },
            function (err) {
                console.error("Failed to stop recognition:", err);
                finishRecordingUI();
                safelyCloseRecognizer();
            }
        );
    }

    function finishRecordingUI() {
        state.isStartingSpeech = false;
        state.isRecording = false;
        state.interimText = "";
        endCurrentSession();
        els.recordToggle.classList.remove("is-recording");
        els.recordToggleLabel.textContent = "Start Listening";
        els.fileInput.disabled = false;
        setBadge("Idle", "idle");
        stopTimer();
        stopVisualizer();
        clearTokenRefreshTimer();
        render();
        saveTranscripts();
    }

    function startRecording() {
        if (state.isRecording || state.isFileProcessing || state.isStartingSpeech) {
            return;
        }

        state.isStartingSpeech = true;
        setBadge("Connecting...", "working");

        buildSpeechConfig().then(function (speechConfig) {
            state.isStartingSpeech = false;
            if (!speechConfig) {
                setBadge("Idle", "idle");
                return;
            }

            var audioConfig;
            try {
                audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
            } catch (err) {
                console.error("Microphone unavailable:", err);
                showToast("Could not access the microphone.", "error");
                setBadge("Idle", "idle");
                return;
            }

            var recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
            attachHandlers(recognizer, function () {
                if (state.isRecording) {
                    finishRecordingUI();
                    safelyCloseRecognizer();
                }
            });
            state.recognizer = recognizer;

            beginSession("Microphone");
            state.interimText = "";
            rebuildFinalText();
            state.isRecording = true;
            activateTab("live");
            els.recordToggle.classList.add("is-recording");
            els.recordToggleLabel.textContent = "Stop Listening";
            els.fileInput.disabled = true;
            setBadge("Listening...", "listening");
            startTimer();
            startVisualizer();
            render();

            recognizer.startContinuousRecognitionAsync(
                function () {},
                function (err) {
                    console.error("Failed to start recognition:", err);
                    showToast(friendlyError(String(err)), "error");
                    finishRecordingUI();
                    safelyCloseRecognizer();
                }
            );
        });
    }

    function toggleRecording() {
        if (state.isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    }

    // =======================================================================
    // File transcription (.wav)
    // =======================================================================


    function finishFileUI(failed) {
        if (state.fileWatchdog) {
            clearTimeout(state.fileWatchdog);
            state.fileWatchdog = null;
        }
        if (!state.isFileProcessing) {
            return;
        }
        state.isFileProcessing = false;
        state.interimText = "";
        endCurrentSession();
        els.recordToggle.disabled = false;
        setBadge("Idle", "idle");
        safelyCloseRecognizer();
        clearTokenRefreshTimer();
        els.fileInput.value = "";
        render();
        saveTranscripts();

        if (!failed) {
            showToast("File transcription complete.", "success");
        }
    }

    function transcribeFile(file) {
        if (state.isRecording || state.isFileProcessing || state.isStartingSpeech || !file) {
            return;
        }

        var isWav =
            /\.wav$/i.test(file.name) ||
            file.type === "audio/wav" ||
            file.type === "audio/x-wav";
        if (!isWav) {
            showToast("Please choose a .wav file (PCM WAV format).", "error");
            return;
        }

        if (file.size > MAX_FILE_BYTES) {
            var sizeMb = Math.round(file.size / (1024 * 1024));
            showToast("That file is " + sizeMb + " MB. Please use a WAV under 50 MB.", "error");
            return;
        }

        state.isStartingSpeech = true;
        setBadge("Connecting...", "working");

        buildSpeechConfig().then(function (speechConfig) {
            state.isStartingSpeech = false;
            if (!speechConfig) {
                setBadge("Idle", "idle");
                return;
            }

            var audioConfig;
            try {
                audioConfig = SpeechSDK.AudioConfig.fromWavFileInput(file);
            } catch (err) {
                console.error("Could not read audio file:", err);
                showToast("Could not read that audio file.", "error");
                setBadge("Idle", "idle");
                return;
            }

            var recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
            state.recognizer = recognizer;
            state.isFileProcessing = true;
            beginSession(file.name);
            state.interimText = "";
            rebuildFinalText();

            activateTab("live");
            els.recordToggle.disabled = true;
            setBadge("Transcribing...", "working");

            state.fileWatchdog = setTimeout(function () {
                console.warn("File transcription watchdog fired.");
                showToast("Transcription timed out. The file may be too long or not PCM WAV.", "error");
                finishFileUI(true);
            }, FILE_WATCHDOG_MS);

            attachHandlers(recognizer, function () {
                finishFileUI(false);
            });

            recognizer.startContinuousRecognitionAsync(
                function () {},
                function (err) {
                    console.error("Failed to transcribe file:", err);
                    showToast(friendlyError(String(err)), "error");
                    finishFileUI(true);
                }
            );
        });
    }

    // =======================================================================
    // Copy / download / clear
    // =======================================================================

    // Shared clipboard helper (used by the right panel and per-session copy).
    function copyToClipboard(text, successMsg) {
        text = (text || "").trim();
        if (!text) {
            return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                function () { showToast(successMsg, "success"); },
                function () { fallbackCopy(text, successMsg); }
            );
        } else {
            fallbackCopy(text, successMsg);
        }
    }

    function copyTranscript() {
        copyToClipboard(state.finalText, "Transcript copied to clipboard.");
    }

    function fallbackCopy(text, successMsg) {
        var textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand("copy");
            showToast(successMsg || "Copied to clipboard.", "success");
        } catch (err) {
            showToast("Could not copy automatically.", "error");
        }
        document.body.removeChild(textarea);
    }

    function downloadTranscript() {
        var text = state.finalText.trim();
        if (!text) {
            return;
        }
        var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var link = document.createElement("a");
        var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        link.href = url;
        link.download = "lilywave-transcript-" + stamp + ".txt";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 0);
        showToast("Transcript downloaded.", "success");
    }

    function clearTranscript() {
        var currentSession = findSession(state.currentSessionId);
        var removedSegmentIds = [];

        if (currentSession && !state.isRecording && !state.isFileProcessing) {
            currentSession.text = sessionText(currentSession);
        }

        state.finalText = "";
        state.interimText = "";

        // Clear only the live/current transcript. Saved session records stay in
        // state.sessions and sessionStorage so the Transcript tab keeps history
        // for this browser tab.
        state.segments = state.segments.filter(function (seg) {
            if (seg.sessionId === state.currentSessionId) {
                removedSegmentIds.push(seg.id);
                return false;
            }
            return true;
        });
        state.polishQueue = state.polishQueue.filter(function (id) {
            return removedSegmentIds.indexOf(id) === -1;
        });
        saveTranscripts();
        render();
        renderTranscriptLog();
        showToast("Transcript cleared.");
    }

    // =======================================================================
    // Initialization
    // =======================================================================

    function hydrateSettings() {
        var saved = loadSettings();
        if (saved) {
            els.speechTokenEndpoint.value = saved.speechTokenEndpoint || "";
            if (saved.language) {
                els.languageSelect.value = saved.language;
            }
            if (saved.cleanupStyle) {
                els.cleanupStyle.value = saved.cleanupStyle;
            }
        }
        refreshAzureStatus();
    }

    function bindEvents() {
        els.tabs.forEach(function (tab) {
            tab.addEventListener("click", function () {
                activateTab(tab.getAttribute("data-tab"));
            });
        });

        Array.prototype.slice.call(document.querySelectorAll("[data-open-tab]")).forEach(function (button) {
            button.addEventListener("click", function () {
                activateTab(button.getAttribute("data-open-tab"));
            });
        });

        els.navSettingsBtn.addEventListener("click", function () {
            activateTab("settings");
            els.views.settings.scrollIntoView({ behavior: "smooth", block: "center" });
        });

        els.saveSettings.addEventListener("click", function () {
            try {
                normalizeTokenEndpointOverride(els.speechTokenEndpoint.value);
            } catch (err) {
                showToast(err.message, "error");
                els.speechTokenEndpoint.focus();
                return;
            }
            var s = getCurrentSettings();
            if (persistSettings(s)) {
                refreshAzureStatus();
                showToast("Settings saved.", "success");
                activateTab("live");
            }
        });

        els.clearSettings.addEventListener("click", function () {
            removeSessionItem(STORAGE_KEY);
            clearSpeechTokenCache();
            els.speechTokenEndpoint.value = "";
            refreshAzureStatus();
            showToast("Saved settings cleared.");
        });

        els.speechTokenEndpoint.addEventListener("input", refreshAzureStatus);
        els.cleanupStyle.addEventListener("change", refreshAzureStatus);

        els.recordToggle.addEventListener("click", toggleRecording);

        els.chooseFileBtn.addEventListener("click", function () {
            els.fileInput.click();
        });
        els.dropzone.addEventListener("click", function () {
            els.fileInput.click();
        });
        els.fileInput.addEventListener("change", function (event) {
            var file = event.target.files && event.target.files[0];
            transcribeFile(file);
        });

        els.copyBtn.addEventListener("click", copyTranscript);
        els.downloadBtn.addEventListener("click", downloadTranscript);
        els.clearBtn.addEventListener("click", clearTranscript);

        // Transcript list interaction (delegated so it survives re-renders):
        // a per-session Copy button, otherwise select the clicked entry.
        if (els.transcriptLog) {
            els.transcriptLog.addEventListener("click", function (event) {
                var copyBtn =
                    event.target.closest && event.target.closest(".log-entry__copy");
                if (copyBtn) {
                    event.stopPropagation();
                    copySessionText(copyBtn.getAttribute("data-session-id"));
                    return;
                }
                var entry = event.target.closest && event.target.closest(".log-entry");
                if (entry) {
                    selectSession(entry.getAttribute("data-session-id"));
                }
            });
            els.transcriptLog.addEventListener("keydown", function (event) {
                if (event.key !== "Enter" && event.key !== " ") {
                    return;
                }
                var entry = event.target.closest && event.target.closest(".log-entry");
                if (entry) {
                    event.preventDefault();
                    selectSession(entry.getAttribute("data-session-id"));
                }
            });
        }

        window.addEventListener("resize", function () {
            sizeCanvas();
            if (state.isRecording || audio.analyser) {
                return; // the live loop redraws at the new size on its next frame
            }
            startIdleAnimation();
        });

        // Pause the resting animation when the tab is backgrounded; resume it
        // when we return (if we're on the live view and not recording).
        document.addEventListener("visibilitychange", function () {
            if (document.hidden) {
                stopIdleAnimation();
            } else if (!state.isRecording && !audio.analyser && isLiveViewVisible()) {
                startIdleAnimation();
            }
        });

        window.addEventListener("beforeunload", function (event) {
            if (state.isRecording) {
                event.preventDefault();
                event.returnValue = "";
            }
        });
    }

    function init() {
        if (!SpeechSDK) {
            showToast("Speech SDK could not be loaded. Check your connection.", "error");
        }
        hydrateSettings();
        loadTranscripts();
        bindEvents();
        render();
        renderTranscriptLog();
        sizeCanvas();
        if (hasValidCredentials()) {
            startIdleAnimation();
        } else {
            activateTab("settings");
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
