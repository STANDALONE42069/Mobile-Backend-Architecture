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

http.setResponseCallback(expectedStatuses(200, 202, 409));

export const options = {
  scenarios: {
    write_load: {
      executor: 'constant-vus',
      vus: 500,
      duration: '1s',
      gracefulStop: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:write_load}': ['p(95)<300'],
  },
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
  const userIndex = exec.scenario.iterationInTest;
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
  const responses = http.batch(requests);

  for (const response of responses) {
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
  sleep(1);
}

export function handleSummary(data) {
  const requests = data.metrics.write_requests?.values;
  const latency = data.metrics.write_latency?.values;
  const failures = data.metrics.write_errors?.values;
  const checks = data.metrics.checks?.values;

  const summary = {
    testType: 'write',
    generatedAt: new Date().toISOString(),
    target: `${BASE_URL}/api/v1/orders`,
    productId: PRODUCT_ID,
    concurrentUsers: 500,
    uniqueUsers: 500,
    requests: requests?.count || 0,
    requestsPerSecond: requests?.rate || 0,
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
