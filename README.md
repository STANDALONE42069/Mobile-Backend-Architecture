# Mobile Backend Architecture — Flash Sale

Backend สำหรับระบบ Flash Sale ที่รองรับการอ่านจำนวนมากและการสั่งซื้อพร้อมกัน โดยใช้ Nginx, NestJS, PostgreSQL, Redis และ BullMQ

## Architecture

```text
Client / k6
    |
  Nginx (least connections)
    `-- NestJS API 1-3
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
3. Worker ตัดสต็อกและบันทึก order ด้วย data-modifying CTE คำสั่งเดียว (`UPDATE ... RETURNING` ป้อนให้ `INSERT ... SELECT`) จึงเป็น atomic โดยไม่ต้องเปิด transaction แยก และตัดสต็อกเฉพาะเมื่อ `remaining_stock > 0`
4. Unique constraint `(user_id, product_id)` ป้องกันการซื้อซ้ำขั้นสุดท้าย ถ้าชนคอนสเตรนต์ statement เดียวกันจะ rollback การตัดสต็อกไปพร้อมกัน
5. หลัง commit Worker เพิ่ม cache version ทำให้ GET ถัดไปไม่ใช้ cache เก่า

### Failure handling

- Job ตั้ง `attempts: 3` พร้อม exponential backoff เพื่อกันความผิดพลาดชั่วคราวของ DB
- กรณีที่เป็น business rule (`OUT_OF_STOCK_OR_INACTIVE`, `DUPLICATE_ORDER`) โยน `UnrecoverableError` จึง fail ทันทีโดยไม่ retry และยังนับรวมใน Failed jobs บน Bull Board
- Worker ปล่อย reservation key คืนเมื่อ job fail แบบไม่ใช่ duplicate (ของหมด หรือ retry ครบแล้ว) ผู้ใช้จึงไม่ถูกล็อกสิทธิ์ค้างจนหมด TTL

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
docker run --rm --network mobile-backend-architecture_default \
  -v "$PWD/loadtest:/scripts:ro" \
  -v "$PWD/loadtest/results:/results" \
  grafana/k6:latest run \
  -e BASE_URL=http://nginx -e RESULTS_DIR=/results \
  -e PAGE=1 -e LIMIT=10 /scripts/read-load.js

docker run --rm --network mobile-backend-architecture_default \
  -v "$PWD/loadtest:/scripts:ro" \
  -v "$PWD/loadtest/results:/results" \
  grafana/k6:latest run \
  -e BASE_URL=http://nginx -e RESULTS_DIR=/results \
  -e PRODUCT_ID=p-1001 /scripts/write-load.js
```

### Latest verified clean-state result

ทดสอบหลัง `docker compose down -v` โดยใช้ k6 อยู่ใน Docker network เดียวกับระบบ:

| Test | Workload | Requests | Throughput | p95 | avg | Threshold | Error | Checks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Read | 1,000 concurrent VUs / 30s | 284,947 | 9,464.62 req/s | 11.08 ms | 3.54 ms | < 200 ms | 0% | 854,841 / 0 |
| Write | 500 unique users / 575-request burst | 575 | 1,737.16 req/s | 205.00 ms | 79.01 ms | < 300 ms | 0% | 1,500 / 0 |

ผลนี้ทดสอบหลังสลับ HTTP platform เป็น Fastify (`@nestjs/platform-fastify`) และลด backend เหลือ 3 instance (ตรงสเปคขั้นต่ำ) บนเครื่อง dev 4 core / 6144 MB

Write throughput วัดเฉพาะช่วง order burst 400 ms ไม่รวมขั้นตอนเตรียม JWT แบบ sequential ใน `setup()` ผลเต็มถูกบันทึกใน `loadtest/results` และแสดงบน Operations Dashboard

ตัวเลขที่วัดได้จากรอบเดียวกัน: queue completed 50 / failed 450 (ของหมด) และ worker 1 ตัว ส่วน cache hit ratio วัดได้ 99.92% (561,569 hits / 445 misses)

p95 ของ write มี variance สูงระหว่างรอบ (วัดซ้ำได้ 153 / 169 / 201 / 205 ms) เพราะ k6 500 VUs รันบนเครื่องเดียวกับระบบและแย่ง CPU กัน ตัวเลขที่นิ่งกว่าคือ average latency และ burst duration รอบแรกหลัง `docker compose up` ไม่ควรใช้เทียบ เพราะ cold start ดันขึ้นไปถึง 346-450 ms

### JWT secret เป็น KeyObject

`jsonwebtoken` สร้าง `KeyObject` ใหม่ทุกครั้งที่ sign/verify ถ้าได้ secret เป็น string หรือ Buffer จึงสร้างครั้งเดียวใน `src/auth/auth.module.ts` ด้วย `createSecretKey()` แล้วส่งต่อให้ `JwtModule` (ชนิด `jwt.Secret` รองรับ `KeyObject` อยู่แล้ว ไม่ต้อง cast)

วัดใน container (`node:22-alpine`, OpenSSL 3.5.7): `jwt.verify` 64.10 us/op เมื่อใช้ string เทียบกับ 16.67 us/op เมื่อใช้ KeyObject — เร็วขึ้น 3.8 เท่า คิดเป็น CPU ที่ประหยัดได้ราว 9 ms ต่อ instance ต่อ burst จึงเห็นผลที่ average latency และ throughput มากกว่าที่ p95 tail

Read path ใช้ Redis Lua lookup หนึ่ง round-trip, ส่ง cached JSON โดยไม่ parse/serialize ซ้ำ, query เฉพาะ 6 field ตามสเปคเพื่อลดขนาด payload และ batch cache metrics ทุก 250 ms เพื่อลด persistent writes ส่วน Nginx ใช้ worker อัตโนมัติและกระจายโหลดไปยัง API 3 replicas ด้วย upstream keepalive 512 connections

ทุก Redis client เปิด `enableAutoPipelining` ทำให้คำสั่งที่เกิดใน event-loop tick เดียวกันถูกรวมเป็น socket write เดียว ลด round-trip ทั้งฝั่ง cache lookup และ `SET NX` + enqueue

ตรวจ data integrity หลัง queue ทำงานเสร็จ:

```bash
docker compose exec postgres psql -U flashsale -d flashsale -c "SELECT remaining_stock FROM products WHERE product_id='p-1001';"
docker compose exec postgres psql -U flashsale -d flashsale -c "SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders WHERE product_id='p-1001';"
```

ผลที่คาดหวังคือ stock เท่ากับ `0` และจำนวน order/distinct user เท่ากับ `50` โดยไม่มีผู้ใช้คนใดได้เกิน 1 ชิ้น

## Reset test data

คำสั่งนี้ลบ Docker volumes ของโปรเจกต์:

```bash
docker compose down -v
docker compose up --build -d
```
