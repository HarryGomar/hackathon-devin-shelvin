import { homeStrings as s } from './strings';

export interface Modes {
  apiMode: 'mock' | 'live';
  searchMode: 'mock' | 'claude';
  identifyMode: 'mock' | 'live';
}

/**
 * Which parts are real. With a live backend, search and scrapers are live whatever `searchMode` says
 * (`searchMode` stays 'mock' then: it only switches the mock backend's search to Claude).
 */
export function liveParts({ apiMode, searchMode, identifyMode }: Modes) {
  return { id: identifyMode === 'live', search: apiMode === 'live' || searchMode === 'claude', scrapers: apiMode === 'live' };
}

/**
 * Home's status line, saying exactly which parts are real: "DEMO DATA" when everything is mocked, "LIVE" when nothing is,
 * otherwise each part, e.g. "LIVE ID · LIVE SEARCH · DEMO SCRAPERS". With a live backend, search and scrapers are live too.
 */
export function modeStatus(modes: Modes): { label: string; demo: boolean } {
  const { id, search, scrapers } = liveParts(modes);
  if (id && search && scrapers) return { label: s.modeLive, demo: false };
  if (!id && !search && !scrapers) return { label: s.modeDemo, demo: true };
  return {
    label: [id ? s.liveId : s.demoId, search ? s.liveSearch : s.demoSearch, scrapers ? s.liveScrapers : s.demoScrapers].join(' · '),
    demo: true,
  };
}
