import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Camera,
  Video,
  Square,
  RotateCcw,
  Check,
  SwitchCamera,
} from 'lucide-react';

interface MediaCaptureProps {
  mode: 'photo' | 'video';
  isOpen: boolean;
  onClose: () => void;
  onCapture: (blob: Blob, filename: string) => void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs
    .toString()
    .padStart(2, '0')}`;
}

const MediaCapture = ({
  mode,
  isOpen,
  onClose,
  onCapture,
}: MediaCaptureProps): JSX.Element | null => {

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [capturedMedia, setCapturedMedia] =
    useState<{ blob: Blob; url: string } | null>(null);
  const [facingMode, setFacingMode] =
    useState<'user' | 'environment'>('environment');
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Tracks the actual container format negotiated by MediaRecorder.
  // Safari/iOS may resolve to mp4 instead of webm; filename extension
  // must match the actual MIME type to avoid MIME/extension drift.
  const capturedExtensionRef =
    useRef<'jpg' | 'webm' | 'mp4'>('webm');


  /* ================= BODY SCROLL LOCK ================= */

  useEffect(() => {

    if (!isOpen) return;

    const originalOverflow =
      document.body.style.overflow;

    document.body.style.overflow =
      'hidden';

    return () => {

      document.body.style.overflow =
        originalOverflow;

    };

  }, [isOpen]);


  /* ================= ESC CLOSE ================= */

  const handleClose = useCallback(() => {

    streamRef.current
      ?.getTracks()
      .forEach(track => track.stop());

    // FIX: clear recording timer on close to prevent interval leak,
    // background CPU usage, and React StrictMode duplicate timers
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (capturedMedia)
      URL.revokeObjectURL(
        capturedMedia.url
      );

    setCapturedMedia(null);
    setIsRecording(false);
    setRecordingTime(0);

    onClose();

  }, [capturedMedia, onClose]);


  useEffect(() => {

    if (!isOpen) return;

    function onEsc(
      e: KeyboardEvent
    ) {

      if (e.key === 'Escape')
        handleClose();

    }

    window.addEventListener(
      'keydown',
      onEsc
    );

    return () =>
      window.removeEventListener(
        'keydown',
        onEsc
      );

  }, [isOpen, handleClose]);


  /* ================= CAMERA START ================= */

  const startCamera =
    useCallback(async () => {

      try {

        setError(null);

        streamRef.current
          ?.getTracks()
          .forEach(track =>
            track.stop()
          );

        const constraints:
          MediaStreamConstraints =
        {
          video: { facingMode },
          audio:
            mode === 'video',
        };

        const newStream =
          await navigator
            .mediaDevices
            .getUserMedia(
              constraints
            );

        streamRef.current =
          newStream;

        setStream(newStream);

        if (videoRef.current) {

          videoRef.current.srcObject =
            newStream;

        }

      }

      catch (err) {

        setError(
          'Camera access denied. Please allow camera permission.'
        );

        console.error(
          'Error accessing camera:',
          err
        );

      }

    }, [
      facingMode,
      mode,
    ]);


  /* ================= OPEN INIT ================= */

  useEffect(() => {

    if (
      isOpen &&
      !capturedMedia
    ) {

      void startCamera();

    }

    return () => {

      streamRef.current
        ?.getTracks()
        .forEach(track =>
          track.stop()
        );

      if (timerRef.current)
        clearInterval(
          timerRef.current
        );

    };

  }, [isOpen]);


  /* ================= CAMERA SWITCH ================= */

  useEffect(() => {

    if (
      isOpen &&
      !capturedMedia
    ) {

      void startCamera();

    }

  }, [
    facingMode,
  ]);


  /* ================= PHOTO ================= */

  const takePhoto =
    useCallback(() => {

      if (!videoRef.current)
        return;

      const w =
        videoRef.current.videoWidth;

      const h =
        videoRef.current.videoHeight;

      if (!w || !h)
        return;

      const canvas =
        document.createElement(
          'canvas'
        );

      canvas.width = w;
      canvas.height = h;

      const ctx =
        canvas.getContext('2d');

      if (!ctx)
        return;

      ctx.drawImage(
        videoRef.current,
        0,
        0
      );

      canvas.toBlob(
        blob => {

          if (!blob)
            return;

          const url =
            URL.createObjectURL(
              blob
            );

          setCapturedMedia({
            blob,
            url,
          });

          streamRef.current
            ?.getTracks()
            .forEach(track =>
              track.stop()
            );

          // FIX: detach stream from video element after capture
          // so the live feed doesn't bleed through the photo preview
          if (videoRef.current) {
            videoRef.current.srcObject = null;
          }

        },
        'image/jpeg',
        0.9
      );

    }, []);


  /* ================= VIDEO RECORD ================= */

  const startVideoRecording =
    useCallback(() => {

      if (!stream)
        return;

      chunksRef.current = [];

      // Capability-based MIME negotiation — Safari/iOS does not support
      // video/webm in MediaRecorder and throws synchronously if forced.
      // Prefer webm where supported for deterministic container format;
      // fall back to browser default (typically mp4 on Safari/iOS) to
      // restore compatibility without changing semantics where webm works.
      const preferredMime =
        MediaRecorder.isTypeSupported('video/webm')
          ? 'video/webm'
          : '';

      const mediaRecorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);

      mediaRecorderRef.current =
        mediaRecorder;

      mediaRecorder.ondataavailable =
        e => {

          if (
            e.data.size > 0
          ) {

            chunksRef.current.push(
              e.data
            );

          }

        };

      mediaRecorder.onstop =
        () => {

          // Use the recorder's actual mimeType rather than a hardcoded
          // value — on Safari the negotiated type will differ from webm.
          const resolvedMime =
            mediaRecorder.mimeType || 'video/webm';

          // Derive extension from resolved MIME — mp4 on Safari/iOS,
          // webm elsewhere. Stored in ref so handleConfirm can read
          // it synchronously without a state re-render cycle.
          capturedExtensionRef.current =
            resolvedMime.includes('mp4')
              ? 'mp4'
              : 'webm';

          const blob =
            new Blob(
              chunksRef.current,
              {
                type: resolvedMime,
              }
            );

          const url =
            URL.createObjectURL(
              blob
            );

          setCapturedMedia({
            blob,
            url,
          });

          streamRef.current
            ?.getTracks()
            .forEach(track =>
              track.stop()
            );

          // FIX: detach stream from video element after recording stops
          // so the live feed doesn't bleed through the video preview
          if (videoRef.current) {
            videoRef.current.srcObject = null;
          }

        };

      mediaRecorder.start();

      setIsRecording(true);
      setRecordingTime(0);

      timerRef.current =
        window.setInterval(
          () => {

            setRecordingTime(
              prev =>
                prev + 1
            );

          },
          1000
        );

    }, [stream]);


  const stopVideoRecording =
  useCallback(() => {

    const recorder =
      mediaRecorderRef.current;

    if (
      recorder &&
      recorder.state !==
        'inactive'
    ) {

      recorder.stop();

    }

    setIsRecording(false);

    if (timerRef.current) {

      clearInterval(
        timerRef.current
      );

      timerRef.current =
        null;

    }

  }, []);


  /* ================= RETAKE ================= */

  const handleRetake =
    useCallback(() => {

      if (capturedMedia)

        URL.revokeObjectURL(
          capturedMedia.url
        );

      setCapturedMedia(null);
      setRecordingTime(0);

      void startCamera();

    }, [
      capturedMedia,
      startCamera,
    ]);


  /* ================= CONFIRM ================= */

  const handleConfirm =
    useCallback(() => {

      if (!capturedMedia)
        return;

      const timestamp =
        Date.now();

      const filename =
        mode === 'photo'
          ? `photo_${timestamp}.jpg`
          : `video_${timestamp}.${capturedExtensionRef.current}`;

      onCapture(
        capturedMedia.blob,
        filename
      );

      URL.revokeObjectURL(
        capturedMedia.url
      );

      setCapturedMedia(null);

      onClose();

    }, [
      capturedMedia,
      mode,
      onCapture,
      onClose,
    ]);


  /* ================= CAMERA SWITCH ================= */

  const toggleCamera =
    useCallback(() => {

      setFacingMode(
        prev =>
          prev === 'user'
            ? 'environment'
            : 'user'
      );

    }, []);


  if (!isOpen)
    return null;


  return createPortal(

    <div className="fixed inset-0 bg-black flex flex-col z-[99999] isolate">

      {/* HEADER */}

      <div className="absolute top-0 left-0 right-0 z-10 flex justify-between items-center p-4">

        <button
          type="button"
          onClick={handleClose}
          className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center text-white hover:bg-black/70"
          aria-label="Close camera"
        >
          <X size={24} />
        </button>

        {isRecording && (

          <div className="flex items-center gap-2 px-4 py-2 bg-red-500/90 rounded-full text-white text-sm font-semibold">

            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />

            REC {formatTime(recordingTime)}

          </div>

        )}

        {!capturedMedia ? (

          <button
            type="button"
            onClick={toggleCamera}
            className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center text-white hover:bg-black/70"
            aria-label="Switch camera"
          >
            <SwitchCamera size={20} />
          </button>

        ) : (

          <div className="w-10" />

        )}

      </div>


      {/* PREVIEW */}

      <div className="absolute inset-0 flex items-center justify-center pt-16 pb-32">

        {error ? (

          <div className="text-center p-5">

            <p className="text-red-400 mb-4">

              {error}

            </p>

            <button
              type="button"
              onClick={() => void startCamera()}
              className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30"
            >
              Try Again
            </button>

          </div>

        ) : capturedMedia ? (

          mode === 'photo' ? (

            <img
              src={capturedMedia.url}
              alt="Captured photo preview"
              loading="eager"
              decoding="async"
              className="max-w-full max-h-full object-contain rounded-lg"
            />

          ) : (

            <video
              src={capturedMedia.url}
              controls
              preload="metadata"
              playsInline
              className="max-w-full max-h-full object-contain rounded-lg"
            />

          )

        ) : (

          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />

        )}

      </div>


      {/* CONTROLS */}

      <div className="absolute bottom-0 left-0 right-0 z-20 flex justify-center items-center gap-8 p-6 pb-[max(24px,env(safe-area-inset-bottom))]">

        {capturedMedia ? (

          <>
            <button onClick={handleRetake} className="flex flex-col items-center gap-2">
              <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center text-white hover:bg-white/30">
                <RotateCcw size={24} />
              </div>
              <span className="text-white text-xs">Retake</span>
            </button>

            <button onClick={handleConfirm} className="flex flex-col items-center gap-2">
              <div className="w-[72px] h-[72px] rounded-full bg-accent flex items-center justify-center shadow-lg">
                <Check size={32} />
              </div>
              <span className="text-white text-xs">Add to Capsule</span>
            </button>
          </>

        ) : mode === 'photo' ? (

          <button onClick={takePhoto} className="w-[72px] h-[72px] rounded-full bg-white border-4 border-white/30 flex items-center justify-center">
            <Camera size={28} className="text-black" />
          </button>

        ) : isRecording ? (

          <button onClick={stopVideoRecording} className="w-[72px] h-[72px] rounded-full bg-red-500 border-4 border-white/30 flex items-center justify-center">
            <Square size={28} fill="white" />
          </button>

        ) : (

          <button onClick={startVideoRecording} className="w-[72px] h-[72px] rounded-full bg-red-500 border-4 border-white/30 flex items-center justify-center">
            <Video size={28} />
          </button>

        )}

      </div>

    </div>,

    document.body
  );

};

export default MediaCapture;