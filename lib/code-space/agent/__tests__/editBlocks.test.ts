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
});
