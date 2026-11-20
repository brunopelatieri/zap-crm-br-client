'use client';

// ============================================================
// Tela "confirme seu telefone" (SPEC 085 F7).
//
// O formulário com `settings.phone_proof` não aceita o telefone digitado: a
// pessoa envia, do próprio WhatsApp, um código ao número da conta. Esta tela
// pede o código à sessão (`requestProof`), mostra o botão `wa.me` com a
// mensagem pronta e consulta (`checkProof`, a cada 3 s) até a mensagem
// chegar; então avisa o componente (`onConfirmed`), que repete o `start`.
// Com Turnstile no formulário, o desafio roda ANTES de pedir o código.
// ============================================================

import { MessageCircle } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import type { LiveHandlers } from '@/lib/forms/form-session';
import type { PublicFormTranslator } from '@/lib/forms/public-messages';
import type { Answers } from '@/lib/forms/types';

import { TurnstileWidget } from './turnstile-widget';

export const PROOF_POLL_MS = 3000;

type Phase =
  | { kind: 'requesting' }
  | { kind: 'waiting'; code: string; whatsappNumber: string }
  | { kind: 'confirmed' }
  | { kind: 'expired' }
  | { kind: 'error'; code: string; retryAfterSeconds?: number };

export interface PhoneProofStepProps {
  t: PublicFormTranslator;
  live: LiveHandlers;
  answers: Answers;
  /** `settings.turnstile_site_key` do payload (ou `null`). */
  turnstileKey: string | null;
  /** Repete o `start` com a prova confirmada (também no "tentar de novo"). */
  onConfirmed: () => void;
  /** Mensagem do último `start` recusado depois da confirmação (ou `''`). */
  startError: string;
  onBack: () => void;
  buttonClass: string;
  buttonStyle: CSSProperties;
}

function waUrl(number: string, text: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

function errorText(
  t: PublicFormTranslator,
  code: string,
  retryAfterSeconds?: number
): string {
  switch (code) {
    case 'network':
      return t('networkError');
    case 'invalid_phone':
      return t('invalidPhone');
    case 'too_fast':
      return t('tooFast');
    case 'turnstile_failed':
      return t('turnstileFailed');
    case 'rate_limited':
      return t('phoneProof.rateLimited', {
        minutes: Math.max(1, Math.ceil((retryAfterSeconds ?? 60) / 60)),
      });
    case 'proof_unavailable':
      return t('phoneProof.unavailable');
    default:
      return t('phoneProof.failed');
  }
}

export function PhoneProofStep({
  t,
  live,
  answers,
  turnstileKey,
  onConfirmed,
  startError,
  onBack,
  buttonClass,
  buttonStyle,
}: PhoneProofStepProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'requesting' });
  const [attempt, setAttempt] = useState(0);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const answersRef = useRef(answers);
  const confirmedRef = useRef(onConfirmed);
  useEffect(() => {
    answersRef.current = answers;
    confirmedRef.current = onConfirmed;
  }, [answers, onConfirmed]);

  // Pede o código (de novo a cada `attempt`); com Turnstile, espera o token.
  // O pedido vive num ref por (tentativa, token): o StrictMode roda o efeito
  // duas vezes e um 2º pedido cairia no intervalo mínimo entre códigos.
  const needsToken = !!turnstileKey;
  const inflight = useRef<{
    key: string;
    promise: ReturnType<LiveHandlers['requestProof']>;
  } | null>(null);
  useEffect(() => {
    if (needsToken && !turnstileToken) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase({ kind: 'requesting' });
    const key = `${attempt}:${turnstileToken ?? ''}`;
    if (inflight.current?.key !== key) {
      inflight.current = {
        key,
        promise: live.requestProof(answersRef.current, turnstileToken, {
          fresh: attempt > 0,
        }),
      };
    }
    void inflight.current.promise.then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setPhase({
          kind: 'waiting',
          code: r.code,
          whatsappNumber: r.whatsappNumber,
        });
      } else {
        setPhase({
          kind: 'error',
          code: r.code,
          retryAfterSeconds: r.retryAfterSeconds,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [live, attempt, needsToken, turnstileToken]);

  // Consulta enquanto espera a mensagem.
  const waiting = phase.kind === 'waiting';
  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    const id = setInterval(() => {
      void live.checkProof().then((outcome) => {
        if (cancelled) return;
        if (outcome === 'confirmed') {
          // Para o polling (o efeito depende de `waiting`) e segue.
          setPhase({ kind: 'confirmed' });
          confirmedRef.current();
        } else if (outcome === 'expired') setPhase({ kind: 'expired' });
      });
    }, PROOF_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live, waiting]);

  const again = useCallback(() => {
    // O token do Turnstile é de uso único: um novo código pede um novo desafio.
    setTurnstileToken(null);
    setAttempt((n) => n + 1);
  }, []);

  return (
    <div className="flex flex-col items-start gap-5">
      <h1 className="text-2xl leading-tight font-bold">
        {t('phoneProof.title')}
      </h1>

      {turnstileKey && !turnstileToken && phase.kind !== 'waiting' ? (
        <TurnstileWidget
          key={attempt}
          siteKey={turnstileKey}
          onToken={setTurnstileToken}
        />
      ) : null}

      {phase.kind === 'requesting' && (!needsToken || turnstileToken) && (
        <p className="text-base opacity-80" role="status">
          {t('phoneProof.requesting')}
        </p>
      )}

      {phase.kind === 'waiting' && (
        <>
          <p className="text-base opacity-80">{t('phoneProof.body')}</p>
          <p
            className="rounded-lg border px-4 py-3 font-mono text-3xl font-bold tracking-widest select-all"
            style={{
              borderColor:
                'color-mix(in srgb, var(--pf-text) 25%, transparent)',
            }}
            aria-label={t('phoneProof.codeLabel')}
          >
            {phase.code}
          </p>
          <a
            href={waUrl(
              phase.whatsappNumber,
              t('phoneProof.whatsappText', { code: phase.code })
            )}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass}
            style={{ ...buttonStyle, outlineColor: 'var(--pf-primary)' }}
          >
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            {t('phoneProof.open')}
          </a>
          <p className="text-sm opacity-60" role="status" aria-live="polite">
            {t('phoneProof.waiting')}
          </p>
        </>
      )}

      {phase.kind === 'confirmed' && (
        <>
          <p className="text-base opacity-80" role="status">
            {t('phoneProof.confirmed')}
          </p>
          {startError ? (
            <>
              <p className="text-base" role="alert">
                {startError}
              </p>
              <button
                type="button"
                onClick={onConfirmed}
                className={buttonClass}
                style={buttonStyle}
              >
                {t('retry')}
              </button>
            </>
          ) : null}
        </>
      )}

      {phase.kind === 'expired' && (
        <>
          <p className="text-base opacity-80" role="alert">
            {t('phoneProof.expired')}
          </p>
          <button
            type="button"
            onClick={again}
            className={buttonClass}
            style={buttonStyle}
          >
            {t('phoneProof.newCode')}
          </button>
        </>
      )}

      {phase.kind === 'error' && (
        <>
          <p className="text-base" role="alert">
            {errorText(t, phase.code, phase.retryAfterSeconds)}
          </p>
          <button
            type="button"
            onClick={again}
            className={buttonClass}
            style={buttonStyle}
          >
            {t('retry')}
          </button>
        </>
      )}

      <button
        type="button"
        onClick={onBack}
        className="text-sm underline opacity-70 hover:opacity-100"
      >
        {t('phoneProof.changeNumber')}
      </button>
    </div>
  );
}
