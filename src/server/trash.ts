import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileRef } from './db.js';

/**
 * ComfyUI's output folder on disk, read from its launch arguments (Comfy Desktop passes --output-directory).
 * Null when ComfyUI does not say, in which case Darkroom refuses to remove files rather than guess a folder.
 */
export function outputDirFromArgv(argv: string[] | undefined): string | null {
  if (!argv) return null;
  const i = argv.indexOf('--output-directory');
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : null;
}

/** Absolute path of an output file, or null if it would fall outside the output folder. */
export function outputPath(outputDir: string, f: FileRef): string | null {
  if ((f.type ?? 'output') !== 'output') return null;
  const p = path.resolve(outputDir, f.subfolder ?? '', f.filename);
  const root = path.resolve(outputDir) + path.sep;
  return p.startsWith(root) ? p : null;
}

/**
 * Send files to the Windows Recycle Bin (never a hard delete), so "Delete forever" in the Library can still be undone
 * from Windows. Paths go through a temp JSON file, so no path is ever spliced into the command line.
 */
export function recycle(files: string[]): Promise<{ recycled: string[]; failed: string[] }> {
  const existing = files.filter((f) => fs.existsSync(f));
  if (!existing.length) return Promise.resolve({ recycled: [], failed: [] });
  const list = path.join(os.tmpdir(), `darkroom-recycle-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(list, JSON.stringify(existing), 'utf8');
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$files = Get-Content -Raw -LiteralPath '${list.replace(/'/g, "''")}' | ConvertFrom-Json`,
    'foreach ($f in $files) {',
    // a folder (a layered canvas's project) goes to the Recycle Bin whole
    "  try { if (Test-Path -LiteralPath $f -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($f, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f, 'OnlyErrorDialogs', 'SendToRecycleBin') }; Write-Output \"OK`t$f\" }",
    "  catch { Write-Output \"FAIL`t$f\" }",
    '}',
  ].join('\n');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120_000 }, (_err, stdout) => {
      fs.rmSync(list, { force: true });
      const recycled: string[] = [];
      for (const line of String(stdout ?? '').split(/\r?\n/)) if (line.startsWith('OK\t')) recycled.push(line.slice(3));
      resolve({ recycled, failed: existing.filter((f) => !recycled.includes(f)) });
    });
  });
}
