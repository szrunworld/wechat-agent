import { useEffect, useState } from 'react';

/**
 * Screenshot evidence. Zoom and pan (crop) with buttons or arrow keys; masked by
 * default so a glance at the window does not leak a chat. Without an image
 * source the viewer shows the evidence id and says why there is no picture.
 */
export function EvidenceViewer({ evidenceId, src, alt }: { evidenceId: string; src?: string; alt: string }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [masked, setMasked] = useState(true);
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); setMasked(true); }, [evidenceId]);

  const step = 40;
  const onKey = (e: React.KeyboardEvent) => {
    const moves: Record<string, [number, number]> = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [step, 0], ArrowRight: [-step, 0] };
    if (moves[e.key]) { e.preventDefault(); setPan((p) => ({ x: p.x + moves[e.key][0], y: p.y + moves[e.key][1] })); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom((z) => Math.min(4, z + 0.5)); }
    if (e.key === '-') { e.preventDefault(); setZoom((z) => Math.max(1, z - 0.5)); }
  };

  return (
    <figure className="evidence">
      <div className="evidence-toolbar" role="group" aria-label="截图工具">
        <button type="button" className="btn btn-secondary" onClick={() => setZoom((z) => Math.min(4, z + 0.5))}>放大</button>
        <button type="button" className="btn btn-secondary" onClick={() => setZoom((z) => Math.max(1, z - 0.5))}>缩小</button>
        <button type="button" className="btn btn-secondary" onClick={() => setPan((p) => ({ ...p, y: p.y + step }))} aria-label="视图上移">↑</button>
        <button type="button" className="btn btn-secondary" onClick={() => setPan((p) => ({ ...p, y: p.y - step }))} aria-label="视图下移">↓</button>
        <button type="button" className="btn btn-secondary" onClick={() => setPan((p) => ({ ...p, x: p.x + step }))} aria-label="视图左移">←</button>
        <button type="button" className="btn btn-secondary" onClick={() => setPan((p) => ({ ...p, x: p.x - step }))} aria-label="视图右移">→</button>
        <button type="button" className="btn btn-secondary" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>重置</button>
        <button type="button" className="btn btn-secondary" aria-pressed={!masked} onClick={() => setMasked((m) => !m)}>{masked ? '显示原图' : '重新脱敏'}</button>
        <span className="muted">缩放 {zoom}×{masked ? ' · 已脱敏' : ' · 原图'}</span>
      </div>
      <div className="evidence-viewport" tabIndex={0} onKeyDown={onKey} aria-label={`${alt}，方向键平移，加减号缩放`}>
        {src ? (
          <img src={src} alt={alt} className={masked ? 'masked' : ''} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} draggable={false} />
        ) : (
          <div className="evidence-placeholder">
            <div>证据 <code>{evidenceId}</code></div>
            <div className="muted">当前 IPC 没有读取证据图片的方法，这里只显示证据编号；图片由应用核心保存在本机。</div>
          </div>
        )}
      </div>
      <figcaption className="muted">截图按证据编号 {evidenceId} 归档；默认脱敏，需要时再显示原图。</figcaption>
    </figure>
  );
}
