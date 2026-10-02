export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 1.8;
export const ZOOM_STEP = 0.1;

export type ZoomDirection = "in" | "out" | "reset";

export function zoomDirection(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "key">): ZoomDirection | null {
  if (!event.ctrlKey && !event.metaKey) return null;
  if (["+", "=", "Add"].includes(event.key)) return "in";
  if (["-", "_", "Subtract"].includes(event.key)) return "out";
  if (event.key === "0") return "reset";
  return null;
}

export function nextZoom(current: number, direction: ZoomDirection): number {
  if (direction === "reset") return 1;
  const delta = direction === "in" ? ZOOM_STEP : -ZOOM_STEP;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((current + delta) * 10) / 10));
}
