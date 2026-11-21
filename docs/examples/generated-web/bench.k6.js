import http from 'k6/http';
import { fail } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const cases = {
  health: { path: '/health', status: 200 },
  asset: { path: '/assets/posts.svg', status: 200 },
  'rest-miss': { path: '/api/not-a-route', status: 404 },
  view: { path: '/api/views/posts?limit=2', status: 200 }
};
const target = cases[__ENV.CASE ?? 'health'];
if (!target || !__ENV.ORIGIN) throw new Error('Set ORIGIN and choose CASE=health, asset, rest-miss or view.');
const url = __ENV.ORIGIN.replace(/\/$/, '') + target.path;
const successful = new Counter('successful_requests');
const unexpected = new Rate('unexpected_responses');
const latency = new Trend('response_latency', true);
const status = http.expectedStatuses(target.status);

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    requests: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE ?? 1000),
      timeUnit: '1s',
      duration: __ENV.DURATION ?? '20s',
      preAllocatedVUs: Number(__ENV.VUS ?? 64)
    }
  }
};

export function setup() {
  for (let i = 0; i < 20; i++) {
    const result = http.get(url, { responseCallback: status, redirects: 0 });
    if (result.status !== target.status) fail(`Expected ${target.status} at ${target.path}, received ${result.status}`);
  }
}

export default function () {
  const result = http.get(url, { responseCallback: status, redirects: 0 });
  const ok = result.status === target.status;
  successful.add(ok ? 1 : 0);
  unexpected.add(!ok);
  latency.add(result.timings.duration);
}
