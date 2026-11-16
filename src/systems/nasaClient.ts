export type NASAResult = { dataset: string; source: string; observedAt: string; cached?: boolean; snapshot?: boolean; snapshotImage?: string; data: unknown };
export function nasaApiUrl(resource: string, baseUrl: string, apiBase = baseUrl) {
  const query = resource.startsWith('?') ? resource : `/${resource}`;
  return `${apiBase.replace(/\/$/, '')}/api/nasa${query}`;
}
/** Prefer the private server, then the dated, public NASA snapshot for static hosting. */
export async function loadNASAData(dataset: string, baseUrl: string, signal: AbortSignal, mode: 'proxy' | 'snapshot' = 'proxy', apiBase = baseUrl): Promise<NASAResult> {
  let serviceError = 'El servicio científico no está disponible.';
  if (mode === 'proxy') try {
    const response = await fetch(nasaApiUrl(`?dataset=${encodeURIComponent(dataset)}`, baseUrl, apiBase), { signal, headers: { Accept: 'application/json' } });
    const value: unknown = await response.json();
    if (response.ok && value && typeof value === 'object' && 'data' in value) return value as NASAResult;
    if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') serviceError = value.error;
  } catch (error) { if (signal.aborted) throw error; }
  try {
    if (mode === 'snapshot') {
      const manifest = await fetch(`${baseUrl}nasa-data/index.json`, { signal, headers: { Accept: 'application/json' } });
      if (!manifest.ok) throw new Error('Snapshot index unavailable');
      const datasets: unknown = await manifest.json();
      if (!Array.isArray(datasets) || !datasets.includes(dataset)) throw new Error('Snapshot unavailable');
    }
    const response = await fetch(`${baseUrl}nasa-data/${encodeURIComponent(dataset)}.json`, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Sin archivo publicado');
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('data' in value) || !('observedAt' in value) || !('dataset' in value) || value.dataset !== dataset) throw new Error('Archivo inválido');
    return { ...value as NASAResult, snapshot: true };
  } catch (error) { if (signal.aborted) throw error; throw new Error(`${serviceError} Tampoco hay datos publicados para esta fuente.`); }
}
