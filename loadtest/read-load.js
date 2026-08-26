import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const PAGE = Number(__ENV.PAGE || 1);
const LIMIT = Number(__ENV.LIMIT || 10);

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
