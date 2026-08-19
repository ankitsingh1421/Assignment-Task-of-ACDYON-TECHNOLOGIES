const fetchButton = document.querySelector('#fetch-button');
const runMessage = document.querySelector('#run-message');
const jobCount = document.querySelector('#job-count');
const activeSource = document.querySelector('#active-source');
const lastFetched = document.querySelector('#last-fetched');
const pipelineState = document.querySelector('#pipeline-state');
const healthTime = document.querySelector('#health-time');
const sourceList = document.querySelector('#source-list');
const runLog = document.querySelector('#run-log');
const jobsList = document.querySelector('#jobs-list');
const sourceFilter = document.querySelector('#source-filter');
const limitFilter = document.querySelector('#limit-filter');
const refreshButton = document.querySelector('#refresh-button');

const sourceNames = { remoteok: 'RemoteOK', weworkremotely: 'We Work Remotely' };

function sourceName(id) { return sourceNames[id] || id; }
function formatDate(value) {
  if (!value) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}
function formatTime(value) {
  if (!value) return 'Waiting for a run';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

async function loadJobs() {
  const params = new URLSearchParams({ limit: limitFilter.value });
  if (sourceFilter.value) params.set('source', sourceFilter.value);
  const response = await fetch(`/jobs?${params}`);
  if (!response.ok) throw new Error('Could not load stored listings');
  const data = await response.json();
  jobCount.textContent = data.count;
  if (!data.jobs.length) {
    jobsList.innerHTML = '<div class="empty">No listings stored yet. Run the pipeline to fetch public jobs.</div>';
    return;
  }
  jobsList.innerHTML = data.jobs.map((job) => `
    <article class="job-card">
      <div class="job-top"><span class="source-id">${escapeHtml(sourceName(job.sourceId))}</span><a class="job-link" href="${escapeHtml(job.url)}" target="_blank" rel="noreferrer">View source &#8599;</a></div>
      <h3 class="job-title">${escapeHtml(job.title)}</h3>
      <p class="job-company">${escapeHtml(job.company)}</p>
      <p class="job-detail">${escapeHtml(job.location)} &middot; ${escapeHtml(formatDate(job.postedAt))}</p>
    </article>`).join('');
}

async function loadHealth() {
  const response = await fetch('/health');
  if (!response.ok) throw new Error('Could not load pipeline health');
  const data = await response.json();
  activeSource.textContent = data.lastUsedSource ? sourceName(data.lastUsedSource) : 'None yet';
  const lastLog = data.lastRun?.find((entry) => entry.status === 'ok');
  lastFetched.textContent = lastLog ? `Last successful run ${formatTime(lastLog.timestamp)}` : 'Waiting for a successful run';
  pipelineState.textContent = data.lastUsedSource ? 'Healthy' : 'Ready';
  healthTime.textContent = `Checked ${formatTime(new Date().toISOString())}`;
  sourceList.innerHTML = data.sources.map((source) => {
    const status = source.circuitState === 'closed' ? 'Healthy' : source.circuitState.replace('_', ' ');
    const statusClass = source.circuitState === 'closed' ? '' : source.circuitState === 'open' ? 'warning' : 'neutral';
    const detail = source.lastRun ? `${source.lastRun.status}${source.lastRun.jobsFound !== undefined ? ` / ${source.lastRun.jobsFound} jobs` : ''}` : 'No run recorded';
    return `<div class="source-row"><div><span class="status-dot ${statusClass}"></span><span class="source-name">${escapeHtml(sourceName(source.sourceId))}</span></div><div class="source-meta"><span>${escapeHtml(status)}</span><span>${escapeHtml(detail)}</span><span>${source.consecutiveEmptyRuns} empty runs</span></div></div>`;
  }).join('');
  runLog.innerHTML = data.lastRun?.length
    ? `<div class="run-log-heading"><span class="summary-label">Latest run log</span><span class="muted">${data.lastRun.length} source attempt${data.lastRun.length === 1 ? '' : 's'}</span></div>${data.lastRun.map((entry) => `<div class="log-entry"><span class="log-source">${escapeHtml(sourceName(entry.sourceId))}</span><span class="log-status">${escapeHtml(entry.status)}</span><span class="muted">${entry.jobsFound !== undefined ? `${entry.jobsFound} jobs` : escapeHtml(entry.detail || 'No additional detail')}</span></div>`).join('')}`
    : '<div class="run-log-empty">No ingestion run has been recorded yet.</div>';
}

async function refresh() {
  try {
    await Promise.all([loadJobs(), loadHealth()]);
  } catch (error) {
    jobsList.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    pipelineState.textContent = 'Unavailable';
  }
}

fetchButton.addEventListener('click', async () => {
  fetchButton.disabled = true;
  runMessage.textContent = 'Contacting sources and applying failover...';
  try {
    const response = await fetch('/ingest', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Ingestion failed');
    runMessage.textContent = result.usedSource ? `Run complete via ${sourceName(result.usedSource)}.` : 'No source returned usable listings.';
    await refresh();
  } catch (error) {
    runMessage.textContent = error.message;
    pipelineState.textContent = 'Failed';
  } finally {
    fetchButton.disabled = false;
  }
});

sourceFilter.addEventListener('change', loadJobs);
limitFilter.addEventListener('change', loadJobs);
refreshButton.addEventListener('click', refresh);

refresh();
