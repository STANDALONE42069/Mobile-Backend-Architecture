import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { expectedStatuses } from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1001';
const RESULTS_DIR = __ENV.RESULTS_DIR || 'loadtest/results';

const writeRequests = new Counter('write_requests');
const writeLatency = new Trend('write_latency', true);
const writeErrors = new Rate('write_errors');
const acceptedOrders = new Counter('accepted_orders');
const rejectedDuplicates = new Counter('rejected_duplicates');
const writeStartedAt = new Trend('write_started_at');
const writeCompletedAt = new Trend('write_completed_at');

http.setResponseCallback(expectedStatuses(200, 202, 409));

export const options = {
  scenarios: {
    write_load: {
      executor: 'per-vu-iterations',
      vus: 500,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    'http_req_failed{scenario:write_load}': ['rate<0.01'],
    'http_req_duration{scenario:write_load}': ['p(95)<300'],
    write_latency: ['p(95)<300'],
    write_errors: ['rate<0.001'],
    checks: ['rate>0.9999'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export function setup() {
  const tokens = [];

  for (let i = 1; i <= 500; i += 1) {
    const response = http.post(`${BASE_URL}/api/v1/auth/token`, JSON.stringify({ userId: `user-${i}` }), {
      headers: { 'Content-Type': 'application/json' },
    });

    check(response, {
      'token issued': (r) => r.status === 200 && typeof r.json('accessToken') === 'string',
    });
    tokens.push(response.json('accessToken'));
  }

  return { tokens };
}

export default function (data) {
  const userIndex = exec.vu.idInTest - 1;
  const token = data.tokens[userIndex];
  sleep(0.25);
  const requestCount = userIndex < 25 ? 3 : userIndex < 50 ? 2 : 1;
  const requests = Array.from({ length: requestCount }, () => ({
    method: 'POST',
    url: `${BASE_URL}/api/v1/orders`,
    body: JSON.stringify({ productId: PRODUCT_ID }),
    params: {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      tags: { endpoint: 'orders' },
    },
  }));
  writeStartedAt.add(Date.now());
  const responses = http.batch(requests);
  const completedAt = Date.now();

  for (const response of responses) {
    writeCompletedAt.add(completedAt);
    writeRequests.add(1);
    writeLatency.add(response.timings.duration);
    writeErrors.add(response.status !== 202 && response.status !== 409);
    if (response.status === 202) acceptedOrders.add(1);
    if (response.status === 409) rejectedDuplicates.add(1);
  }

  check(responses, {
    'exactly one order queued per user': (items) => items.filter((r) => r.status === 202).length === 1,
    'all duplicate requests rejected': (items) => items.filter((r) => r.status === 409).length === requestCount - 1,
  });
}

export function handleSummary(data) {
  const requests = data.metrics.write_requests?.values;
  const latency = data.metrics.write_latency?.values;
  const failures = data.metrics.write_errors?.values;
  const checks = data.metrics.checks?.values;
  const burstStartedAt = data.metrics.write_started_at?.values.min || 0;
  const burstCompletedAt = data.metrics.write_completed_at?.values.max || 0;
  const burstDurationMs = Math.max(0, burstCompletedAt - burstStartedAt);

  const summary = {
    testType: 'write',
    generatedAt: new Date().toISOString(),
    target: `${BASE_URL}/api/v1/orders`,
    productId: PRODUCT_ID,
    concurrentUsers: 500,
    uniqueUsers: 500,
    requests: requests?.count || 0,
    requestsPerSecond: burstDurationMs ? (requests?.count || 0) / (burstDurationMs / 1000) : 0,
    burstDurationMs,
    p95LatencyMs: latency?.['p(95)'] || 0,
    averageLatencyMs: latency?.avg || 0,
    errorRate: failures?.rate || 0,
    acceptedOrders: data.metrics.accepted_orders?.values.count || 0,
    rejectedDuplicates: data.metrics.rejected_duplicates?.values.count || 0,
    checksPassed: checks?.passes || 0,
    checksFailed: checks?.fails || 0,
  };

  return {
    stdout: `\nWRITE LOAD SUMMARY\n${JSON.stringify(summary, null, 2)}\n`,
    [`${RESULTS_DIR}/write-summary.json`]: JSON.stringify(summary, null, 2),
  };
}
