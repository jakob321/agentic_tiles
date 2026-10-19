import type { NotificationSound } from "./types";

interface Note {
  frequency: number;
  start: number;
  duration: number;
  wave?: OscillatorType;
}

export const notificationSounds: ReadonlyArray<{ id: NotificationSound; label: string }> = [
  { id: "chime", label: "Chime" },
  { id: "bell", label: "Bell" },
  { id: "pop", label: "Pop" },
  { id: "double-beep", label: "Double beep" },
  { id: "rising", label: "Rising" },
];

const notes: Record<NotificationSound, Note[]> = {
  chime: [
    { frequency: 659.25, start: 0, duration: 0.24 },
    { frequency: 987.77, start: 0.14, duration: 0.35 },
  ],
  bell: [
    { frequency: 880, start: 0, duration: 0.55 },
    { frequency: 1760, start: 0, duration: 0.3 },
  ],
  pop: [{ frequency: 440, start: 0, duration: 0.1, wave: "triangle" }],
  "double-beep": [
    { frequency: 740, start: 0, duration: 0.1 },
    { frequency: 740, start: 0.18, duration: 0.1 },
  ],
  rising: [
    { frequency: 523.25, start: 0, duration: 0.16 },
    { frequency: 659.25, start: 0.12, duration: 0.16 },
    { frequency: 783.99, start: 0.24, duration: 0.25 },
  ],
};

let audioContext: AudioContext | undefined;

// Call during a user gesture so saved, unmuted chats can notify after a reload.
export async function prepareNotificationAudio(): Promise<void> {
  try {
    if (!audioContext || audioContext.state === "closed") audioContext = new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
  } catch {
    // Audio availability must never affect sending or receiving chat messages.
  }
}

export function playNotificationSound(sound: NotificationSound): void {
  // Do not queue audio behind an autoplay restriction and play stale alerts later.
  if (!audioContext || audioContext.state !== "running") return;
  const context = audioContext;
  try {
    for (const note of notes[sound] ?? notes.chime) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + note.start;
      oscillator.type = note.wave ?? "sine";
      oscillator.frequency.setValueAtTime(note.frequency, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.09, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, start + note.duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(start);
      oscillator.stop(start + note.duration);
    }
  } catch {
    // A missing audio device must not interrupt completion handling.
  }
}

export async function previewNotificationSound(sound: NotificationSound): Promise<void> {
  await prepareNotificationAudio();
  playNotificationSound(sound);
}
