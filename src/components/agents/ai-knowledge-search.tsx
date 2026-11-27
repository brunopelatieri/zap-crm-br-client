'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { KNOWLEDGE_MAX_DISTANCE } from '@/lib/ai/defaults';
import { QUERY_MAX_CHARS } from '@/lib/ai/query';

type Origin = 'semantic' | 'lexical' | 'both';

interface SearchHit {
  chunk_id: string;
  document_id: string | null;
  title: string | null;
  heading: string | null;
  content: string;
  distance: number | null;
  lexical_rank: number | null;
  score: number;
  origin: Origin;
}

interface SearchResult {
  search_failed: boolean;
  used_embedding: boolean;
  embedding_failed: boolean;
  knowledge_empty: boolean;
  embeddings_key_unreadable: boolean;
  lexical_query: string;
  max_distance: number;
  hits: SearchHit[];
}

const PREVIEW_CHARS = 240;

/**
 * "Test retrieval" (SPEC 089 F3): type a customer question and see which
 * knowledge-base excerpts the agent would receive, ranked, with score,
 * origin (semantic / lexical / both) and document. Never calls the LLM.
 */
export function AiKnowledgeSearch() {
  const t = useTranslations('Agents.knowledgeSearch');
  const [query, setQuery] = useState('');
  const [maxDistance, setMaxDistance] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const run = async () => {
    const q = query.trim();
    if (!q || loading) return;
    const body: { query: string; max_distance?: number } = { query: q };
    if (maxDistance.trim() !== '') {
      const v = Number(maxDistance.replace(',', '.'));
      if (!Number.isFinite(v) || v < 0 || v > 2) {
        toast.error(t('badDistance'));
        return;
      }
      body.max_distance = v;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          res.status === 429
            ? t('rateLimited')
            : res.status === 403
              ? t('forbidden')
              : t('failed')
        );
        return;
      }
      setResult(data as SearchResult);
      setExpanded(new Set());
    } catch {
      toast.error(t('failed'));
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="text-primary h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="kb-search-query">{t('queryLabel')}</Label>
          <Textarea
            id="kb-search-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void run();
              }
            }}
            maxLength={QUERY_MAX_CHARS}
            rows={2}
            placeholder={t('queryPlaceholder')}
          />
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="kb-search-distance" className="text-xs">
              {t('distanceLabel')}
            </Label>
            <Input
              id="kb-search-distance"
              inputMode="decimal"
              value={maxDistance}
              onChange={(e) => setMaxDistance(e.target.value)}
              placeholder={String(KNOWLEDGE_MAX_DISTANCE)}
              className="w-28"
            />
          </div>
          <Button
            onClick={() => void run()}
            disabled={!query.trim() || loading}
          >
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-2 h-4 w-4" />
            )}
            {t('search')}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t('distanceHint')}</p>

        {result && (
          <div className="space-y-3" data-testid="kb-search-results">
            {result.search_failed && (
              <p className="flex items-start gap-1.5 text-xs text-amber-500">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('searchFailed')}
              </p>
            )}
            {result.embeddings_key_unreadable && (
              <p className="flex items-start gap-1.5 text-xs text-amber-500">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('keyUnreadable')}
              </p>
            )}

            {!result.knowledge_empty && (
              <p className="text-muted-foreground text-xs">
                {result.used_embedding
                  ? t('vectorOn')
                  : result.embedding_failed
                    ? t('vectorFailed')
                    : t('vectorOff')}
                {result.lexical_query
                  ? ` · ${t('words', { words: result.lexical_query })}`
                  : ''}
                {result.used_embedding
                  ? ` · ${t('ceiling', { value: result.max_distance })}`
                  : ''}
              </p>
            )}

            {result.hits.length === 0 ? (
              <p className="text-foreground rounded-md border border-dashed p-3 text-sm">
                {result.knowledge_empty ? t('baseEmpty') : t('noResults')}
              </p>
            ) : (
              <ol className="divide-border border-border divide-y rounded-md border">
                {result.hits.map((hit, i) => {
                  const open = expanded.has(hit.chunk_id);
                  const long = hit.content.length > PREVIEW_CHARS;
                  return (
                    <li key={hit.chunk_id} className="space-y-1.5 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground text-xs tabular-nums">
                          #{i + 1}
                        </span>
                        <span className="text-foreground min-w-0 truncate text-sm font-medium">
                          {hit.title ?? t('untitled')}
                        </span>
                        <Badge variant="outline">
                          {t(`origin.${hit.origin}`)}
                        </Badge>
                        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                          {t('score', { value: hit.score.toFixed(4) })}
                          {hit.distance !== null
                            ? ` · ${t('distance', { value: hit.distance.toFixed(3) })}`
                            : ''}
                        </span>
                      </div>
                      {hit.heading && hit.heading !== hit.title && (
                        <p className="text-muted-foreground text-xs">
                          {hit.heading}
                        </p>
                      )}
                      <p className="text-foreground/90 text-xs whitespace-pre-wrap">
                        {open || !long
                          ? hit.content
                          : `${hit.content.slice(0, PREVIEW_CHARS)}…`}
                      </p>
                      {long && (
                        <button
                          type="button"
                          onClick={() => toggle(hit.chunk_id)}
                          className="text-primary text-xs hover:underline"
                        >
                          {open ? t('showLess') : t('showMore')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
