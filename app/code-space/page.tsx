'use client';

import { useEffect } from 'react';
import Page from '../page';
import { useDiagramStore } from '@/lib/state/store';

export default function CodeSpaceRoute() {
  const setMode = useDiagramStore((s) => s.setMode);

  useEffect(() => {
    setMode('code-space');
  }, [setMode]);

  return <Page />;
}
