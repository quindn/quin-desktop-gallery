import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

// AI enhancement (src-tauri/src/ai.rs): smoother motion (RIFE) and a sharper picture (Real-ESRGAN).

export interface AiStatus {
  rife: boolean;
  esrgan: boolean;
  gpu: string | null;
}
export interface AiSourceInfo {
  width: number;
  height: number;
  fps: number;
  fpsExpr: string;
  durationMs: number;
  frames: number;
  colorMatrix: string;
  hasAudio: boolean;
}
export interface AiOptions {
  mode: "smooth" | "sharpen";
  factor: number;
  quality: "best" | "fast";
  content: "real" | "anime";
  upscale: boolean;
}

export const aiStatus = () => invoke<AiStatus>("ai_status");
export const aiInstall = (tool: "rife" | "esrgan") => invoke<AiStatus>("ai_install", { tool });
export const aiSourceInfo = (id: number) => invoke<AiSourceInfo>("ai_source_info", { id });
export const aiEnhance = (id: number, options: AiOptions) => invoke<{ jobId: string; outputPath: string }>("ai_enhance", { id, options });

/** Which video the AI Enhance dialog is open for. */
export const useEnhance = create<{ item: { id: number; filename: string } | null; open: (item: { id: number; filename: string }) => void; close: () => void }>((set) => ({
  item: null,
  open: (item) => set({ item }),
  close: () => set({ item: null }),
}));
