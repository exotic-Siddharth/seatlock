import { BenchSummarySchema } from '@seatlock/shared';
import { LabContent } from '../features/lab/LabContent';

// A glob, not a plain import: when the benchmark has not been run, the file is absent and the
// page shows its empty state instead of breaking the build. @bench-results is loadtest/results
// (vite.config.ts); the web Docker image copies that folder in, so the stack shows the results too.
const files = import.meta.glob('@bench-results/summary.json', { eager: true, import: 'default' });
const parsed = BenchSummarySchema.safeParse(Object.values(files)[0]);

export default function Lab() {
  return <LabContent summary={parsed.success ? parsed.data : null} />;
}
