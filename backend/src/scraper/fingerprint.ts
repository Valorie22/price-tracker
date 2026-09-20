/**
 * Structure-change detection.
 *
 * A scraper that silently keeps working while the store reshapes itself is a scraper
 * that is about to break without warning. This module turns "what shape was the store
 * in when we read it?" into a short stable string, so a change is a detectable event
 * rather than a surprise at 3 a.m.
 *
 * This store makes the idea unusually concrete: it publishes its own structure at
 * `/api/layout` and rotates it. Phase 1 observed `revision: 627000, variant: 4` with
 * every price-area class suffixed `-z6`, a `priceTag` of `span` and a `priceCarrier`
 * of `text` — all four of which the shipped bundle reads at runtime and can change.
 *
 * A changed fingerprint never blocks a write on its own. It is an alert, not a veto:
 * the store is allowed to redecorate, and we are allowed to notice.
 */
import crypto from 'node:crypto';
import type { StoreLayout } from './storeClient.js';

export interface FingerprintInput {
  strategy: string;
  /** For the API path: the layout document the store published. */
  layout?: StoreLayout | null;
  /** Keys present in the decrypted quote, sorted. */
  quoteKeys?: string[];
  /** For the DOM path: which candidate selectors matched, sorted. */
  matchedSelectors?: string[];
  /** For the DOM path: tag/class path from the price node up to the document. */
  ancestorPath?: string;
}

export interface Fingerprint {
  fingerprint: string;
  details: Record<string, unknown>;
}

const hash = (s: string): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Class names rotate as a family (`pv-z6`, `mr-z6`, …); only the suffix carries signal. */
function classSuffix(classes: Record<string, string> | undefined): string | null {
  const value = classes?.['priceValue'];
  if (!value) return null;
  const m = /-([a-z0-9]+)$/i.exec(value);
  return m?.[1] ?? value;
}

export function computeFingerprint(input: FingerprintInput): Fingerprint {
  const parts: string[] = [`strategy=${input.strategy}`];
  const details: Record<string, unknown> = { strategy: input.strategy };

  if (input.layout) {
    const suffix = classSuffix(input.layout.classes);
    // `revision` and `validUntil` are timestamps, not structure — deliberately excluded,
    // otherwise every rotation window would look like a breaking change.
    parts.push(
      `layoutVariant=${input.layout.variant}`,
      `priceTag=${input.layout.priceTag}`,
      `priceCarrier=${input.layout.priceCarrier}`,
      `facetOrder=${(input.layout.order ?? []).join('>')}`,
      `classSuffix=${suffix ?? 'none'}`,
      `classKeys=${Object.keys(input.layout.classes ?? {}).sort().join(',')}`,
    );
    details['layout'] = {
      variant: input.layout.variant,
      revision: input.layout.revision,
      priceTag: input.layout.priceTag,
      priceCarrier: input.layout.priceCarrier,
      order: input.layout.order,
      classSuffix: suffix,
    };
  }

  if (input.quoteKeys?.length) {
    parts.push(`quoteKeys=${[...input.quoteKeys].sort().join(',')}`);
    details['quoteKeys'] = [...input.quoteKeys].sort();
  }

  if (input.matchedSelectors?.length) {
    parts.push(`selectors=${[...input.matchedSelectors].sort().join('|')}`);
    details['matchedSelectors'] = [...input.matchedSelectors].sort();
  }

  if (input.ancestorPath) {
    parts.push(`ancestors=${hash(input.ancestorPath)}`);
    details['ancestorPath'] = input.ancestorPath;
  }

  const raw = parts.join(';');
  return { fingerprint: `${input.strategy}:${hash(raw)}`, details: { ...details, raw } };
}

/**
 * Human sentence describing what moved, for the alert and the UI banner.
 * Falls back to a generic line when we have no previous detail to diff against.
 */
export function describeStructureChange(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown>,
): string {
  const prevLayout = (previous?.['layout'] ?? null) as Record<string, unknown> | null;
  const nextLayout = (next['layout'] ?? null) as Record<string, unknown> | null;
  const changes: string[] = [];

  if (prevLayout && nextLayout) {
    for (const key of ['variant', 'priceTag', 'priceCarrier', 'classSuffix'] as const) {
      if (JSON.stringify(prevLayout[key]) !== JSON.stringify(nextLayout[key])) {
        changes.push(`${key}: ${JSON.stringify(prevLayout[key])} → ${JSON.stringify(nextLayout[key])}`);
      }
    }
    if (JSON.stringify(prevLayout['order']) !== JSON.stringify(nextLayout['order'])) {
      changes.push(`facet order: ${JSON.stringify(prevLayout['order'])} → ${JSON.stringify(nextLayout['order'])}`);
    }
  }

  const prevKeys = previous?.['quoteKeys'] as string[] | undefined;
  const nextKeys = next['quoteKeys'] as string[] | undefined;
  if (prevKeys && nextKeys) {
    const added = nextKeys.filter((k) => !prevKeys.includes(k));
    const removed = prevKeys.filter((k) => !nextKeys.includes(k));
    if (added.length) changes.push(`new quote fields: ${added.join(', ')}`);
    if (removed.length) changes.push(`quote fields gone: ${removed.join(', ')}`);
  }

  const prevSel = previous?.['matchedSelectors'] as string[] | undefined;
  const nextSel = next['matchedSelectors'] as string[] | undefined;
  if (prevSel && nextSel) {
    const lost = prevSel.filter((s) => !nextSel.includes(s));
    const gained = nextSel.filter((s) => !prevSel.includes(s));
    if (lost.length) changes.push(`selectors stopped matching: ${lost.join(', ')}`);
    if (gained.length) changes.push(`selectors started matching: ${gained.join(', ')}`);
  }

  if (changes.length === 0) return 'The store changed the shape of its price area.';
  return `The store changed its price area — ${changes.join('; ')}.`;
}
