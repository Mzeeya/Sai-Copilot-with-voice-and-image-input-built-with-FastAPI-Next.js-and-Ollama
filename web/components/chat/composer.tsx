"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUpIcon, ImageIcon, LoaderCircleIcon, MicIcon, SquareIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { APP_CONFIG } from "@/lib/config";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";
const MAX_IMAGES = 4;

// Shrink a picture so it is fast to send, fast for the model, and small to store.
async function resizeImage(file: File, maxSide = 1024): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported");
  ctx.fillStyle = "#ffffff"; // transparent PNGs get a white background
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

// Convert the recording into a 16 kHz mono WAV file
async function toWav16k(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();

  const length = decoded.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / decoded.numberOfChannels;
  }

  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  placeholder = `Message ${APP_CONFIG.appName}…`,
  autoFocus,
}: {
  onSend: (text: string, images?: string[]) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (autoFocus && window.matchMedia("(min-width: 768px)").matches) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    return () => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    };
  }, []);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (streaming) return onStop();
    if ((!value.trim() && images.length === 0) || disabled) return;
    onSend(value, images);
    setValue("");
    setImages([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const touch = window.matchMedia("(hover: none)").matches;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touch) {
      e.preventDefault();
      submit();
    }
  };

  // ---- Image attach ----
  const onPickImages = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow picking the same file again
    if (files.length === 0) return;
    setMicError(null);

    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setMicError(`You can attach up to ${MAX_IMAGES} images.`);
      return;
    }
    try {
      const picked = files.filter((f) => f.type.startsWith("image/")).slice(0, room);
      const resized = await Promise.all(picked.map((f) => resizeImage(f)));
      setImages((prev) => [...prev, ...resized]);
    } catch (err) {
      console.error(err);
      setMicError("Could not read that image.");
    }
  };

  const removeImage = (index: number) => setImages((prev) => prev.filter((_, i) => i !== index));

  // ---- Voice input ----
  const transcribe = async (blob: Blob) => {
    setTranscribing(true);
    try {
      const wav = await toWav16k(blob);
      const form = new FormData();
      form.append("audio", wav, "recording.wav");
      const res = await fetch(`${API_URL}/api/transcribe`, { method: "POST", body: form });
      if (!res.ok) {
        console.error("Transcribe error:", res.status, await res.text());
        throw new Error(`Server returned ${res.status}`);
      }
      const data = await res.json();
      if (data.text) setValue((prev) => (prev ? prev + " " : "") + data.text);
      ref.current?.focus();
    } catch (err) {
      console.error(err);
      setMicError(err instanceof Error ? err.message : "Could not transcribe audio.");
    } finally {
      setTranscribing(false);
    }
  };

  const toggleRecording = async () => {
    setMicError(null);

    if (recording) {
      recorderRef.current?.stop();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        transcribe(new Blob(chunksRef.current, { type: recorder.mimeType }));
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setMicError("Microphone access was denied or is not available.");
    }
  };

  const canSend = streaming || ((!!value.trim() || images.length > 0) && !disabled);

  return (
    <form
      onSubmit={submit}
      className="mx-auto w-full max-w-3xl rounded-3xl border bg-card p-2.5 pl-4 shadow-sm transition-colors focus-within:border-ring"
    >
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 pr-1.5">
          {images.map((src, i) => (
            <div key={i} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Attachment ${i + 1}`} className="size-16 rounded-xl border object-cover" />
              <button
                type="button"
                onClick={() => removeImage(i)}
                aria-label="Remove image"
                className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <label htmlFor="composer" className="sr-only">
        Message
      </label>
      <textarea
        id="composer"
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={recording ? "Listening… click the mic to stop" : placeholder}
        enterKeyHint="send"
        className="field-sizing-content max-h-52 min-h-7 w-full resize-none bg-transparent py-1.5 text-[15px] leading-6 outline-none placeholder:text-muted-foreground"
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onPickImages}
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-xs text-destructive">{micError}</span>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => fileRef.current?.click()}
            disabled={disabled || images.length >= MAX_IMAGES}
            aria-label="Attach image"
            className="rounded-full"
          >
            <ImageIcon />
          </Button>
          <Button
            type="button"
            size="icon"
            variant={recording ? "destructive" : "ghost"}
            onClick={toggleRecording}
            disabled={transcribing || disabled}
            aria-label={recording ? "Stop recording" : "Start voice input"}
            className={cn("rounded-full", recording && "animate-pulse")}
          >
            {transcribing ? <LoaderCircleIcon className="animate-spin" /> : <MicIcon />}
          </Button>
          <Button
            type="submit"
            size="icon"
            disabled={!canSend}
            aria-label={streaming ? "Stop generating" : "Send message"}
            className={cn("rounded-full", !canSend && "opacity-30")}
          >
            {streaming ? <SquareIcon className="size-3.5 fill-current" /> : <ArrowUpIcon />}
          </Button>
        </div>
      </div>
    </form>
  );
}