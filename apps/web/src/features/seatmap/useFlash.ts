import { useCallback, useEffect, useRef, useState } from 'react';

const FLASH_MS = 2_700;
const NONE: ReadonlySet<number> = new Set();

/** Seats flashed after a failed hold, cleared after a moment. */
export function useFlash() {
  const [ids, setIds] = useState<ReadonlySet<number>>(NONE);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback((next: number[]) => {
    clearTimeout(timer.current);
    setIds(new Set(next));
    timer.current = setTimeout(() => setIds(NONE), FLASH_MS);
  }, []);
  return [ids, flash] as const;
}
