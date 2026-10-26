import { create } from "zustand";

interface LockStore {
  /** Starts locked: the app asks for the password on every launch. */
  locked: boolean;
  lock: () => void;
  unlock: () => void;
}

export const useLockStore = create<LockStore>((set) => ({
  locked: true,
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
}));
