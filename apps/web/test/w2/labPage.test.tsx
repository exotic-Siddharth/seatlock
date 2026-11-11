import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Lab from '../../src/pages/Lab';

/*
 * The Lab page reads the committed results through import.meta.glob at build time, so a wrong
 * path quietly shows "no results" forever (the Docker image did exactly that). Here the real
 * page, through its real glob, renders the fixture that vitest.config.ts maps @bench-results
 * to; labAlias.test.ts pins what the production build maps it to.
 */
describe('Lab page results file', () => {
  it('renders the summary.json its glob finds', () => {
    render(<Lab />);
    expect(screen.getByText(/Glob Fixture CPU/)).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Hot seat results' })).toBeTruthy();
    expect(screen.queryByText('No benchmark results committed yet')).toBeNull();
  });
});
