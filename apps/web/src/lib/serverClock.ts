import { useEffect, useRef, useState } from 'react';

/** Server time, estimated from a `serverTime` the API sent and the moment it arrived. */
export type ServerClock = { now(): number };

/**
 * Countdowns must follow the server, not the device: a phone whose clock is 5 minutes fast
 * would otherwise show a hold expiring 5 minutes early.
 */
export function createServerClock(serverTimeIso: string, receivedAtMs = Date.now()): ServerClock {
  const offsetMs = Date.parse(serverTimeIso) - receivedAtMs;
  return { now: () => Date.now() + offsetMs };
}

export type Countdown = { msLeft: number; mm: string; ss: string; done: boolean };

export function countdown(targetIso: string, clock: ServerClock): Countdown {
  const msLeft = Math.max(0, Date.parse(targetIso) - clock.now());
  const secondsLeft = Math.ceil(msLeft / 1000);
  return {
    msLeft,
    mm: String(Math.floor(secondsLeft / 60)).padStart(2, '0'),
    ss: String(secondsLeft % 60).padStart(2, '0'),
    done: msLeft === 0,
  };
}

const sameDisplay = (a: Countdown, b: Countdown) => a.mm === b.mm && a.ss === b.ss && a.done === b.done;

/**
 * Time left until `targetIso` by `clock`, re-rendering once per displayed second.
 * `clock` may be a new object on every render; the latest one is always used.
 */
export function useCountdown(targetIso: string, clock: ServerClock): Countdown {
  const clockRef = useRef(clock);
  const [state, setState] = useState(() => countdown(targetIso, clock));

  useEffect(() => {
    clockRef.current = clock;
  }, [clock]);

  useEffect(() => {
    const tick = () =>
      setState((prev) => {
        const next = countdown(targetIso, clockRef.current);
        return sameDisplay(prev, next) ? prev : next;
      });
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [targetIso]);

  return state;
}
