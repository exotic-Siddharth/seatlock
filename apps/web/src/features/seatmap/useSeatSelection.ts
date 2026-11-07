import type { SeatTuple } from '@seatlock/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../components/ui';

/** "C12": how a seat is named in messages. */
export const shortSeatName = (seat: SeatTuple) => `${seat[2]}${seat[3]}`;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The seats the visitor has picked, at most `max`. When a live update shows that someone
 * else took a picked seat, the seat is dropped with a toast. Pass `paused` while our own
 * hold request is in flight: the update for seats we are holding ourselves can arrive first.
 */
export function useSeatSelection({ max, seats, paused = false }: { max: number; seats: SeatTuple[] | undefined; paused?: boolean }) {
  const toast = useToast();
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  // Read by the handlers so that quick clicks see each other; every update goes through both.
  const selectedRef = useRef(selected);

  const toggle = useCallback(
    (id: number) => {
      const current = selectedRef.current;
      if (!current.has(id) && current.size >= max) {
        toast.push({ tone: 'warning', title: `You can pick up to ${max} ${plural(max, 'seat', 'seats')}`, body: 'Deselect a seat to pick another.' });
        return;
      }
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      selectedRef.current = next;
      setSelected(next);
    },
    [max, toast],
  );

  const remove = useCallback((ids: Iterable<number>) => {
    const next = new Set(selectedRef.current);
    for (const id of ids) next.delete(id);
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const clear = useCallback(() => remove(selectedRef.current), [remove]);

  useEffect(() => {
    if (paused || !seats || selected.size === 0) return;
    const taken = seats.filter((seat) => selected.has(seat[0]) && seat[5] !== 'A');
    if (taken.length === 0) return;
    remove(taken.map((seat) => seat[0]));
    const names = taken.map(shortSeatName).join(', ');
    toast.push({ tone: 'warning', title: `${plural(taken.length, 'Seat', 'Seats')} ${names} ${plural(taken.length, 'was', 'were')} just taken.` });
  }, [seats, selected, paused, remove, toast]);

  return { selected, toggle, remove, clear };
}
