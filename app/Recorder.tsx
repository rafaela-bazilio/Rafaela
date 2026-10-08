"use client";
import { useEffect, useRef, useState } from "react";
export default function Recorder({
  onAudio,
  onError,
}: {
  onAudio: (file: File) => void;
  onError: (error: string) => void;
}) {
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  useEffect(
    () => () => {
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  async function start() {
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw new Error(
          "Gravação requer navegador compatível e HTTPS. Você também pode anexar um áudio.",
        );
      const mime = [
        "audio/webm;codecs=opus",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((m) => MediaRecorder.isTypeSupported(m));
      if (!mime)
        throw new Error(
          "Formato de gravação não suportado; anexe um arquivo de áudio.",
        );
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const rec = new MediaRecorder(stream.current, { mimeType: mime }),
        parts: Blob[] = [];
      recorder.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) parts.push(e.data);
      };
      rec.onstop = () => {
        stream.current?.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const ext = mime.includes("mp4")
          ? "m4a"
          : mime.includes("ogg")
            ? "ogg"
            : "webm";
        onAudio(
          new File(parts, `audio-${Date.now()}.${ext}`, {
            type: mime.split(";")[0],
          }),
        );
      };
      rec.onerror = () => {
        stream.current?.getTracks().forEach((t) => t.stop());
        setRecording(false);
        onError("Falha na gravação.");
      };
      rec.start();
      setRecording(true);
      // Evitar gravações ilimitadas; o upload ainda valida tamanho e assinatura.
      setTimeout(() => {
        if (rec.state === "recording") rec.stop();
      }, 120000);
    } catch (error) {
      stream.current?.getTracks().forEach((t) => t.stop());
      onError((error as Error).message);
    }
  }
  return (
    <button
      className="secondary"
      type="button"
      onClick={() => (recording ? recorder.current?.stop() : void start())}
    >
      {recording ? "Parar gravação (máx. 2 min)" : "Gravar áudio"}
    </button>
  );
}
