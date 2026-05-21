'use client';

import { useEffect, useState } from 'react';
import { BookOpenText, SlidersHorizontal } from 'lucide-react';
import { readUiPreferences, writeUiPreference } from '@/lib/state/uiPreferences';
import { InspectorPanel } from './InspectorPanel';
import { InstructionPanel } from './InstructionPanel';

export function InspectorWorkspacePanel() {
  const [isPropertiesVisible, setIsPropertiesVisible] = useState(true);
  const [isInstructionVisible, setIsInstructionVisible] = useState(false);

  useEffect(() => {
    const preferences = readUiPreferences();
    if (typeof preferences.isInspectorPropertiesVisible === 'boolean') {
      setIsPropertiesVisible(preferences.isInspectorPropertiesVisible);
    }
    if (typeof preferences.isInstructionVisible === 'boolean') {
      setIsInstructionVisible(preferences.isInstructionVisible);
    }
  }, []);

  const toggleProperties = () => {
    setIsPropertiesVisible((value) => {
      const next = !value;
      writeUiPreference('isInspectorPropertiesVisible', next);
      return next;
    });
  };

  const toggleInstruction = () => {
    setIsInstructionVisible((value) => {
      const next = !value;
      writeUiPreference('isInstructionVisible', next);
      return next;
    });
  };

  const splitClass = isPropertiesVisible && isInstructionVisible ? 'basis-1/2' : 'basis-full';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 items-center justify-between gap-2 border-b border-ink-700 bg-ink-950/60 px-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-ink-400">Properties Workspace</div>
        <div className="flex items-center gap-2">
          <button
            aria-label={isPropertiesVisible ? 'Hide Inspector properties' : 'Show Inspector properties'}
            aria-pressed={isPropertiesVisible}
            className={`surface-transition inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] ${
              isPropertiesVisible
                ? 'border-accent/50 bg-accent/15 text-accent'
                : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-accent/50 hover:text-ink-100'
            }`}
            onClick={toggleProperties}
            type="button"
          >
            <SlidersHorizontal size={13} />
            Inspector
          </button>
          <button
            aria-label={isInstructionVisible ? 'Hide Instruction tab' : 'Show Instruction tab'}
            aria-pressed={isInstructionVisible}
            className={`surface-transition inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] ${
              isInstructionVisible
                ? 'border-accent/50 bg-accent/15 text-accent'
                : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-accent/50 hover:text-ink-100'
            }`}
            onClick={toggleInstruction}
            type="button"
          >
            <BookOpenText size={13} />
            Instruction
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {isPropertiesVisible && (
          <section className={`${splitClass} min-h-0 overflow-hidden border-b border-ink-700/80`}>
            <InspectorPanel />
          </section>
        )}
        {isInstructionVisible && (
          <section className={`${splitClass} min-h-0 overflow-hidden`}>
            <InstructionPanel />
          </section>
        )}
        {!isPropertiesVisible && !isInstructionVisible && (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs leading-6 text-ink-400">
            Both panels are hidden. Use the controls above to expand Inspector or Instruction.
          </div>
        )}
      </div>
    </div>
  );
}
