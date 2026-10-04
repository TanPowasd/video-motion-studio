export type PreviewTicket = { key: string; frame: number; playing: boolean; signature: string };
export function canPresentPreview(
  request: PreviewTicket,
  current: PreviewTicket | undefined,
  reply: { revision: string; frame: number },
  revision: string,
  last?: { key: string; frame: number },
  maxLag = 60,
) {
  if (
    !current ||
    current.key !== request.key ||
    reply.revision !== revision ||
    reply.frame !== request.frame
  )
    return false;
  if (last?.key === request.key && reply.frame < last.frame && current.playing) return false;
  return (
    current.signature === request.signature ||
    (request.playing &&
      current.playing &&
      current.frame >= request.frame &&
      current.frame - request.frame <= maxLag)
  );
}
export function paintPreview(canvas: HTMLCanvasElement, bitmap: ImageBitmap) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('预览画布不可用');
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
}
