// src/App.jsx
import React, { useEffect, useRef, useState } from "react";

/**
 * Realtime voice chat App (updated)
 * - Auto-detects user voice (VAD) during AI playback and sends interruption events.
 * - Forwards recorded MediaRecorder blobs to server via websocket.
 *
 * Adjust WS_URL to point to your relay server (wss://... in production).
 */

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
  { code: "es", label: "Spanish" },
  { code: "bn", label: "Bengali" },
];

const WS_URL =
  (window.location.protocol === "https:" ? "wss:" : "ws:") +
  "//localhost:8080/ws";

export default function App() {
  const [language, setLanguage] = useState(null);
  const [showChat, setShowChat] = useState(false);
  const [messages, setMessages] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [statusDots, setStatusDots] = useState("..........");

  // WebSocket
  const wsRef = useRef(null);
  const sessionIdRef = useRef(null);

  // Recording
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  // Audio playback & context
  const audioCtxRef = useRef(null);
  const isPlayingAudioRef = useRef(false); // whether AI audio is currently playing
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);

  // Mic monitoring (VAD)
  const micStreamRef = useRef(null);
  const analyserRef = useRef(null);
  const vadActiveRef = useRef(false);
  const vadAnimationRef = useRef(null);

  // timer for UI
  useEffect(() => {
    let timer;
    if (showChat) {
      timer = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    } else {
      setElapsedSec(0);
    }
    return () => clearInterval(timer);
  }, [showChat]);

  // status dots animation (assistant thinking)
  useEffect(() => {
    const id = setInterval(() => {
      setStatusDots((d) => {
        if (d.length >= 10) return ".";
        return d + "...........";
      });
    }, 400);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    audioCtxRef.current = new (window.AudioContext ||
      window.webkitAudioContext)();
    return () => {
      // cleanup
      try {
        audioCtxRef.current && audioCtxRef.current.close();
      } catch {}
    };
  }, []);

  // ------------------------
  // WebSocket helpers
  // ------------------------
  function ensureWebSocket() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    wsRef.current = new WebSocket(WS_URL);
    wsRef.current.binaryType = "arraybuffer";

    wsRef.current.onopen = () => {
      // send init with optional language label
      sessionIdRef.current = `user_${Date.now()}`;
      wsRef.current.send(
        JSON.stringify({
          type: "init",
          sessionId: sessionIdRef.current,
          language_label: language?.label,
        })
      );
      console.log("WS opened and init sent", sessionIdRef.current);
    };

    wsRef.current.onmessage = async (ev) => {
      if (typeof ev.data === "string") {
        try {
          const obj = JSON.parse(ev.data);
          handleJsonMsgFromServer(obj);
        } catch (e) {
          console.log("Text:", ev.data);
        }
      } else {
        // binary audio bytes from server (TTS)
        const arr = ev.data;
        await playAudioBuffer(arr);
      }
    };

    wsRef.current.onclose = () => {
      console.log("WS closed");
    };

    wsRef.current.onerror = (err) => {
      console.error("WS error", err);
    };
  }

  function sendJson(obj) {
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(obj));
      } else {
        console.warn("WS not open; dropping message", obj);
      }
    } catch (e) {
      console.error("sendJson err", e);
    }
  }

  function handleJsonMsgFromServer(obj) {
    // server sends events like {type: 'inited'}, {type:'transcript', text:...}, {type:'assistant', text:...}
    if (!obj || !obj.type) return;
    if (obj.type === "inited") {
      console.log("Session inited:", obj.sessionId || obj.sessionId);
    } else if (obj.type === "transcript") {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: `(transcript) ${obj.text}`,
          ts: new Date().toISOString(),
        },
      ]);
    } else if (obj.type === "assistant") {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: obj.text, ts: new Date().toISOString() },
      ]);
    } else {
      // generic event
      setMessages((m) => [
        ...m,
        {
          role: "system",
          text: JSON.stringify(obj).slice(0, 200),
          ts: new Date().toISOString(),
        },
      ]);
    }
  }

  // ------------------------
  // VAD (simple RMS-based)
  // ------------------------
  async function startMicMonitor() {
    if (analyserRef.current) return; // already running
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      micStreamRef.current = stream;
      const audioCtx =
        audioCtxRef.current ||
        new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = audioCtx;
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      analyserRef.current = analyser;
      vadActiveRef.current = true;
      runVadLoop();
    } catch (e) {
      console.warn("Could not start mic monitor:", e);
    }
  }

  function stopMicMonitor() {
    vadActiveRef.current = false;
    if (vadAnimationRef.current) {
      cancelAnimationFrame(vadAnimationRef.current);
      vadAnimationRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
  }

  // parameters for VAD
  const VAD_RMS_THRESHOLD = 0.02; // tune this (0.02 is a good starting point)
  const VAD_SUSTAIN_MS = 180; // require voice to be present for ~180ms to be considered real speech

  let vadLastAboveAt = 0;

  function computeRMS(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i] / 128 - 1; // convert uint8 to -1..1
      sum += v * v;
    }
    return Math.sqrt(sum / arr.length);
  }

  function runVadLoop() {
    if (!vadActiveRef.current || !analyserRef.current) return;
    const analyser = analyserRef.current;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    const rms = computeRMS(data);
    const now = performance.now();

    if (rms > VAD_RMS_THRESHOLD) {
      // mark time above threshold
      if (!vadLastAboveAt) vadLastAboveAt = now;
      // if sustained
      if (now - vadLastAboveAt > VAD_SUSTAIN_MS) {
        // user is speaking
        if (isPlayingAudioRef.current) {
          // user interrupts! send interruption once and reset detection to avoid spamming
          console.log(
            "VAD detected user speak during AI playback -> sending interruption"
          );
          sendJson({ type: "interruption" });
          // also stop current playback locally if desired (optional)
          // set a small cooldown
          vadLastAboveAt = 0;
        }
      }
    } else {
      vadLastAboveAt = 0;
    }

    vadAnimationRef.current = requestAnimationFrame(runVadLoop);
  }

  // ------------------------
  // MediaRecorder: record audio and send to server
  // ------------------------
  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Audio recording is not supported in this browser.");
      return;
    }
    ensureWebSocket();
    // ensure mic monitor runs so VAD can detect interruption too
    startMicMonitor();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunksRef.current = [];
      const options = { mimeType: "audio/webm" };
      const mr = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
          // send small chunk to server as ArrayBuffer to enable low-latency streaming
          e.data.arrayBuffer().then((ab) => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(ab);
            }
          });
        }
      };

      mr.onstop = () => {
        // create final blob and show in transcript as placeholder
        const blob = new Blob(recordedChunksRef.current, {
          type: "audio/webm",
        });
        const ts = new Date().toISOString();
        setMessages((m) => [...m, { role: "user", text: `[audio blob]`, ts }]);
        // Stop mic monitor only if not needed for VAD later (we keep monitor running while chat open)
        // mr.stream tracks stopped below
      };

      mr.start(150); // timeslice - sends chunks ~150ms
      setIsRecording(true);
    } catch (err) {
      console.error("startRecording err", err);
      alert("Could not start recording: " + (err.message || err));
    }
  }

  function stopRecording() {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;
    }
    setIsRecording(false);
    // keep mic monitor running so interruption detection remains active (we only stop monitor when chat ends)
  }

  function toggleRecord() {
    if (isRecording) stopRecording();
    else startRecording();
  }

  // ------------------------
  // Audio playback helper (decode + play then mark flags)
  // ------------------------
  async function playAudioBuffer(arrayBuffer) {
    try {
      const audioCtx = audioCtxRef.current;
      if (!audioCtx) return;
      // decode audio (works for WAV/MP3/ogg/opus)
      const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      // create buffer source
      const src = audioCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(audioCtx.destination);

      // set playing flags
      isPlayingAudioRef.current = true;
      setIsPlayingAudio(true);

      src.onended = () => {
        isPlayingAudioRef.current = false;
        setIsPlayingAudio(false);
      };

      src.start();
    } catch (e) {
      console.error("Failed to decode/play audio:", e);
      // reset playing flags if decode fails
      isPlayingAudioRef.current = false;
      setIsPlayingAudio(false);
    }
  }

  // ------------------------
  // UI handlers
  // ------------------------
  function handleEndChat() {
    setShowChat(false);
    setMessages([]);
    setIsRecording(false);
    setElapsedSec(0);
    stopMicMonitor();
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
  }

  function sendTextToAssistant(text) {
    // local simulate + server instruct (optional)
    const userMsg = { role: "user", text, ts: new Date().toISOString() };
    setMessages((m) => [...m, userMsg]);
    // ensure WS and send as control instruct to provider via server
    ensureWebSocket();
    sendJson({ type: "ttstext", text });
  }

  // start chat: open WS and mic monitor
  function startChat() {
    setShowChat(true);
    ensureWebSocket();
    startMicMonitor();
  }

  // UI rendering (mostly same as your original)
  function formatTimer(sec) {
    const mm = Math.floor(sec / 60)
      .toString()
      .padStart(2, "0");
    const ss = (sec % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  }

  return (
    <div className="app-root">
      {!showChat ? (
        <div className="center-card language-card">
          <h1>Choose a language to start</h1>
          <div className="language-grid">
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                className={`lang-btn ${
                  language?.code === l.code ? "active" : ""
                }`}
                onClick={() => setLanguage(l)}
              >
                {l.label}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 18 }}>
            <button
              className="start-btn"
              disabled={!language}
              onClick={startChat}
            >
              Start Chat {language ? `(${language.label})` : ""}
            </button>
          </div>
        </div>
      ) : (
        <div className="center-card chat-card">
          <div className="video-card">
            <div className="timer-badge">
              Time remaining {formatTimer(elapsedSec)}
            </div>

            <div className="video-placeholder">
              <div className="fake-content">
                <div className="portrait"> </div>
              </div>
            </div>

            <div className="ui-overlay">
              <div className="left-controls">
                <button
                  className={`icon-btn ${isRecording ? "recording" : ""}`}
                  onClick={toggleRecord}
                  title="Record (mic)"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20">
                    <path
                      fill="currentColor"
                      d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"
                    />
                    <path
                      fill="currentColor"
                      d="M19 11a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 0 0 2 0v-3.08A7 7 0 0 0 19 11z"
                    />
                  </svg>
                </button>

                <button
                  className="icon-btn"
                  onClick={() => setShowTranscript(true)}
                  title="Transcript / History"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20">
                    <path
                      fill="currentColor"
                      d="M4 5h16v2H4zM4 11h16v2H4zM4 17h16v2H4z"
                    />
                  </svg>
                </button>
              </div>

              <div className="center-control">
                <div
                  className="text-pill"
                  onClick={() => {
                    const text = prompt(
                      "Type a message to send to assistant:",
                      ""
                    );
                    if (text) {
                      sendTextToAssistant(text);
                      // simulate assistant reply locally appended by server events normally
                      setTimeout(() => {
                        setMessages((m) => [
                          ...m,
                          {
                            role: "assistant",
                            text: `Reply to "${text}" (${language.label})`,
                            ts: new Date().toISOString(),
                          },
                        ]);
                      }, 900);
                    }
                  }}
                >
                  {statusDots}
                </div>
              </div>

              <div className="right-controls">
                <button className="end-btn" onClick={handleEndChat}>
                  End Chat
                </button>
              </div>
            </div>
          </div>

          {/* Transcript modal */}
          {showTranscript && (
            <div className="modal">
              <div className="modal-content">
                <h3>Transcript</h3>
                <div className="transcript-list">
                  {messages.length === 0 && (
                    <div className="empty">No messages yet</div>
                  )}
                  {messages.map((m, idx) => (
                    <div key={idx} className={`transcript-item ${m.role}`}>
                      <div className="role">{m.role}</div>
                      <div className="text">{m.text}</div>
                      <div className="ts">
                        {new Date(m.ts).toLocaleTimeString()}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ textAlign: "right", marginTop: 12 }}>
                  <button
                    onClick={() => setShowTranscript(false)}
                    className="ok-btn"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* small indicator that AI audio is playing */}
          <div style={{ position: "absolute", bottom: 14, left: 16 }}>
            <small>AI playing: {isPlayingAudio ? "yes" : "no"}</small>
          </div>
        </div>
      )}
    </div>
  );
}
