# Mobile Backend Architecture — Flash Sale

Backend สำหรับระบบ Flash Sale ที่รองรับการอ่านจำนวนมากและการสั่งซื้อพร้อมกัน โดยใช้ Nginx, NestJS, PostgreSQL, Redis และ BullMQ

## Architecture

```text
Client / k6
    |
  Nginx (least connections)
    |-- NestJS API 1
    |-- NestJS API 2
    `-- NestJS API 3
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
