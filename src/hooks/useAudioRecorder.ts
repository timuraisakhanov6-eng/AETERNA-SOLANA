import {
  useState,
  useRef,
  useCallback,
  useEffect,
} from "react";


interface UseAudioRecorderReturn {

  isRecording: boolean;

  recordingTime: number;

  startRecording: () => Promise<void>;

  stopRecording: () => Promise<Blob | null>;

  error: string | null;

}


/**
 * Canonical audio recorder hook
 *
 * Guarantees:
 * deterministic mimeType
 * safe stream lifecycle
 * timer cleanup
 * StrictMode safe
 */

export const useAudioRecorder =
(): UseAudioRecorderReturn => {

  const [
    isRecording,
    setIsRecording,
  ] = useState(false);


  const [
    recordingTime,
    setRecordingTime,
  ] = useState(0);


  const [
    error,
    setError,
  ] = useState<string | null>(null);


  const mediaRecorderRef =
    useRef<MediaRecorder | null>(null);


  const chunksRef =
    useRef<Blob[]>([]);


  const timerRef =
    useRef<number | null>(null);


  const streamRef =
    useRef<MediaStream | null>(null);

    /**
 * Actual recorder MIME type.
 *
 * Keeps Blob/container consistent with
 * MediaRecorder negotiated format.
 */
const resolvedMimeTypeRef =
  useRef<string>(
    "audio/webm"
  );


  /* ================= START RECORDING ================= */

  const startRecording =
  useCallback(async () => {

    try {

      setError(null);

      chunksRef.current = [];


      /**
       * stop previous stream if exists
       * prevents duplicate microphone capture
       */

      streamRef.current
        ?.getTracks()
        .forEach(track =>
          track.stop()
        );


      const stream =
        await navigator
          .mediaDevices
          .getUserMedia({
            audio: true,
          });


      streamRef.current =
        stream;


      /**
       * deterministic container format
       *
       * prevents Safari / Android mismatch
       */

      const mimeType =

  MediaRecorder.isTypeSupported(
    "audio/webm"
  )

    ? "audio/webm"

    : MediaRecorder.isTypeSupported(
        "audio/mp4"
      )

    ? "audio/mp4"

    : undefined;


const mediaRecorder =
  mimeType

    ? new MediaRecorder(
        stream,
        { mimeType }
      )

    : new MediaRecorder(stream);


      mediaRecorderRef.current =
        mediaRecorder;
      resolvedMimeTypeRef.current =
        mediaRecorder.mimeType ||
        mimeType ||
        "audio/webm";

      mediaRecorder.ondataavailable =
        (e) => {

          if (
            e.data.size > 0
          ) {

            chunksRef.current.push(
              e.data
            );

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

    }

    catch (err) {

      setError(
        "Microphone access denied"
      );

      console.error(
        "Error starting recording:",
        err
      );

    }

  }, []);


  /* ================= STOP RECORDING ================= */

  const stopRecording =
  useCallback(async () => {

    return new Promise<Blob | null>(
      (resolve) => {

        const recorder =
          mediaRecorderRef.current;


        if (
          !recorder ||
          recorder.state ===
            "inactive"
        ) {

          resolve(null);

          return;

        }


        recorder.onstop =
          () => {

            const blob =
              new Blob(
                chunksRef.current,
                {
                  type:
                    resolvedMimeTypeRef.current,
                }
              );


            chunksRef.current = [];


            streamRef.current
              ?.getTracks()
              .forEach(track =>
                track.stop()
              );


            streamRef.current =
              null;


            resolve(blob);

          };


        recorder.stop();


        setIsRecording(false);


        if (
          timerRef.current
        ) {

          clearInterval(
            timerRef.current
          );

          timerRef.current =
            null;

        }

      }
    );

  }, []);


  /* ================= CLEANUP ================= */

  useEffect(() => {

    return () => {

      /**
       * timer cleanup
       */

      if (
        timerRef.current
      ) {

        clearInterval(
          timerRef.current
        );

      }


      /**
       * stream cleanup
       */

      streamRef.current
        ?.getTracks()
        .forEach(track =>
          track.stop()
        );

    };

  }, []);


  /* ================= RETURN ================= */

  return {

    isRecording,

    recordingTime,

    startRecording,

    stopRecording,

    error,

  };

};