import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { invalidateBySourceTable, invalidateAll } from "./dashboardHtmlCache";

export async function invokeWithTableInvalidation<T>(
  cmd: string,
  args: InvokeArgs | undefined,
  invalidateTables: string[]
): Promise<T> {
  const result = await invoke<T>(cmd, args);
  invalidateTables.filter(Boolean).forEach((t) => invalidateBySourceTable(t));
  return result;
}

export { invalidateBySourceTable, invalidateAll };
