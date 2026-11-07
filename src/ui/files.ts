import { closeSync, constants, openSync, readSync } from "node:fs";

/** Reads bytes `[start, end)` of a file (shorter if the file shrank meanwhile). With `noFollow`
 * the open refuses a symlink where the platform supports `O_NOFOLLOW`. */
export const readRange = (path: string, start: number, end: number, noFollow = false): Buffer => {
  const fd = openSync(path, noFollow ? constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) : "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (!count) break;
      read += count;
    }
    return buffer.subarray(0, read);
  } finally { closeSync(fd); }
};
