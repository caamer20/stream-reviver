import type { FrameStatus } from "../shared/types";

/** Returns only frames that belong to one exact origin. The top-frame origin
 * is supplied separately because a tab can be known before it has reported a
 * monitor status. */
export function frameIdsForOrigin(
  frames: ReadonlyMap<number, Pick<FrameStatus, "origin">> | undefined,
  origin: string,
  topFrameOrigin: string | null
): number[] {
  const ids = new Set<number>();
  if (topFrameOrigin === origin) ids.add(0);
  for (const [frameId, status] of frames ?? []) if (status.origin === origin) ids.add(frameId);
  return [...ids].sort((first, second) => first - second);
}
