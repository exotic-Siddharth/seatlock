import { Check, Minus } from 'lucide-react';
import { Badge, Card } from '../../components/ui';
import type { StrategyInfo } from './strategies';

export function StrategyCard({ strategy }: { strategy: StrategyInfo }) {
  return (
    <Card className="flex flex-col p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-xl font-bold">{strategy.name}</h3>
        {strategy.badge && <Badge tone={strategy.badge.tone}>{strategy.badge.label}</Badge>}
      </div>
      <p className="mt-1 text-muted">{strategy.tagline}</p>

      <pre
        tabIndex={0}
        className="mt-4 overflow-x-auto rounded-xl bg-ink p-4 text-[13px] leading-relaxed text-bg"
      >
        <code>{strategy.sql}</code>
      </pre>

      <ul className="mt-4 space-y-1.5 text-sm">
        {strategy.pros.map((text) => (
          <li key={text} className="flex gap-2">
            <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            <span><span className="sr-only">Pro: </span>{text}</span>
          </li>
        ))}
        {strategy.cons.map((text) => (
          <li key={text} className="flex gap-2">
            <Minus aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <span><span className="sr-only">Con: </span>{text}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
