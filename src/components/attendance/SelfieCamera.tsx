import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, RefreshCw } from "lucide-react";

/*
 * Live front-camera selfie for attendance. The photo is taken from the camera preview (not chosen
 * from the gallery), scaled to 480 px wide, stamped with the time, name and godown like a timestamp
 * camera, and returned as a small JPEG data URL (~50 KB). Phones whose browser blocks the live
 * camera fall back to the camera app (capture="user").
 */

const WIDTH = 480;

export type SelfieStamp = { lines: string[] };

function stampAndEncode(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, stamp: SelfieStamp, mirror: boolean) {
  const scale = WIDTH / sourceWidth;
  const height = Math.round(sourceHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This phone can't prepare the photo");
  if (mirror) { ctx.translate(WIDTH, 0); ctx.scale(-1, 1); }
  ctx.drawImage(source, 0, 0, WIDTH, height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const lineHeight = 20;
  const band = stamp.lines.length * lineHeight + 14;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, height - band, WIDTH, band);
  ctx.fillStyle = "#fff";
  ctx.font = "600 15px system-ui, sans-serif";
  stamp.lines.forEach((line, index) => ctx.fillText(line, 10, height - band + 22 + index * lineHeight, WIDTH - 20));
  return canvas.toDataURL("image/jpeg", 0.72);
}

export function SelfieCamera({ stamp, onCapture }: { stamp: () => SelfieStamp; onCapture: (dataUrl: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<"starting" | "live" | "fallback">("starting");
  const [problem, setProblem] = useState("");

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setProblem("");
    setState("starting");
    if (!navigator.mediaDevices?.getUserMedia) { setState("fallback"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 960 } }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) { video.srcObject = stream; await video.play().catch(() => undefined); }
      setState("live");
    } catch (cause) {
      const name = cause instanceof DOMException ? cause.name : "";
      setProblem(name === "NotAllowedError"
        ? "Camera permission is blocked. Allow the camera for grainbazar.com in your browser settings, or use the button below."
        : "The live camera could not start. Use the button below to take the selfie.");
      setState("fallback");
    }
  }, []);

  useEffect(() => { void start(); return stop; }, [start, stop]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    try {
      onCapture(stampAndEncode(video, video.videoWidth, video.videoHeight, stamp(), true));
      stop();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "The photo could not be taken");
    }
  };

  const fromFile = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try { onCapture(stampAndEncode(image, image.naturalWidth, image.naturalHeight, stamp(), false)); }
      catch (cause) { setProblem(cause instanceof Error ? cause.message : "The photo could not be used"); }
      finally { URL.revokeObjectURL(url); }
    };
    image.onerror = () => { setProblem("The photo could not be opened. Take it again."); URL.revokeObjectURL(url); };
    image.src = url;
  };

  return (
    <div className="space-y-3">
      <div className="relative mx-auto aspect-[3/4] w-full max-w-xs overflow-hidden rounded-2xl bg-navy/90">
        <video ref={videoRef} playsInline muted className={`h-full w-full -scale-x-100 object-cover ${state === "live" ? "" : "hidden"}`} />
        {state !== "live" && (
          <div className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-white/80">
            {state === "starting" ? <span className="inline-flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" /> Starting camera…</span> : <Camera className="h-10 w-10" />}
          </div>
        )}
      </div>
      {problem && <p role="alert" className="text-center text-xs text-red-700">{problem}</p>}
      {state === "live" ? (
        <button type="button" onClick={capture} className="flex w-full items-center justify-center gap-2 rounded-xl bg-navy py-4 text-base font-bold text-white active:scale-[0.99]">
          <Camera className="h-5 w-5" /> Take selfie
        </button>
      ) : state === "fallback" ? (
        <label className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-navy py-4 text-base font-bold text-white">
          <Camera className="h-5 w-5" /> Open camera
          <input type="file" accept="image/*" capture="user" className="sr-only" onChange={(event) => fromFile(event.target.files?.[0])} />
        </label>
      ) : null}
    </div>
  );
}
