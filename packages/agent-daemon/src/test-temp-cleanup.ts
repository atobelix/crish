import { rm } from "node:fs/promises";

export async function removeTempDirs(tempDirs: string[]): Promise<void> {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => removeTempDir(dir)));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 0,
    retryDelay: 25,
  });
}
