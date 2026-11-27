'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { AiTuningEval } from '@/components/agents/ai-tuning-eval';
import { AiTuningExamples } from '@/components/agents/ai-tuning-examples';

type Section = 'examples' | 'eval';

/**
 * The "Tuning" tab of /agents (SPEC 089 F7, §7.2): dynamic examples with the
 * corrections captured from the inbox, the evaluation set, and the dataset
 * export. There is no model training here (D-19): the agent improves by
 * better context, and the admin decides what enters it.
 */
export function AiTuning() {
  const t = useTranslations('Agents.tuning');
  const [section, setSection] = useState<Section>('examples');

  return (
    <div className="space-y-4">
      <p className="border-border bg-muted/40 text-muted-foreground flex items-start gap-2 rounded-md border px-4 py-3 text-sm">
        <ShieldCheck className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('intro')}</span>
      </p>

      <div className="flex gap-2">
        <Button
          size="sm"
          variant={section === 'examples' ? 'default' : 'outline'}
          onClick={() => setSection('examples')}
        >
          {t('sectionExamples')}
        </Button>
        <Button
          size="sm"
          variant={section === 'eval' ? 'default' : 'outline'}
          onClick={() => setSection('eval')}
        >
          {t('sectionEval')}
        </Button>
      </div>

      {section === 'examples' ? <AiTuningExamples /> : <AiTuningEval />}
    </div>
  );
}
