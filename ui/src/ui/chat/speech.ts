/**
 * Custom STT/TTS for OpenClaw using local Cohere STT server.
 * STT: Records in webm/opus, converts to WAV 16kHz for server compatibility.
 */

console.log("[SPEECH] Module loading...");

declare global {
  interface Window {
    STT_SERVER_URL?: string;
    STT_API_KEY?: string;
  }
}

function getSttServerUrl(): string {
  return "http://localhost:8890";
}

// ─── Audio Feedback Sounds ───

let beepAudioContext: AudioContext | null = null;

function playBeep(frequency: number = 800, duration: number = 0.15, volume: number = 0.2): void {
  try {
    if (!beepAudioContext) {
      beepAudioContext = new AudioContext();
    }
    const oscillator = beepAudioContext.createOscillator();
    const gainNode = beepAudioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(beepAudioContext.destination);

    oscillator.frequency.value = frequency;
    oscillator.type = "sine";

    // Soft attack and release for less harsh sound
    const now = beepAudioContext.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(volume, now + 0.02); // 20ms attack
    gainNode.gain.setValueAtTime(volume, now + duration - 0.03);
    gainNode.gain.linearRampToValueAtTime(0, now + duration); // 30ms release

    oscillator.start(now);
    oscillator.stop(now + duration);
  } catch (e) {
    console.error("[SPEECH] Failed to play beep:", e);
  }
}

function playDoneSound(): void {
  // Pleasant soft ascending chime for completion
  playBeep(392, 0.15, 0.1); // G4 - softer low tone
  setTimeout(() => playBeep(494, 0.15, 0.1), 120); // B4 - softer
  setTimeout(() => playBeep(587, 0.18, 0.1), 240); // D5 - softer
}

function playStartSound(): void {
  // Soft low tone
  playBeep(440, 0.1, 0.15); // A4
}

function playStopSound(): void {
  // Clear two-tone descending "bip-bop" sound
  playBeep(880, 0.08, 0.25); // High A5 - distinct
  setTimeout(() => playBeep(440, 0.12, 0.25), 120); // A4 - clear drop
}

// ─── STT (Speech-to-Text) via Cohere Server ───

export type SttCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
};

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let sttCallbacks: SttCallbacks | null = null;
let audioContext: AudioContext | null = null;
let pageDownHandler: ((e: KeyboardEvent) => void) | null = null;
let currentSessionId: number = 0;

// Global PageDown handler for voice recording toggle
export function initVoiceShortcut(): void {
  console.log("[VOICE] initVoiceShortcut called");
  if (pageDownHandler) {
    return;
  }

  pageDownHandler = (e: KeyboardEvent) => {
    if (e.key === "PageDown") {
      e.preventDefault();
      console.log("[VOICE] PageDown pressed, toggling recording, state:", mediaRecorder?.state);

      if (mediaRecorder && mediaRecorder.state === "recording") {
        console.log("[VOICE] Stopping recording via PageDown");
        stopStt();
      } else if (!mediaRecorder || mediaRecorder.state === "inactive") {
        console.log("[VOICE] Starting recording via PageDown");
        // Set up callbacks BEFORE starting
        sttCallbacks = {
          onTranscript: (text, isFinal) => {
            if (isFinal) {
              const textarea = document.querySelector(
                ".agent-chat__input textarea",
              ) as HTMLTextAreaElement;
              console.log("[VOICE] Found textarea:", !!textarea);
              if (textarea) {
                const current = textarea.value;
                const sep = current && !current.endsWith(" ") ? " " : "";
                textarea.value = current + sep + text;
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
                console.log("[VOICE] Added to textarea:", text);
              } else {
                console.log("[VOICE] Textarea not found, trying alternative selectors");
                // Try alternative selectors
                const alt = document.querySelector("textarea") as HTMLTextAreaElement;
                console.log("[VOICE] Fallback textarea:", !!alt);
              }
            }
          },
          onStart: () => {
            playStartSound();
            console.log("[VOICE] Recording started");
          },
          onEnd: () => {
            playStopSound();
            console.log("[VOICE] Recording ended");
          },
          onError: (err) => console.error("[VOICE] Error:", err),
        };
        startStt(sttCallbacks);
      }
    }
  };

  document.addEventListener("keydown", pageDownHandler);
  console.log("[VOICE] PageDown shortcut initialized");
}

export function cleanupVoiceShortcut(): void {
  if (pageDownHandler) {
    document.removeEventListener("keydown", pageDownHandler);
    pageDownHandler = null;
  }
}

export function isSttSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
  );
}

// Convert webm audio blob to WAV 16kHz using Web Audio API
async function convertToWav(audioBlob: Blob): Promise<Blob> {
  const arrayBuffer = await audioBlob.arrayBuffer();

  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: 16000 });
  }

  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  // Create WAV file
  const wavBuffer = audioBufferToWav(audioBuffer);
  return new Blob([wavBuffer], { type: "audio/wav" });
}

