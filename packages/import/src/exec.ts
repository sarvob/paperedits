import { execFile } from 'node:child_process';

/**
 * Promisified execFile with a generous buffer — ffprobe/whisper JSON output for
 * a long file can be several MB. Rejects on non-zero exit with stderr attached.
 */
export function exec(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 0 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${bin} failed: ${err.message}\n${stderr}`));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}
