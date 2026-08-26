# Mobile Backend Architecture — Flash Sale

Backend สำหรับระบบ Flash Sale ที่รองรับการอ่านจำนวนมากและการสั่งซื้อพร้อมกัน โดยใช้ Nginx, NestJS, PostgreSQL, Redis และ BullMQ

## Architecture

```text
Client / k6
    |
  Nginx (least connections)
    |-- NestJS API 1-3
    `-- NestJS API 4-6
              |-- Redis: cache + atomic reservation
              |-- BullMQ: asynchronous order queue --> Worker
              `-- PostgreSQL: source of truth
```

## Start

```bash
docker compose up --build -d
```

- API: http://localhost:8080
- Health check: http://localhost:8080/health
- Operations Dashboard: http://localhost:3001/dashboard
- Bull Board: http://localhost:3001/admin/queues
- Cache metrics: http://localhost:8080/api/v1/products/cache-metrics

ข้อมูลสินค้าเริ่มต้นอ่านจาก `database/products-seed.json` โดยกำหนด `remainingStock` เริ่มต้นเท่ากับ `availableStock`

## API examples

```bash
curl -X POST http://localhost:8080/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-999"}'

curl "http://localhost:8080/api/v1/products?page=1&limit=10"

curl -X POST http://localhost:8080/api/v1/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"productId":"p-1001"}'
```

## Correctness strategy

1. API ใช้ Redis `SET NX EX` เพื่อกัน user/product เดิมส่งซ้ำก่อนเข้าคิว
2. API enqueue งานและตอบ `202 Accepted` ทันที
3. Worker ทำ PostgreSQL transaction และ atomic update เฉพาะเมื่อ `remaining_stock > 0`
4. Unique constraint `(user_id, product_id)` ป้องกันการซื้อซ้ำขั้นสุดท้าย
5. หลัง commit Worker เพิ่ม cache version ทำให้ GET ถัดไปไม่ใช้ cache เก่า

## Load test

ติดตั้ง k6 แล้วรัน:

```bash
k6 run loadtest/loadtest.js
```

รันเฉพาะ Read Load ด้วย 1,000 concurrent users โดยเลือกหน้าและขนาดหน้าได้:

```bash
k6 run -e PAGE=1 -e LIMIT=10 loadtest/read-load.js
```

รันเฉพาะ Write Load ด้วยผู้ใช้ไม่ซ้ำ 500 คน แย่งสินค้า `p-1001` และยิงซ้ำพร้อมกันบางส่วน:

```bash
k6 run -e PRODUCT_ID=p-1001 loadtest/write-load.js
```

เมื่อรัน k6 ผ่าน Docker ให้ mount `loadtest/results` เพื่อส่งผล Req/s, p95 และ Error Rate เข้า Operations Dashboard:

```bash
docker run --rm --network mobilebackendarchitecture_default \
  -v "$PWD/loadtest:/scripts:ro" \
  -v "$PWD/loadtest/results:/results" \
  grafana/k6:latest run \
  -e BASE_URL=http://nginx -e RESULTS_DIR=/results \
  -e PAGE=1 -e LIMIT=10 /scripts/read-load.js

docker run --rm --network mobilebackendarchitecture_default \
  -v "$PWD/loadtest:/scripts:ro" \
  -v "$PWD/loadtest/results:/results" \
  grafana/k6:latest run \
  -e BASE_URL=http://nginx -e RESULTS_DIR=/results \
  -e PRODUCT_ID=p-1001 /scripts/write-load.js
```

### Latest verified clean-state result

ทดสอบหลัง `docker compose down -v` โดยใช้ k6 อยู่ใน Docker network เดียวกับระบบ:

| Test | Workload | Requests | Throughput | p95 | Threshold | Error |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Read | 1,000 concurrent VUs / 30s | 195,862 | 6,502.10 req/s | 124.11 ms | < 200 ms | 0% |
| Write | 500 unique users / 575-request burst | 575 | 1,996.53 req/s | 158.73 ms | < 300 ms | 0% |

Write throughput วัดเฉพาะช่วง order burst 288 ms ไม่รวมขั้นตอนเตรียม JWT แบบ sequential ใน `setup()` ผลเต็มถูกบันทึกใน `loadtest/results` และแสดงบน Operations Dashboard

Read path ใช้ Redis Lua lookup หนึ่ง round-trip, ส่ง cached JSON โดยไม่ parse/serialize ซ้ำ และ batch cache metrics ทุก 250 ms เพื่อลด persistent writes ส่วน Nginx ใช้ worker อัตโนมัติและกระจายโหลดไปยัง API 6 replicas

ตรวจ data integrity หลัง queue ทำงานเสร็จ:

```bash
docker compose exec postgres psql -U flashsale -d flashsale -c "SELECT remaining_stock FROM products WHERE product_id='p-1001';"
docker compose exec postgres psql -U flashsale -d flashsale -c "SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders WHERE product_id='p-1001';"
```

ผลที่คาดหวังคือ stock เท่ากับ `0` และจำนวน order/distinct user เท่ากับ `50`

## Reset test data

คำสั่งนี้ลบ Docker volumes ของโปรเจกต์:

```bash
docker compose down -v
docker compose up --build -d
```
