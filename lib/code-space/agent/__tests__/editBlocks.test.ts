import { describe, expect, it } from 'vitest';
import { validateSyntaxLightweight } from '../editBlocks';

describe('validateSyntaxLightweight', () => {
  it('detects unexpected Python indentation before patch review', () => {
    const diagnostics = validateSyntaxLightweight(
      'api/chatbot.py',
      ['from typing import Any', '', '    def __init__(self, *args: Any, **kwargs: Any):', '        self.value = 1', ''].join('\n'),
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SYNTAX_ERROR',
          line: 3,
        }),
      ]),
    );
  });

  it('allows valid nested Python blocks', () => {
    const diagnostics = validateSyntaxLightweight(
      'api/chatbot.py',
      [
        'from typing import Any',
        '',
        'class RAGMedicalChatbot:',
        '    def __init__(self, *args: Any, **kwargs: Any):',
        '        self.value = 1',
        '',
      ].join('\n'),
    );

    expect(diagnostics).toEqual([]);
  });

  it('accepts a block header that closes a multi-line bracket on the colon line', () => {
    const diagnostics = validateSyntaxLightweight(
      'backend/api/config.py',
      [
        'def setup_logging():',
        '    for name in [',
        '        "uvicorn.error", "uvicorn.access",',
        '        "fastapi", "starlette",',
        '        "pymongo", "gridfs",',
        '    ]:',
        '        logging.getLogger(name).setLevel(logging.WARNING)',
        '',
      ].join('\n'),
    );

    expect(diagnostics).toEqual([]);
  });

  it('accepts a multi-line if-condition wrapped in parentheses', () => {
    const diagnostics = validateSyntaxLightweight(
      'backend/api/config.py',
      [
        'def check(a, b):',
        '    if (a and',
        '            b):',
        '        return True',
        '    return False',
        '',
      ].join('\n'),
    );

    expect(diagnostics).toEqual([]);
  });

  it('accepts a backslash line continuation before an indented body', () => {
    const diagnostics = validateSyntaxLightweight(
      'backend/api/config.py',
      [
        'def compute():',
        '    total = 1 + \\',
        '        2',
        '    return total',
        '',
      ].join('\n'),
    );

    expect(diagnostics).toEqual([]);
  });
});
