/** Encoded playback includes the final frame interval; motion span may omit it. */
export function playbackDuration(item: { frames?: number | null; fps?: number | null; duration?: number | null }): number | null {
  return item.frames && item.fps ? item.frames / item.fps : item.duration ?? null;
}
export const gibibytes = (bytes: number) => bytes / 1024 ** 3;
