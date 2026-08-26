import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const PAGE = Number(__ENV.PAGE || 1);
const LIMIT = Number(__ENV.LIMIT || 10);
const RESULTS_DIR = __ENV.RESULTS_DIR || 'loadtest/results';

export const options = {
  scenarios: {
    read_load: {
      executor: 'constant-vus',
      vus: 1000,
      duration: '30s',
      gracefulStop: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200'],
    checks: ['rate>0.9999'],
  },
};

export default function () {
  const response = http.get(`${BASE_URL}/api/v1/products?page=${PAGE}&limit=${LIMIT}`, {
    tags: { endpoint: 'products' },
  });

  check(response, {
    'status is 200': (r) => r.status === 200,
    'response status is success': (r) => r.json('status') === 'success',
    'pagination matches request': (r) => r.json('meta.page') === PAGE && r.json('meta.limit') === LIMIT,
  });

  sleep(0.1);
}

export function handleSummary(data) {
  const requests = data.metrics.http_reqs?.values;
  const latency = data.metrics.http_req_duration?.values;
  const failures = data.metrics.http_req_failed?.values;
  const checks = data.metrics.checks?.values;

  const summary = {
    testType: 'read',
    generatedAt: new Date().toISOString(),
    target: `${BASE_URL}/api/v1/products?page=${PAGE}&limit=${LIMIT}`,
    concurrentUsers: 1000,
    page: PAGE,
    limit: LIMIT,
    requests: requests?.count || 0,
    requestsPerSecond: requests?.rate || 0,
    p95LatencyMs: latency?.['p(95)'] || 0,
    averageLatencyMs: latency?.avg || 0,
    p95WaitingMs: data.metrics.http_req_waiting?.values['p(95)'] || 0,
    p95SendingMs: data.metrics.http_req_sending?.values['p(95)'] || 0,
    p95ReceivingMs: data.metrics.http_req_receiving?.values['p(95)'] || 0,
    p95BlockedMs: data.metrics.http_req_blocked?.values['p(95)'] || 0,
    p95ConnectingMs: data.metrics.http_req_connecting?.values['p(95)'] || 0,
    errorRate: failures?.rate || 0,
    checksPassed: checks?.passes || 0,
    checksFailed: checks?.fails || 0,
  };

  return {
    stdout: `\nREAD LOAD SUMMARY\n${JSON.stringify(summary, null, 2)}\n`,
    [`${RESULTS_DIR}/read-summary.json`]: JSON.stringify(summary, null, 2),
  };
}
