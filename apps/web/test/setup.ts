import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only cleans up by itself when test globals are enabled; we import them explicitly.
afterEach(() => cleanup());