// Convert AudioBuffer to WAV format
function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = 1; // Mono
  const sampleRate = 16000;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Write audio samples
  const channelData = buffer.getChannelData(0);
  let offset = 44;
  for (let i = 0; i < channelData.length; i++) {
    const sample = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return arrayBuffer;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

async function sendToSttServer(wavBlob: Blob): Promise<string> {
  const formData = new FormData();
  formData.append("file", wavBlob, "audio.wav");
  formData.append("model", "base");
  formData.append("language", "de");

  const serverUrl = getSttServerUrl();

  const response = await fetch(`${serverUrl}/v1/audio/transcriptions`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`STT server error: ${response.status} - ${text}`);
  }

  const result = await response.json();
  return result.text || "";
}

export function startStt(callbacks: SttCallbacks): boolean {
  if (!isSttSupported()) {
    callbacks.onError?.("MediaRecorder is not supported in this browser");
    return false;
  }

  stopStt();
  currentSessionId++;
  sttCallbacks = callbacks;
  audioChunks = [];

  navigator.mediaDevices
    .getUserMedia({ audio: true, video: false })
    .then((stream) => {
      const mimeType = "audio/webm;codecs=opus";
      console.log("[STT] Recording with mimeType:", mimeType);

      mediaRecorder = new MediaRecorder(stream, { mimeType });

      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      const sessionId = currentSessionId;

      mediaRecorder.onstop = async () => {
        console.log("[STT] Recording stopped, sessionId:", sessionId, "current:", currentSessionId);

        // Only process if this is still the current session
        if (sessionId !== currentSessionId) {
          console.log("[STT] Ignoring old session callback");
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        if (audioChunks.length === 0) {
          sttCallbacks?.onError?.("No audio recorded");
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        const audioBlob = new Blob(audioChunks, { type: mimeType });
        console.log("[STT] Audio blob size:", audioBlob.size, "bytes");

        try {
          const wavBlob = await convertToWav(audioBlob);
          console.log("[STT] WAV blob size:", wavBlob.size, "bytes");

          // Play stop sound BEFORE sending to server (when audio file is ready)
          playStopSound();

          const text = await sendToSttServer(wavBlob);
          console.log("[STT] Transcription:", text);

          if (text && sttCallbacks && sessionId === currentSessionId) {
            console.log("[STT] Calling onTranscript with:", text);
            playDoneSound(); // Play completion sound when transcription done
            sttCallbacks.onTranscript(text, true);
          }
        } catch (error) {
          console.error("[STT] Error:", error);
          if (sessionId === currentSessionId) {
            sttCallbacks?.onError?.(`Transcription failed: ${String(error)}`);
          }
        } finally {
          stream.getTracks().forEach((track) => track.stop());
          audioChunks = [];
        }
      };

      mediaRecorder.addEventListener("error", (error) => {
        console.error("[STT] MediaRecorder error:", error);
        const msg = error instanceof ErrorEvent ? error.message : String(error);
        callbacks.onError?.(`MediaRecorder error: ${msg}`);
        stream.getTracks().forEach((track) => track.stop());
      });

      mediaRecorder.start(1000);
      callbacks.onStart?.();
      console.log("[STT] Recording started");
    })
    .catch((error) => {
      console.error("[STT] Microphone error:", error);
      if (error.name === "NotAllowedError") {
        callbacks.onError?.("Microphone permission denied.");
      } else if (error.name === "NotFoundError") {
        callbacks.onError?.("No microphone found.");
      } else {
        callbacks.onError?.(`Microphone error: ${error.message}`);
      }
    });

  return true;
}

export function stopStt(): void {
  console.log("[STT] stopStt called");
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
}

export function isSttActive(): boolean {
  return mediaRecorder !== null && mediaRecorder.state === "recording";
}

// ─── TTS (Text-to-Speech) ───

export function isTtsSupported(): boolean {
  return "speechSynthesis" in globalThis;
}

let currentUtterance: SpeechSynthesisUtterance | null = null;

export function speakText(
  text: string,
  opts?: {
    onStart?: () => void;
    onEnd?: () => void;
    onError?: (error: string) => void;
  },
): boolean {
  if (!isTtsSupported()) {
    opts?.onError?.("Speech synthesis is not supported in this browser");
    return false;
  }

  stopTts();

  const cleaned = stripMarkdown(text);
  if (!cleaned.trim()) {
    return false;
  }

  const utterance = new SpeechSynthesisUtterance(cleaned);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  utterance.addEventListener("start", () => opts?.onStart?.());
  utterance.addEventListener("end", () => {
    if (currentUtterance === utterance) {
      currentUtterance = null;
    }
    opts?.onEnd?.();
  });
  utterance.addEventListener("error", (e) => {
    if (currentUtterance === utterance) {
      currentUtterance = null;
    }
    if (e.error === "canceled" || e.error === "interrupted") {
      return;
    }
    opts?.onError?.(e.error);
  });

  currentUtterance = utterance;
  speechSynthesis.speak(utterance);
  return true;
}

export function stopTts(): void {
  if (currentUtterance) {
    currentUtterance = null;
  }
  if (isTtsSupported()) {
    speechSynthesis.cancel();
  }
}

export function isTtsSpeaking(): boolean {
  return isTtsSupported() && speechSynthesis.speaking;
}

/** Strip common markdown syntax for cleaner speech output. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\(.*?\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*{1,3}(.*?)\*{1,3}/g, "$1")
    .replace(/_{1,3}(.*?)_{1,3}/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Initialize PageDown shortcut when module loads
initVoiceShortcut();
