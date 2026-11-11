import QRCode from 'qrcode';
import { useMemo } from 'react';
import { cx } from '../../components/ui';

const QUIET_ZONE = 2;

/** The dark modules of a QR code as one SVG path, one 1x1 square per module. */
function qrPath(text: string): { size: number; d: string } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  let d = '';
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return { size: modules.size + QUIET_ZONE * 2, d };
}

/** A ticket's QR code, drawn as inline SVG. Always dark on white, as scanners expect, even in dark mode. */
export function TicketQr({ code, className }: { code: string; className?: string }) {
  const { size, d } = useMemo(() => qrPath(code), [code]);
  return (
    <svg
      role="img"
      aria-label={`QR code for ticket ${code}`}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cx('rounded-md bg-white', className)}
    >
      <path d={d} fill="#111827" />
    </svg>
  );
}
