import http from 'k6/http';
import { check, sleep } from 'k6';
import { expectedStatuses } from 'k6/http';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
http.setResponseCallback(expectedStatuses(200, 202, 409));

export const options = {
  scenarios: {
    read_load: {
      executor: 'constant-vus',
      exec: 'readProducts',
      vus: 1000,
      duration: '30s',
      startTime: '2s',
    },
    write_load: {
      executor: 'per-vu-iterations',
      exec: 'createOrder',
      vus: 500,
      iterations: 1,
      maxDuration: '30s',
      startTime: '2s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:read_load}': ['p(95)<200'],
    'http_req_duration{scenario:write_load}': ['p(95)<300'],
  },
};

export function setup() {
  const tokens = [];
  for (let i = 1; i <= 500; i += 1) {
    const response = http.post(`${BASE_URL}/api/v1/auth/token`, JSON.stringify({ userId: `user-${i}` }), {
      headers: { 'Content-Type': 'application/json' },
    });
    check(response, { 'token issued': (r) => r.status === 200 });
    tokens.push(response.json('accessToken'));
  }
  return { tokens };
}

export function readProducts() {
  const response = http.get(`${BASE_URL}/api/v1/products?page=1&limit=10`);
  check(response, { 'products returned': (r) => r.status === 200 });
  sleep(0.1);
}

export function createOrder(data) {
  const userIndex = exec.scenario.iterationInTest;
  const token = data.tokens[userIndex];
  const response = http.post(`${BASE_URL}/api/v1/orders`, JSON.stringify({ productId: 'p-1001' }), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  check(response, { 'order queued': (r) => r.status === 202 });

  if (userIndex < 50) {
    const duplicate = http.post(`${BASE_URL}/api/v1/orders`, JSON.stringify({ productId: 'p-1001' }), {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    check(duplicate, { 'duplicate rejected': (r) => r.status === 409 });
  }
}
