import React, { useEffect, useRef, useState } from "react";
import LanguageSelector from "./components/LanguageSelector";
import VideoCard from "./components/VideoCard";
import TranscriptModal from "./components/TranscriptModal";
const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
];

const WS_URL =(window.location.protocol === "https:" ? "wss:" : "ws:") +"//localhost:8080/ws";
const INPUT_SAMPLE_RATE = 44100; 
const OUTPUT_SAMPLE_RATE = 24000; 
export default function App() {
  const [language, setLanguage] = useState(null);
  const [showChat, setShowChat] = useState(false);
  const [messages, setMessages] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [statusDots, setStatusDots] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const wsRef = useRef(null);
  const sessionIdRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const workletNodeRef = useRef(null);
  const audioCtxRef = useRef(null);
  const isPlayingAudioRef = useRef(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const audioQueueRef = useRef([]);
  const currentSourceRef = useRef(null);
  const micStreamRef = useRef(null);
  const analyserRef = useRef(null);
  const vadActiveRef = useRef(false);
  const vadAnimationRef = useRef(null);
  const greetingSentRef = useRef(false);
  useEffect(() => {
    if (!isThinking) {
      setStatusDots("");
      return;
    }
    const id = setInterval(() => {
      setStatusDots((d) => {
        const next = (d || ".") + ".";
        return next.length > 10 ? "." : next;
      });
    }, 350);
    return () => clearInterval(id);
  }, [isThinking]);
  useEffect(() => {
    audioCtxRef.current = new (window.AudioContext ||
      window.webkitAudioContext)();
    return () => {
      try {
        audioCtxRef.current && audioCtxRef.current.close();
      } catch {}
    };
  }, []);
  function ensureWebSocket() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    wsRef.current = new WebSocket(WS_URL);
    wsRef.current.binaryType = "arraybuffer";
    wsRef.current.onopen = () => {
      sessionIdRef.current = `user_${Date.now()}`;
      wsRef.current.send(
        JSON.stringify({
          type: "init",
          sessionId: sessionIdRef.current,
          language: language?.label,
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
        audioQueueRef.current.push(ev.data);
        setIsThinking(true);
        if (!isPlayingAudioRef.current) {
          processAudioQueue();
        }
      }
    };
    wsRef.current.onclose = () => {
      console.log("WS closed");
    };
    wsRef.current.onerror = (err) => {
      console.error("WS error", err);
    };
  }
  // This useEffect triggers the initial greeting
  useEffect(() => {
    if (
      messages.length > 0 &&
      messages[0].type === "inited" &&
      !greetingSentRef.current
    ) {
      sendJson({ type: "greeting", language: language?.label });
      greetingSentRef.current = true;
    }
  }, [messages, language?.label]);

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
    if (!obj || !obj.type) return;

    if (obj.type === "inited") {
      setMessages((m) => [{ type: "inited", text: "Session initialized." }]);
    } else if (obj.type === "response.created") {
      setIsThinking(true);
    } else if (obj.type === "response.output_audio_transcript.delta") {
      const newText = obj.text;
      if (newText) {
        setMessages((m) => {
          const lastMessage = m[m.length - 1];
          if (lastMessage && lastMessage.role === "assistant") {
            return [
              ...m.slice(0, -1),
              { ...lastMessage, text: lastMessage.text + newText },
            ];
          } else {
            return [
              ...m,
              {
                role: "assistant",
                text: newText,
                ts: new Date().toISOString(),
              },
            ];
          }
        });
      }
    } else if (obj.type === "response.output_text.done") {
      setMessages((m) => {
        const lastMessage = m[m.length - 1];
        if (lastMessage && lastMessage.role === "assistant") {
          return [...m.slice(0, -1), { ...lastMessage, text: obj.text }];
        } else {
          return [
            ...m,
            { role: "assistant", text: obj.text, ts: new Date().toISOString() },
          ];
        }
      });
    } else if (obj.type === "response.done") {

      setIsThinking(false);
    } else if (obj.type === "input_audio_buffer.committed") {
      // This is a workaround to display the user's input since the API is not providing a direct transcript event for it.
      setMessages((m) => {
        const lastMessage = m[m.length - 1];
        if (lastMessage && lastMessage.role === "user") {
          return [...m];
        } else {
          return [
            ...m,
            { role: "user", text: "...", ts: new Date().toISOString() },
          ];
        }
      });
    } else {
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

  async function startMicMonitor() {
    if (analyserRef.current) return;
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
  const VAD_RMS_THRESHOLD = 0.02; 
  const VAD_SUSTAIN_MS = 180;

  let vadLastAboveAt = 0;

  function computeRMS(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i] / 128 - 1; 
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
      if (!vadLastAboveAt) {
        vadLastAboveAt = now;
      }
      if (now - vadLastAboveAt > VAD_SUSTAIN_MS) {
        if (isPlayingAudioRef.current) {
          console.log("VAD barge-in: stopping playback and interrupting");
          // Immediately stop current playback and clear pending audio for instant barge-in
          stopPlayback();
          sendJson({ type: "interruption" });
          vadLastAboveAt = 0;
        }
      }
    } else {
      vadLastAboveAt = 0;
    }

    vadAnimationRef.current = requestAnimationFrame(runVadLoop);
  }

  // removed unused resample and float32To16BitPCM

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Audio recording is not supported in this browser.");
      return;
    }
    ensureWebSocket();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: INPUT_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      const audioCtx = audioCtxRef.current;
      if (!audioCtx) {
        console.error("Audio context not available.");
        return;
      }

      // Add the audio worklet
      await audioCtx.audioWorklet.addModule("/audio-processor.js");

      const source = audioCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      const workletNode = new AudioWorkletNode(audioCtx, "audio-processor");
      workletNodeRef.current = workletNode;

      // Handle messages from the worklet
      workletNode.port.onmessage = (event) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(event.data);
        }
      };

      source.connect(workletNode);
      workletNode.connect(audioCtx.destination);

      micStreamRef.current = stream;
      setIsRecording(true);
    } catch (err) {
      console.error("startRecording err", err);
      alert("Could not start recording: " + (err.message || err));
    }
  }

  function stopRecording() {
    setIsRecording(false);
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
  }

  function toggleRecord() {
    if (isRecording) {
      stopRecording();
      sendJson({ type: "input_audio_buffer.commit" });
    } else {
      startRecording();
    }
  }
  // Audio playback helper (decode + play then mark flags)
  async function processAudioQueue() {
    if (audioQueueRef.current.length === 0) {
      isPlayingAudioRef.current = false;
      setIsPlayingAudio(false);
      setIsThinking(false);
      return;
    }
    isPlayingAudioRef.current = true;
    setIsPlayingAudio(true);

    const arrayBuffer = audioQueueRef.current.shift();
    const audioCtx = audioCtxRef.current;
    if (!audioCtx) return;

    try {
      // Convert raw PCM16 mono (24kHz) to an AudioBuffer and play it
      const pcmBuffer = ensureEvenByteArrayBuffer(arrayBuffer);
      const int16 = new Int16Array(pcmBuffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 0x8000;
      }
      const audioBuffer = audioCtx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
      audioBuffer.copyToChannel(float32, 0);

      const src = audioCtx.createBufferSource();
      currentSourceRef.current = src;
      src.buffer = audioBuffer;
      src.connect(audioCtx.destination);
      src.onended = () => {
        // Clear reference when a chunk finishes, then continue with queue
        if (currentSourceRef.current === src) currentSourceRef.current = null;
        processAudioQueue();
      };
      src.start();
    } catch (e) {
      console.error("Failed to play PCM16 audio chunk:", e);
      processAudioQueue();
    }
  }

  function stopPlayback() {
    try {
      if (currentSourceRef.current) {
        currentSourceRef.current.stop();
        currentSourceRef.current.disconnect();
        currentSourceRef.current = null;
      }
    } catch {}
    audioQueueRef.current = [];
    isPlayingAudioRef.current = false;
    setIsPlayingAudio(false);
  }

  function ensureEvenByteArrayBuffer(buf) {
    // Make sure the buffer length is a multiple of 2 bytes for Int16
    const u8 = new Uint8Array(buf);
    if (u8.byteLength % 2 === 0) return buf;
    return u8.buffer.slice(0, u8.byteLength - 1);
  }
  // UI handlers (end chat removed)

  // start chat: open WS and mic monitor
  function startChat() {
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume();
    }
    setShowChat(true);
    ensureWebSocket();
    startMicMonitor();
  }

  // end chat handler
  function handleEndChat() {
    setShowChat(false);
    setMessages([]);
    setIsRecording(false);
    stopMicMonitor();
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
  }

  // removed unused formatTimer

  return (
    <div className="app-root">
      {!showChat ? (
        <LanguageSelector
          languages={LANGUAGES}
          language={language}
          onSelect={setLanguage}
          onStart={startChat}
        />
      ) : (
        <>
          <VideoCard
            isRecording={isRecording}
            onToggleRecord={toggleRecord}
            onOpenTranscript={() => setShowTranscript(true)}
            onEndChat={handleEndChat}
          >
            {isThinking ? (
              <div className="text-pill" aria-live="polite">{statusDots}</div>
            ) : null}
          </VideoCard>
          <TranscriptModal
            open={showTranscript}
            messages={messages}
            onClose={() => setShowTranscript(false)}
          />
          <div style={{ position: "absolute", bottom: 14, left: 16 }}><small>AI playing: {isPlayingAudio ? "yes" : "no"}</small></div>
        </>
      )}
    </div>
  );
}
