import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBeijingTime(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

import { invoke } from "@tauri-apps/api/core";

export function initTerminalLogging() {
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalLog = console.log;

  console.error = (...args: any[]) => {
    originalError.apply(console, args);
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    invoke("log_to_terminal", { level: "error", message: msg }).catch(() => {});
  };

  console.warn = (...args: any[]) => {
    originalWarn.apply(console, args);
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    invoke("log_to_terminal", { level: "warn", message: msg }).catch(() => {});
  };

  console.log = (...args: any[]) => {
    originalLog.apply(console, args);
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    invoke("log_to_terminal", { level: "info", message: msg }).catch(() => {});
  };
}
