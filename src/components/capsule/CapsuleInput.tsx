import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Mic, ArrowUp, Square } from 'lucide-react';
import { useAudioRecorder } from '@/hooks/useAudioRecorder';

interface CapsuleInputProps {
  onSendText: (text: string) => void;
  onOpenActions: () => void;
  onAudioRecorded: (blob: Blob, filename: string) => void;
}

/* ===== AUTO HEIGHT ===== */
const LINE_HEIGHT = 22;
const PADDING_Y   = 24;
const MIN_HEIGHT  = LINE_HEIGHT + PADDING_Y;
const MAX_HEIGHT  = LINE_HEIGHT * 3 + PADDING_Y;

function formatTime(s: number): string {
  const m   = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

const CapsuleInput = ({
  onSendText,
  onOpenActions,
  onAudioRecorded,
}: CapsuleInputProps): JSX.Element => {
  const [text, setText]     = useState('');
  const [height, setHeight] = useState(MIN_HEIGHT);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { isRecording, recordingTime, startRecording, stopRecording } =
    useAudioRecorder();

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = `${MIN_HEIGHT}px`;
    const next = Math.min(Math.max(el.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);

    setHeight(next);
    el.style.height = `${next}px`;
    // Enable scroll only when content exceeds max height
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  // Escape cancels recording (mobile/desktop parity)
  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape' && isRecording) {
        stopRecording();
      }
    }

    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [isRecording, stopRecording]);

  const handleSend = () => {
    if (!text.trim()) return;

    onSendText(text.trim());
    setText('');
    setHeight(MIN_HEIGHT);

    if (textareaRef.current) {
      textareaRef.current.style.height = `${MIN_HEIGHT}px`;
      textareaRef.current.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleMicClick = async () => {
    if (isRecording) {
      const blob = await stopRecording();
      if (blob) {
        // PATCH — crypto.randomUUID() replaces Date.now() as filename
        // identity source. Prevents collisions under rapid stop/start,
        // suspended-tab resume, and StrictMode replay scenarios.
        const extension =
          blob.type.includes("mp4")
            ? "mp4"
            : blob.type.includes("mpeg")
            ? "mp3"
            : blob.type.includes("wav")
            ? "wav"
            : "webm";

        onAudioRecorded(
          blob,
          `audio_${globalThis.crypto.randomUUID()}.${extension}`,
        );
      }
    } else {
      await startRecording();
    }
  };

  const hasText = text.trim().length > 0;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 pointer-events-none">
      <div className="px-5 pb-[calc(env(safe-area-inset-bottom)+20px)]">
        <div
          className="
            mx-auto
            w-full
            pointer-events-auto
            max-w-[92vw]
            sm:max-w-[520px]
            md:max-w-[640px]
            lg:max-w-[720px]
            xl:max-w-[720px]
          "
        >
          {/* GLASS CARD */}
          <div
            className="
              rounded-2xl
              border
              bg-card/60
              backdrop-blur-xl
              shadow-[0_0_40px_rgba(0,0,0,0.45)]
            "
          >
            {/* INPUT BAR */}
            <div
              className="
                flex items-center gap-2
                px-3 py-3
                sm:px-4 sm:py-4
              "
            >
              {/* ➕ */}
              <button
                type="button"
                aria-label="Add capsule content"
                onClick={onOpenActions}
                disabled={isRecording}
                className="
                  w-10 h-10
                  sm:w-11 sm:h-11
                  rounded-full
                  flex items-center justify-center
                  bg-background/60
                  border
                  cursor-pointer
                  transition-all
                  hover:bg-background/80
                  hover:scale-105
                  hover:shadow-[0_0_12px_rgba(249,115,22,0.25)]
                  active:scale-95
                  focus-visible:ring-2
                  focus-visible:ring-orange-500/40
                  disabled:opacity-50
                  disabled:cursor-not-allowed
                  disabled:hover:scale-100
                  disabled:hover:shadow-none
                "
              >
                <Plus size={20} />
              </button>

              {/* TEXT / RECORD */}
              <div className="flex-1 flex items-center">
                {isRecording ? (
                  <div
                    role="status"
                    aria-live="polite"
                    className="h-[46px] flex items-center gap-2 text-red-500 text-sm font-semibold"
                  >
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    REC {formatTime(recordingTime)}
                  </div>
                ) : (
                  <textarea
                    ref={textareaRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Write your message…"
                    aria-label="Capsule message input"
                    rows={1}
                    className="
                      w-full
                      resize-none
                      bg-transparent
                      outline-none
                      text-[15px]
                      sm:text-[16px]
                      lg:text-[17px]
                      leading-[1.45]
                      text-foreground
                      placeholder:text-foreground/60
                      overflow-y-auto
                      py-[6px]
                      capsule-textarea
                    "
                    style={{ height: `${height}px` }}
                  />
                )}
              </div>

              {/* 🎤 / SEND */}
              <button
                type="button"
                aria-label={hasText ? "Send message" : isRecording ? "Stop recording" : "Record audio"}
                onClick={hasText ? handleSend : handleMicClick}
                className={`
                  w-10 h-10
                  sm:w-11 sm:h-11
                  rounded-full
                  flex items-center justify-center
                  transition-all
                  cursor-pointer
                  hover:scale-105
                  hover:shadow-[0_0_12px_rgba(249,115,22,0.25)]
                  active:scale-95
                  focus-visible:ring-2
                  focus-visible:ring-orange-500/40
                  ${
                    hasText || isRecording
                      ? 'bg-accent text-accent-foreground shadow-md'
                      : 'bg-background/60 border hover:bg-background/80'
                  }
                `}
              >
                {isRecording ? (
                  <Square size={18} fill="currentColor" />
                ) : hasText ? (
                  <ArrowUp size={20} />
                ) : (
                  <Mic size={20} />
                )}
              </button>
            </div>

            {/* HELPER */}
            <p
              className="
                pb-3
                text-center
                text-[11px]
                sm:text-xs
                lg:text-sm
                text-foreground/70
              "
            >
              Start creating your story inside the capsule.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CapsuleInput;