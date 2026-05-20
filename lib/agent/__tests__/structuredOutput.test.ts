import { describe, expect, it } from 'vitest';
import { parseStructuredJson } from '../structuredOutput';

describe('parseStructuredJson', () => {
  it('accepts fenced JSON', () => {
    expect(parseStructuredJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('uses the first complete JSON value when providers append extra output', () => {
    expect(parseStructuredJson('{"title":"Diagram"}\n{"extra":"second object"}')).toEqual({ title: 'Diagram' });
  });
});
