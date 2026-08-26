import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { expectedStatuses } from 'k6/http';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1001';

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

  check(responses, {
    'exactly one order queued per user': (items) => items.filter((r) => r.status === 202).length === 1,
    'all duplicate requests rejected': (items) => items.filter((r) => r.status === 409).length === requestCount - 1,
  });
  sleep(1);
}
